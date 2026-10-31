import * as THREE from 'three';
// Shared polygon vertices arrive from the server. One outward normal per cell
// avoids the artificial triangular spokes produced by flat-shaded triangle fans.
export function polygonGeometry(vertices, center, lift=0) {
  const normal=new THREE.Vector3().fromArray(center).normalize();
  const points=vertices.map(v=>new THREE.Vector3().fromArray(v).addScaledVector(normal,lift));
  const pivot=new THREE.Vector3();
  points.forEach(v=>pivot.add(v));pivot.multiplyScalar(1/points.length);
  if(points.length>=3 && points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).dot(normal)<0)points.reverse();
  const positions=[],normals=[];
  for(let i=0;i<points.length;i++)for(const v of [pivot,points[i],points[(i+1)%points.length]]){
    positions.push(...v.toArray());normals.push(...normal.toArray());
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  return geometry;
}
export function shellModel(shell) {
  const group=new THREE.Group(), positions=[],normals=[],colors=[],edges=[];
  shell.faces.forEach((face,i)=>{
    const vertices=face.map(index=>shell.vertices[index]);
    const center=vertices.reduce((s,v)=>s.map((x,j)=>x+v[j]),[0,0,0]).map(x=>x/vertices.length);
    const geometry=polygonGeometry(vertices,center);
    positions.push(...geometry.attributes.position.array);normals.push(...geometry.attributes.normal.array);
    const color=new THREE.Color().setHSL(.045+(i%7)*.002,.43,.27+(i%5)*.018);
    for(let k=0;k<geometry.attributes.position.count;k++)colors.push(color.r,color.g,color.b);
    geometry.dispose();
    for(let k=0;k<vertices.length;k++)edges.push(...vertices[k],...vertices[(k+1)%vertices.length]);
  });
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  group.add(new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:true,roughness:1})));
  const lines=new THREE.BufferGeometry();lines.setAttribute('position',new THREE.Float32BufferAttribute(edges,3));
  group.add(new THREE.LineSegments(lines,new THREE.LineBasicMaterial({color:0x442b25,transparent:true,opacity:.24})));
  return group;
}
