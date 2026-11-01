import * as THREE from 'three';
import { surfaceDistance } from './motion.js';

const COLLISION_EPSILON = 1e-6;
const GROUND_EPSILON = 1e-5;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function centerOf(shape) {
  return shape.center?.isVector3 ? shape.center : new THREE.Vector3().fromArray(shape.center);
}

function unitVector(value, fallback) {
  return value?.isVector3 ? value.clone().normalize() : value ? new THREE.Vector3().fromArray(value).normalize() : fallback.clone();
}

function footprintCoordinates(shape, point, planetRadius) {
  const center = centerOf(shape).normalize();
  const radial = point.clone().normalize();
  const delta = radial.sub(center).multiplyScalar(planetRadius);
  const reference = Math.abs(center.y) < .9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const fallbackX = reference.clone().cross(center).normalize();
  const fallbackZ = center.clone().cross(fallbackX).normalize();
  const hasFrame = shape.axis_x != null && shape.axis_z != null;
  const axisX = hasFrame ? unitVector(shape.axis_x, fallbackX) : fallbackX;
  const axisZ = hasFrame ? unitVector(shape.axis_z, fallbackZ) : fallbackZ;
  return { x: delta.dot(axisX), z: delta.dot(axisZ), axisX, axisZ };
}

/** Signed footprint distance before expanding by the player's radius. */
export function footprintDistance(shape, point, planetRadius) {
  const { x, z } = footprintCoordinates(shape, point, planetRadius);
  if (shape.kind !== 'box' && shape.axis_x == null) return surfaceDistance(centerOf(shape), point, planetRadius) - shape.radius;
  if (shape.kind === 'box') {
    const qx = Math.abs(x) - shape.half_x, qz = Math.abs(z) - shape.half_z;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
  }
  return Math.hypot(x, z) - shape.radius;
}

function footprintWallNormal(shape, point, planetRadius) {
  const { x, z, axisX, axisZ } = footprintCoordinates(shape, point, planetRadius);
  let nx, nz;
  if (shape.kind === 'box') {
    const qx = Math.abs(x) - shape.half_x, qz = Math.abs(z) - shape.half_z;
    const dx = Math.max(qx, 0), dz = Math.max(qz, 0), outside = Math.hypot(dx, dz);
    if (outside > 1e-12) {
      nx = Math.sign(x || 1) * dx / outside;
      nz = Math.sign(z || 1) * dz / outside;
    } else if (qx >= qz) {
      nx = Math.sign(x || 1); nz = 0;
    } else {
      nx = 0; nz = Math.sign(z || 1);
    }
  } else {
    const length = Math.hypot(x, z);
    nx = length > 1e-12 ? x / length : 1;
    nz = length > 1e-12 ? z / length : 0;
  }
  return axisX.multiplyScalar(nx).addScaledVector(axisZ, nz).normalize();
}

function moveOnSurface(position, direction, distance, radius) {
  const normal = position.clone().normalize();
  const tangent = direction.clone().addScaledVector(normal, -direction.dot(normal));
  const magnitude = tangent.length();
  if (magnitude < 1e-12) return position.clone();
  return normal.multiplyScalar(radius).addScaledVector(tangent.normalize(), distance * Math.min(1, magnitude))
    .normalize().multiplyScalar(radius);
}

function overlaps(shape, point, feet, planetRadius, playerRadius, playerHeight) {
  return footprintDistance(shape, point, planetRadius) < playerRadius - COLLISION_EPSILON &&
    feet < shape.top - COLLISION_EPSILON && feet + playerHeight > shape.bottom + COLLISION_EPSILON;
}

function hasHeadClearance(shapes, point, feet, planetRadius, playerRadius, playerHeight) {
  const head = feet + playerHeight;
  return !shapes.some(shape => footprintDistance(shape, point, planetRadius) < playerRadius - COLLISION_EPSILON &&
    head > shape.bottom + COLLISION_EPSILON && feet < shape.top - COLLISION_EPSILON);
}

