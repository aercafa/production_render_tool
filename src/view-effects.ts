import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { premiumMaterial, premiumSurface } from './studio';
import { premiumStudio } from './render-config';
import type { MaterialOverrides, MaterialValues, RenderTuning } from './assistant-edits';
import { applyProceduralSurface } from './procedural-wood';

export type RenderStyle = 'studio' | 'premium' | 'clay';
export const EFFECT_BORDER = 144; // covers AO and bloom kernels at 2× PNG export

const fragmentShader = /* glsl */ `
uniform sampler2D uBeauty, uNormal, uDepth, uIdentity, uGlow;
uniform vec2 uSize;
uniform float uPixelsPerUnit, uDepthSpan, uScale;
uniform float uAoStrength, uAoWorldRadius, uAoSheetRadius, uExposure;
uniform bool uClay, uPremium, uBloom;
varying vec2 vUv;

vec4 surface(vec2 uv) { return texture2D(uNormal, uv); }
float depthAt(vec2 uv) { return texture2D(uDepth, uv).r; }

float contactAt(vec2 uv, vec2 offset, float d, vec3 n, float radius) {
  vec2 other = uv + offset/uSize;
  if (surface(other).a < .5) return 0.;
  vec3 delta = vec3(offset/uPixelsPerUnit, (d-depthAt(other))*uDepthSpan);
  float distanceToSample = length(delta);
  float facing = dot(n, delta)/max(distanceToSample, .00001);
  float angle = uPremium ? smoothstep(.07,.64,facing) : smoothstep(.08,.78,facing);
  return angle * (1.-smoothstep(radius*.22,radius,distanceToSample));
}

void main() {
  vec4 info = surface(vUv);
  vec3 glow = vec3(0.);
  if (uBloom) glow = texture2D(uGlow,vUv).rgb;
  if (info.a < .5) {
    vec3 paper = uClay ? vec3(1.) : vec3(.980392,.980392,.972549);
    gl_FragColor = vec4(mix(paper, normalize(glow+.0001), min(.16,length(glow)*.17*uExposure)), 1.);
    return;
  }
  vec3 n = normalize(info.rgb*2.-1.);
  float d = depthAt(vUv);
  float radius = min(uAoWorldRadius, uAoSheetRadius*uScale/uPixelsPerUnit);
  float stepPx = max(1.25, radius*uPixelsPerUnit);
  float contact = 0.;
  float silhouette = 0.;
  float interior = 0.;
  float seam = 0.;
  vec3 id = uClay ? texture2D(uIdentity,vUv).rgb : vec3(0.);
  for (int i=0; i<8; ++i) {
    float angle = float(i)*.78539816339;
    vec2 direction = vec2(cos(angle),sin(angle));
    float nearby = contactAt(vUv, direction*stepPx*.37, d, n, radius);
    float broader = contactAt(vUv, direction*stepPx*.78, d, n, radius);
    if (uPremium) {
      float tight = contactAt(vUv, direction*max(1.,stepPx*.16), d, n, radius*.56);
      contact += max(tight, nearby*.88) + broader*.34;
    } else {
      contact += max(nearby, broader);
    }
    if (uClay) {
      vec2 edgeUV = vUv + direction*max(1.1,uScale*1.04)/uSize;
      silhouette = max(silhouette, 1.-surface(edgeUV).a);
      float detailPx = max(.80,uScale*.42);
      vec2 detailUV = vUv + direction*detailPx/uSize;
      vec4 other = surface(detailUV);
      if (other.a > .5) {
        vec3 nn = normalize(other.rgb*2.-1.);
        float crease = smoothstep(.16,.48,1.-dot(n,nn));
        // Draw discontinuities on the near side; a continuous slanted face isn't a seam.
        vec3 delta = vec3(direction*detailPx/uPixelsPerUnit, (d-depthAt(detailUV))*uDepthSpan);
        float gap = smoothstep(.004,.014,-delta.z)*smoothstep(.0015,.008,abs(dot(n,delta)));
        interior = max(interior,max(crease,gap));
        vec3 idDelta = abs(id-texture2D(uIdentity,detailUV).rgb);
        seam = max(seam, step(.002,max(idDelta.r,max(idDelta.g,idDelta.b))));
      }
    }
  }
  float ao = uPremium ? 1.-exp(-contact*.42) : clamp(contact*.23,0.,1.);
  if (uClay) {
    float softLight = clamp(dot(n,normalize(vec3(-.30,.67,.69))),0.,1.);
    float fill = .933 + .058*softLight - .070*ao;
    fill = mix(fill,.68,seam*.78);
    fill = mix(fill,.54,interior*.78);
    fill = mix(fill,.17,silhouette);
    gl_FragColor = vec4(vec3(fill),1.);
  } else {
    vec3 beauty = texture2D(uBeauty,vUv).rgb;
    gl_FragColor = vec4(beauty*(1.-uAoStrength*ao)+glow*.25,1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
}
`;

