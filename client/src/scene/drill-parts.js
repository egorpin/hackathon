import * as THREE from 'three';

// Split the supplied single-mesh drill once on load, preserving every triangle/UV.
export function prepareDrillParts(root) {
  const meshes=[];root.traverse(node=>{if(node.isMesh)meshes.push(node);});
  for(const source of meshes) {
    const geometry=source.geometry.index?source.geometry.toNonIndexed():source.geometry.clone();
    geometry.computeBoundingBox();
    const bounds=geometry.boundingBox,center=bounds.getCenter(new THREE.Vector3());
    const size=bounds.getSize(new THREE.Vector3()),position=geometry.attributes.position;
    const groups={DrillBit:[],DrillBody:[],DrillLegs:[]};
    for(let i=0;i<position.count;i+=3) {
      const x=(position.getX(i)+position.getX(i+1)+position.getX(i+2))/3;
      const y=(position.getY(i)+position.getY(i+1)+position.getY(i+2))/3;
      const z=(position.getZ(i)+position.getZ(i+1)+position.getZ(i+2))/3;
      const lower=y<bounds.min.y+size.y*.53;
      const central=Math.abs(x-center.x)<Math.max(size.x,1e-6)*.23 && Math.abs(z-center.z)<Math.max(size.z,1e-6)*.23;
      groups[lower?(central?'DrillBit':'DrillLegs'):'DrillBody'].push(i,i+1,i+2);
    }
    const assembly=new THREE.Group();assembly.name='DrillAssembly';
    assembly.position.copy(source.position);assembly.quaternion.copy(source.quaternion);assembly.scale.copy(source.scale);
    for(const [name,indices] of Object.entries(groups)) {
      if(!indices.length)continue;
      const part=new THREE.BufferGeometry();
      for(const [name,attribute] of Object.entries(geometry.attributes)) {
        const array=new attribute.array.constructor(indices.length*attribute.itemSize);
        indices.forEach((index,j)=>{for(let k=0;k<attribute.itemSize;k++)array[j*attribute.itemSize+k]=attribute.array[index*attribute.itemSize+k];});
        part.setAttribute(name,new THREE.BufferAttribute(array,attribute.itemSize,attribute.normalized));
      }
      const node=new THREE.Mesh(part,source.material);node.name=name;
      if(name==='DrillBit') {
        part.translate(-center.x,0,-center.z);node.position.set(center.x,0,center.z);
      }
      assembly.add(node);
    }
    source.parent.add(assembly);source.removeFromParent();
    geometry.dispose();source.geometry.dispose();
  }
}
