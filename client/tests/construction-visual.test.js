import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {isPlan,setPlanVisual} from '../src/scene/construction-visual.js';
test('plan shows polygon wires and restores the original textured material on completion',()=>{
 const texture=new THREE.Texture();const material=new THREE.MeshStandardMaterial({map:texture,color:0xe07020});
 const root=new THREE.Mesh(new THREE.BoxGeometry(),material);
 assert.equal(isPlan({construction_status:'planned'}),true);
 assert.equal(isPlan({construction_status:'completed'}),false);
 setPlanVisual(root,true);setPlanVisual(root,true);
 assert.equal(material.wireframe,true);assert.equal(material.depthWrite,false);assert.equal(material.map,null);
 setPlanVisual(root,false);
 assert.equal(material.map,texture);assert.equal(material.wireframe,false);assert.equal(material.opacity,1);assert.equal(material.color.getHex(),0xe07020);
 root.geometry.dispose();material.dispose();texture.dispose();
});
