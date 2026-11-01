import * as THREE from 'three';

// Rotation follows measured travel, so a stopped rover has stationary wheels.
export function updateRoverWheels(root, position, enabled = true) {
  let state = root.userData.wheelMotion;
  if (!state) {
    const wheels=[];
    root.traverse(node=>{if(/^Wheel_\d+$/.test(node.name))wheels.push(node);});
    state=root.userData.wheelMotion={wheels,previous:position.clone()};
    return;
  }
  const delta=position.clone().sub(state.previous);
  state.previous.copy(position);
  const distance=delta.length();
  if (!enabled || distance<1e-7 || distance>2) return;
  const forward=new THREE.Vector3(0,0,1).applyQuaternion(root.quaternion);
  const radius=.32*Math.abs(root.scale.x);
  const angle=distance/radius*(delta.dot(forward)>=0?1:-1);
  for(const wheel of state.wheels)wheel.rotateX(angle);
}
