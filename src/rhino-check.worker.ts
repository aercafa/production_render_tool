import rhinoModule from 'rhino3dm/rhino3dm.module.js?url';
import wasm from 'rhino3dm/rhino3dm.wasm?url';

const rhinoPromise = import(/* @vite-ignore */ rhinoModule).then(
  (module: typeof import('rhino3dm')) => module.default({ locateFile: () => wasm }),
);
function release(value: unknown) {
  (value as { delete?: () => void } | undefined)?.delete?.();
}

self.onmessage = async ({ data }: MessageEvent<Blob>) => {
  try {
    const rhino = await rhinoPromise;
    const doc = rhino.File3dm.fromByteArray(new Uint8Array(await data.arrayBuffer()));
    if (!doc) throw new Error('无法读取 3DM 文件。请检查文件是否完整。');
    const issues: string[] = [];
    const visibleIds = new Set<string>();
    const legacyMaterials: Record<string, number> = {};
    let unit = '';
    let unitFactor: number | null = null;
    const table = doc.objects();
    const settings = doc.settings();
    try {
      const units = [
        ['Microns', 'μm', 0.001], ['Millimeters', 'mm', 1], ['Centimeters', 'cm', 10],
        ['Meters', 'm', 1000], ['Inches', 'in', 25.4], ['Feet', 'ft', 304.8],
        ['Kilometers', 'km', 1000000], ['Yards', 'yd', 914.4],
      ] as const;
      const match = units.find(([key]) => {
        const u = rhino.UnitSystem as unknown as Record<string, unknown>;
        return u[key] !== undefined && u[key] === settings.modelUnitSystem;
      });
      if (match) [, unit, unitFactor] = match;
      const materials = doc.materials();
      for (let i = 0; i < materials.count; i++) {
        const material = materials.get(i);
        const pbr = material.physicallyBased();
        try {
          if (!pbr.supported) legacyMaterials[material.id] = material.shine;
        } finally {
          release(pbr);
          release(material);
        }
      }
      function usable(mesh: ReturnType<InstanceType<typeof rhino.BrepFace>['getMesh']>) {
        if (!mesh || !mesh.isValid) return false;
        const faces = mesh.faces();
        try { return faces.count > 0; } finally { release(faces); }
      }
      const layers = new Map<number, { id: string; parent: string; visible: boolean }>();
      const layerTable = doc.layers();
      for (let i = 0; i < layerTable.count; i++) {
        const layer = layerTable.get(i);
        layers.set(layer.index, { id:layer.id, parent:layer.parentLayerId, visible:layer.visible });
        release(layer);
      }
      const layersById = new Map(Array.from(layers.values(), layer => [layer.id, layer]));
      function layerVisible(index: number) {
        const visited = new Set<string>();
        let layer = layers.get(index);
        while (layer && !visited.has(layer.id)) {
          if (!layer.visible) return false;
          visited.add(layer.id);
          layer = layersById.get(layer.parent);
        }
        return true;
      }
      const objects = new Map<string, { index: number; member: boolean; ref?: string }>();
      for (let i = 0; i < table.count; i++) {
        const item = table.get(i);
        const attr = item.attributes();
        try {
          const { activeSpace } = attr as typeof attr & { activeSpace: typeof rhino.ActiveSpace.PageSpace };
          if (!attr.visible || attr.mode === rhino.ObjectMode.Hidden ||
            activeSpace === rhino.ActiveSpace.PageSpace || !layerVisible(attr.layerIndex)) continue;
          const geometry = item.geometry();
          try {
            objects.set(attr.id, { index:i, member:attr.isInstanceDefinitionObject,
              ref:geometry instanceof rhino.InstanceReference ? geometry.parentIdefId : undefined });
          } finally { release(geometry); }
        } finally { release(attr); release(item); }
      }
      const definitions = new Map<string, string[]>();
      const definitionTable = doc.instanceDefinitions();
      for (let i = 0; i < definitionTable.count; i++) {
        const definition = definitionTable.get(i);
        definitions.set(definition.id, definition.getObjectIds() as string[]);
        release(definition);
      }
      const pending = Array.from(objects, ([id, object]) => object.member ? null : id)
        .filter((id): id is string => id !== null);
      while (pending.length) {
        const id = pending.pop()!;
        const object = objects.get(id);
        if (!object || visibleIds.has(id)) continue;
        visibleIds.add(id);
        if (object.ref) for (const member of definitions.get(object.ref) ?? []) pending.push(member);
      }
      for (const id of visibleIds) {
        const i = objects.get(id)!.index;
        const item = table.get(i);
        const g = item.geometry();
        const attr = item.attributes();
        const name = attr.name?.trim() || '部件 ' + (i + 1);
        try {
          if (g instanceof rhino.Brep) {
            const faces = g.faces();
            let missing = 0;
            try {
              for (let j = 0; j < faces.count; j++) {
                const face = faces.get(j);
                const mesh = face.getMesh(rhino.MeshType.Render);
                try { if (!usable(mesh)) missing++; }
                finally { release(mesh); release(face); }
              }
              if (missing || !faces.count) issues.push(name + '：' + missing + '/' + faces.count + ' 个曲面缺少有效显示网格');
            } finally { release(faces); }
          } else if (g instanceof rhino.Extrusion) {
            const mesh = g.getMesh(rhino.MeshType.Render);
            try { if (!usable(mesh)) issues.push(name + '：拉伸体缺少有效显示网格'); }
            finally { release(mesh); }
          } else if (g instanceof rhino.Mesh) {
            if (!usable(g)) issues.push(name + '：网格为空或无效');
          } else if (g instanceof rhino.Surface) {
            issues.push(name + '：曲面没有可用的渲染网格，请在 Rhino 中导出为网格');
          }
        } finally {
          release(attr);
          release(g);
          release(item);
        }
      }
    } finally {
      release(settings);
      // The object table is owned by the document; its delete(id) removes an object.
      release(doc);
    }
    self.postMessage({ issues, unit, unitFactor, legacyMaterials, visibleIds:[...visibleIds] });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
