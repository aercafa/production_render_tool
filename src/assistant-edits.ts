import * as THREE from 'three';
import type { RenderModel } from './model';
import { premiumMaterial, premiumSurface } from './studio';
import { premiumStudio } from './render-config';
import type { RenderStyle } from './view-effects';
import { grainDirections, type GrainDirection } from './procedural-wood';
import presets from '../server/material-presets.json';

export type MaterialPreset = keyof typeof presets;
export const materialPresets = presets;

function presetValues(pattern: MaterialPreset, textured: boolean): Partial<MaterialValues> {
  return {
    specularIntensity: 1, clearcoat: 0, transmission: 0, ior: 1.5,
    emissiveColor: '#000000', emissiveIntensity: 0,
    grainScale: 1, grainDetail: .55, grainDirection: 'auto',
    ...materialPresets[pattern].defaults, pattern,
    ...(pattern === 'screen' && textured ? { color: '#ffffff' } : {}),
  } as Partial<MaterialValues>;
}

export type MaterialValues = {
  color: string;
  roughness: number;
  metalness: number;
  emissiveIntensity: number;
  emissiveColor: string;
  specularIntensity: number;
  clearcoat: number;
  transmission: number;
  ior: number;
  pattern: 'source' | MaterialPreset;
  grainDirection: GrainDirection;
  grainScale: number;
  grainDetail: number;
};
export type MaterialOverrides = ReadonlyMap<THREE.Mesh, ReadonlyMap<number, Partial<MaterialValues>>>;
export type RenderTuning = { ao: number; shadow: number; reflection: number };
export const defaultTuning: RenderTuning = {
  ao: premiumStudio.ao.strength,
  shadow: premiumStudio.shadow.intensity,
  reflection: premiumStudio.environmentIntensity,
};
export type SceneValues = RenderTuning & { style: RenderStyle; exposure: number };
type MaterialProperty = keyof MaterialValues;
type SceneProperty = keyof SceneValues;
type OverridesById = Map<string, Partial<MaterialValues>>;
export type Change = { target: string; property: MaterialProperty | SceneProperty; value: string | number };
type ModelMaterial = {
  id: string;
  name: string;
  objects: Set<string>;
  slots: { mesh: THREE.Mesh; index: number }[];
  values: MaterialValues;
  emits: boolean;
  textured: boolean;
  varies: boolean;
  longAxes: Set<GrainDirection>;
};

export const propertyLabels = {
  color: '基础色', roughness: '粗糙度', metalness: '金属度', emissiveIntensity: '自发光强度',
  pattern: '表面材质', grainDirection: '木纹方向', grainScale: '木纹密度', grainDetail: '木纹细节',
  emissiveColor: '自发光颜色', specularIntensity: '高光强度', clearcoat: '清漆强度',
  transmission: '透射率', ior: '折射率',
  style: '渲染风格', exposure: '曝光', ao: 'AO 强度', shadow: '阴影强度', reflection: '环境反射',
};
export const styleLabels = { studio: '棚拍材质', premium: '高保真棚拍', clay: '灰白模 · 线描' };

function inventory(model: RenderModel) {
  const groups = new Map<string, ModelMaterial>();
  const labels = new Map<string, number>();
  const descriptions = new Map<THREE.Material, Map<ReturnType<typeof premiumSurface>,
    { values: MaterialValues; emits: boolean }>>();
  model.group.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const size = object.geometry.boundingBox?.getSize(new THREE.Vector3());
    const longAxis = !size || (size.x >= size.y && size.x >= size.z) ? 'x' : size.y >= size.z ? 'y' : 'z';
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const sourceMaterials = object.userData.workbenchMaterials as { id: string; name: string }[] | undefined;
    materials.forEach((material, index) => {
      if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhongMaterial)) return;
      const source = sourceMaterials?.[index];
      const label = source?.name || '未命名材质';
      const finish = premiumSurface(material, object.name);
      let finishes = descriptions.get(material);
      if (!finishes) { finishes = new Map(); descriptions.set(material, finishes); }
      let description = finishes.get(finish);
      if (!description) {
        const physical = premiumMaterial(material, finish);
        if (!(physical instanceof THREE.MeshStandardMaterial)) return;
        description = {
          values: {
            color: '#' + physical.color.getHexString(),
            roughness: +physical.roughness.toFixed(3),
            metalness: +physical.metalness.toFixed(3),
            emissiveIntensity: +physical.emissiveIntensity.toFixed(3),
            emissiveColor: '#' + physical.emissive.getHexString(),
            specularIntensity: physical instanceof THREE.MeshPhysicalMaterial ? physical.specularIntensity : 1,
            clearcoat: physical instanceof THREE.MeshPhysicalMaterial ? physical.clearcoat : 0,
            transmission: physical instanceof THREE.MeshPhysicalMaterial ? physical.transmission : 0,
            ior: physical instanceof THREE.MeshPhysicalMaterial ? physical.ior : 1.5,
            pattern: 'source', grainDirection: 'auto', grainScale: 1, grainDetail: .55,
          },
          emits: !!physical.emissiveMap || Math.max(physical.emissive.r, physical.emissive.g, physical.emissive.b) > 0,
        };
        if (physical !== material) physical.dispose();
        finishes.set(finish, description);
      }
      const { values, emits } = description;
      const key = source?.id ?? material.uuid;
      const group = groups.get(key);
      if (group) {
        group.slots.push({ mesh: object, index });
        group.emits &&= emits;
        group.textured ||= !!material.map;
        group.longAxes.add(longAxis);
        group.varies ||= (Object.keys(values) as MaterialProperty[]).some(p => values[p] !== group.values[p]);
        if (object.name) group.objects.add(object.name);
      } else {
        const number = (labels.get(label) ?? 0) + 1;
        labels.set(label, number);
        groups.set(key, { id: 'm' + (groups.size + 1), name: number === 1 ? label : label + '（' + number + '）',
          objects: new Set(object.name ? [object.name] : []), slots: [{ mesh: object, index }],
          values, emits, textured: !!material.map, varies: false, longAxes: new Set([longAxis]) });
      }
    });
  });
  return groups;
}

