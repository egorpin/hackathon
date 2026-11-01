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


test('demand loading shares one manifest and decode without downloading unrelated models',async()=>{
 const original=globalThis.fetch; let manifests=0;
 globalThis.fetch=async()=>{manifests++;return new Response(JSON.stringify({approved:['storage','rover'],revision:'1'}));};
 try {
  const library=new ModelLibrary(), downloads=[]; let decodes=0;
  library.cache.get=async name=>{downloads.push(name);return new ArrayBuffer(12);};
  library.loader.parseAsync=async()=>{decodes++;return {scene:new THREE.Group(),animations:[]};};
  const [a,b]=await Promise.all([library.ensure('storage'),library.ensure('storage')]);
  assert.equal(a,b); assert.equal(manifests,1); assert.equal(decodes,1);
  assert.deepEqual(downloads,['storage']); assert.equal(library.assets.has('rover'),false);
  await library.ensure('not-a-model'); assert.deepEqual(downloads,['storage']);
  await library.ensure('rover'); assert.equal(manifests,1); library.dispose();
 } finally {globalThis.fetch=original;}
});

test('unused decoded assets expire after grace and can be decoded again from raw cache',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({approved:['rover'],revision:'1'}));
 try {
  const library=new ModelLibrary(); let releases=0,decodes=0;
  library.cache.get=async()=>new ArrayBuffer(12);
  library.loader.parseAsync=async()=>{
   decodes++; const geometry=new THREE.BoxGeometry();geometry.addEventListener('dispose',()=>releases++);
   return {scene:new THREE.Mesh(geometry,new THREE.MeshBasicMaterial()),animations:[]};
  };
  await library.ensure('rover');
  library.prune(new Set(),0);library.prune(new Set(),29999);assert.equal(releases,0);
  library.prune(new Set(['rover']),30000); // becoming active cancels expiry
  library.prune(new Set(),40000);library.prune(new Set(),70000);
  assert.equal(releases,1);assert.equal(library.assets.size,0);
  await library.ensure('rover'); assert.equal(decodes,2);library.dispose();
 } finally {globalThis.fetch=original;}
});


test('scene demand protects live hidden instances and requests only current object types',async()=>{
 const {WorldScene}=await import('../src/scene/world-scene.js');
 const library=new ModelLibrary(); const requested=[]; let pinned;
 library.ensure=async name=>{requested.push(name);return null;};
 library.prune=required=>{pinned=new Set(required);};
 const scene=new THREE.Scene(), hiddenPreview=new THREE.Group();
 hiddenPreview.visible=false; hiddenPreview.userData.modelAsset='drill';scene.add(hiddenPreview);
 const state={models:library,scene,enabled:true,stage:'lobby',buildType:'warehouse',
  modelRequests:new Map(),modelRetryAt:new Map(),buildings:new Map(),rovers:new Map(),
  events:{emit(){}},modelLoaded(){throw Error('unexpected asset');}};
 WorldScene.prototype.syncModels.call(state,1000);
 await Promise.all(state.modelRequests.values());
 assert.deepEqual(requested.sort(),['astronaut','drill','storage']);
 assert.equal(pinned.has('drill'),true,'hidden instances still own shared resources');
 assert.equal(pinned.has('rover'),false);
 library.dispose();
});