const quadVertex = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }';
const glowShader = /* glsl */ `
uniform sampler2D uInput;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uInput,vUv).rgb*.227027;
  c += (texture2D(uInput,vUv+uStep*1.384615).rgb+texture2D(uInput,vUv-uStep*1.384615).rgb)*.316216;
  c += (texture2D(uInput,vUv+uStep*3.230769).rgb+texture2D(uInput,vUv-uStep*3.230769).rgb)*.070270;
  gl_FragColor = vec4(c,1.);
}
`;

type RenderMaterial = THREE.Material | THREE.Material[];
type Variant = { mesh: THREE.Mesh; source: RenderMaterial; premium: RenderMaterial;
  studio: RenderMaterial; identity: RenderMaterial; emission: RenderMaterial };

function overrideMaterial(material: THREE.Material, changes: Partial<MaterialValues>, mesh: THREE.Mesh) {
  if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial)) return material;
  const pattern = changes.pattern;
  const preset = pattern && pattern !== 'source';
  const edited = preset ? new THREE.MeshPhysicalMaterial({
    name: material.name, side: material.side,
    map: pattern === 'screen' ? material.map : null,
    emissiveMap: pattern === 'screen' ? material.map : null,
    clearcoatRoughness: .23,
  }) : material.clone();
  if (!preset) {
    edited.onBeforeCompile = material.onBeforeCompile;
    edited.customProgramCacheKey = material.customProgramCacheKey;
  }
  if (edited instanceof THREE.MeshStandardMaterial) {
    if (pattern === 'oak' || pattern === 'walnut' || pattern === 'engineered_stone') {
      applyProceduralSurface(edited, mesh, pattern, changes.grainDirection ?? 'auto',
        changes.grainScale ?? 1, changes.grainDetail ?? .55);
    }
    if (changes.roughness !== undefined) edited.roughness = changes.roughness;
    if (changes.metalness !== undefined) edited.metalness = changes.metalness;
  }
  if (edited instanceof THREE.MeshPhysicalMaterial) {
    if (changes.specularIntensity !== undefined) edited.specularIntensity = changes.specularIntensity;
    if (changes.clearcoat !== undefined) edited.clearcoat = changes.clearcoat;
    if (changes.transmission !== undefined) edited.transmission = changes.transmission;
    if (changes.ior !== undefined) edited.ior = changes.ior;
  }
  if (changes.color !== undefined) edited.color.set(changes.color);
  if (changes.emissiveColor !== undefined) edited.emissive.set(changes.emissiveColor);
  if (changes.emissiveIntensity !== undefined) edited.emissiveIntensity = changes.emissiveIntensity;
  return edited;
}

function dataTarget() {
  return new THREE.WebGLRenderTarget(1,1,{ minFilter:THREE.NearestFilter, magFilter:THREE.NearestFilter });
}

