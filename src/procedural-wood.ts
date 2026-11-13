import * as THREE from 'three';

export type GrainDirection = 'auto' | 'x' | 'y' | 'z';
export const grainDirections = { auto: '沿部件长轴', x: '部件 X 轴', y: '部件 Y 轴', z: '部件 Z 轴' };

const woodShader = /* glsl */ `
varying vec3 vWoodPosition;
uniform float woodScale, woodDetail, woodSeed;
float woodHash(vec3 p) {
  p = fract(p * .1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float woodNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f*f*(3.-2.*f);
  return mix(
    mix(mix(woodHash(i),woodHash(i+vec3(1,0,0)),f.x),
        mix(woodHash(i+vec3(0,1,0)),woodHash(i+vec3(1,1,0)),f.x),f.y),
    mix(mix(woodHash(i+vec3(0,0,1)),woodHash(i+vec3(1,0,1)),f.x),
        mix(woodHash(i+vec3(0,1,1)),woodHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float woodBand(vec3 p) {
  vec3 footprint = fwidth(p);
  float fade = 1.-smoothstep(.30,1.15,max(footprint.x,max(footprint.y,footprint.z)));
  return (woodNoise(p)-.5)*fade;
}
`;

export function applyProceduralSurface(material: THREE.MeshStandardMaterial, mesh: THREE.Mesh,
  pattern: 'oak' | 'walnut' | 'engineered_stone', direction: GrainDirection, scale: number, detail: number) {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox!;
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 1e-8);
  const axis = direction === 'auto'
    ? (size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z')
    : direction;
  // Replacing the finish removes texture inputs that would compete with the wood.
  material.map = null;
  material.roughnessMap = null;
  material.metalnessMap = null;
  material.bumpMap = null;
  material.normalMap = null;
  material.vertexColors = false;
  if (material instanceof THREE.MeshPhysicalMaterial) {
    material.clearcoat = material.sheen = material.anisotropy = material.transmission = 0;
    material.specularIntensity = .65;
  }
  const origin = bounds.min.clone();
  const seed = (origin.x * 2.37 + origin.y * 3.11 + origin.z * 4.53) / span % 37;
  const stone = pattern === 'engineered_stone';
  material.customProgramCacheKey = () => 'workbench-grain-v2-' + (stone ? 'stone' : axis);
  material.onBeforeCompile = shader => {
    shader.uniforms.woodOrigin = { value: origin };
    shader.uniforms.woodInvSpan = { value: 1 / span };
    shader.uniforms.woodScale = { value: scale };
    shader.uniforms.woodDetail = { value: detail };
    shader.uniforms.woodSeed = { value: seed + (pattern === 'walnut' ? 19 : 0) };
    const axes = stone || axis === 'x' ? 'xyz' : axis === 'z' ? 'zxy' : 'yxz';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWoodPosition; uniform vec3 woodOrigin; uniform float woodInvSpan;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWoodPosition = (position - woodOrigin).' + axes + ' * woodInvSpan;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + woodShader)
      .replace('#include <map_fragment>', stone ? `#include <map_fragment>
        vec3 p = (vWoodPosition + woodSeed)*72.*woodScale;
        float spots = smoothstep(.59,.80,woodNoise(p));
        float pores = smoothstep(.70,.90,woodNoise(p*2.1+17.));
        vec3 footprint = fwidth(p);
        float grainFade = 1.-smoothstep(.34,1.3,max(footprint.x,max(footprint.y,footprint.z)));
        float woodHeight = (spots*.65-pores*.35)*grainFade;
        diffuseColor.rgb *= 1.+(.10*spots-.37*pores)*woodDetail*grainFade;
      ` : `#include <map_fragment>
        vec3 woodP = vWoodPosition + vec3(woodSeed, woodSeed*.71, woodSeed*.53);
        vec2 woodWarp = vec2(woodNoise(woodP*vec3(2.,5.,5.)),woodNoise(woodP*vec3(2.,5.,5.)+7.));
        vec3 woodFiber = vec3(woodP.x*3.,woodP.yz*(52.*woodScale)+(woodWarp-.5)*3.);
        float woodCoarse = woodBand(woodFiber*vec3(.85,.32,.32));
        float woodLine = woodBand(woodFiber);
        float woodFine = woodBand(woodFiber*vec3(1.8,2.35,2.35)+13.);
        float woodHeight = woodLine + woodFine*.36;
        float woodColor = woodCoarse*.36 + woodLine*(.54+.46*woodDetail) + woodFine*.26*woodDetail;
        diffuseColor.rgb *= clamp(1.+woodColor, .52, 1.50);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + woodHeight*.08*woodDetail, .18, 1.);
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 woodDx = dFdx(-vViewPosition), woodDy = dFdy(-vViewPosition);
        vec3 woodR1 = cross(woodDy,normal), woodR2 = cross(normal,woodDx);
        float woodDet = dot(woodDx,woodR1);
        vec3 woodGradient = sign(woodDet)*(dFdx(woodHeight)*woodR1+dFdy(woodHeight)*woodR2);
        normal = normalize(max(abs(woodDet),1e-10)*normal - .00016*woodDetail*woodGradient);
      `);
  };
}
