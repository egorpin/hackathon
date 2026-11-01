import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ModelLibrary } from '../src/scene/model-library.js';

test('dispose while loading releases late decoded resources and never retains asset',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({approved:['storage'],revision:'1'}));
  try {
    const library=new ModelLibrary(); let finish; let releases=0;
    library.cache.get=()=>new Promise(resolve=>{finish=resolve;});
    const geometry=new THREE.BoxGeometry(); geometry.addEventListener('dispose',()=>releases++);
    library.loader.parseAsync=async()=>({scene:new THREE.Mesh(geometry,new THREE.MeshBasicMaterial()),animations:[]});
    const loading=library.load(); await new Promise(resolve=>setTimeout(resolve,0));
    library.dispose(); finish(new ArrayBuffer(12)); await loading;
    assert.equal(releases,1); assert.equal(library.assets.size,0); assert.equal(library.create('storage'),null);
  } finally { globalThis.fetch=original; }
});

test('model instances share textures and geometry but isolate their material colors',()=>{
 const library=new ModelLibrary();
 const texture=new THREE.Texture(); let closed=0, disposed=0;
 texture.source.data={close(){closed++;}};
 texture.addEventListener('dispose',()=>disposed++);
 const material=new THREE.MeshBasicMaterial({map:texture}); material.name='Accent';
 const geometry=new THREE.BoxGeometry(), scene=new THREE.Group();
 scene.add(new THREE.Mesh(geometry,material),new THREE.Mesh(geometry,material));
 library.assets.set('storage',{scene,animations:[]});
 const a=library.create('storage','#ff0000'), b=library.create('storage','#00ff00');
 assert.equal(a.children[0].material,a.children[1].material);
 assert.notEqual(a.children[0].material,b.children[0].material);
 assert.equal(a.children[0].geometry,b.children[0].geometry);
 assert.equal(a.children[0].material.map,b.children[0].material.map);
 assert.notEqual(a.children[0].material.color.getHex(),b.children[0].material.color.getHex());
 library.dispose(); assert.equal(disposed,1); assert.equal(closed,1);
});

test('per-model content version takes precedence over the legacy manifest revision',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({approved:['storage'],revision:'old',versions:{storage:'content-hash'}}));
 try {
   const library=new ModelLibrary(); const calls=[];
   library.cache.get=async(name,revision)=>{calls.push([name,revision]); return new ArrayBuffer(12);};
   library.loader.parseAsync=async()=>({scene:new THREE.Group(),animations:[]});
   await library.load(); await library.load();
   assert.deepEqual(calls,[['storage','content-hash']]); library.dispose();
 }finally{globalThis.fetch=original;}
});
