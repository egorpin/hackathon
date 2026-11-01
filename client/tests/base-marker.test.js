import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBaseMarker, updateBaseMarker } from '../src/scene/base-marker.js';

test('base marker uses its owner color and appears only on the top map', () => {
  const marker = createBaseMarker(20);
  const position = [0, 20, 0];
  assert.equal(updateBaseMarker(marker, { building_type: 'dome_base', color: '#42d6a4' }, position, 'first', 20, false), false);
  assert.equal(marker.visible, false);
  assert.equal(updateBaseMarker(marker, { building_type: 'dome_base', color: '#42d6a4' }, position, 'top', 20, false), true);
  assert.equal(marker.visible, true);
  assert.equal(marker.material.color.getHexString(), '42d6a4');
  assert.ok(Math.abs(marker.position.length() - 20.3) < 1e-8);
  updateBaseMarker(marker, { building_type: 'dome_base', color: '#000000' }, position, 'top', 20, false);
  assert.equal(marker.material.color.getHexString(), '000000');
  assert.equal(updateBaseMarker(marker, { building_type: 'warehouse', color: '#ffffff' }, position, 'top', 20, false), false);
  assert.equal(marker.visible, false);
  marker.geometry.dispose();
  marker.material.dispose();
});
