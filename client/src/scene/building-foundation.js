import * as THREE from 'three';
import { projectTerrain } from './terrain.js';

export function withFoundation(building) {
  building.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(building);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshStandardMaterial({
    color:0x99958e,roughness:1,metalness:0,flatShading:true,
  }));
  slab.name = 'ConcreteFoundation';
  slab.scale.set(Math.max(1.6,size.x)+.3,.3,Math.max(1.6,size.z)+.3);
  slab.position.set(center.x,0,center.z);
  const root = new THREE.Group();
  root.add(slab,building);
  root.userData.foundation = {slab,building,bottom:bounds.min.y};
  if(building.userData.mechanical)root.userData.mechanical=building.userData.mechanical;
  return root;
}

export function fitFoundation(root,position,radius,terrain) {
  const foundation = root.userData.foundation;
  if(!foundation)return;
  const key = `${position.x},${position.y},${position.z},${radius},${terrain}`;
  if(foundation.key===key)return;
  foundation.key=key;
  const {slab,building,bottom}=foundation;
  const up=position.clone().normalize();
  const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
  let low=Infinity,high=-Infinity;
  // Sample corners, edge midpoints and center in the building's tangent plane.
  for(const x of [-.5,0,.5])for(const z of [-.5,0,.5]) {
    const point=new THREE.Vector3(slab.position.x+x*slab.scale.x,0,slab.position.z+z*slab.scale.z)
      .applyQuaternion(rotation).add(position);
    const height=projectTerrain(point,radius,0,terrain).sub(position).dot(up);
    low=Math.min(low,height);high=Math.max(high,height);
  }
  const top=high+.12,base=low-.2;
  slab.scale.y=top-base;
  slab.position.y=(top+base)/2;
  building.position.y=top-bottom;
}
