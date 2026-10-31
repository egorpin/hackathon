import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER_SCALE } from './character-scale.js';

const ARM_NAME = /(?:left|right).*(?:arm|forearm|hand)|(?:arm|forearm|hand).*(?:left|right)/i;

/**
 * Camera-space arms extracted from separately named meshes in the astronaut GLB.
 * Pass the loaded GLB scene and optional armPattern if its node names differ.
 * The simple mesh fallback is for loading gaps only.
 */
export class FirstPersonHands {
  constructor(camera, { astronaut = null, armPattern = ARM_NAME, fallback = true } = {}) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.name = 'FirstPersonHands';
    this.root.scale.setScalar(CHARACTER_SCALE);
    this.root.renderOrder = 2;
    camera.add(this.root);
    this.time = 0;
    this.color = new THREE.Color(0xd3a875);
    this.procedural = false;
    this.armNodes = [];
    this.materials = new Set();
    this.accentMaterials = new Set();
    this.geometries = new Set();

    if (astronaut) this.useAstronautArms(astronaut, armPattern);
    if (!this.armNodes.length && fallback) this.createLoadingFallback();
    this.setColor(this.color);
  }

  useAstronautArms(astronaut, pattern) {
    const clone = cloneSkeleton(astronaut);
    clone.name = 'FirstPersonAstronautArms';
    clone.traverse(node => {
      if (node.isMesh || node.isSkinnedMesh) node.visible = false;
    });
    const found = [];
    clone.traverse(node => {
      if (node.isMesh && pattern.test(node.name)) {
        node.visible = true;
        found.push(node);
        if (node.material) {
          node.material = [node.material].flat().map(material => {
            const owned = material.clone();
            this.materials.add(owned);
            if (owned.name.toLowerCase() === 'accent') this.accentMaterials.add(owned);
            return owned;
          });
          if (node.material.length === 1) node.material = node.material[0];
        }
        if (node.geometry) {
          node.geometry = node.geometry.clone();
          this.geometries.add(node.geometry);
        }
      }
    });
    if (!found.length) return;

    // Camera-space model proportions are independent from the world scale.
    const bounds = new THREE.Box3().setFromObject(clone);
    const modelHeight = bounds.getSize(new THREE.Vector3()).y;
    const scale = modelHeight > 0.5 && modelHeight < 5 ? 1.8 / modelHeight : 1;
    clone.position.set(0, -1.65, -0.48);
    clone.scale.setScalar(scale);
    clone.rotation.set(0, Math.PI, 0);
    this.root.add(clone);
    this.armNodes = found;
    this.astronautClone = clone;
    this.procedural = false;
  }

  createLoadingFallback() {
    this.procedural = true;
    const glove = new THREE.MeshStandardMaterial({ color: this.color, roughness: 0.82, flatShading: true });
    const cuff = new THREE.MeshStandardMaterial({ color: 0x76614f, roughness: 0.9, flatShading: true });
    this.materials.add(glove); this.materials.add(cuff);
    this.accentMaterials.add(glove);
    const forearmGeometry = new THREE.CapsuleGeometry(0.072, 0.27, 3, 6);
    const mittenGeometry = new THREE.IcosahedronGeometry(0.12, 1);
    const cuffGeometry = new THREE.CylinderGeometry(0.075, 0.085, 0.09, 7);
    this.geometries.add(forearmGeometry); this.geometries.add(mittenGeometry); this.geometries.add(cuffGeometry);
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.37, -0.48, -0.62);
      arm.rotation.z = side * -0.16;
      this.root.add(arm);
      const forearm = new THREE.Mesh(forearmGeometry, cuff);
      forearm.rotation.x = -0.22;
      forearm.position.set(-side * 0.015, -0.13, 0.05);
      arm.add(forearm);
      const wrist = new THREE.Mesh(cuffGeometry, cuff);
      wrist.rotation.x = -Math.PI / 2;
      wrist.position.set(0, -0.005, -0.01);
      arm.add(wrist);
      const mitten = new THREE.Mesh(mittenGeometry, glove);
      mitten.scale.set(0.88, 0.78, 1.12);
      mitten.position.set(0, 0.065, -0.06);
      arm.add(mitten);
      this.armNodes.push(arm);
    }
  }

  setColor(color) {
    this.color.set(color);
    for (const material of this.accentMaterials) if (material.color) material.color.copy(this.color);
  }

  update(dt, { moving = false, running = false, airborne = false, color, visible = true } = {}) {
    if (color != null) this.setColor(color);
    this.root.visible = visible;
    this.time += Math.max(0, Math.min(dt || 0, 0.05));
    const pace = running ? 11.5 : 7.2;
    const stride = moving ? 1 : 0;
    const bob = Math.sin(this.time * pace);
    for (let i = 0; i < this.armNodes.length; i++) {
      const node = this.armNodes[i];
      const side = i % 2 === 0 ? -1 : 1;
      if (this.procedural) {
        node.position.y = -0.48 + (airborne ? 0.13 : 0) + Math.abs(bob) * 0.014 * stride;
        node.rotation.x = (airborne ? -0.3 : 0) + bob * 0.026 * stride;
        node.rotation.z = side * (-0.16 + (airborne ? 0.08 : 0) + bob * 0.022 * stride);
      } else {
        node.position.y = (node.userData.fpBaseY ??= node.position.y) + (airborne ? 0.08 : 0) + Math.abs(bob) * 0.008 * stride;
        node.rotation.x = (node.userData.fpBaseX ??= node.rotation.x) + (airborne ? -0.14 : 0) + bob * 0.018 * stride;
        node.rotation.z = (node.userData.fpBaseZ ??= node.rotation.z) + side * ((airborne ? 0.07 : 0) + bob * 0.014 * stride);
      }
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    this.armNodes.length = 0;
    this.geometries.clear();
    this.materials.clear();
    this.accentMaterials.clear();
  }
}
