import rhinoModule from 'rhino3dm/rhino3dm.module.js?url';
import wasm from 'rhino3dm/rhino3dm.wasm?url';

const rhinoPromise = import(/* @vite-ignore */ rhinoModule).then(
  (module: typeof import('rhino3dm')) => module.default({ locateFile: () => wasm }),
);
function release(value: unknown) {
  (value as { delete?: () => void } | undefined)?.delete?.();
}

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer>) => {
  try {
    const rhino = await rhinoPromise;
    const doc = rhino.File3dm.fromByteArray(new Uint8Array(data));
    if (!doc) throw new Error('无法读取 3DM 文件。请检查文件是否完整。');
    const issues: string[] = [];
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
      for (let i = 0; i < table.count; i++) {
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
    self.postMessage({ issues, unit, unitFactor, legacyMaterials });
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
