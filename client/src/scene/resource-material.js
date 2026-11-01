import * as THREE from 'three';

const RESOURCE_COLORS = Object.freeze({
  iron: 0x41484c,
  copper: 0xb87545,
  sulfur: 0xd1b04b,
  stone: 0x858b8b,
  ice: 0xa6dce2,
  // Existing server terrain uses "water" for this pale cyan ice deposit.
  water: 0xa6dce2,
});

/**
 * Material for an exposed mineral vein that remains flush with its terrain cell.
 * The broad branching pattern is evaluated from world position, so neighboring
 * cell meshes share the same continuous pattern without image textures.
 */
export function resourceMaterial(kind, center = [0,1,0]) {
  const color = RESOURCE_COLORS[kind];
  if (color === undefined) throw new RangeError(`Unknown resource material: ${kind}`);

  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02 });
  const origin=new THREE.Vector3().fromArray(center), up=origin.clone().normalize();
  const east=new THREE.Vector3(Math.abs(up.y)<.9?0:1,Math.abs(up.y)<.9?1:0,0).cross(up).normalize();
  const north=up.clone().cross(east).normalize();
  material.onBeforeCompile = shader => {
    shader.uniforms.veinOrigin={value:origin};shader.uniforms.veinEast={value:east};shader.uniforms.veinNorth={value:north};
    shader.uniforms.veinGround={value:new THREE.Color(0x9e5034)};
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vResourceWorldPosition;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 resourceWorldPosition = modelMatrix * vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          resourceWorldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        #endif
        vResourceWorldPosition = resourceWorldPosition.xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vResourceWorldPosition;
        uniform vec3 veinOrigin;
        uniform vec3 veinEast;
        uniform vec3 veinNorth;
        uniform vec3 veinGround;
        float veinHash(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }
        float veinNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(veinHash(i), veinHash(i + vec3(1,0,0)), f.x),
                mix(veinHash(i + vec3(0,1,0)), veinHash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(veinHash(i + vec3(0,0,1)), veinHash(i + vec3(1,0,1)), f.x),
                mix(veinHash(i + vec3(0,1,1)), veinHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        vec3 relative = vResourceWorldPosition - veinOrigin;
        vec3 veinP = vec3(dot(relative,veinEast), dot(relative,veinNorth), 0.0) * 0.6;
        vec3 veinWarp = vec3(
          veinNoise(veinP * 0.42 + vec3(2.0, 0.0, 0.0)),
          veinNoise(veinP * 0.42 + vec3(0.0, 5.0, 0.0)),
          veinNoise(veinP * 0.42 + vec3(0.0, 0.0, 8.0))) - 0.5;
        vec3 veinField = veinP + veinWarp * 0.75;
        float mainBand = abs(veinField.y + 0.28 * sin(veinField.x * 1.5) + 0.18 * sin(veinField.z * 1.8));
        float branchBand = abs(veinField.x + 0.24 * sin(veinField.y * 2.0 + veinField.z * 0.55));
        float branchGate = smoothstep(-0.45, 0.65, sin(veinField.y * 1.25 + veinField.z * 1.1));
        float veinDistance = mix(mainBand, min(mainBand, branchBand * 0.82), branchGate);
        float vein = 1.0 - smoothstep(0.075, 0.19, veinDistance);
        float veinEdge = smoothstep(0.16, 0.31, veinDistance) * (1.0 - smoothstep(0.31, 0.4, veinDistance));
        diffuseColor.rgb = mix(veinGround * (0.9 + veinEdge * 0.08), diffuseColor.rgb, vein);
      `);
  };
  material.customProgramCacheKey = () => 'mars-resource-veins-v1';
  return material;
}
