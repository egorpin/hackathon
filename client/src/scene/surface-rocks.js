import * as THREE from 'three';
import { projectTerrain } from './terrain.js';

const up = new THREE.Vector3(0, 1, 0);
const tangentX = new THREE.Vector3();
const tangentZ = new THREE.Vector3();
const center = new THREE.Vector3();
const point = new THREE.Vector3();
const normal = new THREE.Vector3();
const vertex = new THREE.Vector3();
const edgeA = new THREE.Vector3();
const edgeB = new THREE.Vector3();
const edge = new THREE.Vector3();
const candidate = new THREE.Vector3();
const orient = new THREE.Quaternion();
const spin = new THREE.Quaternion();
const rotation = new THREE.Quaternion();
const transform = new THREE.Object3D();
const tint = new THREE.Color();

const ROCK_COLORS = [0x453a35, 0x51413a, 0x5b443a, 0x514c49, 0x62534b, 0x3e4140];

function hashSeed(seed, cellId) {
  let hash = 2166136261;
  const text = `${seed ?? 0}:${cellId ?? ''}`;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return hash >>> 0 || 0x9e3779b9;
}

function randomFrom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function cellInset(cell, center, xAxis, zAxis) {
  const vertices = cell.vertices;
  let inset = Infinity;
  for (let i = 0; i < vertices.length; i++) {
    const a = edgeA.fromArray(vertices[i]).sub(center);
    a.addScaledVector(center, -a.dot(center) / center.lengthSq());
    const b = edgeB.fromArray(vertices[(i + 1) % vertices.length]).sub(center);
    b.addScaledVector(center, -b.dot(center) / center.lengthSq());
    const ax = a.dot(xAxis), az = a.dot(zAxis);
    const bx = b.dot(xAxis), bz = b.dot(zAxis);
    const dx = bx - ax, dz = bz - az;
    const t = THREE.MathUtils.clamp(-(ax * dx + az * dz) / (dx * dx + dz * dz || 1), 0, 1);
    inset = Math.min(inset, Math.hypot(ax + dx * t, az + dz * t));
  }
  return inset;
}

/** Build visual regolith rocks for one streamed chunk. Geometry/material are shared per chunk. */
export function surfaceRocks(cells, { radius, terrain = false, seed = 0 } = {}) {
  const placements = [];

  for (const cell of cells || []) {
    if (cell.surface === 'landing' || cell.surface === 'mountain' || cell.resource) continue;
    if (!cell.center || !cell.vertices?.length) continue;

    center.fromArray(cell.center);
    normal.copy(center).normalize();
    // A stable local frame keeps the sampled disk circular and avoids pole seams.
    tangentX.set(1, 0, 0).addScaledVector(normal, -normal.x);
    if (tangentX.lengthSq() < 1e-8) tangentX.set(0, 0, 1).addScaledVector(normal, -normal.z);
    tangentX.normalize();
    tangentZ.crossVectors(normal, tangentX).normalize();
    const inset = cellInset(cell, center, tangentX, tangentZ);
    const usableRadius = Math.max(0, inset * 0.78 - 0.08);
    if (!Number.isFinite(usableRadius) || usableRadius < 0.14) continue;

    const random = randomFrom(hashSeed(seed, cell.cell_id));
    const count = 12 + Math.floor(random() * 13);
    const baseRadius = Number(radius) || center.length();
    orient.setFromUnitVectors(up, normal);
    for (let i = 0; i < count; i++) {
      // The tail of larger stones is rare; most sit in the attached-photo scale range.
      const diameter = random() < 0.035 ? 0.14 + random() * 0.06 : 0.025 + random() * 0.115;
      const flatten = 0.34 + random() * 0.24;
      const angle = random() * Math.PI * 2;
      const distance = Math.sqrt(random()) * usableRadius;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;

      point.copy(center).addScaledVector(tangentX, x).addScaledVector(tangentZ, z);
      projectTerrain(point, baseRadius, -.035, terrain);
      normal.copy(point).normalize();
      orient.setFromUnitVectors(up, normal);
      spin.setFromAxisAngle(up, random() * Math.PI * 2);
      rotation.copy(orient).multiply(spin);

      const height = diameter * 0.5 * flatten;
      const buried = 0.30 + random() * 0.20;
      candidate.copy(point).addScaledVector(normal, height * (1 - buried));
      transform.position.copy(candidate);
      transform.quaternion.copy(rotation);
      transform.scale.set(diameter * 0.5 * (0.78 + random() * 0.44), height, diameter * 0.5 * (0.72 + random() * 0.56));
      transform.updateMatrix();
      placements.push({ matrix: transform.matrix.clone(), color: ROCK_COLORS[Math.floor(random() * ROCK_COLORS.length)] });
    }
  }

  if (!placements.length) return new THREE.Group();
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0, flatShading: true });
  const rocks = new THREE.InstancedMesh(geometry, material, placements.length);
  rocks.name = 'surface-regolith-rocks';
  for (let i = 0; i < placements.length; i++) {
    rocks.setMatrixAt(i, placements[i].matrix);
    tint.setHex(placements[i].color);
    rocks.setColorAt(i, tint);
  }
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  return rocks;
}
