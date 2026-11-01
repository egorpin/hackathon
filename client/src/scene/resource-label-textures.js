import * as THREE from 'three';

export const RESOURCE_LABELS = Object.freeze({ water: 'Л', ice: 'Л', iron: 'Ж', sulfur: 'С', copper: 'М' });

// One canvas and GPU texture per resource type for the life of a scene.
export class ResourceLabelTextures {
  constructor(createCanvas=()=>document.createElement('canvas')) {
    this.createCanvas=createCanvas;
    this.textures=new Map();
  }
  get(resource) {
    if (!Object.hasOwn(RESOURCE_LABELS,resource)) return null;
    if (this.textures.has(resource)) return this.textures.get(resource);
    const canvas=this.createCanvas(); canvas.width=canvas.height=128;
    const context=canvas.getContext('2d');
    context.font='bold 104px sans-serif'; context.textAlign='center'; context.textBaseline='middle';
    context.lineWidth=9; context.strokeStyle='#241710'; context.fillStyle='#ffffff';
    context.strokeText(RESOURCE_LABELS[resource],64,68); context.fillText(RESOURCE_LABELS[resource],64,68);
    const texture=new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace;
    this.textures.set(resource,texture);
    return texture;
  }
  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }
}
