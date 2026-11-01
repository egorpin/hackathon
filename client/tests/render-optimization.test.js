import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldScene } from '../src/scene/world-scene.js';
import { surfaceDistance } from '../src/scene/motion.js';

test('surface distance preserves spherical distance at poles, altitudes and zero vectors', () => {
  for (const a of [[0,0,0],[0,100,0],[1,2,3],[-100,0,0]]) {
    for (const b of [[0,0,0],[0,-110,0],[9,3,7],[100,0,0]]) {
      const x=new THREE.Vector3(...a), y=new THREE.Vector3(...b);
      const expected=Math.acos(THREE.MathUtils.clamp(x.clone().normalize().dot(y.clone().normalize()),-1,1))*100;
      assert.ok(Math.abs(surfaceDistance(x,y,100)-expected)<1e-5);
    }
  }
});

test('selection emits only on changes but reacts immediately to distance, occupancy and build type', () => {
  const scene=Object.create(WorldScene.prototype), events=[];
  Object.assign(scene,{models:{assets:new Map()},buildType:null,previewKey:'null:false',
    preview:new THREE.Group(),buildings:new Map(),position:new THREE.Vector3(0,100,0),
    radius:100,buildDistance:6,events:{emit:(...args)=>events.push(args)},place:()=>{}});
  const cell={cell_id:'one',center:[0,100,0],buildable:true};
  scene.select(cell); scene.select(cell); scene.select(cell);
  assert.equal(events.length,1);
  scene.position.set(100,0,0); scene.select(cell);
  assert.equal(events.length,2); assert.equal(events.at(-1)[1].locallyAllowed,false);
  scene.position.set(0,100,0); scene.select(cell);
  assert.equal(events.at(-1)[1].locallyAllowed,true);
  scene.buildings.set('b',{data:{cell_id:'one'}}); scene.select(cell);
  assert.equal(events.at(-1)[1].locallyAllowed,false);
  scene.select(null); scene.select(null);
  assert.equal(events.length,5);
});
