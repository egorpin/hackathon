import * as T from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {ModelLibrary,recolor} from './scene/model-library.js';
const library=new ModelLibrary();const views=[];
await library.load();
for(const [name,title] of Object.entries({drill:'Бур',dome_base:'Купол',oxygen_generator:'Генератор O₂',astronaut:'Космонавт',rover:'Ровер без руки'})){
 const section=document.createElement('section');section.innerHTML=`<h2>${title}</h2>`;document.querySelector('main').append(section);
 const renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(section.clientWidth,320);section.append(renderer.domElement);
 const scene=new T.Scene();scene.background=new T.Color('#30363c');scene.add(new T.HemisphereLight(0xffffff,0x777788,2));const light=new T.DirectionalLight(0xffffff,3);light.position.set(3,6,5);scene.add(light);
 const model=library.create(name,'#ff720f');scene.add(model);model.updateMatrixWorld(true);
 const box=new T.Box3().setFromObject(model),center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());const d=Math.max(size.x,size.y,size.z)*1.8;
 const camera=new T.PerspectiveCamera(38,section.clientWidth/320,.01,100);camera.position.copy(center).add(new T.Vector3(d*.65,d*.4,d));
 const controls=new OrbitControls(camera,renderer.domElement);controls.target.copy(center);controls.update();views.push({renderer,scene,camera,model});
}
document.querySelector('#color').oninput=e=>views.forEach(v=>recolor(v.model,e.target.value));
function frame(){requestAnimationFrame(frame);for(const v of views)v.renderer.render(v.scene,v.camera);}frame();
