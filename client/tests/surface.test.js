import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sphericalCellGeometry, sphericalOutline, smoothSurface } from '../src/scene/mars-surface.js';
import { disposeObject } from '../src/scene/world-scene.js';

test('curved pentagons and hexagons follow the sphere with radial normals at either pole',()=>{
 for(const count of [5,6])for(const sign of [-1,1]){
  const vertices=Array.from({length:count},(_,i)=>[5*Math.cos(i*2*Math.PI/count),sign*100,5*Math.sin(i*2*Math.PI/count)]);
  const geometry=sphericalCellGeometry(vertices,[0,sign*100,0],100.015);
  const points=geometry.attributes.position,normals=geometry.attributes.normal;
  for(let i=0;i<points.count;i++){
   const p=new THREE.Vector3().fromBufferAttribute(points,i),n=new THREE.Vector3().fromBufferAttribute(normals,i);
   assert.ok(Math.abs(p.length()-100.015)<.00001);
   assert.ok(p.normalize().distanceTo(n)<.000001);
  }
  geometry.dispose();
 }
});
test('curved selection outline is closed and stays above the ground',()=>{
 const geometry=sphericalOutline([[4,100,0],[0,100,4],[-4,100,0]],100.05);
 const p=geometry.attributes.position;
 assert.deepEqual(Array.from(p.array.slice(0,3)),Array.from(p.array.slice(-3)));
 for(let i=0;i<p.count;i++)assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(p,i).length()-100.05)<.00001);
 geometry.dispose();
});
test('unload disposes both cached geometry representations and the smooth surface',()=>{
 const near=new THREE.SphereGeometry(1,8,4),far=new THREE.IcosahedronGeometry(1);
 const tile=new THREE.Mesh(near,new THREE.MeshStandardMaterial());
 tile.userData.ownedGeometries=[far,near];
 let released=0;near.addEventListener('dispose',()=>released++);far.addEventListener('dispose',()=>released++);
 disposeObject(tile);assert.equal(released,2);
 const surface=smoothSurface(100);let geometryReleased=false,materialReleased=false;
 surface.geometry.addEventListener('dispose',()=>geometryReleased=true);
 surface.material.addEventListener('dispose',()=>materialReleased=true);
 disposeObject(surface);assert.ok(geometryReleased&&materialReleased);
});
