import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {updateRoverWheels} from '../src/scene/rover-wheels.js';
test('rover wheels roll with distance, reverse and stop without spinning chassis',()=>{
 const root=new THREE.Group(),wheel=new THREE.Group();wheel.name='Wheel_0';root.add(wheel);root.scale.setScalar(.375);
 updateRoverWheels(root,new THREE.Vector3());
 updateRoverWheels(root,new THREE.Vector3(0,0,.12));
 assert.ok(Math.abs(wheel.rotation.x-1)<1e-8);
 const stopped=wheel.quaternion.clone();updateRoverWheels(root,new THREE.Vector3(0,0,.12));assert.ok(stopped.equals(wheel.quaternion));
 updateRoverWheels(root,new THREE.Vector3());assert.ok(Math.abs(wheel.rotation.x)<1e-8);assert.equal(root.rotation.x,0);
 updateRoverWheels(root,new THREE.Vector3(0,0,.12),false);assert.ok(Math.abs(wheel.rotation.x)<1e-8);
});
