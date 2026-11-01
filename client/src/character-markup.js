import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const JOINTS=[['Hips','Центр таза'],['Spine','Центр груди'],['Neck','Основание шеи'],['Head','Центр головы'],['LeftShoulder','Левое плечо'],['LeftElbow','Левый локоть'],['LeftWrist','Левое запястье'],['RightShoulder','Правое плечо'],['RightElbow','Правый локоть'],['RightWrist','Правое запястье'],['LeftHip','Левый тазобедренный'],['LeftKnee','Левое колено'],['LeftAnkle','Левый голеностоп'],['RightHip','Правый тазобедренный'],['RightKnee','Правое колено'],['RightAnkle','Правый голеностоп']];
const KEY='mars.character-landmarks.PixelArtistry_00011.v1';
let points={},selected=0,ready=false;const history=[];
try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.model==='astronaut.glb')points=saved.points||{};}catch{}
const status=document.querySelector('#status'),list=document.querySelector('#joints'),data=document.querySelector('#data');
const scene=new THREE.Scene();scene.background=new THREE.Color('#202b3a');
scene.add(new THREE.HemisphereLight(0xffffff,0x9aa5ba,2.4));
for(const pos of [[3,3,4],[-3,2,-3]]){const light=new THREE.DirectionalLight(0xffffff,1.8);light.position.set(...pos);scene.add(light);}
const views=['front','side'].map(name=>{
  const host=document.getElementById(name),renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));host.append(renderer.domElement);
  const camera=new THREE.OrthographicCamera(-1.2,1.2,2.1,-.3,.01,20);
  camera.position.set(...(name==='front'?[0,.9,5]:[5,.9,0]));camera.lookAt(0,.9,0);
  const guide=document.createElement('div');guide.className='guide';host.append(guide);
  const markers=JOINTS.map(([,label],i)=>{const el=document.createElement('div');el.className='marker';el.textContent=i+1;el.title=label;host.append(el);return el;});
  return {name,host,renderer,camera,markers,guide};
});
function exportData(){return {version:1,model:'astronaut.glb',coordinate_system:'Y-up, feet Y=0, height 1.8m, front +Z, character-left +X',points};}
function persist(){data.value=JSON.stringify(exportData(),null,2);try{localStorage.setItem(KEY,data.value);document.querySelector('#saved').textContent='Сохранено в этом браузере. Когда закончишь, напиши «готово».';}catch{document.querySelector('#saved').textContent='Браузер не сохранил точки. Скачай разметку перед закрытием.';}}
function refresh(){
  list.replaceChildren();JOINTS.forEach(([key,label],i)=>{const b=document.createElement('button'),p=points[key];b.className=(selected===i?'active ':'')+(p?.front&&p?.side?'done':'');b.textContent=`${i+1}. ${label} ${p?.front?'●':'○'} ${p?.side?'●':'○'}`;b.onclick=()=>{selected=i;refresh();};list.append(b);});
  document.querySelector('#undo').disabled=!history.length;
  const complete=JOINTS.filter(([key])=>points[key]?.front&&points[key]?.side).length;
  if(ready)status.textContent=`${complete} / ${JOINTS.length} суставов · выбран: ${JOINTS[selected][1]}`;
  persist();draw();
}
function draw(){for(const v of views){
  v.renderer.render(scene,v.camera);const w=v.host.clientWidth,h=v.host.clientHeight;
  JOINTS.forEach(([key],i)=>{const p=points[key],el=v.markers[i];el.hidden=!p?.front;if(el.hidden)return;
    const q=new THREE.Vector3(p.x,p.y,p.z??0).project(v.camera);el.style.left=`${(q.x+1)*w/2}px`;el.style.top=`${(1-q.y)*h/2}px`;el.style.opacity=v.name==='side'&&!p.side?'.35':'1';el.className=`marker${i===selected?' selected':''}`;
  });
  const p=points[JOINTS[selected][0]];v.guide.hidden=v.name!=='side'||!p?.front;
  if(p?.front){const q=new THREE.Vector3(0,p.y,0).project(v.camera);v.guide.style.top=`${(1-q.y)*h/2}px`;}
}}
function resize(){for(const v of views){const w=v.host.clientWidth,h=v.host.clientHeight,aspect=w/Math.max(h,1);const halfHeight=Math.max(1.05,1.05/aspect);v.camera.left=-halfHeight*aspect;v.camera.right=halfHeight*aspect;v.camera.top=halfHeight;v.camera.bottom=-halfHeight;v.camera.updateProjectionMatrix();v.renderer.setSize(w,h,false);}draw();}
for(const v of views)v.renderer.domElement.addEventListener('pointerdown',event=>{
  if(!ready||event.button!==0)return;const key=JOINTS[selected][0],previous=points[key];
  if(v.name==='side'&&!previous?.front){status.textContent='Сначала поставь этот сустав на виде спереди.';return;}
  const rect=v.renderer.domElement.getBoundingClientRect(),mouse=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
  const ray=new THREE.Raycaster();ray.setFromCamera(mouse,v.camera);
  const hit=new THREE.Vector3();ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(...(v.name==='front'?[0,0,1]:[1,0,0])),0),hit);
  if(hit.y<-.15||hit.y>1.95||(v.name==='front'&&Math.abs(hit.x)>1.05)||(v.name==='side'&&Math.abs(hit.z)>.65)){status.textContent='Поставь точку в пределах тела персонажа.';return;}
  history.push(JSON.stringify(points));
  points[key]=v.name==='front'?{...previous,x:hit.x,y:hit.y,z:previous?.z??0,front:true,side:previous?.side??false}:{...previous,z:hit.z,side:true};
  refresh();
});
document.querySelector('#next').onclick=()=>{selected=(selected+1)%JOINTS.length;refresh();};
document.querySelector('#undo').onclick=()=>{if(history.length){points=JSON.parse(history.pop());refresh();}};
document.querySelector('#clear').onclick=()=>{history.push(JSON.stringify(points));delete points[JOINTS[selected][0]];refresh();};
document.querySelector('#download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportData(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='astronaut-joints.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
new ResizeObserver(resize).observe(document.querySelector('#views'));refresh();resize();
new GLTFLoader().load('/assets/models/astronaut.glb',gltf=>{
  const actor=gltf.scene,bounds=new THREE.Box3().setFromObject(actor),size=bounds.getSize(new THREE.Vector3()),scale=1.8/size.y;
  actor.scale.multiplyScalar(scale);actor.position.set(-(bounds.min.x+bounds.max.x)*.5*scale,-bounds.min.y*scale,0);
  scene.add(actor);ready=true;refresh();
},undefined,error=>{status.textContent='Не удалось загрузить исходную модель. Обнови страницу.';console.error(error);});
