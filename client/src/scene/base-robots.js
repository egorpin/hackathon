import * as THREE from 'three';

const AMBIENT_COUNT = 9;
const BUILDERS_PER_SITE = 3;
const MAX_ROBOTS = 30;
// A robot can notice and greet an astronaut from a small, but visible distance.
const PLAYER_REACT_RADIUS = 3;
const REACTION_COOLDOWN = 8;
const TAU = Math.PI * 2;
const ROBOT_SCALE = .14;
const BUILDER_STANDOFF = 1.35;
// Ambient robots are hub staff, rather than explorers. Construction workers may
// still travel to their assigned site, but idle robots remain within the hub.
const HUB_ROAM_RADIUS = 6;
const RESOURCE_COLORS = Object.freeze({
  water: 0x65d9ed, ice: 0x65d9ed, iron: 0xb76e45, sulfur: 0xf4d447, copper: 0xd8844f,
});

function hash(value) {
  let h = 2166136261;
  for (const char of String(value)) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

function seeded(seed) {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function constructionSiteId(site) {
  return String(site?.site_id ?? site?.construction_id ?? site?.building_id ?? site?.cell_id ?? site?.id ?? '');
}

export function allocateRobotRoles(sites = [], ambientCount = AMBIENT_COUNT, maxCount = MAX_ROBOTS) {
  const roles = Array.from({ length: Math.min(ambientCount, maxCount) }, (_, index) => ({
    id: `ambient-${index}`, role: 'ambient', siteId: null, index,
  }));
  const limit = Math.min(maxCount, Math.max(0, maxCount));
  for (const site of sites) {
    if (site?.construction_status && !['planned', 'building'].includes(site.construction_status)) continue;
    const siteId = constructionSiteId(site);
    if (!siteId || roles.length + BUILDERS_PER_SITE > limit) break;
    for (let index = 0; index < BUILDERS_PER_SITE; index++) {
      roles.push({ id: `builder-${siteId}-${index}`, role: 'builder', siteId, index });
    }
  }
  return roles;
}

function vector(value) {
  return value?.isVector3 ? value.clone() : Array.isArray(value) ? new THREE.Vector3().fromArray(value) : null;
}

function surfacePoint(direction, radiusAt, projectSurface, offset = 0) {
  const normal = direction.clone().normalize();
  if (projectSurface) {
    const point = projectSurface(normal.clone());
    return (point?.isVector3 ? point : normal.clone().multiplyScalar(radiusAt(normal))).addScaledVector(normal, offset);
  }
  return normal.multiplyScalar(radiusAt(normal) + offset);
}

function lowestModelY(root) {
  root.updateWorldMatrix(true, true);
  const rootInverse = root.matrixWorld.clone().invert();
  const point = new THREE.Vector3();
  let minimum = Infinity;
  root.traverse(node => {
    if (!node.isMesh || !node.geometry || node.userData.robotCargo) return;
    const bounds = node.geometry.boundingBox || (node.geometry.computeBoundingBox(), node.geometry.boundingBox);
    if (!bounds) return;
    for (let corner = 0; corner < 8; corner++) {
      point.set(corner & 1 ? bounds.max.x : bounds.min.x,
        corner & 2 ? bounds.max.y : bounds.min.y,
        corner & 4 ? bounds.max.z : bounds.min.z)
        .applyMatrix4(node.matrixWorld)
        .applyMatrix4(rootInverse);
      minimum = Math.min(minimum, point.y);
    }
  });
  return Number.isFinite(minimum) ? minimum : 0;
}

function tangentFrame(position, preferred) {
  const up = position.clone().normalize();
  const forward = preferred.clone().addScaledVector(up, -preferred.dot(up));
  if (forward.lengthSq() < 1e-8) {
    const fallback = Math.abs(up.x) < .8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    forward.copy(fallback).addScaledVector(up, -fallback.dot(up));
  }
  forward.normalize();
  return { up, forward, right: new THREE.Vector3().crossVectors(forward, up).normalize() };
}

function orientRobot(entry) {
  const frame = tangentFrame(entry.position, entry.heading);
  entry.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3().crossVectors(frame.up, entry.heading).normalize(), frame.up, entry.heading,
  ));
}

