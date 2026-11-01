import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { prepareDrillParts } from './drill-parts.js';
import { attachMechanicalAnimation } from './mechanical-animation.js';
import { ModelCache } from './model-cache.js';

export const MODEL_NAMES = ['astronaut','drill','oxygen_generator','storage','dome_base','rover','solar_panel','wind_turbine','robot_minion'];
const suitTints = new WeakMap();
function tintSuit(material, color) {
  let uniform = suitTints.get(material);
  if (!uniform) {
    uniform = {value: new THREE.Color(color)};
    suitTints.set(material, uniform);
    material.color.set(0xffffff);
    material.onBeforeCompile = shader => {
      shader.uniforms.playerSuitColor = uniform;
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>',
        '#include <common>\nuniform vec3 playerSuitColor;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #include <map_fragment>
        // Recolor orange/red fabric only; preserve visor, neutral suit and shading.
        float warmPanel = smoothstep(0.08, 0.28, diffuseColor.r - max(diffuseColor.g, diffuseColor.b));
        float panelValue = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
        diffuseColor.rgb = mix(diffuseColor.rgb, playerSuitColor * panelValue, warmPanel);
      `);
    };
    material.customProgramCacheKey = () => 'astronaut-orange-panels-v1';
    material.needsUpdate = true;
  }
  uniform.value.set(color);
}
export function recolor(root, color) {
  if (!color) return;
  root.traverse(node => {
    for (const material of [node.material].flat().filter(Boolean)) {
      if (material.name === 'Accent') material.color?.set(color);
      if (material.name.startsWith('AstronautSuit') || material.name === 'BaseSuit') tintSuit(material,color);
    }
  });
}
export class ModelLibrary {
  constructor() { this.assets = new Map(); this.loader = new GLTFLoader(); this.cache = new ModelCache(); this.disposed=false; this.loading=null; }
  load(onLoad) {
    if (!this.loading) this.loading = this.loadAssets(onLoad).finally(() => { this.loading = null; });
    return this.loading;
  }
  async loadAssets(onLoad) {
    const response = await fetch('/assets/models/manifest.json', {cache:'no-cache'});
    if(!response.ok)return;
    const manifest=await response.json();
    const approved=MODEL_NAMES.filter(name=>manifest.approved?.includes(name));
    const results = await Promise.allSettled(approved.map(async name => {
      if (this.assets.has(name) || this.disposed) return;
      const revision = manifest.versions?.[name] || manifest.revision;
      let asset;
      try {
        const bytes = await this.cache.get(name, revision);
        asset = await this.loader.parseAsync(bytes, '/assets/models/');
      } catch (error) {
        const removed = await this.cache.invalidate(name, revision);
        if (!removed) throw error;
        const bytes = await this.cache.get(name, revision);
        try { asset = await this.loader.parseAsync(bytes, '/assets/models/'); }
        catch (retryError) { await this.cache.invalidate(name, revision); throw retryError; }
      }
      if(this.disposed) { this.release(asset); return; }
      if(name==='drill')prepareDrillParts(asset.scene);
      if(name==='oxygen_generator')asset.scene.traverse(node=>{if(node.isMesh)node.name='OxygenHousing';});
      this.assets.set(name,asset); onLoad?.(name);
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if(failures.length) throw new AggregateError(failures.map(result=>result.reason),'Model loading failed');
  }
  create(name,color) {
    const asset = this.assets.get(name); if (!asset) return null;
    const root = clone(asset.scene);
    const materialCopies = new Map();
    root.traverse(node => {
      node.userData.sharedAsset = true;
      if(node.material) {
        const materials = [node.material].flat().map(m => {
          if (!materialCopies.has(m)) materialCopies.set(m, m.clone());
          return materialCopies.get(m);
        });
        node.material = Array.isArray(node.material) ? materials : materials[0];
      }
    });
    recolor(root,color);
    if(name==='drill')root.userData.mechanical=attachMechanicalAnimation(root,'drill');
    if(name==='oxygen_generator')root.userData.mechanical=attachMechanicalAnimation(root,name);
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
      animation.action?.fadeOut(.15);
      const once=state==='jump'||state==='wave';
      action.reset().setLoop(once?THREE.LoopOnce:THREE.LoopRepeat,once?1:Infinity);
      action.clampWhenFinished=once;
      action.fadeIn(.15).play();
      animation.action=action; animation.current=state;
    }
    animation.mixer.update(dt);
  }
  release(asset) {
    const resources=new Set();
    asset.scene.traverse(node=>{
      if(node.isSkinnedMesh && node.skeleton)resources.add(node.skeleton);
      if(node.geometry)resources.add(node.geometry);
      for(const material of [node.material].flat().filter(Boolean)) {
        resources.add(material);
        for(const value of Object.values(material))if(value?.isTexture)resources.add(value);
      }
    });
    const bitmaps = new Set();
    for (const resource of resources) {
      if (resource.isTexture && typeof resource.source?.data?.close === 'function') bitmaps.add(resource.source.data);
      resource.dispose();
    }
    bitmaps.forEach(bitmap => bitmap.close());
  }
  dispose(){ this.disposed=true; this.cache.clearMemory(); this.assets.forEach(asset=>this.release(asset));this.assets.clear(); }
}
