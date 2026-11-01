import * as THREE from 'three';
export const vector = a => new THREE.Vector3().fromArray(a);
export function tangent(position, heading) {
  const up = position.clone().normalize();
  const forward = heading.clone().addScaledVector(up, -heading.dot(up));
  if (forward.lengthSq() < 1e-10) {
    forward.set(Math.abs(up.y) < .9 ? 0 : 1, Math.abs(up.y) < .9 ? 1 : 0, 0);
    forward.addScaledVector(up, -forward.dot(up));
  }
  forward.normalize();
  return { up, forward, right: forward.clone().cross(up).normalize() };
}
export function advance(position, heading, axes, speed, dt, radius) {
  const { up, forward, right } = tangent(position, heading);
  const displacement = forward.multiplyScalar(axes.forward).addScaledVector(right, axes.right);
  if (displacement.lengthSq() > 1) displacement.normalize();
  const next = position.clone().addScaledVector(displacement, speed * dt).normalize().multiplyScalar(radius);
  const rotation = new THREE.Quaternion().setFromUnitVectors(up, next.clone().normalize());
  return { position: next, heading: heading.clone().applyQuaternion(rotation).normalize() };
}
export function surfaceDistance(a, b, radius) {
  const length = Math.sqrt(a.lengthSq() * b.lengthSq());
  return Math.acos(THREE.MathUtils.clamp(length ? a.dot(b) / length : 0, -1, 1)) * radius;
}
export class PlayerTrack {
  constructor() { this.samples = []; }
  push(player, now) {
    this.samples.push({ position: vector(player.position), heading: vector(player.heading || [0,0,-1]), time: now });
    if (this.samples.length > 20) this.samples.shift();
  }
  sample(time, radius, preserveAltitude = false) {
    while (this.samples.length > 2 && this.samples[1].time <= time) this.samples.shift();
    const a = this.samples[0], b = this.samples[1] || a;
    if (!a) return null;
    const t = b.time === a.time ? 0 : THREE.MathUtils.clamp((time-a.time)/(b.time-a.time),0,1);
    const height = preserveAltitude ? THREE.MathUtils.lerp(a.position.length(),b.position.length(),t) : radius;
    return { position: a.position.clone().lerp(b.position,t).normalize().multiplyScalar(height),
      heading: a.heading.clone().lerp(b.heading,t).normalize() };
  }
}
