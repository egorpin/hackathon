import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ProductionParticles } from '../src/scene/production-particles.js';

test('active drill particles use a visible deposit color for every supported resource',()=>{
  const expected={iron:0x66554b,copper:0xb87545,sulfur:0xc9b442,water:0x9fcbd8,ice:0x9fcbd8};
  for(const [resource,color] of Object.entries(expected)){
    const root=new THREE.Group();
    const particles=new ProductionParticles(root,'drill');
    particles.update(.08,true,resource);
    const emitted=particles.items.find(item=>item.mesh.visible);
    assert.ok(emitted,`${resource} drill should emit a particle`);
    assert.equal(emitted.mesh.material.color.getHex(),color,`${resource} particle color`);
    root.remove(particles.root);
    particles.root.traverse(object=>{
      object.geometry?.dispose();
      if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());
      else object.material?.dispose();
    });
  }
});

test('drill debris originates around the lower cone regardless of root position or tilt',()=>{
  const create=(position,rotation)=>{
    const root=new THREE.Group();root.position.copy(position);root.quaternion.copy(rotation);
    const body=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshBasicMaterial());
    body.position.set(.4,2,-.2);root.add(body);
    const bit=new THREE.Mesh(new THREE.ConeGeometry(.2,.6,8),new THREE.MeshBasicMaterial());
    bit.name='DrillBit';bit.position.set(.1,.32,-.1);root.add(bit);root.updateMatrixWorld(true);
    return {root,body,particles:new ProductionParticles(root,'drill')};
  };
  const identity=new THREE.Quaternion();
  const tilted=new THREE.Quaternion().setFromEuler(new THREE.Euler(.8,-1.1,.4));
  const first=create(new THREE.Vector3(),identity);
  const second=create(new THREE.Vector3(17,-8,31),tilted);
  second.root.scale.set(2,.5,3);second.root.updateMatrixWorld(true);
  assert.ok(first.particles.source.distanceTo(second.particles.source)<1e-10,'world pose must not change local emitter coordinates');
  assert.ok(first.particles.source.y>.02&&first.particles.source.y<.3,'emitter belongs to the bottom cone, not the roof');
  assert.ok(Math.abs(first.particles.source.x-.1)<1e-6);
  first.particles.update(.08,true,'water');
  const particle=first.particles.items.find(item=>item.mesh.visible);
  assert.ok(particle.mesh.position.y<.6,'debris stays near the cutting cone');
  const before=first.root.localToWorld(first.particles.source.clone());
  const up=new THREE.Vector3(0,1,0).applyQuaternion(first.root.quaternion);
  const moved=before.clone().sub(first.root.position);
  assert.ok(moved.dot(up)>0,'emitter should follow the tilted building up axis');
  for(const {root,particles} of [first,second]){
    particles.root.traverse(object=>{
      object.geometry?.dispose();
      if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());
      else object.material?.dispose();
    });
    root.traverse(object=>{if(object.isMesh)object.material.dispose();});
  }
});

test('drill emitter follows the current cone tip stroke without sampling mesh bounds every frame',()=>{
  const root=new THREE.Group();
  const bit=new THREE.Mesh(new THREE.ConeGeometry(.2,.6,8),new THREE.MeshBasicMaterial());
  bit.name='DrillBit';bit.position.y=.32;root.add(bit);root.updateMatrixWorld(true);
  const particles=new ProductionParticles(root,'drill');
  const initial=particles.source.y;
  bit.position.y+=.1;
  particles.update(.08,true,'iron');
  assert.ok(Math.abs(particles.source.y-initial-.1)<1e-6,'emitter follows the mechanical vertical stroke');
  const emitted=particles.items.find(item=>item.mesh.visible);
  assert.ok(emitted);
  const radial=Math.hypot(emitted.mesh.position.x-particles.source.x,emitted.mesh.position.z-particles.source.z);
  assert.ok(radial>.1,'debris starts outside the narrow opaque tip instead of inside the cone');
  assert.ok(Math.abs(particles.bitSourceLocal.y-((bit.geometry.boundingBox?.min.y ?? -.3)+.03))<1e-5,
    'the emitter point is just above the cutting tip, outside the opaque cone');
  particles.root.traverse(object=>{
    object.geometry?.dispose();
    if(Array.isArray(object.material))object.material.forEach(material=>material.dispose());
    else object.material?.dispose();
  });
  bit.material.dispose();
});

test('working oxygen generator emits visible rising mist above its housing and stops when idle',()=>{
  const root=new THREE.Group(),building=new THREE.Group();
  const housing=new THREE.Mesh(new THREE.BoxGeometry(1,.9,1),new THREE.MeshBasicMaterial());
  building.add(housing);building.position.y=.7;root.add(building);
  root.userData.foundation={building};
  root.position.set(30,0,0);root.rotation.z=-Math.PI/2;
  const particles=new ProductionParticles(root,'oxygen_generator');
  assert.ok(particles.source.y>1.15);
  particles.update(.08,true);
  const puff=particles.items.find(item=>item.mesh.visible);
  assert.ok(puff);assert.ok(puff.mesh.position.y>particles.source.y);
  assert.ok(puff.mesh.material.opacity>.4);assert.ok(puff.mesh.scale.x>.09);
  for(let i=0;i<30;i++)particles.update(.1,false);
  assert.ok(particles.items.every(item=>!item.mesh.visible));
});
