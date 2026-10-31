import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

export const MODEL_NAMES = ['astronaut','drill','oxygen_generator','storage','dome_base','rover'];
export function recolor(root, color) {
  if (!color) return;
  root.traverse(node => {
    for (const material of [node.material].flat().filter(Boolean)) {
      if (material.name === 'Accent') material.color?.set(color);
    }
  });
}
export class ModelLibrary {
  constructor() { this.assets = new Map(); this.loader = new GLTFLoader(); this.disposed=false; }
  async load(onLoad) {
    const response = await fetch('/assets/models/manifest.json');
    if(!response.ok)return;
    const manifest=await response.json();
    const approved=MODEL_NAMES.filter(name=>manifest.approved?.includes(name));
    await Promise.allSettled(approved.map(async name => {
      const asset = await this.loader.loadAsync(`/assets/models/${name}.glb`);
      if(this.disposed) { this.release(asset); return; }
      this.assets.set(name,asset); onLoad?.(name);
    }));
  }
  create(name,color) {
    const asset = this.assets.get(name); if (!asset) return null;
    const root = clone(asset.scene);
    root.traverse(node => {
      node.userData.sharedAsset = true;
      if(node.material) {
        const materials = [node.material].flat().map(m=>m.clone());
        node.material = Array.isArray(node.material) ? materials : materials[0];
      }
    });
    recolor(root,color);
    if(asset.animations.length) {
      const mixer = new THREE.AnimationMixer(root);
      root.userData.animation = { mixer, clips:asset.animations, current:null };
    }
    return root;
  }
  animate(root, state, dt) {
    const animation=root.userData.animation; if(!animation)return;
    if(animation.current!==state) {
      const clip=animation.clips.find(c=>c.name.toLowerCase()===state) || animation.clips[0];
      const action=animation.mixer.clipAction(clip);
      animation.action?.fadeOut(.15); action.reset().fadeIn(.15).play();
      animation.action=action; animation.current=state;
    }
    animation.mixer.update(dt);
  }
  release(asset) {
    const resources=new Set();
    asset.scene.traverse(node=>{
      if(node.geometry)resources.add(node.geometry);
      for(const material of [node.material].flat().filter(Boolean)) {
        resources.add(material);
        for(const value of Object.values(material))if(value?.isTexture)resources.add(value);
      }
    });
    resources.forEach(r=>r.dispose());
  }
  dispose(){ this.disposed=true; this.assets.forEach(asset=>this.release(asset));this.assets.clear(); }
}
