import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldScene } from '../src/scene/world-scene.js';

function canvas() {
  return {clientWidth:200,clientHeight:100,getBoundingClientRect:()=>({left:10,top:20,width:200,height:100})};
}

test('map preview click raycasts the rendered ground and returns planet coordinates',()=>{
  const scene=Object.create(WorldScene.prototype),c=canvas();
  scene.radius=10;scene.ground=new THREE.Mesh(new THREE.SphereGeometry(10,32,16),new THREE.MeshBasicMaterial());
  const camera=new THREE.PerspectiveCamera(70,2,.1,100);camera.position.set(0,0,30);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  scene.roverPreview={canvas:c,camera,mode:'map'};
  const point=scene.pickRoverPreviewPoint({clientX:110,clientY:70});
  assert.ok(point);
  assert.ok(Math.abs(point.latitude)<1e-6);
  assert.ok(Math.abs(point.longitude-90)<1e-6);
  scene.roverPreview.mode='camera';
  assert.equal(scene.pickRoverPreviewPoint({clientX:110,clientY:70}),null);
});

test('onboard camera remains available when rover is culled and restores scene state after render errors',()=>{
  const scene=Object.create(WorldScene.prototype),c=canvas(),events=[];
  const mesh=new THREE.Group();mesh.position.set(0,10,0);mesh.visible=false;scene.rovers=new Map([['r',{mesh,data:{heading:[0,0,-1]}}]]);
  scene.enabled=true;scene.mode='top';scene.camera={visible:true};
  scene.atmosphere={sky:{visible:true},dust:{visible:true}};
  scene.events={emit:(...args)=>events.push(args)};scene.scene=new THREE.Scene();
  scene.syncSurface=()=>{};
  const renderer={setSize(){},clear(){},render(){throw new Error('render failed')}};
  scene.roverPreview={canvas:c,renderer,camera:new THREE.PerspectiveCamera(),roverId:'r',mode:'camera',available:null,markers:new THREE.Group()};
  assert.throws(()=>scene.renderRoverPreview(),/render failed/);
  assert.deepEqual(events,[['rover.preview.available',true]]);
  assert.equal(scene.roverPreview.available,true);
  assert.equal(scene.mode,'top');assert.equal(scene.camera.visible,true);assert.equal(mesh.visible,false);
  assert.equal(scene.atmosphere.sky.visible,true);assert.equal(scene.atmosphere.dust.visible,true);
});

test('map preview markers follow declared coordinates and stay hidden outside map rendering',()=>{
  const scene=Object.create(WorldScene.prototype);scene.radius=10;scene.terrain=false;
  const markers=new THREE.Group();markers.visible=false;
  scene.roverPreview={markers,pointsKey:null};
  scene.updateRoverPreviewMarkers([{latitude:0,longitude:90,name:'POINT_A'},{latitude:91,longitude:0,name:'clamped'}]);
  assert.equal(markers.children.length,2);
  assert.equal(markers.visible,false);
  assert.equal(markers.children[0].userData.pointName,'POINT_A');
  assert.ok(Math.abs(markers.children[0].position.x)<1e-6);
  assert.ok(markers.children[0].position.z>10);
  assert.ok(markers.children[1].position.y>10);
});
