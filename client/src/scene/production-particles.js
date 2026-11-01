import * as T from 'three';
const colors={iron:0x66554b,copper:0xb87545,sulfur:0xc9b442,water:0x9fcbd8};
// Fixed pool; no image textures, per-frame allocations or unbounded emitters.
export class ProductionParticles {
 constructor(root,kind){
  this.steam=kind==='oxygen_generator';this.root=new T.Group();root.add(this.root);this.time=0;
  this.geometry=this.steam?new T.IcosahedronGeometry(1,1):new T.TetrahedronGeometry(1);
  this.items=Array.from({length:this.steam?12:18},()=>{const material=new T.MeshBasicMaterial({color:0xddebf0,transparent:true,depthWrite:false});const mesh=new T.Mesh(this.geometry,material);mesh.visible=false;this.root.add(mesh);return {mesh,age:99,v:new T.Vector3()};});
  const subject=root.userData.foundation?.building || root;subject.updateMatrixWorld(true);
  const bounds=new T.Box3().setFromObject(subject);const size=bounds.getSize(new T.Vector3());
  this.height=Math.max(.5,size.y);this.source=new T.Vector3(0,this.steam?this.height*.85:.25,0);
 }
 update(dt,active,resource){
  dt=Math.min(dt,.1);this.time+=dt;
  if(active&&this.time>.07){this.time=0;const p=this.items.find(p=>p.age>=1);if(p){p.age=0;p.mesh.position.copy(this.source);p.v.set((Math.random()-.5)*(this.steam?.12:1.4),this.steam?.35:.65+Math.random()*.6,(Math.random()-.5)*(this.steam?.12:1.4));p.mesh.material.color.setHex(this.steam?0xddebf0:(colors[resource]||colors.iron));}}
  for(const p of this.items){p.age+=dt*(this.steam?.65:1.5);p.mesh.visible=p.age<1;if(!p.mesh.visible)continue;p.mesh.position.addScaledVector(p.v,dt);if(!this.steam)p.v.y-=dt*2.8;p.mesh.scale.setScalar(this.steam?.035+p.age*.14:.025);p.mesh.material.opacity=(1-p.age)*(this.steam?.23:1);}
 }
}
