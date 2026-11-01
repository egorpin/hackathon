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
function arcDistance(point, start, end, radius) {
  const a=start.clone().normalize(), b=end.clone().normalize(), p=point.clone().normalize();
  const extent=Math.acos(THREE.MathUtils.clamp(a.dot(b),-1,1));
  if(extent<1e-10)return surfaceDistance(point,start,radius);
  const tangent=b.clone().addScaledVector(a,-a.dot(b)).normalize();
  const along=Math.atan2(p.dot(tangent),p.dot(a));
  if(along>=0&&along<=extent){
    const closest=a.clone().multiplyScalar(Math.cos(along)).addScaledVector(tangent,Math.sin(along));
    return surfaceDistance(point,closest,radius);
  }
  return Math.min(surfaceDistance(point,start,radius),surfaceDistance(point,end,radius));
}
export function advance(position, heading, axes, speed, dt, radius, obstacles = []) {
  const { up, forward, right } = tangent(position, heading);
  const displacement = forward.multiplyScalar(axes.forward).addScaledVector(right, axes.right);
  if (displacement.lengthSq() > 1) displacement.normalize();
  const next = position.clone().addScaledVector(displacement, speed * dt).normalize().multiplyScalar(radius);
  const blocked=obstacles.some(obstacle=>{
    const center=Array.isArray(obstacle)?vector(obstacle[0]):vector(obstacle.position);
    const clearance=Array.isArray(obstacle)?obstacle[1]:obstacle.radius;
    if(arcDistance(center,position,next,radius)>=clearance)return false;
    const startClearance=surfaceDistance(center,position,radius);
    return startClearance>=clearance || surfaceDistance(center,next,radius)<=startClearance;
  });
  if(blocked)return {position:position.clone(),heading:heading.clone()};
  const rotation = new THREE.Quaternion().setFromUnitVectors(up, next.clone().normalize());
  return { position: next, heading: heading.clone().applyQuaternion(rotation).normalize() };
}
export function surfaceDistance(a, b, radius) {
  return Math.acos(THREE.MathUtils.clamp(a.clone().normalize().dot(b.clone().normalize()), -1, 1)) * radius;
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
