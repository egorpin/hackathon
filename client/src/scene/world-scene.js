import * as THREE from 'three';
import { polygonGeometry, shellModel } from './polygon-geometry.js';
import { smoothSurface, sphericalCellGeometry, sphericalOutline } from './mars-surface.js';
import { Controls } from './controls.js';
import { advance, tangent, vector, PlayerTrack, surfaceDistance } from './motion.js';

export function disposeObject(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const geometry of object.userData.ownedGeometries || []) geometries.add(geometry);
    for (const material of [object.material].flat().filter(Boolean)) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
    if (object.isInstancedMesh) object.dispose();
  });
  geometries.forEach(x => x.dispose()); materials.forEach(x => x.dispose()); textures.forEach(x => x.dispose());
  root.removeFromParent();
}
const material = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .9, flatShading: true, ...extra });
const mesh = (geometry, color) => new THREE.Mesh(geometry, material(color));
const upAxis = new THREE.Vector3(0,1,0);

export class WorldScene {
  constructor(host, events) {
    this.events = events; this.host = host; this.mode = 'first'; this.enabled = false;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0x170f15);
    this.camera = new THREE.PerspectiveCamera(70,1,.05,2000);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute('aria-label','Трёхмерная поверхность Марса');
    this.scene.add(new THREE.HemisphereLight(0xffdfbd,0x46303e,1.8));
    this.scene.add(new THREE.AmbientLight(0xd0b3a1,.75));
    const sun = new THREE.DirectionalLight(0xffe0b0,2); sun.position.set(100,200,90); this.scene.add(sun);
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
    ];
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
    this.previous = performance.now(); this.fpsStart = this.previous; this.frames = 0; this.inputTime = 0;
    this.renderer.setAnimationLoop(now => this.frame(now));
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
    this.viewRadius = world.view_radius; this.buildDistance = world.build_distance;
    this.camera.far = this.radius * 8; this.camera.updateProjectionMatrix();
    this.shell = world.shell.faces ? shellModel(world.shell) : mesh(new THREE.IcosahedronGeometry(world.shell.radius, world.shell.detail),0x9b4b33);
    this.scene.add(this.shell);
    this.ground = smoothSurface(this.radius); this.scene.add(this.ground);
    this.syncSurface();
    this.applyState(snapshot, true); this.enabled = true;
  }
  applyState(state, snap = false) {
    const now = performance.now();
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
        if (snap && player.heading) this.heading.copy(vector(player.heading));
        this.authoritative = this.position.clone(); this.predictionAge = 0;
        continue;
      }
      let entry = this.players.get(player.player_id);
      if (!entry) {
        const model = new THREE.Group();
        const body = mesh(new THREE.CapsuleGeometry(.35,.65,3,6),0xe9e2cf); body.position.y = .9;
        const helmet = mesh(new THREE.IcosahedronGeometry(.36,1),0x233a48); helmet.position.y = 1.65;
        model.add(body,helmet); this.scene.add(model);
        entry = { mesh: model, track: new PlayerTrack() }; this.players.set(player.player_id,entry);
      }
      entry.track.push(player,now);
    }
    for (const building of state.buildings || []) {
      const old = this.buildings.get(building.building_id);
      if (old) disposeObject(old.mesh);
      const model = this.buildingModel(building.building_type);
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
  buildingModel(type) {
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
    return group;
  }
  place(object, position) {
    object.position.copy(position);
    object.quaternion.setFromUnitVectors(upAxis,position.clone().normalize());
  }
  load(chunk) {
    this.unload(chunk.chunk_id);
    const group = new THREE.Group(); const cells = [];
    for (const cell of chunk.cells) {
      const center = vector(cell.center), vertices = cell.vertices.map(vector);
      const geometry = polygonGeometry(cell.vertices, cell.center, .015);
      const curved = sphericalCellGeometry(cell.vertices,cell.center,this.radius+.015);
      const pentagon = vertices.length === 5;
      const color = cell.surface === 'landing' ? 0xb6ada0 : cell.surface === 'mountain' ? 0x694c41 : pentagon ? 0xaa6650 : 0xa96040;
      const tile = new THREE.Mesh(geometry,material(color,{flatShading:false,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1}));
      tile.userData.ownedGeometries = [geometry, curved];
      tile.userData.cell = cell; cells.push(tile); group.add(tile);
      const linePoints = [...vertices,vertices[0]].map(v => v.clone().multiplyScalar(1.001));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePoints),new THREE.LineBasicMaterial({color:cell.surface==='landing'?0x9de2d0:0x50362b,transparent:true,opacity:.8}));
      line.userData.ownedGeometries = [line.geometry,sphericalOutline(cell.vertices,this.radius+.05)];
      tile.userData.outline = line; group.add(line);
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
        marking.userData.ownedGeometries = [marking.geometry,sphericalOutline(inner.slice(0,-1).map(v=>v.toArray()),this.radius+.065)];
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
    const allowed = !!cell?.buildable && !occupied && surfaceDistance(this.position,vector(cell.center),this.radius) <= this.buildDistance;
    this.preview.visible = !!cell;
    if (cell) {
      this.place(this.preview,vector(cell.center)); this.preview.material.color.setHex(allowed ? 0x80ffd7 : 0xff605a);
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
    if(this.ground)this.ground.visible = near;
    if(this.shell)this.shell.visible = !near;
    for(const entry of this.chunks.values())for(const tile of entry.cells) {
      tile.geometry = tile.userData.ownedGeometries[near ? 1 : 0];
      // Invisible curved meshes still support picking with the original server cell_id.
      // Only the landing pad remains painted on the close-up ground.
      tile.material.visible = !near || tile.userData.cell.surface === 'landing';
      const outline = tile.userData.outline;
      outline.geometry = outline.userData.ownedGeometries[near ? 1 : 0];
      const decoration = tile.userData.decoration;
      if(decoration?.userData.ownedGeometries)decoration.geometry=decoration.userData.ownedGeometries[near ? 1 : 0];
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
    const dt = Math.min(.05,Math.max(0,(now-this.previous)/1000)); this.previous = now;
    if (this.enabled) {
      const axes = this.controls.axes(dt), frame = tangent(this.position,this.heading);
      this.heading.copy(frame.forward).applyAxisAngle(frame.up,this.controls.yaw); this.controls.yaw = 0;
      // Bound speculative travel to 150ms; collision and all gameplay remain server-authoritative.
      const predictionDt = Math.min(dt,Math.max(0,.15-(this.predictionAge || 0)));
      this.predictionAge = (this.predictionAge || 0) + dt;
      const predicted = advance(this.position,this.heading,axes,this.speed,predictionDt,this.radius);
      this.position.copy(predicted.position); this.heading.copy(predicted.heading);
      this.inputTime += dt;
      if (this.inputTime >= .05) {
        this.inputTime = 0;
        const basis = tangent(this.position,this.heading);
        const move = basis.forward.multiplyScalar(axes.forward).addScaledVector(basis.right,axes.right);
        if (move.lengthSq() > 1) move.normalize();
        this.events.emit('player.input',{ axes, heading: this.heading.toArray(), pitch: this.controls.pitch, move:move.toArray() });
      }
      const { up, forward } = tangent(this.position,this.heading);
      if (this.mode === 'first') {
        this.camera.position.copy(this.position).addScaledVector(up,1.7);
        const look = forward.multiplyScalar(Math.cos(this.controls.pitch)).addScaledVector(up,Math.sin(this.controls.pitch));
        this.camera.up.copy(up); this.camera.lookAt(this.camera.position.clone().add(look));
      } else {
        this.camera.position.copy(this.position).addScaledVector(up,Math.max(this.radius*.85,this.viewRadius*1.8));
        this.camera.up.copy(forward); this.camera.lookAt(this.position);
      }
      // Interest is always centered on the last authoritative player position, never on the camera.
      const origin = this.authoritative || this.position;
      for (const entry of this.chunks.values()) for (const tile of entry.cells) {
        tile.visible = surfaceDistance(origin,vector(tile.userData.cell.center),this.radius) <= this.viewRadius;
        tile.userData.outline.visible = tile.visible && (this.mode === 'top' || tile.userData.cell.surface === 'landing' || tile.userData.cell.cell_id === this.selected?.cell_id);
        if(tile.userData.decoration)tile.userData.decoration.visible=tile.visible;
      }
      for (const entry of this.chunks.values()) for (const object of entry.group.children) {
        if (!object.isInstancedMesh) continue;
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
        const sample = entry.track.sample(now-100,this.radius);
        if (sample) {
          this.place(entry.mesh,sample.position);
          const basis = tangent(sample.position,sample.heading);
          entry.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(basis.right,basis.up,basis.forward.clone().negate()));
          entry.mesh.visible = surfaceDistance(origin,sample.position,this.radius) <= this.viewRadius;
        }
      }
      const loadedCells = new Set([...this.chunks.values()].flatMap(c => c.cells.map(t => t.userData.cell.cell_id)));
      for (const entry of this.buildings.values()) entry.mesh.visible = loadedCells.has(entry.data.cell_id) && surfaceDistance(origin,entry.mesh.position,this.radius) <= this.viewRadius;
      if (this.mode === 'first') this.pick();
      if (this.selected) {
        if (surfaceDistance(origin,vector(this.selected.center),this.radius)>this.viewRadius) this.select(null);
        else this.select(this.selected);
      }
    }
    this.renderer.render(this.scene,this.camera);
    this.frames++;
    if (now-this.fpsStart>=1000) {
      this.events.emit('performance',{ fps: this.frames*1000/(now-this.fpsStart), drawCalls: this.renderer.info.render.calls,
        geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures });
      this.frames=0; this.fpsStart=now;
    }
  }
  dispose() {
    this.renderer.setAnimationLoop(null); this.resizeObserver.disconnect(); this.controls.dispose();
    this.unsubs.forEach(fn=>fn()); this.reset(); disposeObject(this.preview); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
