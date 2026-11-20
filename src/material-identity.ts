/** Merge copied Rhino definitions only when both their names and decoded surfaces agree. */
export function rhinoMaterialAliases(materials: Record<string, unknown>[]) {
  const aliases = new Map<string, string>();
  const definitions = new Map<string, string>();
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])) : value;
  for (const material of materials) {
    if (typeof material.id !== 'string') continue;
    const { id, renderMaterialInstanceId: _instance, ...surface } = material;
    const name = typeof surface.name === 'string' ? surface.name.trim().normalize('NFKC') : '';
    // Unnamed definitions are not assumed to be one material merely because they look alike.
    const signature = name ? JSON.stringify(stable({ ...surface, name })) : id;
    const canonical = definitions.get(signature) ?? id;
    definitions.set(signature, canonical);
    aliases.set(id, canonical);
  }
  return aliases;
}
