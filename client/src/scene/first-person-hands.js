import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { recolor } from './model-library.js';

const ARM_NAME = /(?:left|right).*(?:arm|forearm|hand)|(?:arm|forearm|hand).*(?:left|right)/i;
const STATE_ALIASES = {
  idle: /idle|stand|breath/i,
  walk: /walk|walking/i,
  run: /run|running|sprint/i,
  jump: /jump|air|fall/i,
};

/** Camera-space copy of the astronaut's animated, skinned arm meshes. */
export class FirstPersonHands {
  constructor(camera, { astronaut = null, animations = [], armPattern = ARM_NAME } = {}) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'FirstPersonHands';
    this.root.renderOrder = 2;
    camera.add(this.root);
    this.time = 0;
    this.color = new THREE.Color(0xd3a875);
    this.armNodes = [];
    this.materials = new Set();
    this.accentMaterials = new Set();
    this.geometries = new Set();
    this.mixer = null;
    this.actions = new Map();
    this.currentAction = null;
    this.currentState = null;
    this.viewArms = [];

    if (astronaut) this.useAstronautArms(astronaut, armPattern, animations);
    this.setColor(this.color);
  }

  useAstronautArms(astronaut, pattern, animations) {
    const clone = cloneSkeleton(astronaut);
    clone.name = 'FirstPersonAstronautArms';
    clone.traverse(node => {
      if (node.isMesh) node.visible = false;
    });
    const found = [];
    clone.traverse(node => {
      if (!(node.isMesh || node.isSkinnedMesh) || !pattern.test(node.name)) return;
      node.visible = true;
      found.push(node);
      if (node.material) {
        const originals = Array.isArray(node.material) ? node.material : [node.material];
        const copies = originals.map(material => {
          const owned = material.clone();
          // Close-up fabric should not inherit the generated metallic highlights.
          owned.metalness = 0;
          owned.metalnessMap = null;
          owned.roughness = 0.9;
          owned.roughnessMap = null;
          owned.normalScale?.setScalar(0.25);
          this.materials.add(owned);
          if (owned.name.toLowerCase() === 'accent') this.accentMaterials.add(owned);
          return owned;
        });
        node.material = Array.isArray(node.material) ? copies : copies[0];
      }
      if (node.geometry) {
        node.geometry = node.geometry.clone();
        this.geometries.add(node.geometry);
      }
    });
    if (!found.length) return;

    // Record bind directions before placing the model in camera space.
    const skeletons=new Set(found.map(node=>node.skeleton).filter(Boolean));
    skeletons.forEach(skeleton=>skeleton.pose());
    clone.updateMatrixWorld(true);
    for(const side of ['Left','Right']) {
      const upper=clone.getObjectByName(side+'Arm'),lower=clone.getObjectByName(side+'Forearm'),hand=clone.getObjectByName(side+'Hand');
      if(!upper?.isBone || !lower?.isBone || !hand?.isBone)continue;
      const shoulder=upper.getWorldPosition(new THREE.Vector3()),elbow=lower.getWorldPosition(new THREE.Vector3()),wrist=hand.getWorldPosition(new THREE.Vector3());
      this.viewArms.push({upper,lower,hand,sign:Math.sign(shoulder.x)||1,
        upperDirection:elbow.clone().sub(shoulder).normalize(),lowerDirection:wrist.clone().sub(elbow).normalize(),
        upperRotation:upper.getWorldQuaternion(new THREE.Quaternion()),lowerRotation:lower.getWorldQuaternion(new THREE.Quaternion())});
    }

    // The source is normalized to 1.8 m, feet at Y=0 and Y-up. Keep only its
    // arm meshes visible, while retaining the complete cloned skeleton for skinning.
    // Pull the upper arms behind the camera; show forearms from roughly the elbows.
    clone.scale.setScalar(0.7);
    clone.position.set(0, -0.96, -0.04);
    clone.rotation.set(0, Math.PI, 0);
    this.root.add(clone);
    this.armNodes = found;
    this.astronautClone = clone;
    // The animated hands can leave their bind-pose bounds near the camera.
    found.forEach(node=>{node.frustumCulled=false;});
    if (animations?.length) {
      this.mixer = new THREE.AnimationMixer(clone);
      for (const clip of animations) this.actions.set(clip.name, this.mixer.clipAction(clip));
      this.playState('idle', true);
    }
  }

  setColor(color) {
    this.color.set(color);
    for (const node of this.armNodes) recolor(node, this.color);
    for (const material of this.accentMaterials) if (material.color) material.color.copy(this.color);
  }

  playState(state, immediate = false) {
    if (!this.mixer || this.currentState === state) return;
    const alias = STATE_ALIASES[state] || STATE_ALIASES.idle;
    const clipName = [...this.actions.keys()].find(name => alias.test(name));
    const action = this.actions.get(clipName) || this.actions.values().next().value;
    if (!action) return;
    if (this.currentAction && this.currentAction !== action) {
      if (immediate) this.currentAction.stop();
      else this.currentAction.fadeOut(0.15);
    }
    action.setLoop(state === 'jump' ? THREE.LoopOnce : THREE.LoopRepeat, state === 'jump' ? 1 : Infinity);
    action.clampWhenFinished = state === 'jump';
    action.reset().fadeIn(immediate ? 0 : 0.15).play();
    this.currentAction = action;
    this.currentState = state;
  }

  update(dt, { moving = false, running = false, airborne = false, color, visible = true } = {}) {
    if (color != null) this.setColor(color);
    this.root.visible = visible;
    const delta = Math.max(0, Math.min(dt || 0, 0.05));
    this.time += delta;
    if (this.mixer) {
      this.playState(airborne ? 'jump' : moving ? (running ? 'run' : 'walk') : 'idle');
      this.mixer.update(delta);
    }
    if(!this.astronautClone)return;
    // Camera-specific skeletal pose: elbows below the eye, mittens forward.
    // The world character keeps its full-body clips; only this private clone changes.
    this.astronautClone.updateWorldMatrix(true,true);
    const modelRotation=this.astronautClone.getWorldQuaternion(new THREE.Quaternion());
    for(const arm of this.viewArms) {
      const sway=moving?Math.sin(this.time*(running?11:7)+arm.sign)* (running?.12:.055):0;
      const aim=(bone,restDirection,restRotation,direction)=>{
        const turn=new THREE.Quaternion().setFromUnitVectors(restDirection,direction.normalize());
        const wanted=modelRotation.clone().multiply(turn).multiply(restRotation);
        const parent=bone.parent.getWorldQuaternion(new THREE.Quaternion());
        bone.quaternion.copy(parent.invert().multiply(wanted));bone.updateWorldMatrix(false,true);
      };
      aim(arm.upper,arm.upperDirection,arm.upperRotation,new THREE.Vector3(arm.sign*.30,-.8,.5+sway));
      aim(arm.lower,arm.lowerDirection,arm.lowerRotation,new THREE.Vector3(arm.sign*.05,.25+(airborne?.2:0)+sway,1));
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.astronautClone);
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.astronautClone?.traverse(node => {
      if (node.skeleton?.boneTexture) node.skeleton.boneTexture.dispose();
    });
    this.armNodes.length = 0;
    this.geometries.clear();
    this.materials.clear();
    this.accentMaterials.clear();
    this.actions.clear();
  }
}
