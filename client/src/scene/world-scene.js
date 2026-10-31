import * as THREE from 'three';
import { polygonGeometry, shellModel } from './polygon-geometry.js';
import { smoothSurface, sphericalCellGeometry, sphericalOutline } from './mars-surface.js';
import { Controls } from './controls.js';
import { advance, tangent, vector, PlayerTrack, surfaceDistance } from './motion.js';
import { configureTerrain, projectTerrain } from './terrain.js';
import { Atmosphere } from './atmosphere.js';
import { FirstPersonHands } from './first-person-hands.js';
import { ModelLibrary, recolor } from './model-library.js';
import { withFoundation, fitFoundation } from './building-foundation.js';
import { resourcePile } from './resource-pile.js';
import { surfaceRocks } from './surface-rocks.js';
import { DEFAULT_VISUAL_OPTIONS, updateVisualOptions } from './visual-options.js';
import { CHARACTER_SCALE, CHARACTER_HEIGHT_SCALE, EYE_HEIGHT } from './character-scale.js';

export function disposeObject(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const skeletons = new Set();
  root.userData.animation?.mixer.stopAllAction();
  root.userData.animation?.mixer.uncacheRoot(root);
  root.traverse(object => {
    if(object.isSkinnedMesh && object.skeleton)skeletons.add(object.skeleton);
    if (object.geometry && !object.userData.sharedAsset) geometries.add(object.geometry);
    for (const geometry of object.userData.ownedGeometries || []) geometries.add(geometry);
    for (const material of [object.material].flat().filter(Boolean)) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && !object.userData.sharedAsset) textures.add(value);
    }
    if (object.isInstancedMesh) object.dispose();
  });
  geometries.forEach(x => x.dispose()); materials.forEach(x => x.dispose()); textures.forEach(x => x.dispose());
  skeletons.forEach(skeleton=>skeleton.dispose());
  root.removeFromParent();
}
const material = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .9, flatShading: true, ...extra });
const mesh = (geometry, color) => new THREE.Mesh(geometry, material(color));
const resourceLabels = { water: 'В', iron: 'Ж', sulfur: 'С' };
const upAxis = new THREE.Vector3(0,1,0);

