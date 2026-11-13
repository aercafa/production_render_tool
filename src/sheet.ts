import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { measured, type RenderModel } from './model';
import type { Mark, Notes, Point } from './annotations';
import { downsampleTile, EXPORT_SAMPLES, TILE_BORDER } from './export';
import { placeMarkLabel, type Rect } from './mark-label';
import { EFFECT_BORDER, ViewEffects, type RenderStyle } from './view-effects';
import { exposureControl, premiumStudio } from './render-config';
import { defaultTuning, type MaterialOverrides, type RenderTuning } from './assistant-edits';

export const SHEET_WIDTH = 1200;
export const SHEET_HEIGHT = 800;
const paper = '#fafaf8';
const ink = '#2c3741';
const font = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif';
export const mainViews = [
  { label: '前右低轴测', azimuth: 34.824290, elevation: 22.257363 },
  { label: '前左低轴测', azimuth: -34.824290, elevation: 22.257363 },
  { label: '后右低轴测', azimuth: 145.175710, elevation: 22.257363 },
  { label: '后左低轴测', azimuth: -145.175710, elevation: 22.257363 },
  { label: '底部前右低轴测', azimuth: 34.824290, elevation: -22.257363 },
  { label: '底部前左低轴测', azimuth: -34.824290, elevation: -22.257363 },
] as const;

const axo: Rect = { x: 34, y: 124, w: 520, h: 575 };
const top: Rect = { x: 589, y: 134, w: 311, h: 241 };
const front: Rect = { x: 589, y: 400, w: 311, h: 271 };
const right: Rect = { x: 931, y: 400, w: 231, h: 271 };
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const centeredRect = (area: Rect, w: number, h: number): Rect =>
  ({ x: center(area).x-w/2, y: center(area).y-h/2, w, h });
const orthoUp = new THREE.Vector3(0, 0, 1);

function mainGeometry(size: THREE.Vector3, preset: number) {
  const view = mainViews[preset] ?? mainViews[0];
  const az = THREE.MathUtils.degToRad(view.azimuth), elev = THREE.MathUtils.degToRad(view.elevation);
  const direction = new THREE.Vector3(Math.sin(az) * Math.cos(elev), -Math.cos(az) * Math.cos(elev), Math.sin(elev));
  const u = new THREE.Vector3().crossVectors(orthoUp, direction).normalize();
  const v = new THREE.Vector3().crossVectors(direction, u);
  const project = (axis: THREE.Vector3) => Math.abs(axis.x)*size.x + Math.abs(axis.y)*size.y + Math.abs(axis.z)*size.z;
  const w = project(u), h = project(v);
  const scale = Math.min((axo.w-24)/w, (axo.h-24)/h);
  return { direction, scale, occupied: centeredRect(axo, w*scale, h*scale) };
}

function sceneLayout(model: RenderModel) {
  const size = model.size.clone().divideScalar(Math.max(...model.size));
  const [w, d, h] = size;
  const scale = Math.min(
    (front.w - 36) / (w || 1e-9), (front.h - 28) / (h || 1e-9),
    (top.h - 26) / (d || 1e-9), (right.w - 28) / (d || 1e-9),
  );
  return { size, scale };
}

function clear(ctx: CanvasRenderingContext2D, k: number, background?: string) {
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, SHEET_WIDTH, SHEET_HEIGHT);
  }
}

function line(ctx: CanvasRenderingContext2D, a: Point, b: Point) {
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}

const arrowLength = 5.8;
function arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const x = to.x - arrowLength * Math.cos(angle), y = to.y - arrowLength * Math.sin(angle);
  const nx = 1.9 * Math.sin(angle), ny = -1.9 * Math.cos(angle);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(x + nx, y + ny);
  ctx.lineTo(x - nx, y - ny);
  ctx.closePath(); ctx.fill();
}