function faceDirection(entry, direction) {
  const up = entry.position.clone().normalize();
  const heading = direction.clone().addScaledVector(up, -direction.dot(up));
  if (heading.lengthSq() > 1e-8) entry.heading.copy(heading.normalize());
  orientRobot(entry);
}

function makeFallback() {
  const root = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(.22, 0), new THREE.MeshStandardMaterial({ color: 0xd6b884, roughness: .85, flatShading: true }));
  shell.position.y = .3;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(.06, 8, 6), new THREE.MeshStandardMaterial({ color: 0x24343b, emissive: 0x16262b }));
  eye.position.set(0, .35, -.19);
  root.add(shell, eye);
  root.userData.fallbackRobot = true;
  return root;
}

function makeGreetingTexture() {
  if (!globalThis.document?.createElement) return null;
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 112;
  const context = canvas.getContext?.('2d');
  if (!context) return null;
  context.fillStyle = '#fffdf5';
  context.strokeStyle = '#26343a';
  context.lineWidth = 7;
  context.beginPath();
  context.roundRect(8, 5, 240, 84, 22);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(110, 85);
  context.lineTo(119, 106);
  context.lineTo(139, 85);
  context.closePath();
  context.fill();
  context.stroke();
  context.fillStyle = '#26343a';
  context.font = 'bold 58px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('БИП!', 128, 46);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function removeRobot(entry) {
  const animation = entry.root.userData.animation;
  animation?.mixer.stopAllAction();
  animation?.mixer.uncacheRoot(entry.root);
  entry.root.removeFromParent();
  if (entry.root.userData.fallbackRobot) {
    entry.root.traverse(node => {
      node.geometry?.dispose();
      if (!node.userData.sharedRobotGreetingMaterial) node.material?.dispose();
    });
  } else {
    entry.root.traverse(node => {
      if (node.isSkinnedMesh) node.skeleton?.dispose();
      if (node.userData.sharedRobotGreetingMaterial) return;
      for (const material of [node.material].flat().filter(Boolean)) material.dispose();
    });
  }
}

/** Decorative local-only robot crowd; resource routes never mutate gameplay state. */
export class BaseRobots {
  constructor(scene, models, { radiusAt = null, projectSurface = null, seed = 91823, ambientCount = AMBIENT_COUNT, maxCount = MAX_ROBOTS, greetingTextureFactory = makeGreetingTexture } = {}) {
    this.scene = scene;
    this.models = models;
    this.radiusAt = radiusAt || (() => this.origin.length());
    this.projectSurface = projectSurface;
    this.random = seeded(seed >>> 0);
    this.ambientCount = ambientCount;
    this.maxCount = maxCount;
    this.entries = new Map();
    this.sites = [];
    this.players = [];
    this.deposits = [];
    this.origin = new THREE.Vector3(0, 100, 0);
    this.baseOrigin = null;
    this.homePosition = null;
    this.now = 0;
    this.disposed = false;
    this.greetingTexture = greetingTextureFactory?.() || null;
    this.greetingMaterial = this.greetingTexture ? new THREE.SpriteMaterial({
      map: this.greetingTexture, transparent: true, depthWrite: false, toneMapped: false,
    }) : null;
  }

  setState({ position, buildings = [], players = [], constructionSites = [], deposits = [] } = {}) {
    if (position) {
      this.origin.copy(position.isVector3 ? position : new THREE.Vector3().fromArray(position));
      this.baseOrigin ||= this.origin.clone();
    }
    this.buildings = buildings;
    this.players = players;
    this.deposits = deposits.map(deposit => {
      const resource = String(deposit?.resource || '').toLowerCase();
      const point = vector(deposit?.position || deposit?.center);
      if (!point || !RESOURCE_COLORS[resource]) return null;
      return { resource, color: RESOURCE_COLORS[resource], point };
    }).filter(Boolean);
    const home = buildings.find(building => building.building_type === 'dome_base')?.position;
    const homeDirection = vector(home) || this.baseOrigin || this.origin;
    this.homePosition = surfacePoint(homeDirection, this.radiusAt, this.projectSurface);
    this.sites = constructionSites.length ? constructionSites : buildings.filter(building =>
      ['planned', 'building'].includes(building.construction_status) || building.is_construction_site === true || building.status === 'constructing' || building.state === 'constructing' ||
      building.building_type === 'construction_site' || building.building_type === 'construction-site');
    // Positions and site progress change frequently; membership usually does not.
    const rosterKey = JSON.stringify([this.ambientCount, this.maxCount, this.sites.map(site =>
      [constructionSiteId(site), site.construction_status])]);
    if (rosterKey !== this.rosterKey) {
      this.rosterKey = rosterKey;
      this.reconcile();
    }
  }

