import * as THREE from 'three';

const SKY_VERTEX = `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = `
  uniform vec3 horizonColor;
  uniform vec3 zenithColor;
  uniform vec3 sunsetColor;
  uniform vec3 upDirection;
  uniform vec3 sunDirection;
  uniform float nightAmount;
  varying vec3 vDirection;
  void main() {
    vec3 ray = normalize(vDirection);
    float elevation = dot(ray, normalize(upDirection));
    float horizon = smoothstep(-0.08, 0.72, elevation);
    vec3 daySky = mix(horizonColor, zenithColor, horizon);
    float sunDistance = 1.0 - max(dot(ray, normalize(sunDirection)), 0.0);
    float glow = exp(-sunDistance * 44.0) * 0.32;
    float sunElevation = dot(normalize(upDirection), normalize(sunDirection));
    float sunsetBand = 1.0 - smoothstep(0.04, 0.35, abs(sunElevation));
    float sunset = exp(-sunDistance * 8.0) * sunsetBand;
    daySky = mix(daySky, sunsetColor, sunset * 0.78);
    daySky += vec3(0.12, 0.075, 0.045) * glow * sunsetBand;
    vec3 nightSky = mix(vec3(0.012, 0.016, 0.03), vec3(0.022, 0.028, 0.05), horizon);
    gl_FragColor = vec4(mix(daySky, nightSky, nightAmount), 1.0);
    #include <colorspace_fragment>
  }