export class AssistantEdits {
  readonly materials: Map<string, ModelMaterial>;
  private values: OverridesById = new Map();
  private history: { values: OverridesById; scene: SceneValues; after: SceneValues }[] = [];

  constructor(model: RenderModel) {
    this.materials = new Map(Array.from(inventory(model).values(), material => [material.id, material]));
  }

  get canUndo() { return this.history.length > 0; }

  context(scope: string, scene: SceneValues) {
    const selected = scope ? this.materials.get(scope) : undefined;
    const truncated = !selected && this.materials.size > 100;
    const materials = selected ? [selected] : truncated ? [] : [...this.materials.values()];
    return {
      current: scene, selectedMaterial: selected?.id ?? null, totalMaterials: this.materials.size,
      requiresMaterialSelection: truncated,
      materials: materials.map(part => ({
        id: part.id, name: part.name.slice(0, 96), count: part.slots.length,
        usedBy: Array.from(part.objects).slice(0, 4).map(name => name.slice(0, 56)),
        values: { ...part.values, ...this.values.get(part.id) },
        hasEmission: ['screen', 'emissive'].includes(this.values.get(part.id)?.pattern ?? '') ||
          (!this.values.get(part.id)?.pattern && part.emits),
        textured: !this.values.get(part.id)?.pattern || this.values.get(part.id)?.pattern === 'screen' ? part.textured : false,
        sourceValuesMayVary: part.varies,
        autoGrainAxes: [...part.longAxes],
      })),
    };
  }

  validate(items: unknown[], scope: string, available: Set<string>, scene: SceneValues): Change[] {
    const seen = new Set<string>();
    if (items.length > 20) throw new Error('修改项超过 20 条，请缩小范围。');
    const changes = items.map(item => {
      const c = item as Partial<Change> | null;
      if (!c || typeof c.target !== 'string' || typeof c.property !== 'string') {
        throw new Error('修改建议格式不正确。');
      }
      const { target, property, value } = c;
      const part = this.materials.get(target);
      let valid = false;
      if (target === 'scene') {
        if (property === 'style') valid = typeof value === 'string' && Object.hasOwn(styleLabels, value);
        if (property === 'exposure') valid = typeof value === 'number' && Number.isInteger(value) && value >= -10 && value <= 10;
        if (property === 'ao' || property === 'shadow') valid = numberIn(value, 1);
        if (property === 'reflection') valid = numberIn(value, 2);
      } else if (part && available.has(target) && (!scope || scope === target)) {
        if (property === 'color' || property === 'emissiveColor') valid = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
        if (property === 'roughness' || property === 'metalness') valid = numberIn(value, 1);
        if (property === 'emissiveIntensity') valid = numberIn(value, 2);
        if (property === 'specularIntensity' || property === 'clearcoat' || property === 'transmission') valid = numberIn(value, 1);
        if (property === 'ior') valid = typeof value === 'number' && value >= 1 && value <= 2.33;
        if (property === 'pattern') valid = typeof value === 'string' && (value === 'source' || Object.hasOwn(materialPresets, value));
        if (property === 'grainDirection') valid = typeof value === 'string' && Object.hasOwn(grainDirections, value);
        if (property === 'grainDetail') valid = numberIn(value, 1);
        if (property === 'grainScale') valid = typeof value === 'number' && value >= .4 && value <= 2.5;
      }
      const key = target + ':' + property;
      if (!valid || seen.has(key)) throw new Error('建议包含无效、重复或超出所选材质的修改，请重新描述。');
      seen.add(key);
      return { target, property, value } as Change;
    });
    for (const change of changes) {
      if (change.target === 'scene' || change.property === 'pattern') continue;
      const pattern = changes.find(item => item.target === change.target && item.property === 'pattern')?.value
        ?? this.values.get(change.target)?.pattern ?? 'source';
      if (pattern !== 'source') {
        const preset = materialPresets[pattern as MaterialPreset];
        if (!preset.tune.includes(change.property)) throw new Error(preset.label + '不支持该参数，请换用合适的材质或参数。');
      } else if (change.property.startsWith('grain') ||
          ((change.property === 'emissiveColor' || change.property === 'emissiveIntensity') && !this.materials.get(change.target)?.emits) ||
          change.property === 'transmission' || change.property === 'ior') {
        throw new Error('请先选择支持此参数的材质预设。');
      }
    }
    return changes.filter(({ target, property, value }) => {
      if (target === 'scene') return scene[property as SceneProperty] !== value;
      const part = this.materials.get(target)!;
      const current = this.values.get(target)?.[property as MaterialProperty];
      const patternChange = changes.find(c => c.target === target && c.property === 'pattern');
      if (patternChange && property !== 'pattern') {
        const pattern = patternChange.value as MaterialValues['pattern'];
        const base = pattern === 'source' ? part.values : presetValues(pattern, part.textured);
        if (pattern !== (this.values.get(target)?.pattern ?? part.values.pattern) ||
            (pattern === 'source' && this.values.has(target))) {
          const presetValue = base[property as keyof typeof base];
          return presetValue === undefined || presetValue !== value;
        }
      }
      if (property === 'pattern' && value === 'source') return this.values.has(target);
      return (current === undefined && part.varies) || (current ?? part.values[property as MaterialProperty]) !== value;
    });
  }

