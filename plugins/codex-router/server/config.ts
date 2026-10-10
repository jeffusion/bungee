import type { LLMProtocol } from '@jeffusion/bungee-types';

export interface ModelBinding {
  provider: string;
  model: string;
  source?: string;
  sourceProvider?: string;
  sourceProtocol?: 'responses';
  alias?: string;
  target: { type: 'route' | 'service'; id: string; protocol: LLMProtocol };
  capabilityOverrides?: { contextWindow?: number; tools?: boolean; reasoning?: boolean; images?: boolean };
}
/** The model in the client request; model itself is the upstream destination. */
export function bindingSource(binding: ModelBinding): string { return binding.source ?? binding.alias ?? binding.model; }
export function parseBindings(value: unknown): readonly ModelBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('codex_router_invalid_bindings');
  const ids = new Set<string>();
  return Object.freeze(value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some(key => !['provider','model','source','sourceProvider','sourceProtocol','alias','target','capabilityOverrides'].includes(key))
      || (entry.source !== undefined && entry.alias !== undefined)
      || (entry.sourceProvider !== undefined && entry.source === undefined)) throw new Error('codex_router_invalid_bindings');
    for (const text of [entry.provider, entry.model, ...(entry.source === undefined ? [] : [entry.source]), ...(entry.sourceProvider === undefined ? [] : [entry.sourceProvider]), ...(entry.alias === undefined ? [] : [entry.alias])]) {
      if (typeof text !== 'string' || !text || text !== text.trim() || text.length > 512 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('codex_router_invalid_bindings');
    }
    if (entry.sourceProtocol !== undefined && entry.sourceProtocol !== 'responses') throw new Error('codex_router_source_protocol_unsupported');
    const target = entry.target;
    if (!target || !['route','service'].includes(target.type) || typeof target.id !== 'string' || !target.id
      || Object.keys(target).some(key => !['type','id','protocol'].includes(key))) throw new Error('codex_router_invalid_target');
    if (target.protocol === undefined) throw new Error('codex_router_target_protocol_required');
    if (!['responses','chat_completions','anthropic_messages'].includes(target.protocol)) throw new Error('codex_router_target_protocol_invalid');
    const publicId = bindingSource(entry);
    if (ids.has(publicId)) throw new Error('codex_router_model_conflict');
    ids.add(publicId);
    const overrides = entry.capabilityOverrides;
    if (overrides !== undefined) {
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('codex_router_invalid_capabilities');
      for (const [key, val] of Object.entries(overrides)) {
        if (['contextWindow'].includes(key) ? typeof val !== 'number' || !Number.isSafeInteger(val) || val < 1
          : !['tools','reasoning','images'].includes(key) || typeof val !== 'boolean') throw new Error('codex_router_invalid_capabilities');
      }
    }
    return Object.freeze(structuredClone(entry)) as ModelBinding;
  }));
}