  create(role) {
    const root = this.models?.create?.('robot_minion') || makeFallback();
    root.scale.multiplyScalar(root.userData.fallbackRobot ? 1 : ROBOT_SCALE);
    root.userData.robotRole = role.role;
    this.scene.add(root);
    const random = seeded(hash(role.id));
    const originPoint = this.baseOrigin || this.origin;
    const direction = originPoint.clone().normalize();
    const frame = tangentFrame(originPoint, new THREE.Vector3(0, 0, -1));
    const angle = random() * TAU;
    const distance = role.role === 'builder' ? 1.5 + random() * 1.2 : 2 + random() * (HUB_ROAM_RADIUS - 2);
    direction.addScaledVector(frame.forward, Math.cos(angle) * distance / this.radiusAt(originPoint));
    direction.addScaledVector(frame.right, Math.sin(angle) * distance / this.radiusAt(originPoint));
    const position = surfacePoint(direction, this.radiusAt, this.projectSurface);
    const rootFrame = tangentFrame(position, frame.forward);
    root.position.copy(position);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(rootFrame.up, rootFrame.forward).normalize(), rootFrame.up, rootFrame.forward,
    ));
    const entry = {
      root, role, position, target: position.clone(), heading: frame.forward,
      retarget: random() * 2, reactionCooldown: 0, actionUntil: 0,
      repairAt: 4 + random() * 8, random: seeded(hash(`${role.id}:motion`)),
      courierEligible: role.role === 'ambient' && role.index % 3 === 0,
      courierPhase: 'idle', courierCooldown: 3 + random() * 7, courier: null, cargoMesh: null,
      footOffset: 0, restFootOffset: 0, carryArms: [],
    };
    const modelScale = root.userData.fallbackRobot ? 1 : ROBOT_SCALE;
    for (const [name, angle] of [['LeftArm', 2.55], ['RightArm', -2.55]]) {
      const arm = root.getObjectByName(name);
      if (arm) entry.carryArms.push({
        arm, rest: arm.quaternion.clone(),
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle),
      });
    }
    entry.restFootOffset = lowestModelY(root) * root.scale.y;
    entry.footOffset = entry.restFootOffset;
    entry.position.copy(this.robotSurfacePoint(entry, direction));
    entry.target.copy(entry.position);
    root.position.copy(entry.position);
    if (this.greetingMaterial) {
      const greeting = new THREE.Sprite(this.greetingMaterial);
      greeting.position.set(0, 1 / modelScale, 0);
      greeting.scale.set(1.25 / (3 * modelScale), .55 / (3 * modelScale), 1);
      greeting.visible = false;
      greeting.userData.sharedRobotGreetingMaterial = true;
      root.add(greeting);
      entry.greetingSprite = greeting;
    }
    const cargo = new THREE.Mesh(new THREE.OctahedronGeometry(.10, 0), new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0x101010, roughness: .72, flatShading: true,
    }));
    cargo.position.set(0, (root.userData.fallbackRobot ? .75 : .343) / modelScale, 0);
    cargo.scale.setScalar(1 / modelScale);
    cargo.visible = false;
    cargo.userData.robotCargo = true;
    root.add(cargo);
    entry.cargoMesh = cargo;
    if (role.role === 'builder') {
      entry.target = this.pickTarget(entry);
      entry.retarget = 10;
    }
    return entry;
  }

  reconcile() {
    if (this.disposed) return;
    const roles = allocateRobotRoles(this.sites, this.ambientCount, this.maxCount);
    const wanted = new Set(roles.map(role => role.id));
    for (const [id, entry] of this.entries) if (!wanted.has(id)) {
      if (entry.role.role === 'builder') {
        this.entries.delete(id);
        entry.role = { ...entry.role, id: `returned-${id}`, role: 'ambient', siteId: null, returned: true };
        entry.target = entry.position.clone();
        this.entries.set(entry.role.id, entry);
      } else if (!entry.role.returned) {
        removeRobot(entry);
        this.entries.delete(id);
      }
    }
    for (const role of roles) if (!this.entries.has(role.id)) {
      const returned = role.role === 'builder' ? [...this.entries.values()].find(entry => entry.role.returned) : null;
      if (returned) {
        this.entries.delete(returned.role.id);
        returned.role = role;
        returned.target = this.pickTarget(returned);
        this.entries.set(role.id, returned);
      } else if (this.entries.size < this.maxCount) this.entries.set(role.id, this.create(role));
    }
  }

  siteFor(entry) { return this.sites.find(site => constructionSiteId(site) === entry.role.siteId); }

  pickTarget(entry) {
    const origin = (this.baseOrigin || this.origin).clone().normalize();
    const frame = tangentFrame(this.baseOrigin || this.origin, entry.heading);
    if (entry.role.role === 'builder') {
      const site = this.siteFor(entry);
      const center = site?.position || site?.center;
      if (center) {
        const direction = (center.isVector3 ? center.clone() : new THREE.Vector3().fromArray(center)).normalize();
        const siteFrame = tangentFrame(direction, new THREE.Vector3(0, 0, -1));
        const angle = entry.role.index * TAU / BUILDERS_PER_SITE;
        const siteRadius = this.radiusAt(direction);
        direction.addScaledVector(siteFrame.forward, Math.cos(angle) * BUILDER_STANDOFF / siteRadius);
        direction.addScaledVector(siteFrame.right, Math.sin(angle) * BUILDER_STANDOFF / siteRadius);
        direction.normalize();
        return this.robotSurfacePoint(entry, direction);
      }
    }
    const nearby = this.buildings.find(building => building.position);
    if (entry.role.role === 'ambient' && nearby && entry.random() < .45) {
      const buildingPosition = nearby.position.isVector3 ? nearby.position.clone() : new THREE.Vector3().fromArray(nearby.position);
      const toward = buildingPosition.normalize().addScaledVector(origin, -buildingPosition.dot(origin));
      if (toward.lengthSq() > 1e-8) return this.robotSurfacePoint(entry,
        origin.clone().addScaledVector(toward.normalize(), (1.5 + entry.random() * 2) / this.radiusAt(this.baseOrigin || this.origin)));
    }
    const angle = entry.random() * TAU;
    const distance = 2 + entry.random() * (HUB_ROAM_RADIUS - 2);
    const baseRadius = this.radiusAt(this.baseOrigin || this.origin);
    const direction = origin.clone().addScaledVector(frame.forward, Math.cos(angle) * distance / baseRadius)
      .addScaledVector(frame.right, Math.sin(angle) * distance / baseRadius);
    return this.robotSurfacePoint(entry, direction);
  }

  robotSurfacePoint(entry, direction) {
    const point = surfacePoint(direction, this.radiusAt, this.projectSurface);
    return point.addScaledVector(point.clone().normalize(), -entry.footOffset);
  }

  groundRobot(entry, animationState) {
    // Jump raises the animated body above its foot contacts; shifting the root
    // to align the temporarily lifted bounds would cancel that jump.
    if (animationState === 'jump') return;
    entry.footOffset = lowestModelY(entry.root) * entry.root.scale.y;
    const normal = entry.position.clone().normalize();
    entry.position.copy(this.robotSurfacePoint(entry, normal));
    entry.root.position.copy(entry.position);
  }

  setCarryPose(entry, carrying) {
    for (const { arm, rest, rotation } of entry.carryArms) {
      if (carrying) arm.quaternion.copy(rest).multiply(rotation);
      else arm.quaternion.copy(rest);
    }
  }

  animate(entry, state, dt) {
    if (this.models?.animate && !entry.root.userData.fallbackRobot) this.models.animate(entry.root, state, dt);
    else if (entry.root.userData.fallbackRobot) entry.root.rotation.y += dt * (state === 'walk' ? 1 : 0);
    const carrying = ['returning', 'unloading'].includes(entry.courierPhase) && entry.cargoMesh.visible;
    if (carrying && entry.carryArms.length) this.setCarryPose(entry, true);
    this.groundRobot(entry, state);
  }

  startCourier(entry) {
    if (!this.deposits.length || !this.homePosition) return false;
    const deposit = this.deposits[Math.floor(entry.random() * this.deposits.length)];
    entry.courier = {
      resource: deposit.resource, color: deposit.color,
      deposit: this.robotSurfacePoint(entry, deposit.point),
      home: this.robotSurfacePoint(entry, this.homePosition),
    };
    entry.courierPhase = 'outbound';
    if (entry.greetingSprite) entry.greetingSprite.visible = false;
    entry.target.copy(entry.courier.deposit);
    return true;
  }

  moveTowardTarget(entry, dt, speed) {
    const targetDirection = entry.target.clone().normalize();
    const currentDirection = entry.position.clone().normalize();
    const axis = new THREE.Vector3().crossVectors(currentDirection, targetDirection);
    const angle = currentDirection.angleTo(targetDirection);
    const step = Math.min(angle, speed * dt / Math.max(1, this.radiusAt(entry.position)));
    if (axis.lengthSq() > 1e-10 && step > 0) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), step);
      currentDirection.applyQuaternion(rotation).normalize();
      entry.heading.applyQuaternion(rotation).normalize();
    }
    entry.position.copy(this.robotSurfacePoint(entry, currentDirection));
    const desiredHeading = targetDirection.clone().addScaledVector(currentDirection, -targetDirection.dot(currentDirection));
    if (desiredHeading.lengthSq() > 1e-8) entry.heading.lerp(desiredHeading.normalize(), Math.min(1, dt * 5)).normalize();
    entry.root.position.copy(entry.position);
    orientRobot(entry);
    return entry.position.distanceTo(entry.target);
  }

  updateCourier(entry, dt) {
    if (!entry.courierEligible) return false;
    if (entry.courierPhase === 'idle') {
      entry.courierCooldown -= dt;
      if (entry.courierCooldown > 0 || !this.startCourier(entry)) return false;
    }
    if (entry.greetingSprite) entry.greetingSprite.visible = false;
    if (entry.courierPhase === 'unloading') {
      if (this.now >= entry.courierUntil) {
        entry.cargoMesh.visible = false;
        entry.courier = null;
        entry.courierPhase = 'idle';
        this.setCarryPose(entry, false);
        entry.courierCooldown = 5 + entry.random() * 7;
        entry.target = this.pickTarget(entry);
      }
      this.animate(entry, 'idle', dt);
      return true;
    }
    const distance = this.moveTowardTarget(entry, dt, entry.courierPhase === 'returning' ? .45 : 1.1);
    if (distance < .4) {
      if (entry.courierPhase === 'outbound') {
        entry.cargoMesh.material.color.setHex(entry.courier.color);
        entry.cargoMesh.material.emissive.setHex(entry.courier.color).multiplyScalar(.16);
        entry.cargoMesh.visible = true;
        entry.courierPhase = 'returning';
        entry.target.copy(entry.courier.home);
      } else if (entry.courierPhase === 'returning') {
        entry.courierPhase = 'unloading';
        entry.courierUntil = this.now + .7;
      }
    }
    // A courier is occupied for the whole trip and unload. It cannot wave,
    // jump, inspect buildings, repair, or switch to another task mid-route.
    this.animate(entry, 'walk', dt);
    return true;
  }

  interact(raycaster, maxDistance = Infinity) {
    if (!raycaster?.intersectObjects) return false;
    const candidates = [...this.entries.values()].filter(entry => entry.root.visible
      && !['outbound', 'returning', 'unloading'].includes(entry.courierPhase));
    if (!candidates.length) return false;
    const roots = candidates.map(entry => entry.root);
    const rootEntries = new Map(candidates.map(entry => [entry.root, entry]));
    const hits = raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      if (hit.distance > maxDistance) continue;
      let object = hit.object;
      while (object && !rootEntries.has(object)) object = object.parent;
      const entry = rootEntries.get(object);
      if (!entry) continue;
      if (entry.action === 'build' && entry.actionUntil > this.now) return true;
      entry.action = entry.random() < .5 ? 'wave' : 'jump';
      entry.actionUntil = this.now + (entry.action === 'jump' ? 1.4 : 2.2);
      entry.reactionCooldown = REACTION_COOLDOWN;
      entry.greetingUntil = entry.action === 'wave' ? this.now + 2 : 0;
      if (entry.greetingSprite) entry.greetingSprite.visible = entry.action === 'wave';
      return true;
    }
    return false;
  }

  update(dt) {
    if (this.disposed) return;
    this.now += Math.max(0, Math.min(.1, dt));
    const playerPositions = this.players.map(player => player.position).filter(Boolean)
      .map(position => position.isVector3 ? position : new THREE.Vector3().fromArray(position));
    for (const entry of this.entries.values()) {
      if (this.updateCourier(entry, dt)) continue;
      entry.reactionCooldown = Math.max(0, entry.reactionCooldown - dt);
      if (entry.actionUntil > this.now) {
        if (entry.action === 'build') {
          const site = this.siteFor(entry);
          const center = site?.position || site?.center;
          if (center) faceDirection(entry, (center.isVector3 ? center.clone() : new THREE.Vector3().fromArray(center)).sub(entry.position));
        } else if (entry.action === 'wave' || entry.action === 'jump') {
          if (entry.action === 'wave' && entry.greetingSprite) {
            entry.greetingSprite.visible = this.now < entry.greetingUntil;
          }
          const player = playerPositions.reduce((closest, position) => !closest || position.distanceTo(entry.position) < closest.distanceTo(entry.position) ? position : closest, null);
          if (player) faceDirection(entry, player.clone().sub(entry.position));
        }
        this.animate(entry, entry.action, dt);
        continue;
      }
      const playerNearby = entry.role.role === 'ambient' && playerPositions.some(position => position.distanceTo(entry.position) <= PLAYER_REACT_RADIUS);
      if (playerNearby && entry.reactionCooldown <= 0 && entry.random() < .018) {
        entry.action = entry.random() < .5 ? 'wave' : 'jump';
        entry.actionUntil = this.now + (entry.action === 'jump' ? 1.4 : 2.2);
        entry.reactionCooldown = REACTION_COOLDOWN;
        entry.greetingUntil = entry.action === 'wave' ? this.now + 2 : 0;
        if (entry.greetingSprite) entry.greetingSprite.visible = entry.action === 'wave';
        this.animate(entry, entry.action, dt);
        continue;
      }
      if (entry.greetingSprite && (entry.action !== 'wave' || this.now >= entry.greetingUntil)) {
        entry.greetingSprite.visible = false;
      }
      entry.retarget -= dt;
      if (entry.retarget <= 0 || entry.position.distanceTo(entry.target) < .35) {
        entry.target = this.pickTarget(entry);
        entry.retarget = 2 + entry.random() * 4;
      }
      this.moveTowardTarget(entry, dt, entry.role.role === 'builder' ? 1.2 : .8);
      const isBuilder = entry.role.role === 'builder';
      const site = isBuilder ? this.siteFor(entry) : null;
      const building = this.buildings.find(item => item.position && entry.position.distanceTo(item.position.isVector3 ? item.position : new THREE.Vector3().fromArray(item.position)) < 2.5);
      if (isBuilder && site && site.construction_status === 'building' && entry.position.distanceTo(entry.target) < .6) {
        entry.action = 'build'; entry.actionUntil = this.now + 2.2;
        this.animate(entry, 'build', dt);
      }
      else if (!isBuilder && building) {
        entry.repairAt -= dt;
        if (entry.repairAt <= 0) {
          entry.repairAt = 5 + entry.random() * 8;
          entry.action = 'build'; entry.actionUntil = this.now + 2.2;
          this.animate(entry, 'build', dt);
        }
        else this.animate(entry, entry.position.distanceTo(entry.target) > .4 ? 'walk' : 'idle', dt);
      } else this.animate(entry, entry.position.distanceTo(entry.target) > .4 ? 'walk' : 'idle', dt);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) removeRobot(entry);
    this.entries.clear();
    this.greetingMaterial?.dispose();
    this.greetingTexture?.dispose();
  }
}
