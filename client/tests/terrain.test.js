import test from 'node:test';
import assert from 'node:assert/strict';
import { terrainHeight, projectTerrain } from '../src/scene/terrain.js';

test('terrain relief matches server reference samples', () => {
  const samples = [
    [[1, 0, 0], 0.1286716363369052],
    [[0, 1, 0], 0.02116018504766136],
    [[0, 0, 1], 0.022613102430665194],
    [[.3, .4, .5], 0.12055212633029176],
    [[-.8, .1, .2], -0.4916172493828303],
  ];
  for (const [point, expected] of samples) assert.ok(Math.abs(terrainHeight(...point)-expected) < 1e-12);
});

test('terrain relief has bounded height and slopes across the sphere', () => {
  let maxHeight = 0, maxSlope = 0;
  const count = 1000, step = .004, golden = (Math.sqrt(5)-1)/2;
  for (let i=0; i<count; i++) {
    const y = 1-2*(i+.5)/count, r = Math.sqrt(1-y*y), a = 2*Math.PI*i*golden;
    const x = r*Math.cos(a), z = r*Math.sin(a), h = terrainHeight(x,y,z);
    const x2 = x*Math.cos(step)+z*Math.sin(step), z2 = -x*Math.sin(step)+z*Math.cos(step);
    maxHeight = Math.max(maxHeight, Math.abs(h));
    maxSlope = Math.max(maxSlope, Math.abs(terrainHeight(x2,y,z2)-h)/(20*step));
  }
  assert.ok(maxHeight < 3.0, `height ${maxHeight}m exceeds build-friendly bound`);
  assert.ok(maxSlope < .85, `slope ${maxSlope} exceeds build-friendly bound`);
});

test('terrain projection preserves radial offset and disabled mode', () => {
  const point = {x: 1, y: 0, z: 0, normalize() { return this; }, multiplyScalar(s) { this.x*=s; this.y*=s; this.z*=s; return this; }};
  assert.equal(projectTerrain(point, 30, .25).x, 30.25 + terrainHeight(1,0,0));
  const flat = {x: 1, y: 0, z: 0, normalize() { return this; }, multiplyScalar(s) { this.x*=s; this.y*=s; this.z*=s; return this; }};
  assert.equal(projectTerrain(flat, 30, .25, false).x, 30.25);
});
