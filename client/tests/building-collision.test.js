import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { footprintDistance, resolveBuildingMotion } from '../src/scene/building-collision.js';

const groundRadius=()=>30;
const planetRadius=30;
const at=(z,altitude=0)=>new THREE.Vector3(0,30+altitude,z).normalize().multiplyScalar(30+altitude);
const move=new THREE.Vector3(0,0,-1);
const box=(center,halfX,halfZ,id='b')=>({building_id:id,surface_id:'body',kind:'box',center,
  axis_x:[1,0,0],axis_z:[0,0,1],half_x:halfX,half_z:halfZ,bottom:30,top:30.8});
const tangentPoint=(x,z=0)=>new THREE.Vector3(x,30,z).normalize().multiplyScalar(30);

test('rectangular footprint handles edges and rounded corners using signed distance',()=>{
  const shape=box([0,30,0],.5,1);
  assert.ok(Math.abs(footprintDistance(shape,tangentPoint(.5,1.15),30)-.15)<2e-3,'near a straight edge');
  assert.ok(footprintDistance(shape,tangentPoint(.5,1.21),30)>.2,'outside the expanded edge');
  assert.ok(footprintDistance(shape,tangentPoint(.65,1.15),30)>.2,'diagonal corner clearance uses the rounded capsule radius');
  assert.ok(footprintDistance(shape,tangentPoint(.64,1.14),30)<.2,'corner overlap is detected');
});

test('movement passes through the gap between compound box colliders',()=>{
  const shapes=[box([-.9,30,0],.3,.6,'left'),box([.9,30,0],.3,.6,'right')];
  const result=resolveBuildingMotion(tangentPoint(0,-1.5),0,0,new THREE.Vector3(0,0,1),2,.05,30,groundRadius,shapes,{grounded:true});
  assert.ok(result.position.z>.4,'the separated boxes leave a navigable corridor');
});

test('grounded movement steps onto the foundation, then stops at the building body',()=>{
  const position=at(2);
  const shapes=[
    {building_id:'b',surface_id:'foundation',center:[0,30,0],radius:1.05,bottom:30,top:30.12},
    {building_id:'b',surface_id:'body',center:[0,30,0],radius:.63,bottom:30.12,top:30.94},
  ];
  const result=resolveBuildingMotion(position,0,0,move,2.4,.05,planetRadius,groundRadius,shapes,{grounded:true});
  assert.ok(result.altitude>.11&&result.altitude<.13);
  assert.equal(result.supportBuildingId,'b');
  assert.equal(result.supportSurfaceId,'foundation');
  assert.ok(result.position.distanceTo(new THREE.Vector3(0,30,0))>.8,'capsule stays outside the body collision radius');
});

test('falling onto a roof lands at the band top and records support',()=>{
  const shape={building_id:'b',surface_id:'body',center:[0,30,0],radius:.9,bottom:30.12,top:30.94};
  const result=resolveBuildingMotion(at(0,1),1,-4.8,new THREE.Vector3(),0,.05,planetRadius,groundRadius,[shape],{grounded:false});
  assert.ok(Math.abs(result.position.length()-shape.top)<1e-6);
  assert.ok(Math.abs(result.altitude-.94)<1e-6);
  assert.equal(result.verticalSpeed,0);
  assert.equal(result.supportSurfaceId,'body');
});

test('initial penetration can escape outward while grounded movement cannot climb while rising',()=>{
  const shape={building_id:'b',surface_id:'body',center:[0,30,0],radius:.9,bottom:30,top:31};
  const escaped=resolveBuildingMotion(at(0),0,0,new THREE.Vector3(0,0,1),.2,.05,planetRadius,groundRadius,[shape],{grounded:true});
  assert.ok(escaped.position.z>.15,'outward movement recovers from stale overlap');
  const airborne=resolveBuildingMotion(at(2),0,2,move,1,.05,planetRadius,groundRadius,[{...shape,top:30.2}],{grounded:true});
  assert.equal(airborne.supportBuildingId,null,'a rising capsule does not step onto a band');
});
