import * as THREE from 'three';
import { projectTerrain } from './terrain.js';

// Build the rim and basin in world coordinates so every vertex follows terrain.
export function crater(cell, {radius, terrain=false}={}) {
  const center=new THREE.Vector3().fromArray(cell.center);
  const up=center.clone().normalize();
  const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
  const vertices=cell.vertices.map(v=>new THREE.Vector3().fromArray(v).sub(center))
    .map(v=>v.addScaledVector(up,-v.dot(up)));
  let inset=Infinity;
  for(let i=0;i<vertices.length;i++) {
    const a=vertices[i], edge=vertices[(i+1)%vertices.length].clone().sub(a);
    const t=THREE.MathUtils.clamp(-a.dot(edge)/edge.lengthSq(),0,1);
    inset=Math.min(inset,a.clone().addScaledVector(edge,t).length());
  }
  const width=inset*.94, segments=20, rings=[0,.38,.65,.80,1];
  const heights=[.035,.045,.27,.20,.025];
  const palette=[0x49342f,0x614138,0x9a6750,0x805342];
  const positions=[],colors=[];
  const points=rings.map((fraction,ring)=>Array.from({length:segments},(_,i)=>{
    const a=i*Math.PI*2/segments;
    const variation=1+.055*Math.sin(i*2.4)+.035*Math.cos(i*4.1);
    const local=new THREE.Vector3(Math.cos(a)*width*fraction*variation,0,Math.sin(a)*width*fraction*variation);
    const point=local.applyQuaternion(rotation).add(center);
    const h=heights[ring]*width*(ring===2 ? 1+.16*Math.sin(i*1.7) : 1);
    return projectTerrain(point,radius || center.length(),h+.035,terrain);
  }));
  for(let ring=0;ring<rings.length-1;ring++) for(let i=0;i<segments;i++) {
    const j=(i+1)%segments;
    const color=new THREE.Color(palette[ring]).multiplyScalar(.91+.12*(.5+.5*Math.sin(i*3.7+ring)));
    for(const point of [points[ring][i],points[ring+1][j],points[ring+1][i],points[ring][i],points[ring][j],points[ring+1][j]]) {
      positions.push(point.x,point.y,point.z); colors.push(color.r,color.g,color.b);
    }
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  geometry.computeVertexNormals();
  const result=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,flatShading:true,side:THREE.DoubleSide}));
  result.name='crater';
  return result;
}
