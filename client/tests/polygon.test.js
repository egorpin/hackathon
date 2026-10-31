import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonGeometry, shellModel } from '../src/scene/polygon-geometry.js';
import { disposeObject } from '../src/scene/world-scene.js';

test('both polygon types have outward normals independent of winding',()=>{
 for(const count of [5,6])for(const reverse of [false,true]){
  const vertices=Array.from({length:count},(_,i)=>[Math.cos(i*2*Math.PI/count),10,Math.sin(i*2*Math.PI/count)]);
  if(reverse)vertices.reverse();
  const g=polygonGeometry(vertices,[0,10,0]);
  const p=g.attributes.position.array,n=g.attributes.normal.array;
  assert.equal(g.attributes.position.count,count*3);
  for(let i=0;i<p.length;i+=9){
   const ax=p[i+3]-p[i],az=p[i+5]-p[i+2],bx=p[i+6]-p[i],bz=p[i+8]-p[i+2];
   assert.ok(az*bx-ax*bz>0);
  }
  for(let i=0;i<n.length;i+=3){assert.equal(n[i],0);assert.equal(n[i+1],1);assert.equal(n[i+2],0);}
  g.dispose();
 }
});
test('coarse polygon shell owns disposable geometry and materials',()=>{
 const root=shellModel({vertices:[[0,1,0],[1,0,0],[0,0,1]],faces:[[0,1,2]]});
 let geometries=0,materials=0;
 root.traverse(o=>{if(o.geometry)o.geometry.addEventListener('dispose',()=>geometries++);if(o.material)o.material.addEventListener('dispose',()=>materials++);});
 disposeObject(root);assert.equal(geometries,2);assert.equal(materials,2);
});
