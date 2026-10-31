import * as THREE from 'three';

// Visual-only regolith. Object-space 3D noise is continuous across the sphere,
// including poles: no UV seam, external texture, height map or hidden world data.
export function marsMaterial() {
  const material = new THREE.MeshStandardMaterial({ color: 0x9e5034, roughness: .98, metalness: 0 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMarsPosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMarsPosition = position;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      varying vec3 vMarsPosition;
      float marsHash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }
      float marsNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(marsHash(i), marsHash(i+vec3(1,0,0)), f.x),
              mix(marsHash(i+vec3(0,1,0)), marsHash(i+vec3(1,1,0)), f.x), f.y),
          mix(mix(marsHash(i+vec3(0,0,1)), marsHash(i+vec3(1,0,1)), f.x),
              mix(marsHash(i+vec3(0,1,1)), marsHash(i+vec3(1,1,1)), f.x), f.y), f.z);
      }
    `).replace('#include <color_fragment>', `
      #include <color_fragment>
      float dust = marsNoise(vMarsPosition * 0.32);
      float grit = marsNoise(vMarsPosition * 5.0);
      float detailFade = 1.0 - smoothstep(0.015, 0.09, length(fwidth(vMarsPosition)));
      float sand = marsNoise(vMarsPosition * 34.0);
      float grain = (grit - 0.5) * 0.13 + (sand - 0.5) * 0.12 * detailFade;
      diffuseColor.rgb *= 0.84 + dust * 0.32 + grain;
      diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 0.93, 0.86), dust * 0.22);
    `);
  };
  material.customProgramCacheKey = () => 'mars-regolith-v1';
  return material;
}

export function smoothSurface(radius) {
  // A generic sphere derived only from the already-accounted world radius.
  // This visual representation contains no cells or additional world state.
  return new THREE.Mesh(new THREE.SphereGeometry(radius - .025, 256, 128), marsMaterial());
}

// Shared edge interpolation keeps cell picking and landing markings on the sphere.
export function sphericalOutline(vertices, radius, segments = 8) {
  const points = [];
  for(let i=0; i<vertices.length; i++) {
    const a = new THREE.Vector3().fromArray(vertices[i]);
    const b = new THREE.Vector3().fromArray(vertices[(i+1)%vertices.length]);
    for(let k=0;k<segments;k++) points.push(a.clone().lerp(b,k/segments).normalize().multiplyScalar(radius));
  }
  points.push(points[0].clone());
  return new THREE.BufferGeometry().setFromPoints(points);
}

export function sphericalCellGeometry(vertices, center, radius, subdivisions = 2) {
  const normal = new THREE.Vector3().fromArray(center).normalize();
  const corners = vertices.map(v=>new THREE.Vector3().fromArray(v).normalize());
  if(corners[1].clone().sub(corners[0]).cross(corners[2].clone().sub(corners[0])).dot(normal)<0)corners.reverse();
  const positions=[], normals=[];
  const triangle=(a,b,c,depth)=>{
    if(depth) {
      const ab=a.clone().add(b).normalize(), bc=b.clone().add(c).normalize(), ca=c.clone().add(a).normalize();
      triangle(a,ab,ca,depth-1);triangle(ab,b,bc,depth-1);triangle(ca,bc,c,depth-1);triangle(ab,bc,ca,depth-1);
    } else for(const point of [a,b,c]) {
      positions.push(...point.clone().multiplyScalar(radius).toArray());normals.push(...point.toArray());
    }
  };
  for(let i=0;i<corners.length;i++)triangle(normal,corners[i],corners[(i+1)%corners.length],subdivisions);
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
  return geometry;
}
