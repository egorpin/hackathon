import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldScene } from '../src/scene/world-scene.js';
import { AimResources } from '../src/ui/aim-resources.js';
import { Events } from '../src/net/events.js';

test('aim targets model children, clears when looking away, and respects nearer terrain',()=>{
  const camera=new THREE.PerspectiveCamera(70,1,.05,100);
  const model=new THREE.Group(), part=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial());
  model.add(part);model.position.z=-3;
  const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshBasicMaterial());
  ground.position.z=-8;ground.userData.cell={cell_id:'ground',surface:'plain'};ground.updateMatrixWorld();
  const events=new Events(),targets=[];
  events.on('building.targeted',value=>targets.push(value?.building_id ?? null));
  const scene={enabled:true,mode:'first',pointer:new THREE.Vector2(),camera,raycaster:new THREE.Raycaster(),
    chunks:new Map([['chunk',{cells:[ground]}]]),buildings:new Map([['drill',{mesh:model,data:{building_id:'drill'}}]]),events,
    select(cell){this.selected=cell;},targetBuilding:WorldScene.prototype.targetBuilding};
  WorldScene.prototype.pick.call(scene);
  assert.equal(targets.at(-1),'drill');
  camera.rotation.y=Math.PI/2;
  WorldScene.prototype.pick.call(scene);
  assert.equal(targets.at(-1),null);
  camera.rotation.y=0;
  ground.position.z=-1;ground.updateMatrixWorld();
  WorldScene.prototype.pick.call(scene);
  assert.equal(scene.targetedBuilding,null,'terrain occludes the building');
  part.geometry.dispose();part.material.dispose();ground.geometry.dispose();ground.material.dispose();
});

test('contextual transfer uses aimed building, reach, ownership and actual inventory',()=>{
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({remove(){}}),querySelector:()=>({append(){}})};
  const events=new Events(),commands=[];
  events.on('command',value=>commands.push(value));
  const ui=new AimResources({events});
  try {
    events.emit('connection.status','connected');
    const drill={building_id:'drill',building_type:'drill',team_id:'team',position:[0,30,0],stock:{water:8}};
    const state={stage:'running',self_id:'me',team_id:'team',world:{radius:30},players:[{player_id:'me',position:[0,30,0]}],
      buildings:[drill],inventory:{iron:46},team_storage:{},config:{interaction_distance:4.5,inventory_capacity:50,storage_capacity:300,building_capacity:50}};
    events.emit('world.state',state);events.emit('building.targeted',drill);
    assert.equal(ui.button.hidden,false);assert.equal(ui.button.disabled,false);
    events.emit('pickup.request');
    assert.deepEqual(commands[0],{type:'resource.pickup',payload:{building_id:'drill',resource:'water',amount:4}});
    events.emit('ui.overlay',true);assert.equal(ui.button.hidden,true);
    events.emit('pickup.request');assert.equal(commands.length,1);
    events.emit('ui.overlay',false);
    events.emit('world.state',{...state,inventory:{iron:50}});
    assert.equal(ui.button.disabled,true);assert.match(ui.button.textContent,/Рюкзак заполнен/);
    events.emit('world.state',{...state,buildings:[{...drill,team_id:'other'}]});
    assert.equal(ui.button.hidden,true);
    events.emit('world.state',{...state,players:[{player_id:'me',position:[30,0,0]}]});
    assert.equal(ui.button.hidden,true);
    events.emit('connection.status','reconnecting');events.emit('connection.status','connected');
    assert.equal(ui.button.hidden,true,'stale snapshot cannot enable transfer after reconnect');
  } finally {ui.dispose();globalThis.document=previous;}
});