function arrowPair(ctx: CanvasRenderingContext2D, a: Point, b: Point) {
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance < .25) return;
  if (distance >= arrowLength * 2 + 3) {
    arrow(ctx, b, a);
    arrow(ctx, a, b);
  } else {
    const x = (b.x - a.x) / distance * (arrowLength + 3);
    const y = (b.y - a.y) / distance * (arrowLength + 3);
    const outerA = { x: a.x - x, y: a.y - y }, outerB = { x: b.x + x, y: b.y + y };
    line(ctx, outerA, a); line(ctx, b, outerB);
    arrow(ctx, outerA, a); arrow(ctx, outerB, b);
  }
}

function label(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, weight = 500, maxWidth = 1090) {
  ctx.fillStyle = ink;
  ctx.font = weight + ' ' + size + 'px ' + font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y, maxWidth);
}

function caption(ctx: CanvasRenderingContext2D, value: string, y: number, size: number) {
  const rows: string[] = [];
  ctx.font = '400 ' + size + 'px ' + font;
  for (const paragraph of value.split('\n')) {
    let current = '';
    for (const ch of paragraph) {
      if (ctx.measureText(current + ch).width > 1040 && current) {
        rows.push(current); current = '';
      }
      current += ch;
    }
    rows.push(current);
  }
  rows.slice(0, 3).forEach((row, i) => label(ctx, row, 600, y + i * 21, size, 400));
}

function dimHorizontal(ctx: CanvasRenderingContext2D, value: string, x: number, half: number, y: number, source: number) {
  if (!value || half < .5) return;
  const a = { x: x - half, y }, b = { x: x + half, y };
  line(ctx, { x: a.x, y: source + 4 }, { x: a.x, y: y + 5 });
  line(ctx, { x: b.x, y: source + 4 }, { x: b.x, y: y + 5 });
  line(ctx, a, b);
  arrowPair(ctx, a, b);
  label(ctx, value, x, y + 14, 15.2);
}

function dimVertical(ctx: CanvasRenderingContext2D, value: string, y: number, half: number, x: number, source: number) {
  if (!value || half < .5) return;
  const a = { x, y: y - half }, b = { x, y: y + half };
  line(ctx, { x: source - 4, y: a.y }, { x: x - 5, y: a.y });
  line(ctx, { x: source - 4, y: b.y }, { x: x - 5, y: b.y });
  line(ctx, a, b);
  arrowPair(ctx, a, b);
  ctx.save(); ctx.translate(x - 13, y); ctx.rotate(-Math.PI / 2);
  label(ctx, value, 0, 0, 15.2); ctx.restore();
}

function extensions(ctx: CanvasRenderingContext2D, mark: Mark, views: Rect[]) {
  const { a,b } = mark;
  const dx = b.x-a.x, dy = b.y-a.y, length = Math.hypot(dx,dy);
  if (length < 6) return;
  const middle = { x:(a.x+b.x)/2, y:(a.y+b.y)/2 };
  const distance = (r: Rect) => Math.hypot(Math.max(r.x-middle.x, 0, middle.x-r.x-r.w),
    Math.max(r.y-middle.y, 0, middle.y-r.y-r.h));
  const nearest = views.reduce((best, r) => distance(r) < distance(best) ? r : best);
  let nx = -dy/length, ny = dx/length;
  const target = center(nearest);
  if (nx*(target.x-middle.x)+ny*(target.y-middle.y) < 0) { nx = -nx; ny = -ny; }
  ctx.save();
  ctx.lineWidth = .82;
  ctx.globalAlpha *= .92;
  for (const p of [a,b]) {
    // Stop just before the adjacent projected part when it's close; otherwise use a short fixed witness line.
    const x = Math.max(nearest.x, Math.min(nearest.x+nearest.w, p.x));
    const y = Math.max(nearest.y, Math.min(nearest.y+nearest.h, p.y));
    const gap = (x-p.x)*nx+(y-p.y)*ny;
    const reach = gap > 5 && gap < 35 ? Math.max(5,gap-3) : 17;
    line(ctx, { x:p.x-4*nx, y:p.y-4*ny }, { x:p.x+reach*nx, y:p.y+reach*ny });
  }
  ctx.restore();
}

