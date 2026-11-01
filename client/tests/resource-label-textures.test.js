import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ResourceLabelTextures, RESOURCE_LABELS } from '../src/scene/resource-label-textures.js';
import { disposeObject, WorldScene } from '../src/scene/world-scene.js';

test('labels reuse bounded scene textures across chunk disposal and release them with the scene',()=>{
 assert.equal(RESOURCE_LABELS.water,'Л');
 assert.equal(RESOURCE_LABELS.ice,'Л');
 let canvases=0;
 const textures=new ResourceLabelTextures(()=>{canvases++;return {getContext:()=>({strokeText(){},fillText(){}})};});
 const water=textures.get('water'); let textureDisposals=0, materialDisposals=0;
 water.addEventListener('dispose',()=>textureDisposals++);
 const label=new THREE.Sprite(new THREE.SpriteMaterial({map:water}));
 label.userData.sharedAsset=true; label.material.addEventListener('dispose',()=>materialDisposals++);
 const chunk=new THREE.Group(); chunk.add(label); disposeObject(chunk);
 assert.equal(materialDisposals,1); assert.equal(textureDisposals,0);
 assert.equal(textures.get('water'),water); assert.equal(canvases,1);
 for(const name of ['iron','sulfur','copper']) textures.get(name);
 assert.equal(textures.get('unknown'),null); assert.equal(canvases,4);
 textures.dispose(); assert.equal(textureDisposals,1); assert.equal(textures.textures.size,0);
});

test('drill selection allows supported deposits and rejects empty cells',()=>{
  const selected=[];
  const scene={buildings:new Map(),buildType:'drill',position:new THREE.Vector3(0,100,0),radius:100,buildDistance:6,
    terrain:false,preview:{material:{color:new THREE.Color()}},place(){},events:{emit(_name,data){selected.push(data);}}};
  const cell={cell_id:'1',buildable:true,center:[0,100,0],resource:'iron'};
  WorldScene.prototype.select.call(scene,cell);
  WorldScene.prototype.select.call(scene,{...cell,resource:null});
  assert.deepEqual(selected.map(x=>x.locallyAllowed),[true,false]);
});
