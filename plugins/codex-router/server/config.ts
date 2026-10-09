export interface ModelBinding {
  provider: string;
  model: string;
  alias?: string;
  target: { type: 'route' | 'service'; id: string };
  capabilityOverrides?: { contextWindow?: number; tools?: boolean; reasoning?: boolean; images?: boolean };
}
export function parseBindings(value: unknown): readonly ModelBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('codex_router_invalid_bindings');
  const ids = new Set<string>();
  return Object.freeze(value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['provider','model','alias','target','capabilityOverrides'].includes(key))) throw new Error('codex_router_invalid_bindings');
    for (const text of [entry.provider, entry.model, ...(entry.alias === undefined ? [] : [entry.alias])]) {
      if (typeof text !== 'string' || !text || text !== text.trim() || text.length > 512 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('codex_router_invalid_bindings');
    }
    const target = entry.target;
    if (!target || !['route','service'].includes(target.type) || typeof target.id !== 'string' || !target.id
      || Object.keys(target).some(key => !['type','id'].includes(key))) throw new Error('codex_router_invalid_target');
    const publicId = entry.alias ?? entry.model;
    if (ids.has(publicId)) throw new Error('codex_router_model_conflict');
    ids.add(publicId);
    const overrides = entry.capabilityOverrides;
    if (overrides !== undefined) {
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('codex_router_invalid_capabilities');
      for (const [key, val] of Object.entries(overrides)) {
        if (key === 'contextWindow' ? typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1
          : !['tools','reasoning','images'].includes(key) || typeof val !== 'boolean') throw new Error('codex_router_invalid_capabilities');
      }
    }
    return Object.freeze(structuredClone(entry)) as ModelBinding;
  }));
}
