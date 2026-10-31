import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSolarState } from '../src/scene/atmosphere.js';

test('solar state repeats exactly after the shared cycle period', () => {
  const up = { x: 0.3, y: 0.8, z: -0.5 };
  const a = computeSolarState(127.25, 600, up);
  const b = computeSolarState(727.25, 600, up);
  assert.deepEqual(b, a);
});

test('sun direction is normalized and local daylight follows surface orientation', () => {
  const daySide = computeSolarState(0, 600, { x: 0, y: -1, z: 0 });
  const nightSide = computeSolarState(0, 600, { x: 0, y: 1, z: 0 });
  assert.ok(Math.abs(Math.hypot(...daySide.direction) - 1) < 1e-12);
  assert.equal(daySide.daylight, 1);
  assert.equal(nightSide.daylight, 0);
  assert.equal(daySide.night, 0);
  assert.equal(nightSide.night, 1);
});