function drawMark(ctx: CanvasRenderingContext2D, mark: Mark, active: boolean, obstacles: Rect[], handleRadius: number) {
  const { a, b } = mark;
  ctx.save();
  ctx.strokeStyle = active ? '#285ed0' : '#44505b';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = active ? 1.25 : .95;
  extensions(ctx, mark, obstacles.slice(0,4));
  line(ctx, a, b);
  arrowPair(ctx, a, b);
  let bounds: Rect | undefined;
  const value = mark.value.trim();
  if (value) {
    ctx.font = '500 15.2px ' + font;
    const w = Math.min(520, ctx.measureText(value).width);
    const placement = placeMarkLabel(mark, w+8, 21, { x:0, y:0, w:SHEET_WIDTH, h:SHEET_HEIGHT }, obstacles);
    const { center, anchor } = placement;
    bounds = placement.bounds;
    if (placement.displaced) {
      const dx = anchor.x-center.x, dy = anchor.y-center.y;
      const t = Math.min((w/2+7)/Math.abs(dx), 13/Math.abs(dy));
      ctx.lineWidth = .8;
      ctx.setLineDash([3, 3]);
      line(ctx, anchor, { x:center.x+dx*t, y:center.y+dy*t });
      ctx.setLineDash([]);
    }
    label(ctx, value, center.x, center.y, 15.2, 500, w);
  }
  if (active && handleRadius > 0) {
    ctx.lineWidth = 1.45;
    ctx.strokeStyle = '#2459cd';
    ctx.fillStyle = '#fff';
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
  return bounds;
}

type NoteOptions = { selected?: number | null; draft?: Mark | null; offset?: Point; preset?: number; handleRadius?: number };

export function drawNotes(ctx: CanvasRenderingContext2D, k: number, model: RenderModel | null,
  notes: Notes, { selected, draft, offset, preset = 0, handleRadius = 0 }: NoteOptions = {}) {
  const labels = new Map<number, Rect>();
  if (offset) ctx.setTransform(k, 0, 0, k, -offset.x, -offset.y);
  else clear(ctx, k);
  if (!model) return labels;
  const { size, scale } = sceneLayout(model);
  const dims = notes.dimensions;
  const f = center(front), r = center(right);
  const hw = size.x * scale / 2, hd = size.y * scale / 2, hh = size.z * scale / 2;
  const lowest = f.y + hh, dimY = Math.min(690, lowest + 24);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = .72;
  const widthText = dims.width.trim() || measured(model, 'width');
  const depthText = dims.depth.trim() || measured(model, 'depth');
  const heightText = dims.height.trim() || measured(model, 'height');
  dimHorizontal(ctx, widthText, f.x, hw, dimY, lowest);
  ctx.fillStyle = ink;
  dimHorizontal(ctx, depthText, r.x, hd, dimY, lowest);
  ctx.fillStyle = ink;
  dimVertical(ctx, heightText, f.y, hh, f.x - hw - 22, f.x - hw);
  if (notes.title.trim()) label(ctx, notes.title.trim(), 600, 59, 30, 650);
  if (notes.subtitle.trim()) caption(ctx, notes.subtitle.trim(), 737, 15);
  const obstacles = [
    mainGeometry(size, preset).occupied, centeredRect(top, hw*2, hd*2),
    centeredRect(front, hw*2, hh*2), centeredRect(right, hd*2, hh*2),
  ];
  ctx.font = '500 15.2px ' + font;
  for (const [value, x] of [[widthText, f.x], [depthText, r.x]] as const) {
    const w = ctx.measureText(value).width;
    if (value) obstacles.push({ x:x-w/2-4, y:dimY+2, w:w+8, h:24 });
  }
  if (heightText) {
    const h = ctx.measureText(heightText).width;
    obstacles.push({ x:f.x-hw-47, y:f.y-h/2-4, w:24, h:h+8 });
  }
  if (notes.title.trim()) obstacles.push({ x:50, y:40, w:1100, h:40 });
  if (notes.subtitle.trim()) obstacles.push({ x:65, y:725, w:1070, h:68 });
  const marks = notes.marks.map(mark => draft?.id === mark.id ? draft : mark);
  if (draft && !marks.some(mark => mark.id === draft.id)) marks.push(draft);
  for (const mark of marks) {
    const isSelected = mark.id === selected;
    const bounds = drawMark(ctx, mark, isSelected || mark === draft, obstacles, isSelected ? handleRadius : 0);
    if (bounds) {
      labels.set(mark.id, bounds);
      obstacles.push(bounds);
    }
  }
  return labels;
}

export function drawEmpty(ctx: CanvasRenderingContext2D, k = 1) {
  clear(ctx, k, paper);
  label(ctx, '导入模型开始出图', 600, 380, 25, 650);
  label(ctx, '拖入 OBJ 或 3DM 文件', 600, 421, 16, 400);
}

export class SheetRenderer {
  private renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  private scene = new THREE.Scene();
  private effects: ViewEffects;
  private lights: { ambient: THREE.HemisphereLight; key: THREE.DirectionalLight; fill: THREE.DirectionalLight; rim: THREE.DirectionalLight;
    softbox: THREE.RectAreaLight; sidebox: THREE.RectAreaLight };
  private lightStyle: RenderStyle = 'studio';
  private previewBuffer = document.createElement('canvas');
  private model: RenderModel | null = null;
  private tuning = defaultTuning;
  constructor() {
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.scene.background = new THREE.Color(paper);
    const ambient = new THREE.HemisphereLight(0xffffff, 0xabb1bb, 1.5);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xfffaf3, 2.1);
    key.position.set(-3, -4, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048,2048);
    Object.assign(key.shadow.camera,{left:-.87,right:.87,top:.87,bottom:-.87,near:5.5,far:10});
    key.shadow.camera.updateProjectionMatrix();
    key.shadow.normalBias = .002;
    key.shadow.bias = -.0006;
    key.shadow.radius = premiumStudio.shadow.radius;
    key.shadow.intensity = premiumStudio.shadow.intensity;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xe0e8fa, .95);
    fill.position.set(3, 2, 2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff,0);
    rim.position.set(1.4,3.2,4.0);
    this.scene.add(rim);
    RectAreaLightUniformsLib.init();
    const softbox = new THREE.RectAreaLight(0xfffcf8, 0, premiumStudio.softbox.width, premiumStudio.softbox.height);
    softbox.position.set(-.63,-1.10,.91);
    softbox.lookAt(0,0,.08);
    const sidebox = new THREE.RectAreaLight(0xf3f6ff, 0, premiumStudio.sidebox.width, premiumStudio.sidebox.height);
    sidebox.position.set(1.06,-.13,.47);
    sidebox.lookAt(0,0,.01);
    this.scene.add(softbox,sidebox);
    this.lights = { ambient, key, fill, rim, softbox, sidebox };
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.effects = new ViewEffects(this.renderer, this.scene);
  }

  attach(model: RenderModel) {
    if (this.model) this.scene.remove(this.model.group);
    this.model = model;
    this.scene.add(model.group);
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    model.group.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial)) continue;
        for (const texture of [material.map, material.emissiveMap, material.normalMap]) {
          if (texture && texture.anisotropy < anisotropy) {
            texture.anisotropy = anisotropy;
            texture.needsUpdate = true;
          }
        }
      }
    });
    this.setMaterialOverrides();
  }

  setMaterialOverrides(overrides?: MaterialOverrides) {
    if (this.model) this.effects.attach(this.model.group, overrides);
    this.renderer.shadowMap.needsUpdate = true;
  }

  setTuning(tuning: RenderTuning) {
    this.tuning = tuning;
  }

  pickPart(point: Point, preset: number) {
    if (!this.model) return;
    const { size, scale } = sceneLayout(this.model);
    const main = mainGeometry(size, preset);
    const views = [
      { rect:axo, direction:main.direction, up:orthoUp, scale:main.scale },
      { rect:top, direction:new THREE.Vector3(0,0,1), up:new THREE.Vector3(0,1,0), scale },
      { rect:front, direction:new THREE.Vector3(0,-1,0), up:orthoUp, scale },
      { rect:right, direction:new THREE.Vector3(1,0,0), up:orthoUp, scale },
    ];
    const view = views.find(({rect}) => point.x >= rect.x && point.x <= rect.x + rect.w &&
      point.y >= rect.y && point.y <= rect.y + rect.h);
    if (!view) return;
    const {rect,direction,up} = view;
    const camera = this.camera(rect, direction, up, view.scale);
    camera.updateMatrixWorld();
    this.model.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(2*(point.x-rect.x)/rect.w-1,1-2*(point.y-rect.y)/rect.h),camera);
    const hit = ray.intersectObjects(this.model.group.children,false)[0];
    if (hit?.object instanceof THREE.Mesh) return { mesh:hit.object, index:hit.face?.materialIndex ?? 0 };
  }

  private camera(rect: Rect, direction: THREE.Vector3, up: THREE.Vector3, scale: number) {
    const width = rect.w / scale, height = rect.h / scale;
    // The normalized model fits inside a radius of sqrt(3)/2 around the origin.
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 3, 5);
    camera.position.copy(direction).multiplyScalar(4);
    camera.up.copy(up);
    camera.lookAt(0, 0, 0);
    return camera;
  }

  private setLightStyle(style: RenderStyle) {
    if (style === this.lightStyle) return;
    const premium = style === 'premium';
    const { ambient,key,fill,rim,softbox,sidebox } = this.lights;
    ambient.intensity = premium ? premiumStudio.ambient : 1.5;
    key.intensity = premium ? premiumStudio.key : 2.1;
    fill.intensity = premium ? premiumStudio.fill : .95;
    rim.intensity = premium ? premiumStudio.rim : 0;
    softbox.intensity = premium ? premiumStudio.softbox.intensity : 0;
    sidebox.intensity = premium ? premiumStudio.sidebox.intensity : 0;
    this.effects.setEnvironment(this.renderer, this.scene, premium);
    this.renderer.toneMapping = premium ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = premium;
    this.renderer.shadowMap.needsUpdate = premium;
    this.lightStyle = style;
  }

  preview(ctx: CanvasRenderingContext2D, k: number, preset: number, style: RenderStyle, exposure: number) {
    const factor = Math.max(1, Math.min(3, 4200 / ctx.canvas.width));
    if (factor <= 1) { this.render(ctx,k,preset,style,exposure); return; }
    const buffer = this.previewBuffer;
    const width = Math.floor(ctx.canvas.width*factor/3)*3;
    const height = width/3*2;
    if (buffer.width !== width) buffer.width = width;
    if (buffer.height !== height) buffer.height = height;
    this.render(buffer.getContext('2d', { alpha:false })!,width/SHEET_WIDTH,preset,style,exposure);
    ctx.setTransform(1,0,0,1,0,0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buffer,0,0,ctx.canvas.width,ctx.canvas.height);
  }

  private render(ctx: CanvasRenderingContext2D, k: number, preset: number, style: RenderStyle, exposure: number,
    region: Rect = { x: 0, y: 0, w: ctx.canvas.width, h: ctx.canvas.height }) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = style === 'clay' ? '#fff' : paper;
    ctx.fillRect(0, 0, region.w, region.h);
    if (!this.model) return;
    this.setLightStyle(style);
    if (style === 'premium') {
      this.lights.key.shadow.intensity = this.tuning.shadow;
      this.scene.environmentIntensity = this.tuning.reflection;
    }
    this.renderer.toneMappingExposure = (style === 'premium' ? premiumStudio.exposure : 1) *
      Math.pow(2, exposure * exposureControl.stopsPerStep);
    const { size, scale } = sceneLayout(this.model);
    const main = mainGeometry(size, preset);
    this.view(ctx, axo, main.direction, orthoUp, main.scale, k, region, style);
    this.view(ctx, top, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), scale, k, region, style);
    this.view(ctx, front, new THREE.Vector3(0, -1, 0), orthoUp, scale, k, region, style);
    this.view(ctx, right, new THREE.Vector3(1, 0, 0), orthoUp, scale, k, region, style);
  }

  private view(ctx: CanvasRenderingContext2D, rect: Rect, direction: THREE.Vector3, up: THREE.Vector3,
    scale: number, k: number, region: Rect, style: RenderStyle) {
    const fullX = Math.round(rect.x * k), fullY = Math.round(rect.y * k);
    const fullW = Math.round(rect.w * k), fullH = Math.round(rect.h * k);
    const x = Math.max(region.x, fullX), y = Math.max(region.y, fullY);
    const w = Math.min(region.x + region.w, fullX + fullW) - x;
    const h = Math.min(region.y + region.h, fullY + fullH) - y;
    if (w <= 0 || h <= 0) return;
    const camera = this.camera(rect,direction,up,scale);
    camera.setViewOffset(fullW, fullH, x - fullX, y - fullY, w, h);
    this.renderer.setSize(w, h, false);
    const gl = this.renderer.getContext();
    if (gl.isContextLost() || gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) {
      throw new Error('当前显卡或浏览器无法绘制这张图，请关闭占用显存的页面后重试。');
    }
    this.effects.render(this.renderer, this.scene, camera, style, w, h, scale*k, k, this.tuning);
    ctx.drawImage(this.renderer.domElement, x - region.x, y - region.y);
  }

  async renderExport(ctx: CanvasRenderingContext2D, model: RenderModel, notes: Notes, preset: number,
    style: RenderStyle, exposure: number, progress: (ratio: number) => void) {
    const tile = 896, scratch = document.createElement('canvas'), overlay = document.createElement('canvas');
    const padded = document.createElement('canvas');
    const buffer = scratch.getContext('2d', { willReadFrequently: true, alpha: false })!;
    const annotations = overlay.getContext('2d')!;
    const shade = padded.getContext('2d', { alpha:false })!;
    const width = ctx.canvas.width, height = ctx.canvas.height;
    const total = Math.ceil(width / tile) * Math.ceil(height / tile);
    const k = width / SHEET_WIDTH * EXPORT_SAMPLES;
    let completed = 0;
    try {
      for (let y = 0; y < height; y += tile) {
        for (let x = 0; x < width; x += tile) {
          const w = Math.min(tile, width - x), h = Math.min(tile, height - y);
          const region = {
            x: (x - TILE_BORDER) * EXPORT_SAMPLES, y: (y - TILE_BORDER) * EXPORT_SAMPLES,
            w: (w + TILE_BORDER * 2) * EXPORT_SAMPLES, h: (h + TILE_BORDER * 2) * EXPORT_SAMPLES,
          };
          if (scratch.width !== region.w) scratch.width = region.w;
          if (scratch.height !== region.h) scratch.height = region.h;
          if (overlay.width !== region.w) overlay.width = region.w;
          if (overlay.height !== region.h) overlay.height = region.h;
          // Shade beyond the filter border so neighborhood effects cannot reveal the export tile grid.
          if (padded.width !== region.w + 2*EFFECT_BORDER) padded.width = region.w + 2*EFFECT_BORDER;
          if (padded.height !== region.h + 2*EFFECT_BORDER) padded.height = region.h + 2*EFFECT_BORDER;
          this.render(shade, k, preset, style, exposure, {
            x: region.x-EFFECT_BORDER, y: region.y-EFFECT_BORDER, w: padded.width, h: padded.height,
          });
          buffer.drawImage(padded, EFFECT_BORDER, EFFECT_BORDER, region.w, region.h, 0, 0, region.w, region.h);
          // A transparent layer uses grayscale glyph coverage, without LCD color fringes in the PNG.
          annotations.setTransform(1, 0, 0, 1, 0, 0);
          annotations.clearRect(0, 0, region.w, region.h);
          drawNotes(annotations, k, model, notes, { offset: region, preset });
          buffer.drawImage(overlay, 0, 0);
          ctx.putImageData(downsampleTile(buffer.getImageData(0, 0, region.w, region.h), w, h), x, y);
          progress(++completed / total);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } finally {
      scratch.width = 0;
      scratch.height = 0;
      overlay.width = 0;
      overlay.height = 0;
      padded.width = padded.height = 0;
    }
  }
}
