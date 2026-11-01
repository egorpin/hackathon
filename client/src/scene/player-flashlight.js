import * as THREE from 'three';
import { tangent } from './motion.js';
import { EYE_HEIGHT } from './character-scale.js';

const asVector = value => value?.isVector3 ? value.clone() : new THREE.Vector3().fromArray(value || [0, 0, 0]);

export function createPlayerFlashlight(group) {
  const light = new THREE.SpotLight(0xffe7d0, 0, 37.4, Math.PI / 7, .65, 1.5);
  const target = new THREE.Object3D();
  light.target = target;
  group.add(light, target);
  return { light, target };
}

/** Position a player's beam in world space while keeping the light under its actor group. */
export function updatePlayerFlashlight(flashlight, sample, pitch = 0, enabled = false, visible = true) {
  const { light, target } = flashlight;
  if (!sample?.position || !sample?.heading) {
    light.intensity = 0;
    light.visible = target.visible = false;
    return;
  }
  const position = asVector(sample.position);
  const heading = asVector(sample.heading);
  const { up, forward } = tangent(position, heading);
  const angle = THREE.MathUtils.clamp(Number.isFinite(pitch) ? pitch : 0, -1.45, 1.45);
  const origin = position.addScaledVector(up, EYE_HEIGHT);
  const direction = forward.multiplyScalar(Math.cos(angle)).addScaledVector(up, Math.sin(angle));
  const destination = origin.clone().addScaledVector(direction, 12);

  const group = light.parent;
  group.updateWorldMatrix(true, false);
  light.position.copy(group.worldToLocal(origin));
  target.position.copy(group.worldToLocal(destination));
  light.intensity = enabled ? 17 : 0;
  light.visible = target.visible = Boolean(visible);
}
