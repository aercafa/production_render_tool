import * as THREE from 'three';
import { premiumStudio } from './render-config';

type LitMaterial = THREE.MeshStandardMaterial | THREE.MeshPhongMaterial;
type Range = { start: number; count: number };

function panelGeometry(geometry: THREE.BufferGeometry, materialIndex: number | null) {
  const p = geometry.getAttribute('position');
  const index = geometry.index;
  const length = index?.count ?? p.count;
  const ranges: Range[] = materialIndex === null
    ? [{ start: 0, count: length }]
    : geometry.groups.filter(group => group.materialIndex === materialIndex);
  const box = materialIndex === null ? geometry.boundingBox! : new THREE.Box3();
  const pointAt = (target: THREE.Vector3, i: number) => target.fromBufferAttribute(p, index ? index.getX(i) : i);
  function forEachPoint(callback: (v: THREE.Vector3) => boolean | void) {
    const v = new THREE.Vector3();
    if (materialIndex === null) {
      for (let i = 0; i < p.count; i++) if (callback(v.fromBufferAttribute(p, i)) === false) return false;
    } else {
      for (const { start, count } of ranges) {
        for (let i = start; i < start + count; i++) if (callback(pointAt(v, i)) === false) return false;
      }
    }
    return true;
  }
  if (materialIndex !== null) forEachPoint(v => { box.expandByPoint(v); });
  return { box, ranges, pointAt, forEachPoint };
}

function isThinPanel(panel: ReturnType<typeof panelGeometry>) {
  const { box, ranges, pointAt, forEachPoint } = panel;
  if (box.isEmpty()) return false;
  const span = Math.max(...box.getSize(new THREE.Vector3()));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const best = new THREE.Vector3();
  for (const { start, count } of ranges) {
    const stride = Math.max(1, Math.floor(count / 768)) * 3;
    for (let i = start; i + 2 < start + count; i += stride) {
      pointAt(a, i);
      pointAt(b, i + 1).sub(a);
      pointAt(c, i + 2).sub(a);
      b.cross(c);
      if (b.lengthSq() > best.lengthSq()) best.copy(b);
    }
  }
  if (best.lengthSq() === 0) return false;
  best.normalize();
  let low = Infinity, high = -Infinity;
  return forEachPoint(v => {
    const distance = v.dot(best);
    low = Math.min(low, distance);
    high = Math.max(high, distance);
    if (high - low > span * .065) return false;
  });
}

/** Preserve the source material and add a soft studio-card reflection on screen glass. */
function glassMaterial(source: LitMaterial, box: THREE.Box3) {
  const glass = source.clone();
  const range = box.getSize(new THREE.Vector3());
  const other = range.y >= range.z ? 1 : 2;
  const epsilon = Math.max(...range) * 1e-6 || 1e-6;
  range.max(new THREE.Vector3(epsilon, epsilon, epsilon));
  if (glass instanceof THREE.MeshStandardMaterial) {
    if (!glass.roughnessMap) glass.roughness = Math.max(glass.roughness, glass.userData.rhinoPbr ? .26 : .17);
    if (!glass.userData.rhinoPbr) glass.metalness = 0;
  } else if (glass instanceof THREE.MeshPhongMaterial) {
    glass.shininess = 70;
  }
  glass.customProgramCacheKey = () => 'studio-glass-v1';
  glass.userData.screenGlass = true;
  glass.onBeforeCompile = shader => {
    shader.uniforms.studioMin = { value: box.min.clone() };
    shader.uniforms.studioSpan = { value: range };
    shader.uniforms.studioAxis = { value: other };
    shader.uniforms.studioBase = { value: !source.map && !source.vertexColors && !source.transparent ? .70 : 1 };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 studioMin, studioSpan;\nvarying vec3 vStudioPanel;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStudioPanel = (position - studioMin) / studioSpan;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vStudioPanel;\nuniform float studioAxis, studioBase;')
      .replace('#include <opaque_fragment>', [
        'vec3 studioView = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);',
        'vec3 studioWorldView = inverseTransformDirection(studioView, viewMatrix);',
        'float studioF = 0.04 + 0.96 * pow(1.0 - clamp(dot(normal, studioView), 0.0, 1.0), 5.0);',
        'float studioU = vStudioPanel.x;',
        'float studioV = studioAxis < 1.5 ? vStudioPanel.y : vStudioPanel.z;',
        'float studioPhase = studioU + (0.35 - 0.34 * studioWorldView.x) * studioV + 0.13 * studioWorldView.x - 0.53;',
        'float studioCard = exp(-pow(abs(studioPhase) / 0.18, 3.0)) * (0.44 + 0.56 * studioV);',
        'float studioRim = exp(-pow((studioPhase + 0.16) / 0.037, 2.0));',
        'float studioTop = exp(-pow((studioV - 0.94) / 0.19, 2.0));',
        'outgoingLight *= studioBase;',
        'outgoingLight += vec3(0.005, 0.007, 0.010) + vec3(0.039, 0.050, 0.069) * (studioCard * (0.75 + 1.5 * studioF) + 0.12 * studioRim + 0.085 * studioTop + 0.18 * studioF);',
        '#include <opaque_fragment>',
      ].join('\n'));
  };
  return glass;
}

