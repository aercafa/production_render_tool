import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import rhinoJS from 'rhino3dm/rhino3dm.js?url';
import rhinoWasm from 'rhino3dm/rhino3dm.wasm?url';
import type { Axis } from './annotations';
import { styleRenderMesh } from './studio';
import { prepareMesh, type OperationProgress } from './local-service';

export const unitChoices: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
const texturePlaceholder = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

export interface RenderModel {
  name: string;
  kind: 'OBJ' | '3DM';
  group: THREE.Group;
  size: THREE.Vector3;
  parts: number;
  unit: string;
  unitFactor: number | null;
  warnings: string[];
}
type CheckResult = {
  issues: string[];
  unit: string;
  unitFactor: number | null;
  legacyMaterials: Record<string, number>;
  error?: string;
};

function inspectRhino(buffer: ArrayBuffer): Promise<CheckResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rhino-check.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { window.clearTimeout(timeout); worker.terminate(); };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('3DM 检查超时，请尝试较小的网格文件。'));
    }, 45000);
    worker.onmessage = ({ data }: MessageEvent<CheckResult>) => {
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('3DM 读取组件未能启动，请刷新后重试。'));
    };
    const copy = buffer.slice(0);
    worker.postMessage(copy, [copy]);
  });
}

function prepare(root: THREE.Object3D, name: string, kind: RenderModel['kind'], unit: string,
  unitFactor: number | null, warnings: string[]): RenderModel {
  const renderables: THREE.Mesh[] = [];
  root.updateWorldMatrix(true, true);
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const p = object.geometry.getAttribute('position');
    if (!p || p.count < 3) return;
    object.geometry.computeBoundingBox();
    const b = object.geometry.boundingBox!;
    if (![...b.min, ...b.max].every(Number.isFinite)) throw new Error('模型含无效坐标，请检查源文件。');
    renderables.push(object);
  });
  if (!renderables.length) throw new Error('文件里没有可渲染的网格面。');
  const bounds = new THREE.Box3();
  const group = new THREE.Group();
  for (const original of renderables) {
    const mesh = original.clone(false);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(original.matrixWorld);
    mesh.visible = true;
    const originalMaterials = Array.isArray(original.material) ? original.material : [original.material];
    mesh.userData.workbenchMaterials = originalMaterials.map(material => {
      if (kind === '3DM' && material.userData.id) return { id: 'rhino:' + material.userData.id, name: material.name };
      if (kind === 'OBJ' && material.name) return { id: 'obj:' + material.name, name: material.name };
      return { id: 'unassigned', name: '未分配材质' };
    });
    styleRenderMesh(mesh);
    group.add(mesh);
    bounds.expandByObject(mesh, true);
  }
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(...size);
  if (!Number.isFinite(span) || span <= 0) throw new Error('模型没有有效的几何范围。');
  const center = bounds.getCenter(new THREE.Vector3());
  // Keep exported dimensions in source units; normalize only scene coordinates.
  group.scale.setScalar(1 / span);
  group.position.copy(center).multiplyScalar(-1 / span);
  return { name, kind, group, size, parts: renderables.length, unit, unitFactor, warnings };
}

async function readOBJ(file: File, files: File[], onProgress?: OperationProgress) {
  const body = await file.text();
  const refs = Array.from(body.matchAll(/^\s*mtllib\s+(.+)$/gm), m => m[1].trim());
  const mats = files.filter(f => /\.mtl$/i.test(f.name));
  const urls = new Map<string, string>();
  const warnings = new Set<string>();
  const manager = new THREE.LoadingManager();
  const textures = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f.name));
  for (const t of textures) urls.set(t.name.toLowerCase(), URL.createObjectURL(t));
  const loader = new OBJLoader(manager);
  const material = mats.find(f => refs.some(ref => ref.split(/[\\/]/).at(-1)?.toLowerCase() === f.name.toLowerCase()))
    ?? (mats.length === 1 ? mats[0] : undefined);
  manager.setURLModifier(url => {
    const base = url.split(/[\\/]/).at(-1) ?? '';
    const match = urls.get(base.toLowerCase());
    if (match) return match;
    warnings.add('贴图未提供：' + base);
    return texturePlaceholder;
  });
  manager.onError = () => warnings.add('个别贴图无法读取，已使用基础材质。');
  const materialBody = material ? await material.text() : undefined;
  let wait: Promise<void> = Promise.resolve();
  if (material) {
    wait = new Promise(resolve => {
      manager.onStart = () => { started = true; };
      manager.onLoad = resolve;
      let started = false;
      const mtl = new MTLLoader(manager).parse(materialBody!, '');
      loader.setMaterials(mtl);
      mtl.preload();
      if (!started) resolve();
    });
  } else if (refs.length) {
    warnings.add('未一起选择 MTL，将使用默认材质。');
  }
  try {
    onProgress?.('正在解析 OBJ 网格…');
    const root = loader.parse(body);
    await wait;
    return prepare(root, file.name, 'OBJ', '', null, [...warnings]);
  } finally {
    urls.forEach(url => URL.revokeObjectURL(url));
  }

}