export class WorldScene {
  constructor(host, events) {
    this.visualOptions = { ...DEFAULT_VISUAL_OPTIONS };
    this.buildType = 'drill';
    this.events = events; this.host = host; this.mode = 'first'; this.enabled = false;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x170f15);
    this.camera = new THREE.PerspectiveCamera(70,1,.05,2000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label','Трёхмерная поверхность Марса');
    this.fillLight = new THREE.HemisphereLight(0xffdfbd,0x46303e,.5); this.scene.add(this.fillLight);
    this.scene.add(this.camera);
    this.atmosphere = new Atmosphere(this.scene);
    this.hands = new FirstPersonHands(this.camera);
    this.models = new ModelLibrary();
    this.models.load(name=>this.modelLoaded(name)).catch(()=>this.events.emit('notice','Модели недоступны; используются временные формы.'));
    this.frameTimes=[]; this.cameraBob=true;
    this.chunks = new Map(); this.players = new Map(); this.buildings = new Map();
    this.position = new THREE.Vector3(0,100,0); this.heading = new THREE.Vector3(0,0,-1);
    this.radius = 100; this.speed = 4; this.viewRadius = 24; this.buildDistance = 6;
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.controls = new Controls(this.renderer.domElement, events); this.controls.mode = this.mode;
    this.preview = mesh(new THREE.CylinderGeometry(.7,.9,1.6,6),0x80ffd7);
    this.preview.material.transparent = true; this.preview.material.opacity = .45;
    this.preview.visible = false; this.scene.add(this.preview);
    this.unsubs = [
      events.on('camera.toggle', () => this.toggleCamera()),
      events.on('scene.click', e => { if (this.mode === 'top') this.pick(e); }),
      events.on('graphics.quality', level => this.setQuality(level)),
      events.on('graphics.bob', enabled => { this.cameraBob=enabled; }),
      events.on('graphics.effects', options => this.setVisualOptions(options)),
    ];
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.previous = performance.now(); this.fpsStart = this.previous; this.frames = 0; this.inputTime = 0;
    this.renderer.setAnimationLoop(now => this.frame(now));
  }
  setQuality(level) {
    this.atmosphere.setQuality(level);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, {low:.8,medium:1,high:1.5}[level] || 1));
    this.resize();
  }
  setVisualOptions(patch) {
    this.visualOptions = updateVisualOptions(this.visualOptions, patch);
  }
  modelLoaded(name) {
    if(name==='astronaut') {
      this.hands.dispose();
      this.hands=new FirstPersonHands(this.camera,{astronaut:this.models.assets.get(name).scene,animations:this.models.assets.get(name).animations});
      for(const entry of this.players.values()) {
        disposeObject(entry.mesh); entry.mesh=this.models.create(name,entry.data?.color); entry.mesh.scale.multiply(new THREE.Vector3(CHARACTER_SCALE, CHARACTER_HEIGHT_SCALE, CHARACTER_SCALE));this.scene.add(entry.mesh);
      }
    } else {
      for(const entry of this.buildings.values()) if((entry.data.building_type==='warehouse'?'storage':entry.data.building_type)===name) {
        disposeObject(entry.mesh);entry.mesh=this.buildingModel(entry.data.building_type,entry.data.color);
        this.place(entry.mesh,vector(entry.data.position));this.scene.add(entry.mesh);
      }
    }
  }
  resize() {
    const { width, height } = this.host.getBoundingClientRect();
    this.renderer.setSize(width,height); this.camera.aspect = width / Math.max(1,height); this.camera.updateProjectionMatrix();
  }
  reset() {
    for (const id of [...this.chunks.keys()]) this.unload(id);
    for (const entry of this.players.values()) disposeObject(entry.mesh);
    for (const entry of this.buildings.values()) disposeObject(entry.mesh);
    this.players.clear(); this.buildings.clear(); this.select(null);
    if (this.shell) disposeObject(this.shell);
    this.shell = null;
    if (this.ground) disposeObject(this.ground);
    this.ground = null;
  }
  configure(snapshot) {
    this.reset();
    this.selfId = snapshot.self_id;
    const world = snapshot.world;
    this.radius = world.radius; this.speed = world.move_speed;
    this.terrain = !!world.terrain;
    configureTerrain(world.terrain_seed);
    this.terrainSeed = world.terrain_seed;
    this.viewRadius = world.view_radius; this.buildDistance = world.build_distance;
    this.camera.far = Math.max(1200,this.radius * 8); this.camera.updateProjectionMatrix();
    this.shell = world.shell.faces ? shellModel(world.shell) : mesh(new THREE.IcosahedronGeometry(world.shell.radius, world.shell.detail),0x9b4b33);
    this.scene.add(this.shell);
    this.ground = smoothSurface(this.radius,this.terrain); this.scene.add(this.ground);
    this.syncSurface();
    this.applyState(snapshot, true); this.enabled = true;
  }
  applyState(state, snap = false) {
    const now = performance.now();
    if(Number.isFinite(state.simulation_time)) { this.simulationTime=state.simulation_time;this.timeReceived=now; }
    if(state.stage)this.stage=state.stage;
    for (const id of state.removed_players || []) {
      const entry = this.players.get(id); if (entry) disposeObject(entry.mesh); this.players.delete(id);
    }
    for (const id of state.removed_buildings || []) {
      const entry = this.buildings.get(id); if (entry) disposeObject(entry.mesh); this.buildings.delete(id);
    }
    for (const player of state.players || []) {
      if (player.player_id === this.selfId) {
        // Server owns position and collision resolution. Prediction is visual only.
        this.position.copy(vector(player.position));
        this.selfColor=player.color; this.altitude=player.altitude || 0; this.verticalSpeed=player.vertical_speed || 0;
        if (snap && player.heading) this.heading.copy(vector(player.heading));
        this.authoritative = this.position.clone(); this.predictionAge = 0;
        continue;
      }
      let entry = this.players.get(player.player_id);
      if (!entry) {
        const model = this.models.create('astronaut',player.color) || new THREE.Group();
        if(!this.models.assets.has('astronaut')) {
        const body = mesh(new THREE.CapsuleGeometry(.35,.65,3,6),0xe9e2cf); body.position.y = .9;
        body.material.name='Accent';
        const helmet = mesh(new THREE.IcosahedronGeometry(.36,1),0x233a48); helmet.position.y = 1.65;
        model.add(body,helmet); }
        model.scale.multiply(new THREE.Vector3(CHARACTER_SCALE, CHARACTER_HEIGHT_SCALE, CHARACTER_SCALE));this.scene.add(model);
        entry = { mesh: model, track: new PlayerTrack() }; this.players.set(player.player_id,entry);
      }
      entry.data=player; recolor(entry.mesh,player.color);
      entry.track.push(player,now);
    }
    for (const building of state.buildings || []) {
      const old = this.buildings.get(building.building_id);
      if (old && old.data.building_type===building.building_type) {
        old.data=building;recolor(old.mesh,building.color);this.place(old.mesh,vector(building.position));continue;
      }
      if(old)disposeObject(old.mesh);
      const model = this.buildingModel(building.building_type,building.color);
      this.place(model,vector(building.position));
      this.scene.add(model);
      if (building.interaction_point) {
        const marker = mesh(new THREE.SphereGeometry(.16,6,4),0x80ffd7);
        model.updateMatrixWorld(true);
        marker.position.copy(model.worldToLocal(vector(building.interaction_point).multiplyScalar(1.003)));
        model.add(marker);
      }
      this.buildings.set(building.building_id,{ mesh: model, data: building });
    }
  }
  buildingModel(type,color) {
    const loaded=this.models.create(type==='warehouse'?'storage':type,color); if(loaded)return type==='drill'?loaded:withFoundation(loaded);
    const group = new THREE.Group();
    const base = mesh(new THREE.CylinderGeometry(1,1.2,.35,6),0x383e47); base.position.y = .18; group.add(base);
    if (type === 'drill') {
      const shaft = mesh(new THREE.ConeGeometry(.45,2,6),0xe8ab50); shaft.position.y = 1.2; group.add(shaft);
      for (const x of [-.8,.8]) {
        const leg = mesh(new THREE.BoxGeometry(.2,2.2,.2),0xd4cbb8); leg.position.set(x,1.1,0); group.add(leg);
      }
    } else if (type === 'oxygen_generator') {
      for (const x of [-.42,.42]) {
        const tank = mesh(new THREE.CylinderGeometry(.36,.36,1.7,8),0x85c8c0); tank.position.set(x,1.05,0); group.add(tank);
      }
    } else {
      const box = mesh(new THREE.BoxGeometry(1.6,1.3,1.3),0xcdb697); box.position.y = .9; group.add(box);
    }
    group.traverse(node=>{if(node.material && node.position.y>.35)node.material.name='Accent';}); recolor(group,color);
    return type==='drill'?group:withFoundation(group);
  }
  place(object, position) {
    fitFoundation(object,position,this.radius,this.terrain);
    object.position.copy(position);
    object.quaternion.setFromUnitVectors(upAxis,position.clone().normalize());
  }
  load(chunk) {
    this.unload(chunk.chunk_id);
    const group = new THREE.Group(); const cells = [];
    group.add(surfaceRocks(chunk.cells, {radius:this.radius,terrain:this.terrain,seed:this.terrainSeed}));
    for (const cell of chunk.cells) {
      const center = vector(cell.center), vertices = cell.vertices.map(vector);
      const geometry = polygonGeometry(cell.vertices, cell.center, .015);
      const curved = sphericalCellGeometry(cell.vertices,cell.center,this.radius+.015,3,this.terrain);
      const pentagon = vertices.length === 5;
      const color = cell.surface === 'landing' ? 0xb6ada0 : cell.surface === 'mountain' ? 0x694c41 : pentagon ? 0xaa6650 : 0xa96040;
      const tile = new THREE.Mesh(geometry,material(color,{flatShading:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
      tile.userData.ownedGeometries = [geometry, curved];
      tile.userData.cell = cell; cells.push(tile); group.add(tile);
      const linePoints = [...vertices,vertices[0]].map(v => v.clone().multiplyScalar(1.001));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints),new THREE.LineBasicMaterial({color:cell.surface==='landing'?0x9de2d0:0x50362b,transparent:true,opacity:.8}));
      line.userData.ownedGeometries = [line.geometry,sphericalOutline(cell.vertices,this.radius+.05,8,this.terrain)];
      tile.userData.outline = line; group.add(line);
      if (resourceLabels[cell.resource]) {
        const pile=resourcePile(cell,{radius:this.radius,terrain:this.terrain});
        this.place(pile,projectTerrain(center.clone(),this.radius,0,this.terrain));
        tile.userData.resourcePile=pile;group.add(pile);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
        const context = canvas.getContext('2d');
        context.font = 'bold 104px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
        context.lineWidth = 9; context.strokeStyle = '#241710'; context.fillStyle = '#ffffff';
        context.strokeText(resourceLabels[cell.resource],64,68); context.fillText(resourceLabels[cell.resource],64,68);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        const label = new THREE.Sprite(new THREE.SpriteMaterial({map:texture}));
        const size = center.distanceTo(vertices[0]) * .38;
        label.scale.set(size,size,1);
        label.position.copy(projectTerrain(center.clone(),this.radius,Math.max(1.1,pile.userData.footprintRadius*1.3),this.terrain));
        tile.userData.decoration = label; group.add(label);
      }
      if (cell.surface === 'mountain') {
        const width = center.distanceTo(vertices[0]) * .85;
        const mountain = mesh(new THREE.ConeGeometry(width,width*1.5,5),0x755348);
        this.place(mountain,center.clone().addScaledVector(center.clone().normalize(),width*.65));
        tile.userData.decoration=mountain;group.add(mountain);
      }
      if (cell.surface === 'landing') {
        const inner=vertices.map(v=>center.clone().lerp(v,.74).addScaledVector(center.clone().normalize(),.07));
        inner.push(inner[0]);
        const marking=new THREE.Line(new THREE.BufferGeometry().setFromPoints(inner),new THREE.LineBasicMaterial({color:0xb7ffee}));
        marking.userData.ownedGeometries = [marking.geometry,sphericalOutline(inner.slice(0,-1).map(v=>v.toArray()),this.radius+.065,8,this.terrain)];
        tile.userData.decoration=marking;group.add(marking);
      }
    }
    if (chunk.rocks?.length) {
      const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),material(0x69483d),chunk.rocks.length);
      const transform = new THREE.Object3D();
      chunk.rocks.forEach((rock,i) => {
        this.place(transform,vector(rock.position)); transform.scale.setScalar(rock.scale || .5); transform.updateMatrix(); rocks.setMatrixAt(i,transform.matrix);
      });
      rocks.instanceMatrix.needsUpdate = true; rocks.userData.rocks = chunk.rocks; group.add(rocks);
    }
    this.chunks.set(chunk.chunk_id,{ group,cells }); this.scene.add(group);
    this.syncSurface();
  }
  unload(id) {
    const entry = this.chunks.get(id); if (!entry) return;
    if (entry.cells.some(tile => tile.userData.cell.cell_id === this.selected?.cell_id)) this.select(null);
    const ids = new Set(entry.cells.map(tile => tile.userData.cell.cell_id));
    for (const [buildingId, building] of this.buildings) {
      if (ids.has(building.data.cell_id)) { disposeObject(building.mesh); this.buildings.delete(buildingId); }
    }
    disposeObject(entry.group); this.chunks.delete(id);
  }
  select(cell) {
    this.selected = cell;
    const occupied = [...this.buildings.values()].some(b => b.data.cell_id === cell?.cell_id);
    const allowed = !!cell?.buildable && (this.buildType !== 'drill' || !!resourceLabels[cell.resource]) && !occupied && surfaceDistance(this.position,vector(cell.center),this.radius) <= this.buildDistance;
    this.preview.visible = !!cell;
    if (cell) {
      this.place(this.preview,projectTerrain(vector(cell.center),this.radius,0,this.terrain)); this.preview.material.color.setHex(allowed ? 0x80ffd7 : 0xff605a);
    }
    this.events.emit('cell.selected',{ cell, locallyAllowed: allowed });
  }
  pick(event) {
    if (!this.enabled) return;
    if (this.mode === 'first') this.pointer.set(0,0);
    else {
      if (!event) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    }
    this.raycaster.setFromCamera(this.pointer,this.camera);
    const tiles = [...this.chunks.values()].flatMap(c => c.cells).filter(c => c.visible && c.userData.cell.surface !== 'mountain');
    const hit = this.raycaster.intersectObjects(tiles,false)[0];
    const cell = hit?.object.userData.cell || null;
    if (cell?.cell_id !== this.selected?.cell_id) this.select(cell);
  }
  syncSurface() {
    const near = this.mode === 'first';
    if(this.ground)this.ground.visible = true;
    if(this.shell)this.shell.visible = false;
    for(const entry of this.chunks.values())for(const tile of entry.cells) {
      tile.geometry = tile.userData.ownedGeometries[1];
      // Invisible curved meshes still support picking with the original server cell_id.
      // Only the landing pad remains painted on the close-up ground.
      tile.material.visible = !near || tile.userData.cell.surface === 'landing';
      tile.material.transparent = !near && tile.userData.cell.surface !== 'landing';
      tile.material.opacity = tile.material.transparent ? .18 : 1;
      tile.material.depthWrite = !tile.material.transparent;
      const outline = tile.userData.outline;
      outline.geometry = outline.userData.ownedGeometries[1];
      const decoration = tile.userData.decoration;
      if(decoration?.userData.ownedGeometries)decoration.geometry=decoration.userData.ownedGeometries[1];
    }
  }
  toggleCamera() {
    this.mode = this.mode === 'first' ? 'top' : 'first'; this.controls.mode = this.mode;
    this.syncSurface();
    this.controls.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    this.select(null); this.events.emit('camera.changed',this.mode);
  }
  nearestBuilding() {
    return [...this.buildings.values()].filter(e => e.mesh.visible)
      .sort((a,b) => vector(a.data.interaction_point || a.data.position).distanceTo(this.position)-vector(b.data.interaction_point || b.data.position).distanceTo(this.position))[0]?.data || null;
  }
  frame(now) {
    this.frameTimes.push(now-this.previous);
    const dt = Math.min(.05,Math.max(0,(now-this.previous)/1000)); this.previous = now;
    if (this.enabled) {
      const axes = this.controls.axes(dt), frame = tangent(this.position,this.heading);
      const running=this.controls.keys.has('ShiftLeft') || this.controls.keys.has('ShiftRight');
      const jump=this.controls.keys.has('Space');
      if(this.stage==='lobby') { axes.forward=0; axes.right=0; }
      this.heading.copy(frame.forward).applyAxisAngle(frame.up,this.controls.yaw); this.controls.yaw = 0;
      // Bound speculative travel to 150ms; collision and all gameplay remain server-authoritative.
      const predictionDt = Math.min(dt,Math.max(0,.15-(this.predictionAge || 0)));
      this.predictionAge = (this.predictionAge || 0) + dt;
      const predicted = advance(this.position,this.heading,axes,this.speed*(running?1.5:1),predictionDt,this.radius);
      if(this.altitude || this.verticalSpeed) {
        this.verticalSpeed-=5.5*predictionDt; this.altitude=Math.max(0,this.altitude+this.verticalSpeed*predictionDt);
        if(!this.altitude)this.verticalSpeed=0;
      }
      projectTerrain(predicted.position,this.radius,this.altitude || 0,this.terrain);
      this.position.copy(predicted.position); this.heading.copy(predicted.heading);
      this.inputTime += dt;
      if (this.inputTime >= .05) {
        this.inputTime = 0;
        const basis = tangent(this.position,this.heading);
        const move = basis.forward.multiplyScalar(axes.forward).addScaledVector(basis.right,axes.right);
        if (move.lengthSq() > 1) move.normalize();
        this.events.emit('player.input',{ axes, heading: this.heading.toArray(), pitch: this.controls.pitch, move:move.toArray(),jump,running });
      }
      const { up, forward } = tangent(this.position,this.heading);
      if (this.mode === 'first') {
        this.camera.position.copy(this.position).addScaledVector(up,EYE_HEIGHT);
        const look = forward.multiplyScalar(Math.cos(this.controls.pitch)).addScaledVector(up,Math.sin(this.controls.pitch));
        this.camera.up.copy(up); this.camera.lookAt(this.camera.position.clone().add(look));
      } else {
        this.camera.position.copy(this.position).addScaledVector(up,Math.max(this.radius*.85,this.viewRadius*1.8));
        this.camera.up.copy(forward); this.camera.lookAt(this.position);
      }
      const sharedTime=(this.simulationTime || 0)+(this.stage==='running'?Math.min(.25,(now-(this.timeReceived || now))/1000):0)+350;
      this.atmosphere.update(sharedTime,this.camera,up,dt,{dust:this.visualOptions.dust});
      this.atmosphere.sky.visible=this.visualOptions.sky && this.mode==='first';
      this.atmosphere.dust.visible=this.visualOptions.dust && this.mode==='first' && this.atmosphere.dust.visible;
      this.atmosphere.stars.visible=this.visualOptions.stars;
      this.atmosphere.sun.visible=this.visualOptions.sun && this.atmosphere.sun.visible;
      if(this.mode==='top')this.atmosphere.stars.material.opacity=.75;
      this.fillLight.intensity=.12+.45*Math.max(0,up.dot(this.atmosphere.sunDirection));
      this.fillLight.position.copy(up);
      this.hands.update(dt,{moving:this.cameraBob && !!(axes.forward || axes.right),running,airborne:(this.altitude || 0)>.05,color:this.selfColor,visible:this.visualOptions.hands && this.mode==='first'});
      // Interest is always centered on the last authoritative player position, never on the camera.
      const origin = this.authoritative || this.position;
      for (const entry of this.chunks.values()) for (const tile of entry.cells) {
        tile.visible = surfaceDistance(origin,vector(tile.userData.cell.center),this.radius) <= this.viewRadius;
        tile.userData.outline.visible = tile.visible && (this.mode === 'top' || tile.userData.cell.surface === 'landing' || tile.userData.cell.cell_id === this.selected?.cell_id);
        if(tile.userData.decoration)tile.userData.decoration.visible=tile.visible && (!tile.userData.decoration.isSprite || this.mode==='top');
        if(tile.userData.resourcePile)tile.userData.resourcePile.visible=this.visualOptions.resourceDeposits && tile.visible;
      }
      for (const entry of this.chunks.values()) for (const object of entry.group.children) {
        if(object.isInstancedMesh) object.visible=this.visualOptions.rocks;
        // Static regolith instances already have their terrain transforms.
        // Only server rock batches carry metadata for per-rock interest culling.
        if (!object.isInstancedMesh || !object.visible || !Array.isArray(object.userData.rocks)) continue;
        const transform = new THREE.Object3D();
        object.userData.rocks.forEach((rock,i) => {
          const position = vector(rock.position);
          this.place(transform,position);
          transform.scale.setScalar(surfaceDistance(origin,position,this.radius) <= this.viewRadius ? (rock.scale || .5) : 0);
          transform.updateMatrix(); object.setMatrixAt(i,transform.matrix);
        });
        object.instanceMatrix.needsUpdate = true;
      }
      for (const entry of this.players.values()) {
        const sample = entry.track.sample(now-100,this.radius,true);
        if (sample) {
          this.place(entry.mesh,sample.position);
          const basis = tangent(sample.position,sample.heading);
          entry.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis.right,basis.up,basis.forward.clone().negate()));
          // The imported astronaut faces +Z; the camera basis faces -Z.
          entry.mesh.rotateY(Math.PI);
          entry.mesh.visible = surfaceDistance(origin,sample.position,this.radius) <= this.viewRadius;
          this.models.animate(entry.mesh,entry.data?.altitude>.05?'jump':entry.data?.moving?(entry.data.running?'run':'walk'):'idle',dt);
        }
      }
      const loadedCells = new Set([...this.chunks.values()].flatMap(c => c.cells.map(t => t.userData.cell.cell_id)));
      for (const entry of this.buildings.values()) {
        entry.mesh.visible = loadedCells.has(entry.data.cell_id) && surfaceDistance(origin,entry.mesh.position,this.radius) <= this.viewRadius;
        if(entry.mesh.visible)entry.mesh.userData.mechanical?.update(dt,{active:this.stage==='running' && (!entry.data.stock || Object.values(entry.data.stock).reduce((a,b)=>a+b,0)<50)});
      }
      if (this.mode === 'first') this.pick();
      if (this.selected) {
        if (surfaceDistance(origin,vector(this.selected.center),this.radius)>this.viewRadius) this.select(null);
        else this.select(this.selected);
      }
    }
    this.renderer.render(this.scene,this.camera);
    this.frames++;
    if (now-this.fpsStart>=1000) {
      const sorted=this.frameTimes.slice().sort((a,b)=>a-b);
      this.events.emit('performance',{ fps: this.frames*1000/(now-this.fpsStart), drawCalls: this.renderer.info.render.calls,
        frameP95:sorted[Math.floor(sorted.length*.95)] || 0,triangles:this.renderer.info.render.triangles,
        geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures });
      this.frames=0; this.fpsStart=now;this.frameTimes.length=0;
    }
  }
  dispose() {
    this.renderer.setAnimationLoop(null); this.resizeObserver.disconnect(); this.controls.dispose();
    this.unsubs.forEach(fn=>fn()); this.reset(); this.hands.dispose();this.atmosphere.dispose();this.models.dispose();disposeObject(this.preview); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
