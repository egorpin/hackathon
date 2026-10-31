import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ModelLibrary, recolor } from './scene/model-library.js';
import { FirstPersonHands } from './scene/first-person-hands.js';

const stage=document.querySelector('#stage');
const scene=new THREE.Scene();scene.background=new THREE.Color('#171c25');
const camera=new THREE.PerspectiveCamera(55,stage.clientWidth/stage.clientHeight,.03,100);
camera.position.set(2,1.5,3);scene.add(camera);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
renderer.setSize(stage.clientWidth,stage.clientHeight);stage.append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xffffff,0x52607d,2));
const light=new THREE.DirectionalLight(0xffeedc,2.3);light.position.set(2,3,4);scene.add(light);
const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.9,0);controls.update();
const library=new ModelLibrary();let actor,hands,skeleton;
const status=document.querySelector('#status');
const motion=document.querySelector('#motion'),color=document.querySelector('#color');
const handsToggle=document.querySelector('#hands'),skeletonToggle=document.querySelector('#skeleton');
const pause=document.querySelector('#pause'),frame=document.querySelector('#frame');
frame.oninput=()=>{pause.checked=true;if(actor?.userData.animation?.action){const animation=actor.userData.animation,action=animation.action;animation.mixer.stopAllAction();action.reset().stopFading().setEffectiveWeight(1).play();action.time=Number(frame.value)*action.getClip().duration;animation.mixer.update(0);}};
handsToggle.onchange=()=>{
  controls.enabled=!handsToggle.checked;
  camera.position.set(...(handsToggle.checked?[0,0,0]:[2,1.5,3]));
  if(handsToggle.checked){camera.quaternion.identity();}else controls.update();
};
document.querySelector('#replay').onclick=()=>{
  if(actor?.userData.animation)actor.userData.animation.current=null;
  if(hands)hands.currentState=null;
};
(async () => { try {
  await library.load();
  actor=library.create('astronaut',color.value);
  if(!actor)throw new Error('Модель космонавта не подключена');
  scene.add(actor);skeleton=new THREE.SkeletonHelper(actor);scene.add(skeleton);
  skeleton.material.depthTest=false;skeleton.material.depthWrite=false;
  skeleton.material.vertexColors=false;skeleton.material.color.set('#67ffd1');skeleton.renderOrder=100;
  hands=new FirstPersonHands(camera,{astronaut:library.assets.get('astronaut').scene,animations:library.assets.get('astronaut').animations});
  let bones=0;actor.traverse(n=>{if(n.isBone)bones++;});
  status.textContent=`Скелет: ${bones} костей · Анимации: ${library.assets.get('astronaut').animations.map(c=>c.name).join(', ')}`;
}catch(error){status.textContent=error.message;console.error(error);} })();
const clock=new THREE.Clock();
renderer.setAnimationLoop(()=>{
  const dt=Math.min(clock.getDelta(),.05),fp=handsToggle.checked;
  if(actor){
    actor.visible=!fp;recolor(actor,color.value);library.animate(actor,motion.value,pause.checked?0:dt);
    if(!pause.checked&&actor.userData.animation?.action){const action=actor.userData.animation.action;frame.value=action.time/action.getClip().duration;}
    skeleton.visible=!fp&&skeletonToggle.checked;
    hands.update(dt,{visible:fp,color:color.value,moving:['walk','run'].includes(motion.value),running:motion.value==='run',airborne:motion.value==='jump'});
  }
  renderer.render(scene,camera);
});
new ResizeObserver(()=>{camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();renderer.setSize(stage.clientWidth,stage.clientHeight);}).observe(stage);