`;

const QUALITY = {
  low: { stars: 140, dust: 24 },
  medium: { stars: 320, dust: 48 },
  high: { stars: 600, dust: 80 },
};

const smoothstep = (min, max, value) => {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
};

/** Pure, deterministic lighting state for a shared simulation timestamp. */
export function computeSolarState(sharedTimeSeconds, cycleSeconds, localUp) {
  const cycle = Math.max(60, cycleSeconds);
  const phase = ((sharedTimeSeconds % cycle) + cycle) % cycle / cycle;
  const angle = phase * Math.PI * 2 - Math.PI * 0.5;
  const length = Math.hypot(Math.cos(angle), Math.sin(angle) * 0.28, Math.sin(angle) * 0.96);
  const direction = [Math.cos(angle) / length, Math.sin(angle) * 0.28 / length, Math.sin(angle) * 0.96 / length];
  const upLength = Math.hypot(localUp.x, localUp.y, localUp.z) || 1;
  const elevation = (localUp.x * direction[0] + localUp.y * direction[1] + localUp.z * direction[2]) / upLength;
  const daylight = smoothstep(-0.22, 0.18, elevation);
  return { phase, direction, daylight, night: 1 - daylight };
}

/** Lightweight local sky, sun and weather. sharedTimeSeconds must be common to all clients. */
export class Atmosphere {
  constructor(scene, { cycleSeconds = 600, seed = 9137, quality = 'medium' } = {}) {
    this.scene = scene;
    this.cycleSeconds = Math.max(60, cycleSeconds);
    this.seed = seed >>> 0;
    this.sunDirection = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    this.cameraDirection = new THREE.Vector3(0, 0, -1);
    this.flashlightOn = false;
    this.disposed = false;

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 24, 12),
      new THREE.ShaderMaterial({
        uniforms: {
          horizonColor: { value: new THREE.Color(0xd99570) },
          zenithColor: { value: new THREE.Color(0xc58d70) },
          sunsetColor: { value: new THREE.Color(0x8bb9d0) },
          upDirection: { value: this.up },
          sunDirection: { value: this.sunDirection },
          nightAmount: { value: 0 },
        },
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      }),
    );
    this.sky.renderOrder = -1000;
    this.scene.add(this.sky);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(5.2, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffe7c1, fog: false, toneMapped: false }),
    );
    this.scene.add(this.sun);
    this.sunLight = new THREE.DirectionalLight(0xffd7ae, 1.7);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.fillStars();
    this.fillDust();

    this.flashlight = new THREE.SpotLight(0xffe7d0, 0, 22, Math.PI / 7, 0.65, 1.5);
    this.flashlight.position.set(0, 0, 0);
    this.flashlightTarget = new THREE.Object3D();
    this.scene.add(this.flashlight, this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    this.onKeyDown = event => {
      if (event.code !== 'KeyF' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || document.querySelector('dialog[open]') || event.target?.closest?.('input,textarea,select,[contenteditable=true]')) return;
      this.setFlashlight(!this.flashlightOn);
    };
    window.addEventListener('keydown', this.onKeyDown);
    this.setQuality(quality);
  }

  random() {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  fillStars() {
    const count = QUALITY.high.stars;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // Uniform points on a unit sphere, scaled to form a sky shell around the camera.
      const y = this.random() * 2 - 1;
      const angle = this.random() * Math.PI * 2;
      const ring = Math.sqrt(1 - y * y);
      positions[i * 3] = Math.cos(angle) * ring * 500;
      positions[i * 3 + 1] = y * 500;
      positions[i * 3 + 2] = Math.sin(angle) * ring * 500;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.stars = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xd9e7ff, size: 1.8, sizeAttenuation: false, transparent: true,
      opacity: 0, depthWrite: false, fog: false,
    }));
    this.stars.renderOrder = -900;
    this.scene.add(this.stars);
  }

  fillDust() {
    const count = QUALITY.high.dust;
    const positions = new Float32Array(count * 3);
    this.dustMotion = [];
    for (let i = 0; i < count; i++) {
      const x = (this.random() - 0.5) * 18;
      const y = (this.random() - 0.5) * 9;
      const z = -this.random() * 18;
      positions.set([x, y, z], i * 3);
      this.dustMotion.push({ x, y, z, drift: 0.25 + this.random() * 0.55, sway: this.random() * 6.28 });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.dust = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xd89967, size: 0.065, sizeAttenuation: true, transparent: true,
      opacity: 0.12, depthWrite: false, fog: true,
    }));
    this.scene.add(this.dust);
    this.dustPositions = positions;
  }

  setQuality(level) {
    const counts = QUALITY[level] || QUALITY.medium;
    this.quality = QUALITY[level] ? level : 'medium';
    this.stars.geometry.setDrawRange(0, counts.stars);
    this.dust.geometry.setDrawRange(0, counts.dust);
  }

  setFlashlight(enabled) {
    this.flashlightOn = Boolean(enabled);
    this.flashlight.intensity = this.flashlightOn ? 17 : 0;
  }

  toggleFlashlight() { this.setFlashlight(!this.flashlightOn); }

  update(sharedTimeSeconds, camera, localUp, dt = 0, {dust = true, animations = true} = {}) {
    if (this.disposed) return;
    const solar = computeSolarState(sharedTimeSeconds, this.cycleSeconds, localUp);
    this.sunDirection.fromArray(solar.direction);
    this.up.copy(localUp).normalize();
    const { daylight, night } = solar;
    const uniforms = this.sky.material.uniforms;
    uniforms.upDirection.value.copy(this.up);
    uniforms.sunDirection.value.copy(this.sunDirection);
    uniforms.nightAmount.value = night;
    this.sky.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.sunDirection, 490);
    this.sun.visible = this.up.dot(this.sunDirection) > 0;
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(400);
    this.sunLight.target.position.set(0, 0, 0);
    this.sunLight.intensity = 0.12 + daylight * 1.75;
    this.sunLight.color.setHSL(0.09, 0.54, 0.65 + daylight * 0.1);
    this.stars.position.copy(camera.position);
    this.stars.material.opacity = THREE.MathUtils.smoothstep(night, 0.28, 0.82) * 0.88;

    this.cameraDirection.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    this.flashlight.position.copy(camera.position);
    this.flashlightTarget.position.copy(camera.position).addScaledVector(this.cameraDirection, 12);
    this.dust.position.copy(camera.position);
    this.dust.quaternion.copy(camera.quaternion);
    const positions = this.dustPositions;
    const elapsed = sharedTimeSeconds;
    for (let i = 0; dust && animations && i < this.dustMotion.length; i++) {
      const p = this.dustMotion[i];
      const offset = i * 3;
      p.x += dt * p.drift;
      if (p.x > 9) p.x = -9;
      positions[offset] = p.x + Math.sin(elapsed * 0.45 + p.sway) * 0.22;
      positions[offset + 1] = p.y + Math.sin(elapsed * 0.7 + p.sway) * 0.12;
      positions[offset + 2] = p.z;
    }
    if(dust && animations) this.dust.geometry.attributes.position.needsUpdate = true;
    this.dust.visible = dust && daylight > 0.12;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    for (const object of [this.sky, this.sun, this.stars, this.dust]) {
      object.geometry.dispose();
      object.material.dispose();
      object.removeFromParent();
    }
    this.sunLight.removeFromParent();
    this.sunLight.target.removeFromParent();
    this.flashlight.removeFromParent();
    this.flashlightTarget.removeFromParent();
  }
}