  describe({ target, property, value }: Change, scene: SceneValues, batch: Change[]) {
    const part = this.materials.get(target);
    const previous = part ? (this.values.get(target)?.[property as MaterialProperty] ?? part.values[property as MaterialProperty])
      : scene[property as SceneProperty];
    const label = (v: string | number) => {
      if (property === 'style') return styleLabels[v as RenderStyle];
      if (property === 'pattern') return v === 'source' ? '源材质' : materialPresets[v as MaterialPreset].label;
      if (property === 'grainDirection') return grainDirections[v as GrainDirection];
      return String(v);
    };
    const name = part ? part.name + '（' + part.slots.length + ' 处）' : '全局';
    const before = part?.varies && this.values.get(target)?.[property as MaterialProperty] === undefined
      ? '原值不一' : label(previous);
    const granular = property === 'grainScale' || property === 'grainDetail';
    const isStone = (batch.find(c => c.target === target && c.property === 'pattern')?.value ??
      this.values.get(target)?.pattern) === 'engineered_stone';
    const propertyLabel = granular ? (isStone ? '颗粒' : '木纹') + (property === 'grainScale' ? '密度' : '细节') : propertyLabels[property];
    return name + ' · ' + propertyLabel + '　' + before + ' → ' + label(value) +
      (property === 'pattern' && value === 'screen' ? '（保留已有画面贴图）' :
        property === 'pattern' && value !== 'source' ? '（替换当前表面材质）' :
          property === 'pattern' ? '（恢复源材质）' :
            property === 'color' && part?.textured ? '（如有保留的贴图则对其调色）' : '');
  }

  apply(changes: Change[], scene: SceneValues) {
    const next = { ...scene };
    const values = new Map(this.values);
    for (const { target, property, value } of changes) {
      if (property !== 'pattern') continue;
      if (value === 'source') values.delete(target);
      else {
        const pattern = value as MaterialPreset;
        values.set(target, presetValues(pattern, !!this.materials.get(target)?.textured));
      }
    }
    for (const { target, property, value } of changes) {
      if (property === 'pattern') continue;
      if (target === 'scene') Object.assign(next, { [property]: value });
      else values.set(target, { ...values.get(target), [property]: value });
    }
    this.history.push({ values: this.values, scene, after: next });
    this.values = values;
    return next;
  }

  undo(current: SceneValues) {
    const entry = this.history.pop();
    if (!entry) return current;
    this.values = entry.values;
    const next = { ...current };
    for (const key of Object.keys(entry.scene) as SceneProperty[]) {
      if (entry.scene[key] !== entry.after[key] && current[key] === entry.after[key]) {
        Object.assign(next, { [key]: entry.scene[key] });
      }
    }
    return next;
  }

  overrides(): MaterialOverrides {
    const result = new Map<THREE.Mesh, Map<number, Partial<MaterialValues>>>();
    for (const [id, values] of this.values) {
      for (const { mesh, index } of this.materials.get(id)!.slots) {
        let slots = result.get(mesh);
        if (!slots) { slots = new Map(); result.set(mesh, slots); }
        slots.set(index, values);
      }
    }
    return result;
  }
}

function numberIn(value: unknown, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}
