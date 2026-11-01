import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayerFlashlight, updatePlayerFlashlight } from '../src/scene/player-flashlight.js';
import { EYE_HEIGHT } from '../src/scene/character-scale.js';

test('remote flashlight follows spherical heading and pitch, and respects off/visibility states', () => {
  const actor = new THREE.Group();
  actor.position.set(0, 10, 0);
  actor.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3);
  const flashlight = createPlayerFlashlight(actor);
  const sample = { position: new THREE.Vector3(0, 10, 0), heading: new THREE.Vector3(1, 0, 0) };

  updatePlayerFlashlight(flashlight, sample, 0, true, true);
  const origin = new THREE.Vector3(), target = new THREE.Vector3();
  flashlight.light.getWorldPosition(origin);
  flashlight.target.getWorldPosition(target);
  const direction = target.sub(origin).normalize();
  assert.equal(flashlight.light.intensity, 17);
  assert.equal(flashlight.light.distance, 37.4);
  assert.ok(Math.abs(origin.y - (10 + EYE_HEIGHT)) < 1e-8);
  assert.ok(direction.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8);

  updatePlayerFlashlight(flashlight, sample, Math.PI / 6, true, true);
  flashlight.light.getWorldPosition(origin);
  flashlight.target.getWorldPosition(target);
  const pitched = target.sub(origin).normalize();
  assert.ok(Math.abs(pitched.x - Math.cos(Math.PI / 6)) < 1e-8);
  assert.ok(Math.abs(pitched.y - Math.sin(Math.PI / 6)) < 1e-8);

  updatePlayerFlashlight(flashlight, sample, 0, false, true);
  assert.equal(flashlight.light.intensity, 0);
  assert.equal(flashlight.light.visible, true);
  updatePlayerFlashlight(flashlight, sample, 0, true, false);
  assert.equal(flashlight.light.visible, false);
  updatePlayerFlashlight(flashlight, null, 0, true, true);
  assert.equal(flashlight.light.intensity, 0);
  assert.equal(flashlight.light.visible, false);
  flashlight.light.parent.remove(flashlight.light, flashlight.target);
});
