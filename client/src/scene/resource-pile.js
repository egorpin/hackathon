import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { projectTerrain } from './terrain.js';

const COLORS = { iron:0x66554b, sulfur:0xc9b442, water:0x9fcbd8, ice:0x9fcbd8, stone:0x777775 };

// A light preview of the deposit silhouette, pending approval of generated assets.
// Keep the entire pile inside the cell's inscribed circle with a generous margin.
export function resourcePile(cell, {radius, terrain=false}={}) {
  const center=new THREE.Vector3().fromArray(cell.center);
  const up=center.clone().normalize();
  const vertices=cell.vertices.map(v=>new THREE.Vector3().fromArray(v).sub(center))
    .map(v=>v.addScaledVector(up,-v.dot(up)));
  let inset=Infinity;
  for(let i=0;i<vertices.length;i++) {
    const a=vertices[i],b=vertices[(i+1)%vertices.length],edge=b.clone().sub(a);
    const t=THREE.MathUtils.clamp(-a.dot(edge)/edge.lengthSq(),0,1);
    inset=Math.min(inset,a.clone().addScaledVector(edge,t).length());
  }
  const width=Math.min(inset*.62,1.8);
  const base=projectTerrain(center.clone(),radius || center.length(),0,terrain);
  const rotation=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),up);
  const stones=[];
  let seed=2166136261;
  for(const char of cell.cell_id || 'deposit')seed=Math.imul(seed^char.charCodeAt(0),16777619)>>>0;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  for(let i=0;i<26;i++) {
    const crumb=i>=8;
    const angle=i*2.39996323+random()*.45;
    const distance=width*(.22+Math.sqrt(random())*.55);
    const size=width*(crumb?.035+random()*.045:.13+random()*.08);
    const geometry=new THREE.IcosahedronGeometry(1,0);
    geometry.rotateY(angle+.35);geometry.rotateZ(i*.21);
    geometry.scale(size*(i%2?1:.85),size*(.55+random()*.35),size);
    geometry.computeBoundingBox();
    const x=Math.cos(angle)*distance,z=Math.sin(angle)*distance;
    const point=new THREE.Vector3(x,0,z).applyQuaternion(rotation).add(base);
    const groundOffset=projectTerrain(point,radius || center.length(),0,terrain).sub(base).dot(up);
    geometry.translate(x,groundOffset-geometry.boundingBox.min.y-size*.42,z);
    stones.push(geometry);
  }
  const geometry=mergeGeometries(stones);stones.forEach(g=>g.dispose());
  const material=new THREE.MeshStandardMaterial({color:COLORS[cell.resource] ?? COLORS.stone,roughness:.92,flatShading:true});
  const pile=new THREE.Mesh(geometry,material);pile.name=`resource-pile-${cell.resource}`;
  pile.userData.footprintRadius=width;
  return pile;
}
