// Seeded analytic terrain kept in lockstep with server/app/world/terrain.py.
export const DEFAULT_TERRAIN_SEED = 0x4d415253;
let currentSeed = DEFAULT_TERRAIN_SEED;
let features = makeFeatures(currentSeed);

function makeFeatures(seed) {
  let state = (Number(seed) >>> 0) || DEFAULT_TERRAIN_SEED;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  const centers = [];
  const feature = () => {
    for (;;) {
      const y = random() * 2 - 1, angle = random() * Math.PI * 2;
      const radial = Math.sqrt(Math.max(0, 1-y*y));
      const point = [radial*Math.cos(angle), y, radial*Math.sin(angle)];
      if (centers.every(other => Math.acos(Math.max(-1,Math.min(1,point[0]*other[0]+point[1]*other[1]+point[2]*other[2]))) >= .5)) {
        centers.push(point); return point;
      }
    }
  };
  const hills = Array.from({length:4}, () => [...feature(), .30+random()*.10, 1.8+random()*.6]);
  const craters = Array.from({length:3}, () => [...feature(), .22+random()*.06, 1.2+random()*.45, .16+random()*.08]);
  return {hills, craters};
}

export function configureTerrain(seed = DEFAULT_TERRAIN_SEED) {
  currentSeed = (Number(seed) >>> 0) || DEFAULT_TERRAIN_SEED;
  features = makeFeatures(currentSeed);
}

export function terrainHeight(x, y, z, seed = currentSeed) {
  const length = Math.hypot(x,y,z); x/=length; y/=length; z/=length;
  const f = seed === currentSeed ? features : makeFeatures(seed);
  let height = .42*Math.sin(8*x+3*z)*Math.sin(7*z-2*y) + .22*Math.sin(9*y+2*x);
  height += .18*(Math.abs(Math.sin(22*x+9*z))*Math.abs(Math.sin(18*z-7*y))-.4);
  for (const [cx,cy,cz,width,amplitude] of f.hills) {
    const d = Math.acos(Math.max(-1,Math.min(1,x*cx+y*cy+z*cz)))/width;
    height += amplitude*Math.exp(-d*d*1.5);
  }
  for (const [cx,cy,cz,width,depth,rim] of f.craters) {
    const d = Math.acos(Math.max(-1,Math.min(1,x*cx+y*cy+z*cz)))/width;
    height += -depth*Math.exp(-d*d*2) + rim*Math.exp(-Math.pow((d-1)/.4,2));
  }
  return height;
}

export function projectTerrain(position, radius, offset=0, enabled=true) {
  return position.normalize().multiplyScalar(radius + offset + (enabled ? terrainHeight(position.x,position.y,position.z) : 0));
}