/** A neutral Z-up reflection environment with broad softboxes and a darker strip between them. */
function makeStudioEnvironment(renderer: THREE.WebGLRenderer) {
  const width = 256, height = 128;
  const pixels = new Float32Array(width * height * 4);
  const direction = new THREE.Vector3();
  const cards = premiumStudio.reflectionCards.map(card => {
    const center = new THREE.Vector3(...card.direction).normalize();
    const across = new THREE.Vector3(0, 0, 1).cross(center).normalize();
    return { ...card, center, across, up: center.clone().cross(across) };
  });
  for (let y = 0; y < height; y++) {
    const pitch = ((y + .5) / height - .5) * Math.PI;
    for (let x = 0; x < width; x++) {
      const yaw = ((x + .5) / width - .5) * 2 * Math.PI;
      direction.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
      let radiance = .12 + .14 * Math.max(0, direction.z);
      for (const card of cards) {
        const facing = direction.dot(card.center);
        if (facing <= 0) continue;
        const u = direction.dot(card.across) / (facing * card.width);
        const v = direction.dot(card.up) / (facing * card.height);
        radiance += card.power * Math.exp(-1.55 * (u*u + v*v));
      }
      const i = (y * width + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = radiance;
      pixels[i + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  const generator = new THREE.PMREMGenerator(renderer);
  const environment = generator.fromEquirectangular(texture);
  texture.dispose();
  generator.dispose();
  return environment;
}

/** Orthographic contact AO and visible linework, evaluated with a padded tile in PNG exports. */
export class ViewEffects {
  private readonly beauty = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
  private readonly normals = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType),
  });
  private readonly normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
  private readonly identity = dataTarget();
  private readonly emission = new THREE.WebGLRenderTarget(1,1,{ type:THREE.HalfFloatType });
  private readonly blurX = new THREE.WebGLRenderTarget(1,1,{ type:THREE.HalfFloatType, depthBuffer:false });
  private readonly blurY = new THREE.WebGLRenderTarget(1,1,{ type:THREE.HalfFloatType, depthBuffer:false });
  private readonly composite = new THREE.Scene();
  private readonly blurScene = new THREE.Scene();
  private readonly screenCamera = new THREE.Camera();
  private readonly blurMaterial = new THREE.ShaderMaterial({
    uniforms:{ uInput:{ value:this.emission.texture }, uStep:{ value:new THREE.Vector2() } },
    vertexShader:quadVertex, fragmentShader:glowShader, toneMapped:false, depthTest:false, depthWrite:false,
  });
  private variants: Variant[] = [];
  private owned = new Set<THREE.Material>();
  private hasEmission = false;
  private studioEnvironment: THREE.WebGLRenderTarget | null = null;
  private premiumEnvironment: THREE.WebGLRenderTarget | null = null;
  private readonly material = new THREE.ShaderMaterial({
    uniforms: {
      uBeauty: { value: this.beauty.texture }, uNormal: { value: this.normals.texture },
      uIdentity: { value:this.identity.texture }, uGlow: { value:this.blurY.texture },
      uDepth: { value: this.normals.depthTexture }, uSize: { value: new THREE.Vector2(1,1) },
      uPixelsPerUnit: { value: 1 }, uDepthSpan: { value: 1 },
      uScale: { value: 1 }, uClay: { value: false }, uPremium: { value:false }, uBloom: { value:false },
      uAoStrength: { value:.23 }, uAoWorldRadius: { value:.055 }, uAoSheetRadius: { value:12 },
      uExposure: { value:1 },
    },
    vertexShader: quadVertex,
    fragmentShader, depthTest: false, depthWrite: false,
  });

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(2,2), this.material);
    screen.frustumCulled = false;
    this.composite.add(screen);
    const blurQuad = new THREE.Mesh(screen.geometry,this.blurMaterial);
    blurQuad.frustumCulled = false;
    this.blurScene.add(blurQuad);
    if (renderer.extensions.has('EXT_color_buffer_float')) {
      const generator = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      this.studioEnvironment = generator.fromScene(room, .08);
      scene.environment = this.studioEnvironment.texture;
      scene.environmentIntensity = .32;
      room.dispose();
      generator.dispose();
    } else {
      for (const target of [this.beauty,this.emission,this.blurX,this.blurY]) target.texture.type = THREE.UnsignedByteType;
    }
  }

  setEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, premium: boolean) {
    if (premium && this.studioEnvironment) this.premiumEnvironment ??= makeStudioEnvironment(renderer);
    scene.environment = (premium ? this.premiumEnvironment : this.studioEnvironment)?.texture ?? null;
    scene.environmentIntensity = premium ? premiumStudio.environmentIntensity : .32;
  }

  attach(group: THREE.Group, overrides?: MaterialOverrides) {
    for (const material of this.owned) material.dispose();
    this.owned.clear();
    this.variants = [];
    this.hasEmission = false;
    let id = 0;
    const own = <T extends THREE.Material>(material:T) => { this.owned.add(material); return material; };
    const physical = new Map<THREE.Material, Map<ReturnType<typeof premiumSurface>, THREE.Material>>();
    const emitters = new Map<THREE.Material,THREE.Material>();
    group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.material;
      const map = (fn:(material:THREE.Material, index: number)=>THREE.Material) => Array.isArray(source) ? source.map(fn) : fn(source, 0);
      const edits = overrides?.get(object);
      const premium = map((material, index) => {
        let variants = physical.get(material);
        if (!variants) { variants = new Map(); physical.set(material, variants); }
        const finish = premiumSurface(material, object.name);
        let base = variants.get(finish);
        if (!base) {
          base = premiumMaterial(material, finish);
          if (base !== material) own(base);
          variants.set(finish, base);
        }
        const change = edits?.get(index);
        if (!change) return base;
        const edited = overrideMaterial(base, change, object);
        return edited === base ? base : own(edited);
      });
      const premiumAt = (index: number) => Array.isArray(premium) ? premium[index] : premium;
      object.castShadow = (Array.isArray(premium) ? premium : [premium]).every(m =>
        !m.transparent && !(m instanceof THREE.MeshPhysicalMaterial && m.transmission > .01));
      object.receiveShadow = true;
      this.variants.push({
        mesh:object,source,premium,
        studio:map((material, index) => {
          const change = edits?.get(index);
          if (!change) return material;
          if (change.pattern || change.roughness !== undefined || change.metalness !== undefined ||
              change.specularIntensity !== undefined || change.clearcoat !== undefined) return premiumAt(index);
          const edited = overrideMaterial(material, change, object);
          return edited === material ? material : own(edited);
        }),
        identity:map(m => {
          const code = ++id;
          const color = new THREE.Color().setRGB((code & 255)/255, ((code>>8)&255)/255, ((code>>16)&255)/255);
          return own(new THREE.MeshBasicMaterial({ color, side:THREE.DoubleSide, toneMapped:false }));
        }),
        emission:map((_m, index) => {
          const m = premiumAt(index);
          const cached = emitters.get(m);
          if (cached) return cached;
          const lit = m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhongMaterial ? m : null;
          const e = lit?.emissive.clone().multiplyScalar(lit.emissiveIntensity) ?? new THREE.Color(0);
          const emits = Math.max(e.r,e.g,e.b) > .002;
          if (emits) this.hasEmission = true;
          const material = own(new THREE.MeshBasicMaterial({
            color: emits ? e : 0, map: emits ? lit?.emissiveMap : null,
            alphaMap:lit?.alphaMap, alphaTest:m.alphaTest, side:m.side, toneMapped:false,
            opacity:m.opacity, transparent:m.transparent, depthWrite:m.depthWrite,
          }));
          emitters.set(m,material);
          return material;
        }),
      });
    });
  }

  private apply(pass:'source'|'studio'|'premium'|'identity'|'emission') {
    for (const item of this.variants) item.mesh.material = item[pass];
  }

  private glow(renderer:THREE.WebGLRenderer, w:number, h:number, k:number) {
    const gw = Math.ceil(w/4), gh = Math.ceil(h/4);
    this.blurX.setSize(gw,gh); this.blurY.setSize(gw,gh);
    const u=this.blurMaterial.uniforms;
    const spread=Math.max(2,2.45*k);
    u.uInput.value=this.emission.texture; u.uStep.value.set(spread/w,0);
    renderer.setRenderTarget(this.blurX); renderer.render(this.blurScene,this.screenCamera);
    u.uInput.value=this.blurX.texture; u.uStep.value.set(0,spread/h);
    renderer.setRenderTarget(this.blurY); renderer.render(this.blurScene,this.screenCamera);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.OrthographicCamera,
    style: RenderStyle, w: number, h: number, pixelsPerUnit: number, k: number, tuning: RenderTuning) {
    const background = scene.background;
    const override = scene.overrideMaterial;
    const oldShadow = renderer.shadowMap.enabled;
    const bloom = style === 'premium' && this.hasEmission;
    if (style !== 'clay') this.beauty.setSize(w,h);
    this.normals.setSize(w,h);
    try {
      if (style !== 'clay') {
        this.apply(style === 'premium' ? 'premium' : 'studio');
        renderer.setRenderTarget(this.beauty);
        renderer.render(scene,camera);
      }
      scene.overrideMaterial = this.normalMaterial;
      scene.background = null;
      renderer.shadowMap.enabled = false;
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.normals);
      renderer.render(scene,camera);
      scene.overrideMaterial = null;
      if (style === 'clay') {
        this.apply('identity');
        this.identity.setSize(w,h);
        renderer.setRenderTarget(this.identity);
        renderer.render(scene,camera);
      } else if (bloom) {
        this.apply('emission');
        this.emission.setSize(w,h);
        renderer.setRenderTarget(this.emission);
        renderer.render(scene,camera);
        this.glow(renderer,w,h,k);
      }
    } finally {
      this.apply('source');
      renderer.shadowMap.enabled = oldShadow;
      scene.background = background;
      scene.overrideMaterial = override;
      renderer.setRenderTarget(null);
    }
    const u = this.material.uniforms;
    u.uSize.value.set(w,h);
    u.uPixelsPerUnit.value = pixelsPerUnit;
    u.uDepthSpan.value = camera.far-camera.near;
    u.uScale.value = k;
    u.uClay.value = style === 'clay';
    const premium = style === 'premium';
    u.uPremium.value = premium;
    u.uAoStrength.value = premium ? tuning.ao : .23;
    u.uAoWorldRadius.value = premium ? premiumStudio.ao.worldRadius : .055;
    u.uAoSheetRadius.value = premium ? premiumStudio.ao.sheetRadius : 12;
    u.uExposure.value = renderer.toneMappingExposure;
    u.uBloom.value = bloom;
    renderer.render(this.composite, this.screenCamera);
  }
}