/** Mirror of server/app/game/collision.py::resolve_player_motion. */
export function resolveBuildingMotion(position, altitude, verticalSpeed, move, distance, dtSeconds, planetRadius,
  groundRadius, shapes, { grounded, supportBuildingId = null, supportSurfaceId = null,
    playerRadius = .2, playerHeight = .6, stepHeight = .3, gravity = 5.5 } = {}) {
  const ordered = [...(shapes || [])].sort((a, b) => compareText(String(a.building_id), String(b.building_id)) ||
    compareText(String(a.surface_id), String(b.surface_id)));
  let support = ordered.find(shape => shape.building_id === supportBuildingId && shape.surface_id === supportSurfaceId) || null;
  if (!support) supportBuildingId = supportSurfaceId = null;
  else {
    const feet = groundRadius(position) + altitude;
    const supported = footprintDistance(support, position, planetRadius) < playerRadius - COLLISION_EPSILON &&
      feet + playerHeight > support.bottom + COLLISION_EPSILON;
    if (Math.abs(feet - support.top) > .04 || !supported) {
      support = null;
      supportBuildingId = supportSurfaceId = null;
    }
  }
  grounded = !!grounded && (altitude <= GROUND_EPSILON || support !== null);
  const oldAltitude = altitude;
  const oldVerticalSpeed = verticalSpeed;
  if (grounded && oldVerticalSpeed <= 0) {
    verticalSpeed = 0;
    if (support) altitude = Math.max(0, support.top - groundRadius(position));
  } else {
    verticalSpeed = oldVerticalSpeed - gravity * dtSeconds;
    altitude = Math.max(0, oldAltitude + verticalSpeed * dtSeconds);
    if (altitude === 0) {
      verticalSpeed = 0;
      supportBuildingId = supportSurfaceId = null;
    }
  }

  const oldFeet = groundRadius(position) + oldAltitude;
  const newFeet = groundRadius(position) + altitude;
  if (oldVerticalSpeed > 0 && newFeet > oldFeet) {
    const ceilings = ordered.filter(shape => footprintDistance(shape, position, planetRadius) < playerRadius &&
      oldFeet + playerHeight <= shape.bottom + COLLISION_EPSILON && newFeet + playerHeight > shape.bottom);
    if (ceilings.length) {
      const ceiling = ceilings.sort((a, b) => a.bottom - b.bottom || compareText(String(a.building_id), String(b.building_id)) ||
        compareText(String(a.surface_id), String(b.surface_id)))[0];
      altitude = Math.max(0, ceiling.bottom - playerHeight - groundRadius(position));
      verticalSpeed = 0;
    }
  }

  let startFeet = groundRadius(position) + oldAltitude;
  const descent = oldVerticalSpeed <= 0 && !(grounded && oldVerticalSpeed <= 0);
  const steps = Math.max(1, Math.ceil(Math.max(0, distance) / .05));
  const subdistance = Math.max(0, distance) / steps;
  let current = position.clone();
  for (let i = 0; i < steps; i++) {
    let candidate = moveOnSurface(current, move, subdistance, planetRadius);
    candidate.setLength(groundRadius(candidate));
    if (grounded && oldVerticalSpeed <= 0 && support) {
      if (footprintDistance(support, candidate, planetRadius) < playerRadius - COLLISION_EPSILON) {
        altitude = Math.max(0, support.top - groundRadius(candidate));
      } else {
        supportBuildingId = supportSurfaceId = null;
        support = null;
      }
    }
    let feet = groundRadius(candidate) + altitude;
    if (descent) {
      const crossed = ordered.filter(shape => footprintDistance(shape, candidate, planetRadius) < playerRadius &&
        startFeet >= shape.top - COLLISION_EPSILON && feet <= shape.top + COLLISION_EPSILON && shape.bottom < shape.top);
      if (crossed.length) {
        const landing = crossed.sort((a, b) => b.top - a.top || compareText(b.building_id, a.building_id) ||
          compareText(b.surface_id, a.surface_id))[0];
        altitude = Math.max(0, landing.top - groundRadius(candidate));
        verticalSpeed = 0;
        supportBuildingId = landing.building_id;
        supportSurfaceId = landing.surface_id;
        feet = landing.top;
      }
    }
    let collisions = ordered.filter(shape => overlaps(shape, candidate, feet, planetRadius, playerRadius, playerHeight));
    if (!collisions.length) {
      current.copy(candidate);
      startFeet = feet;
      continue;
    }
    if (grounded && oldVerticalSpeed <= 0) {
      const stepCandidates = collisions.filter(shape => -COLLISION_EPSILON <= shape.top - startFeet &&
        shape.top - startFeet <= stepHeight + COLLISION_EPSILON)
        .sort((a, b) => a.top - b.top || compareText(String(a.building_id), String(b.building_id)) ||
          compareText(String(a.surface_id), String(b.surface_id)));
      for (const shape of stepCandidates) {
        if (hasHeadClearance(ordered, candidate, shape.top, planetRadius, playerRadius, playerHeight)) {
          altitude = Math.max(0, shape.top - groundRadius(candidate));
          verticalSpeed = 0;
          supportBuildingId = shape.building_id;
          supportSurfaceId = shape.surface_id;
          current.copy(candidate);
          startFeet = shape.top;
          collisions = [];
          break;
        }
      }
    }
    if (!collisions.length) continue;

    let blocker = null;
    const currentFeet = groundRadius(current) + altitude;
    for (const shape of collisions) {
      const startGap = footprintDistance(shape, current, planetRadius);
      const endGap = footprintDistance(shape, candidate, planetRadius);
      const penetrating = overlaps(shape, current, currentFeet, planetRadius, playerRadius, playerHeight);
      if (!penetrating || endGap <= startGap + COLLISION_EPSILON) { blocker = shape; break; }
    }
    if (blocker === null) {
      current.copy(candidate);
      startFeet = feet;
      continue;
    }
    const here = current.clone().normalize();
    const toward = footprintWallNormal(blocker, current, planetRadius).addScaledVector(here,
      -footprintWallNormal(blocker, current, planetRadius).dot(here));
    const desired = move.clone().addScaledVector(here, -move.dot(here));
    if (toward.lengthSq() > 1e-12) {
      toward.normalize();
      const slide = desired.addScaledVector(toward, -desired.dot(toward));
      if (slide.lengthSq() > 1e-12) {
        let slid = moveOnSurface(current, slide, subdistance, planetRadius);
        slid.setLength(groundRadius(slid));
        const slideFeet = groundRadius(slid) + altitude;
        if (!ordered.some(shape => overlaps(shape, slid, slideFeet, planetRadius, playerRadius, playerHeight))) {
          current.copy(slid);
          startFeet = slideFeet;
        }
      }
    }
  }
  if (supportBuildingId !== null) {
    const supportShape = ordered.find(shape => shape.building_id === supportBuildingId && shape.surface_id === supportSurfaceId);
    if (!supportShape || footprintDistance(supportShape, current, planetRadius) >= playerRadius) {
      supportBuildingId = supportSurfaceId = null;
    }
  }
  current.setLength(groundRadius(current) + altitude);
  return { position: current, altitude, verticalSpeed, supportBuildingId, supportSurfaceId };
}
