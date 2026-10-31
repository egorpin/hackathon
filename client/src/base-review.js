import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {ModelLibrary} from './scene/model-library.js';
import {withFoundation,fitFoundation} from './scene/building-foundation.js';
const scene=new THREE.Scene(); scene.background=new THREE.Color('#302a29');
scene.add(new THREE.HemisphereLight(0xffeee0,0x66504a,2));
const sun=new THREE.DirectionalLight(0xffffff,3);sun.position.set(3,5,4);scene.add(sun);
const camera=new THREE.PerspectiveCamera(45,innerWidth/innerHeight,.01,30);camera.position.set(2.5,1.8,2.5);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);document.body.append(renderer.domElement);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.45,0);controls.update();
const models=new ModelLibrary();models.load(name=>{if(name==='dome_base'){
  const base=withFoundation(models.create(name));
  fitFoundation(base,new THREE.Vector3(0,100,0),100,false);
  scene.add(base);
}});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
renderer.setAnimationLoop(()=>renderer.render(scene,camera));