async function read3DM(file: File, onProgress?: OperationProgress) {
  let buffer = await file.arrayBuffer();
  onProgress?.('正在检查 3DM 显示网格…');
  const result = await inspectRhino(buffer);
  let legacyMaterials = result.legacyMaterials;
  const warnings = new Set<string>();
  if (result.issues.length) {
    const extra = result.issues.length > 3 ? '；另有 ' + (result.issues.length - 3) + ' 个部件' : '';
    onProgress?.('发现 3DM 缺少显示网格，正在检查缓存或调用本机 Rhino 生成网格…');
    try {
      const converted = await prepareMesh(buffer, onProgress);
      buffer = converted.buffer;
      onProgress?.('网格已就绪，正在核验并加载预览…');
      const checked = await inspectRhino(buffer);
      if (checked.issues.length || checked.unitFactor !== result.unitFactor)
        throw new Error('处理结果含无效网格或单位与原件不一致。');
      legacyMaterials = checked.legacyMaterials;
      warnings.add(converted.cached ? '已复用 24 小时网格缓存。' : '已自动生成显示网格，并缓存 24 小时。');
    } catch (error) {
      throw new Error('3DM 缺少有效显示网格：' + result.issues.slice(0, 3).join('；') + extra + '。自动处理未完成：' +
        (error instanceof Error ? error.message : String(error)) +
        ' 也可在 Rhino 中另存带网格副本（关闭“保存小文件”），或导出 OBJ/MTL 再导入。');
    }
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (url === 'local-rhino/rhino3dm.js') return rhinoJS;
    if (url === 'local-rhino/rhino3dm.wasm') return rhinoWasm;
    if (/^(data:|blob:)/i.test(url)) return url;
    warnings.add('有外部贴图未加载。');
    return texturePlaceholder;
  });
  const loader = new Rhino3dmLoader(manager).setLibraryPath('local-rhino/').setWorkerLimit(1);
  // The loader otherwise merges different Rhino IDs that share a name and color.
  const comparison = loader as Rhino3dmLoader & { _compareMaterials: (material: THREE.Material) => THREE.Material };
  const compare = comparison._compareMaterials.bind(loader);
  const sourceMaterials = new Map<string, THREE.Material>();
  comparison._compareMaterials = material => {
    if (!material.userData.id) return compare(material);
    const key = JSON.stringify([material.userData.id, material.type, material.vertexColors]);
    const existing = sourceMaterials.get(key);
    if (existing) return existing;
    sourceMaterials.set(key, material);
    return material;
  };
  try {
    onProgress?.('正在加载显示网格…');
    const root = await loader.parseAsync(buffer);
    const inspected = new Set<THREE.Material>();
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshPhysicalMaterial) || inspected.has(material)) continue;
        inspected.add(material);
        const shine = legacyMaterials[material.userData.id];
        // The loader supplies legacy byte colors as normalized RGB. They still need sRGB decoding.
        if (shine !== undefined) {
          material.color.convertSRGBToLinear();
          material.emissive.convertSRGBToLinear();
          material.specularColor.convertSRGBToLinear();
          material.userData.legacyShine = shine;
        } else {
          material.userData.rhinoPbr = true;
        }
        for (const texture of [material.map, material.emissiveMap, material.specularColorMap, material.sheenColorMap]) {
          if (texture) {
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
          }
        }
      }
    });
    const loaderWarnings = root.userData.warnings as { type?: string; message?: string }[] | undefined;
    for (const warning of loaderWarnings ?? []) {
      if (warning.type === 'missing mesh' || /no mesh|missing mesh|no conversion/i.test(warning.message ?? '')) {
        throw new Error('存在无法渲染的 3DM 部件，请导出为完整网格。');
      }
    }
    return prepare(root, file.name, '3DM', result.unit, result.unitFactor, [...warnings]);
  } finally {
    loader.dispose();
  }
}

export async function loadModel(files: File[], onProgress?: OperationProgress): Promise<RenderModel> {
  const models = files.filter(f => /\.(obj|3dm)$/i.test(f.name));
  if (models.length !== 1) throw new Error('请一次选择一个 OBJ 或 3DM 模型。OBJ 可同时选择配套 MTL 和贴图。');
  const file = models[0];
  if (file.size === 0) throw new Error('模型文件为空。');
  return /\.3dm$/i.test(file.name) ? read3DM(file, onProgress) : readOBJ(file, files, onProgress);
}

export function measured(model: RenderModel, axis: Axis) {
  if (model.unitFactor === null) return '';
  const key = { width: 'x', depth: 'y', height: 'z' }[axis] as 'x' | 'y' | 'z';
  const value = model.size[key] * model.unitFactor;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, useGrouping: false }).format(value) + ' mm';
}

export function disposeModel(model: RenderModel) {
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Set<THREE.Texture>();
  model.group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    (Array.isArray(object.material) ? object.material : [object.material]).forEach(m => materials.add(m));
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}
