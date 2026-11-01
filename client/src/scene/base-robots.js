import * as THREE from 'three';

const AMBIENT_COUNT = 9;
const BUILDERS_PER_SITE = 3;
const MAX_ROBOTS = 30;
const PLAYER_REACT_RADIUS = 8;
const REACTION_COOLDOWN = 8;
const TAU = Math.PI * 2;
const ROBOT_SCALE = .14;
const BUILDER_STANDOFF = 1.35;

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

function surfacePoint(direction, radiusAt, projectSurface, offset = 0) {
  const normal = direction.clone().normalize();
  if (projectSurface) {
    const point = projectSurface(normal.clone());
    return (point?.isVector3 ? point : normal.clone().multiplyScalar(radiusAt(normal))).addScaledVector(normal, offset);
  }
  return normal.multiplyScalar(radiusAt(normal) + offset);
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

function removeRobot(entry) {
  const animation = entry.root.userData.animation;
  animation?.mixer.stopAllAction();
  animation?.mixer.uncacheRoot(entry.root);
  entry.root.removeFromParent();
  if (entry.root.userData.fallbackRobot) {
    entry.root.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
  } else {
    entry.root.traverse(node => {
      if (node.isSkinnedMesh) node.skeleton?.dispose();
      for (const material of [node.material].flat().filter(Boolean)) material.dispose();
    });
  }
}

/** Decorative, local-only robot crowd. It never reads or mutates gameplay resources. */
export class BaseRobots {
  constructor(scene, models, { radiusAt = null, projectSurface = null, seed = 91823, ambientCount = AMBIENT_COUNT, maxCount = MAX_ROBOTS } = {}) {
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
    this.origin = new THREE.Vector3(0, 100, 0);
    this.baseOrigin = null;
    this.now = 0;
    this.disposed = false;
  }

  setState({ position, buildings = [], players = [], constructionSites = [] } = {}) {
    if (position) {
      this.origin.copy(position.isVector3 ? position : new THREE.Vector3().fromArray(position));
      this.baseOrigin ||= this.origin.clone();
    }
    this.buildings = buildings;
    this.players = players;
    this.sites = constructionSites.length ? constructionSites : buildings.filter(building =>
      ['planned', 'building'].includes(building.construction_status) || building.is_construction_site === true || building.status === 'constructing' || building.state === 'constructing' ||
      building.building_type === 'construction_site' || building.building_type === 'construction-site');
    this.reconcile();
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
    const distance = role.role === 'builder' ? 1.5 + random() * 1.2 : 4 + random() * 9;
    direction.addScaledVector(frame.forward, Math.cos(angle) * distance / this.radiusAt(originPoint));
    direction.addScaledVector(frame.right, Math.sin(angle) * distance / this.radiusAt(originPoint));
    const position = surfacePoint(direction, this.radiusAt, this.projectSurface, .08);
    const rootFrame = tangentFrame(position, frame.forward);
    root.position.copy(position);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(rootFrame.up, rootFrame.forward).normalize(), rootFrame.up, rootFrame.forward,
    ));
    const entry = {
      root, role, position, target: position.clone(), heading: frame.forward,
      retarget: random() * 2, reactionCooldown: 0, actionUntil: 0,
      repairAt: 4 + random() * 8, random: seeded(hash(`${role.id}:motion`)),
    };
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
        return surfacePoint(direction, this.radiusAt, this.projectSurface, .08);
      }
    }
    const nearby = this.buildings.find(building => building.position);
    if (entry.role.role === 'ambient' && nearby && entry.random() < .45) {
      const buildingPosition = nearby.position.isVector3 ? nearby.position.clone() : new THREE.Vector3().fromArray(nearby.position);
      const toward = buildingPosition.normalize().addScaledVector(origin, -buildingPosition.dot(origin));
      if (toward.lengthSq() > 1e-8) return surfacePoint(origin.clone().addScaledVector(toward.normalize(), (1.5 + entry.random() * 2) / this.radiusAt(this.baseOrigin || this.origin)), this.radiusAt, this.projectSurface, .08);
    }
    const angle = entry.random() * TAU;
    const distance = 2 + entry.random() * 7;
    const baseRadius = this.radiusAt(this.baseOrigin || this.origin);
    const direction = origin.clone().addScaledVector(frame.forward, Math.cos(angle) * distance / baseRadius)
      .addScaledVector(frame.right, Math.sin(angle) * distance / baseRadius);
    return surfacePoint(direction, this.radiusAt, this.projectSurface, .08);
  }

  animate(entry, state, dt) {
    if (this.models?.animate && !entry.root.userData.fallbackRobot) this.models.animate(entry.root, state, dt);
    else if (entry.root.userData.fallbackRobot) entry.root.rotation.y += dt * (state === 'walk' ? 1 : 0);
  }

  update(dt) {
    if (this.disposed) return;
    this.now += Math.max(0, Math.min(.1, dt));
    const playerPositions = this.players.map(player => player.position).filter(Boolean)
      .map(position => position.isVector3 ? position : new THREE.Vector3().fromArray(position));
    for (const entry of this.entries.values()) {
      const { up, forward } = tangentFrame(entry.position, entry.heading);
      entry.reactionCooldown = Math.max(0, entry.reactionCooldown - dt);
      if (entry.actionUntil > this.now) {
        if (entry.action === 'build') {
          const site = this.siteFor(entry);
          const center = site?.position || site?.center;
          if (center) faceDirection(entry, (center.isVector3 ? center.clone() : new THREE.Vector3().fromArray(center)).sub(entry.position));
        } else if (entry.action === 'wave' || entry.action === 'jump') {
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
        this.animate(entry, entry.action, dt);
        continue;
      }
      entry.retarget -= dt;
      if (entry.retarget <= 0 || entry.position.distanceTo(entry.target) < .35) {
        entry.target = this.pickTarget(entry);
        entry.retarget = 2 + entry.random() * 4;
      }
      const targetDirection = entry.target.clone().normalize();
      const currentDirection = entry.position.clone().normalize();
      const axis = new THREE.Vector3().crossVectors(currentDirection, targetDirection);
      const angle = currentDirection.angleTo(targetDirection);
      const step = Math.min(angle, (entry.role.role === 'builder' ? 1.2 : .8) * dt / Math.max(1, this.radiusAt(entry.position)));
      if (axis.lengthSq() > 1e-10 && step > 0) {
        const rotation = new THREE.Quaternion().setFromAxisAngle(axis.normalize(), step);
        currentDirection.applyQuaternion(rotation).normalize();
        entry.heading.applyQuaternion(rotation).normalize();
      }
      entry.position.copy(surfacePoint(currentDirection, this.radiusAt, this.projectSurface, .08));
      const frame = tangentFrame(entry.position, entry.heading);
      const desiredHeading = targetDirection.clone().addScaledVector(currentDirection, -targetDirection.dot(currentDirection));
      if (desiredHeading.lengthSq() > 1e-8) entry.heading.lerp(desiredHeading.normalize(), Math.min(1, dt * 5)).normalize();
      entry.root.position.copy(entry.position);
      orientRobot(entry);
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
  }
}
