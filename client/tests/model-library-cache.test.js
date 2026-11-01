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
