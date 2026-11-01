import * as T from 'three';
const colors={iron:0x66554b,copper:0xb87545,sulfur:0xc9b442,water:0x9fcbd8,ice:0x9fcbd8};
// Fixed pool; no image textures, per-frame allocations or unbounded emitters.
function localBounds(root,subject){
 root.updateMatrixWorld(true);subject.updateMatrixWorld(true);
 const bounds=new T.Box3().makeEmpty(),inverseRoot=root.matrixWorld.clone().invert();
 subject.traverse(object=>{
  if(!object.isMesh||!object.geometry)return;
  if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();
  if(!object.geometry.boundingBox||object.geometry.boundingBox.isEmpty())return;
  const relative=inverseRoot.clone().multiply(object.matrixWorld);
  bounds.union(object.geometry.boundingBox.clone().applyMatrix4(relative));
 });
 return bounds;
}
export class ProductionParticles {
 constructor(root,kind){
  this.steam=kind==='oxygen_generator';this.time=0;
  this.modelRoot=root;
  const subject=root.userData.foundation?.building || root;
  const bounds=localBounds(root,subject);
  const height=bounds.isEmpty()?1:Math.max(.5,bounds.max.y-bounds.min.y);
  const center=bounds.isEmpty()?new T.Vector3():bounds.getCenter(new T.Vector3());
  // Drilling debris belongs to the lower cone, while steam exits above the
  // generator housing. Both positions are measured in building-local space.
  this.bit=subject.getObjectByName('DrillBit');
  const bitBounds=this.bit?localBounds(root,this.bit):null;
  const cuttingBounds=bitBounds&&!bitBounds.isEmpty()?bitBounds:bounds;
  const cuttingCenter=cuttingBounds.isEmpty()?center:cuttingBounds.getCenter(new T.Vector3());
  this.source=this.steam
    ?new T.Vector3(center.x,bounds.isEmpty()?.5:bounds.max.y+Math.max(.08,height*.04),center.z)
    :new T.Vector3(cuttingCenter.x,cuttingBounds.isEmpty()?.12:cuttingBounds.min.y+.03,cuttingCenter.z);
  this.bitSourceLocal=null;
  if(this.bit&&!cuttingBounds.isEmpty()){
   root.updateMatrixWorld(true);this.bit.updateWorldMatrix(true,false);
   this.bitSourceLocal=this.bit.worldToLocal(root.localToWorld(this.source.clone()));
  }
  this.emissionRadius=this.steam?Math.max(.08,height*.06):Math.max(.08,Math.min(.24,cuttingBounds.isEmpty()?.12:(cuttingBounds.max.x-cuttingBounds.min.x)*.55));
  this.steamScale=Math.max(.18,height*.12);
  this.particleScale=Math.max(.035,height*.022);
  this.root=new T.Group();root.add(this.root);
  this.geometry=this.steam?new T.IcosahedronGeometry(1,1):new T.TetrahedronGeometry(1);
  this.items=Array.from({length:this.steam?32:18},()=>{const material=new T.MeshBasicMaterial({color:0x888888,transparent:true,depthWrite:false});const mesh=new T.Mesh(this.geometry,material);mesh.visible=false;this.root.add(mesh);return {mesh,age:99,v:new T.Vector3()};});
 }
 updateDrillSource(){
  if(this.steam||!this.bit||!this.bitSourceLocal)return;
  // Transform the saved point at the cutter tip through its current pivot;
  // this follows vertical stroke and spin without rebuilding mesh bounds.
  this.modelRoot.updateMatrixWorld(true);
  this.source.copy(this.modelRoot.worldToLocal(this.bit.localToWorld(this.bitSourceLocal.clone())));
 }
 update(dt,active,resource){
  dt=Math.min(dt,.1);this.time+=dt;
  if(active&&!this.steam)this.updateDrillSource();
  if(active&&this.time>.07){this.time=0;const p=this.items.find(p=>p.age>=1);if(p){
    p.age=0;p.mesh.position.copy(this.source);
    const angle=Math.random()*Math.PI*2;
    p.mesh.position.x+=Math.cos(angle)*this.emissionRadius;p.mesh.position.z+=Math.sin(angle)*this.emissionRadius;
    const outward=.65+Math.random()*.45;
    p.v.set(this.steam?(Math.random()-.5)*.18:Math.cos(angle)*outward,this.steam?.65:.65+Math.random()*.6,this.steam?(Math.random()-.5)*.18:Math.sin(angle)*outward);
    p.mesh.material.color.setHex(this.steam?0x888888:(colors[resource]||colors.iron));
  }}
  for(const p of this.items){p.age+=dt*(this.steam?.4:1.5);p.mesh.visible=p.age<1;if(!p.mesh.visible)continue;p.mesh.position.addScaledVector(p.v,dt);if(!this.steam)p.v.y-=dt*2.8;p.mesh.scale.setScalar(this.steam?this.steamScale*(1+p.age*2.5):this.particleScale);p.mesh.material.opacity=(1-p.age)*(this.steam?.65:1);}
 }
}