export function styleRenderMesh(mesh: THREE.Mesh) {
  const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const attributes = mesh.userData.attributes as { drawColor?: { r: number; g: number; b: number } } | undefined;
  const replacements = source.map((material, index) => {
    if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial)) return material;
    let base = material;
    // Rhino's unassigned fallback is white metal; preserve the object's display color for those parts.
    if (material.name === THREE.Loader.DEFAULT_MATERIAL_NAME && material instanceof THREE.MeshStandardMaterial) {
      base = material.clone();
      base.name = mesh.name || material.name;
      const color = attributes?.drawColor;
      if (color && [color.r, color.g, color.b].every(Number.isFinite)) {
        base.color.setRGB(color.r / 255, color.g / 255, color.b / 255, THREE.SRGBColorSpace);
      }
      (base as THREE.MeshStandardMaterial).metalness = .08;
      (base as THREE.MeshStandardMaterial).roughness = .62;
    }
    const name = material.name + ' ' + mesh.name;
    const glassName = /玻璃|黑玻|黑色丝印|\bglass\b|glazing|cover[ _-]?glass/i;
    const matte = /哑光|漫反射|matte|anti[ _-]?glare|\bLED\b/i.test(name);
    const screen = /显示屏|触摸屏|屏幕|可视区域|\bscreen\b|\bdisplay\b/i.test(name);
    const dark = !base.map && !base.vertexColors && Math.max(base.color.r, base.color.g, base.color.b) < .055;
    if (!matte && (glassName.test(name) || screen || dark)) {
      const panel = panelGeometry(mesh.geometry, Array.isArray(mesh.material) ? index : null);
      if (!panel.box.isEmpty() && (glassName.test(material.name) || isThinPanel(panel))) {
        return glassMaterial(base, panel.box);
      }
    }
    return base;
  });
  mesh.material = Array.isArray(mesh.material) ? replacements : replacements[0];
}

export function premiumSurface(source: THREE.Material, objectName: string) {
  if (source.userData.rhinoPbr) return 'source';
  if (source.userData.screenGlass) return 'glass';
  const label = (source.name + ' ' + objectName).replaceAll('_', ' ');
  if (/喷涂|烤漆|粉末涂层|powder|paint|coating|lacquer/i.test(label)) return 'coating';
  if (/拉丝|brushed/i.test(label)) return 'brushed';
  if (/亚光金属|哑光金属|matte[ -]+metal/i.test(label)) return 'matte-metal';
  if (/金属|裸铝|铝合金|不锈钢|青铜|黄铜|镀铬|\b(?:aluminium|aluminum|steel|chrome|bronze|brass|copper|metal)\b/i.test(label)) return 'metal';
  return 'source';
}

/** Use explicit PBR values when supplied and infer a finish for named legacy materials. */
export function premiumMaterial(source: THREE.Material, finish: ReturnType<typeof premiumSurface>) {
  if (!(source instanceof THREE.MeshPhongMaterial) && !(source instanceof THREE.MeshStandardMaterial)) return source;
  const m = source instanceof THREE.MeshPhysicalMaterial ? source.clone() : new THREE.MeshPhysicalMaterial({
    name: source.name, color: source.color, map: source.map, emissive: source.emissive,
    emissiveIntensity: source.emissiveIntensity, emissiveMap: source.emissiveMap,
    normalMap: source.normalMap, normalScale: source.normalScale, bumpMap: source.bumpMap, bumpScale: source.bumpScale,
    alphaMap: source.alphaMap, alphaTest: source.alphaTest, opacity: source.opacity,
    transparent: source.transparent, side: source.side, vertexColors: source.vertexColors,
    depthTest: source.depthTest, depthWrite: source.depthWrite, flatShading: source.flatShading,
    roughness: source instanceof THREE.MeshStandardMaterial ? source.roughness :
      THREE.MathUtils.clamp(Math.sqrt(2 / (Math.max(1, source.shininess)+2)), .32, .82),
    metalness: source instanceof THREE.MeshStandardMaterial ? source.metalness : 0,
    roughnessMap: source instanceof THREE.MeshStandardMaterial ? source.roughnessMap : null,
    metalnessMap: source instanceof THREE.MeshStandardMaterial ? source.metalnessMap : null,
    aoMap: source.aoMap, aoMapIntensity: source.aoMapIntensity,
  });
  const legacyShine = source.userData.legacyShine;
  if (typeof legacyShine === 'number' && legacyShine > 0 && !m.roughnessMap) {
    m.roughness = THREE.MathUtils.clamp(Math.sqrt(2 / (legacyShine + 2)), .28, .75);
  }
  if (finish === 'glass') {
    m.clearcoat = .58;
    m.clearcoatRoughness = .24;
    m.roughness = .24;
  } else if ((finish === 'metal' || finish === 'brushed' || finish === 'matte-metal') && !m.metalnessMap && !m.transparent) {
    const metal = premiumStudio.legacyMetal;
    m.metalness = Math.max(m.metalness, metal.metalness);
    if (!m.roughnessMap) {
      if (finish === 'matte-metal') m.roughness = Math.max(m.roughness, .48);
      else {
        const maxRoughness = finish === 'brushed' ? metal.brushedMaxRoughness : metal.maxRoughness;
        m.roughness = THREE.MathUtils.clamp(m.roughness, metal.minRoughness, maxRoughness);
      }
    }
    if (finish === 'brushed' && !m.anisotropyMap) m.anisotropy = Math.max(m.anisotropy, metal.anisotropy);
  } else if (finish === 'coating') {
    m.clearcoat = Math.max(m.clearcoat,.23);
    m.clearcoatRoughness = .37;
  }
  // clone()/conversion does not copy custom material shaders.
  m.onBeforeCompile = source.onBeforeCompile;
  m.customProgramCacheKey = source.customProgramCacheKey;
  return m;
}
