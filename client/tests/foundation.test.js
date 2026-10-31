import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {withFoundation,fitFoundation} from '../src/scene/building-foundation.js';
import {projectTerrain} from '../src/scene/terrain.js';

test('foundation seats the building above relief and extends below its sampled footprint',()=>{
  const building=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),new THREE.MeshStandardMaterial());
  const root=withFoundation(building);
  const point=projectTerrain(new THREE.Vector3(1,2,3),100);
  fitFoundation(root,point,100,true);
  const {slab}=root.userData.foundation;
  const top=slab.position.y+slab.scale.y/2;
  const bottom=slab.position.y-slab.scale.y/2;
  assert.ok(Math.abs(building.position.y-1-top)<1e-8);
  const up=point.clone().normalize();
  const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
  for(const x of [-.5,0,.5])for(const z of [-.5,0,.5]) {
    const ground=projectTerrain(new THREE.Vector3(x*slab.scale.x,0,z*slab.scale.z).applyQuaternion(rotation).add(point),100);
    const height=ground.sub(point).dot(up);
    assert.ok(top>height && bottom<height);
  }
});
