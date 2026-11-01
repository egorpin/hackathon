import * as THREE from 'three';
export const isPlan = data => ['planned','building'].includes(data?.construction_status);
export function setPlanVisual(root, enabled, color=0x71e7ff) {
  root.traverse(node=>{
    if(!node.isMesh)return;
    for(const m of [node.material].flat().filter(Boolean)) {
      if(enabled && !m.userData.planOriginal)m.userData.planOriginal={wireframe:m.wireframe,transparent:m.transparent,opacity:m.opacity,depthWrite:m.depthWrite,map:m.map,color:m.color?.clone()};
      if(enabled){m.wireframe=true;m.transparent=true;m.opacity=.38;m.depthWrite=false;m.map=null;m.color?.setHex(color);}
      else if(m.userData.planOriginal){const saved=m.userData.planOriginal;Object.assign(m,saved);delete m.userData.planOriginal;}
      m.needsUpdate=true;
    }
  });
  root.userData.constructionPlan=enabled;
}
