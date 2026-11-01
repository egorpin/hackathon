import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldScene } from '../src/scene/world-scene.js';

test('nearby authoritative buildings remain visible before terrain arrives and after eviction',()=>{
  const scene=Object.create(WorldScene.prototype);
  scene.scene=new THREE.Scene();scene.buildings=new Map();scene.players=new Map();scene.rovers=new Map();
  scene.radius=30;scene.viewRadius=12;scene.selfId='self';
  scene.buildingModel=()=>new THREE.Group();
  scene.place=(model,position)=>model.position.copy(position);
  const building={building_id:'b',cell_id:'cell',building_type:'warehouse',position:[0,30,0],completed:true};
  scene.chunks=new Map();
  scene.applyState({buildings:[building]});
  const model=scene.buildings.get('b').mesh;
  scene.updateBuildingVisibility(new THREE.Vector3(0,30,0));
  assert.equal(model.visible,true,'building state is sufficient before its terrain chunk loads');
  const group=new THREE.Group();scene.scene.add(group);
  scene.chunks.set('chunk',{group,cells:[{userData:{cell:{cell_id:'cell'}}}]});
  scene.unload('chunk');
  assert.equal(scene.chunks.size,0);
  assert.equal(group.parent,null);
  assert.equal(scene.buildings.get('b').mesh,model);
  assert.equal(model.parent,scene.scene,'terrain eviction must not dispose an authoritative building');
  scene.updateBuildingVisibility(new THREE.Vector3(0,30,0));
  assert.equal(model.visible,true);
  scene.updateBuildingVisibility(new THREE.Vector3(0,-30,0));
  assert.equal(model.visible,false,'interest distance still culls remote buildings');
  scene.applyState({removed_buildings:['b']});
  assert.equal(scene.buildings.size,0);
  assert.equal(model.parent,null,'authoritative removal still disposes the model');
});


test('a complete frame renders authoritative buildings without terrain chunks',()=>{
  const scene=Object.create(WorldScene.prototype);
  const model=new THREE.Group();model.position.set(0,30,0);
  Object.assign(scene,{
    enabled:true,previous:0,frameTimes:[],frames:0,fpsStart:0,
    visualOptions:{animations:false},controls:{axes:()=>({forward:0,right:0}),keys:new Set(),yaw:0,pitch:0},
    position:new THREE.Vector3(0,30,0),heading:new THREE.Vector3(0,0,-1),
    radius:30,viewRadius:12,speed:4,terrain:false,altitude:0,verticalSpeed:0,
    playerRadius:.2,buildingRadius:1.35,mountainRadius:1.5,inputTime:0,
    stage:'lobby',mode:'top',orbitRotation:new THREE.Quaternion(),orbitZoom:1,
    camera:new THREE.PerspectiveCamera(),scene:new THREE.Scene(),
    chunks:new Map(),players:new Map(),rovers:new Map(),baseMarkers:new Map(),
    buildings:new Map([['b',{mesh:model,data:{building_id:'b',cell_id:'cell',building_type:'warehouse',position:[0,30,0]}}]]),
    selectedRoverMarker:new THREE.Group(),
    atmosphere:{update(){},sky:{},dust:{},stars:{material:{}},sun:{},sunDirection:new THREE.Vector3(0,1,0)},
    fillLight:new THREE.DirectionalLight(),hands:{update(){}},events:{emit(){}},
    renderRoverPreview(){},
  });
  let renders=0;
  scene.renderer={render(){renders++;}};
  scene.frame(16);
  assert.equal(renders,1,'frame must reach renderer with a building and no chunks');
  assert.equal(model.visible,true);
  scene.stage='running';
  scene.robots={setState(){},entries:new Map()};
  const start=scene.position.clone();
  scene.controls.axes=()=>({forward:1,right:0});
  scene.supportBuildingId='b';scene.supportSurfaceId='foundation';
  scene.frame(32);
  assert.ok(scene.position.distanceTo(start)>.05,'building does not block player movement');
  assert.equal(scene.altitude,0,'walking through a foundation must not step up');
});
