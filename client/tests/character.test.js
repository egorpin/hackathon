import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { recolor } from '../src/scene/model-library.js';
import { FirstPersonHands } from '../src/scene/first-person-hands.js';

function makeAstronaut() {
  const root = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'Hips'; root.add(hips);
  const left = new THREE.Bone(); left.name = 'LeftArm'; hips.add(left);
  const right = new THREE.Bone(); right.name = 'RightArm'; hips.add(right);
  const skeleton = new THREE.Skeleton([hips, left, right]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,1,0, 1,0,0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0,0,0,0, 1,0,0,0, 2,0,0,0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1,0,0,0, 1,0,0,0, 1,0,0,0], 4));
  const body = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  body.name = 'Torso'; body.bind(skeleton); root.add(body);
  const armGeometry = geometry.clone();
  const armMaterial = new THREE.MeshStandardMaterial(); armMaterial.name = 'AstronautSuitFabric';
  const arms = new THREE.SkinnedMesh(armGeometry, armMaterial);
  arms.name = 'LeftArmMesh'; arms.bind(skeleton); root.add(arms);
  const neutral = new THREE.MeshStandardMaterial(); neutral.name = 'HelmetGlass';
  const helmet = new THREE.Mesh(new THREE.BufferGeometry(), neutral); helmet.name = 'Helmet'; root.add(helmet);
  return { root, body, arms, helmet, skeleton };
}

test('astronaut suit recolor installs isolated shader tint uniforms and leaves neutral materials alone', () => {
  const source = makeAstronaut().root;
  const a = cloneSkeleton(source), b = cloneSkeleton(source);
  for (const object of [a, b]) object.traverse(node => {
    if (node.material) node.material = node.material.clone();
  });
  recolor(a, 0xff7b22);
  recolor(b, 0x3a8fe8);
  const suitA = a.getObjectByName('LeftArmMesh').material;
  const suitB = b.getObjectByName('LeftArmMesh').material;
  const neutralA = a.getObjectByName('Helmet').material;
  assert.equal(suitA.customProgramCacheKey(), 'astronaut-orange-panels-v1');
  assert.equal(suitA.color.getHex(), 0xffffff, 'base fabric albedo remains available to the selective shader');
  assert.notEqual(suitA.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  assert.equal(neutralA.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  assert.equal(neutralA.color.getHex(), 0xffffff);
  const shaderA = { uniforms: {}, fragmentShader: '#include <common>\nvoid main(){\n#include <map_fragment>\n}' };
  const shaderB = { uniforms: {}, fragmentShader: '#include <common>\nvoid main(){\n#include <map_fragment>\n}' };
  suitA.onBeforeCompile(shaderA); suitB.onBeforeCompile(shaderB);
  assert.notEqual(shaderA.uniforms.playerSuitColor, shaderB.uniforms.playerSuitColor);
  assert.equal(shaderA.uniforms.playerSuitColor.value.getHex(), 0xff7b22);
  assert.equal(shaderB.uniforms.playerSuitColor.value.getHex(), 0x3a8fe8);
  assert.match(shaderA.fragmentShader, /warmPanel/);
  assert.match(shaderA.fragmentShader, /diffuseColor\.rgb = mix/);
});

test('first person hands clone retains the skeleton and reveals only arm meshes', () => {
  const astronaut = makeAstronaut();
  const camera = new THREE.PerspectiveCamera();
  const hands = new FirstPersonHands(camera, { astronaut: astronaut.root });
  assert.ok(hands.astronautClone, 'astronaut arm clone should be installed');
  assert.equal(hands.armNodes.length, 1);
  assert.equal(hands.armNodes[0].name, 'LeftArmMesh');
  assert.ok(hands.astronautClone.getObjectByName('Torso').isSkinnedMesh, 'hidden body remains in the clone');
  assert.equal(hands.astronautClone.getObjectByName('Torso').visible, false);
  assert.equal(hands.armNodes[0].visible, true);
  assert.equal(hands.astronautClone.getObjectByName('Helmet').visible, false);
  assert.notEqual(hands.armNodes[0].skeleton, astronaut.arms.skeleton, 'SkeletonUtils must clone the skeleton');
  assert.ok(hands.armNodes[0].skeleton.bones.includes(hands.astronautClone.getObjectByName('LeftArm')));
  hands.setColor(0x35a86b);
  const shader = { uniforms: {}, fragmentShader: '#include <common>\n#include <map_fragment>' };
  hands.armNodes[0].material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.playerSuitColor.value.getHex(), 0x35a86b);
  hands.dispose();
});

test('first person hands do not synthesize fallback geometry when astronaut arms are absent', () => {
  const camera = new THREE.PerspectiveCamera();
  const hands = new FirstPersonHands(camera, { astronaut: new THREE.Group() });
  assert.equal(hands.armNodes.length, 0);
  assert.equal(hands.astronautClone, undefined);
  assert.equal(hands.root.children.length, 0);
  hands.dispose();
});
