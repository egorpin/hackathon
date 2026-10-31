import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {prepareDrillParts} from '../src/scene/drill-parts.js';
import {attachMechanicalAnimation} from '../src/scene/mechanical-animation.js';

test('drill keeps triangles while spinning only its central bit and stopping when inactive',()=>{
  const root=new THREE.Group(),geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute([
    -.1,0,0,.1,0,0,0,.2,0,
    -1,0,0,-.8,0,0,-.9,.3,0,
    .8,0,0,1,0,0,.9,.3,0,
    -.4,.8,0,.4,.8,0,0,1,0,
  ],3));
  root.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial()));
  prepareDrillParts(root);
  let vertices=0;root.traverse(node=>{if(node.isMesh)vertices+=node.geometry.attributes.position.count;});
  assert.equal(vertices,12);
  const bit=root.getObjectByName('DrillBit'),legs=root.getObjectByName('DrillLegs');
  const animator=attachMechanicalAnimation(root,'drill');
  const legPosition=legs.position.clone(),legRotation=legs.quaternion.clone();
  animator.update(.05,{active:true});
  assert.notEqual(bit.quaternion.y,0);
  assert.ok(legs.position.equals(legPosition)&&legs.quaternion.equals(legRotation));
  const stopped=bit.quaternion.clone();
  animator.update(.05,{active:false});
  assert.ok(bit.quaternion.equals(stopped));
});
