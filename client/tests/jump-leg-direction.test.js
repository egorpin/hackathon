import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { reverseJumpLegMotion } from '../src/scene/model-library.js';

test('jump mirrors leg rotations around their bind pose without changing the torso', () => {
  const root = new THREE.Group();
  const thigh = new THREE.Bone(); thigh.name = 'LeftThigh'; root.add(thigh);
  const spine = new THREE.Bone(); spine.name = 'Spine'; root.add(spine);
  const legPose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .4);
  const torsoPose = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .2);
  const clip = new THREE.AnimationClip('Jump', 1, [
    new THREE.QuaternionKeyframeTrack('LeftThigh.quaternion', [0], legPose.toArray()),
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', [0], torsoPose.toArray()),
  ]);

  reverseJumpLegMotion(root, [clip]);

  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -.4);
  const actual = new THREE.Quaternion().fromArray(clip.tracks[0].values);
  assert.ok(Math.abs(Math.abs(actual.dot(expected)) - 1) < 1e-6);
  const unchangedTorso = new THREE.Quaternion().fromArray(clip.tracks[1].values);
  assert.ok(Math.abs(Math.abs(unchangedTorso.dot(torsoPose)) - 1) < 1e-6);
});
