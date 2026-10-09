import { createHash } from 'node:crypto';
import type { ModelsDevCapabilitiesService } from '../../models-dev/contract';
import type { ModelBinding } from './config';
import template from './model-template-0.160.1.json';

export function mergeCatalog(native: unknown, bindings: readonly ModelBinding[], catalog: ModelsDevCapabilitiesService): unknown {
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('codex_router_invalid_catalog');
  const body = native as Record<string, any>;
  // Generic OpenAI consumers retain their original shape. Codex requires richer models.
  const rich = Array.isArray(body.models);
  if (!rich && !Array.isArray(body.data)) throw new Error('codex_router_invalid_catalog');
  const existing = rich ? body.models : body.data;
  const ids = new Set(existing.map((entry: any) => rich ? entry.slug : entry.id));
  const added: any[] = [];
  for (const binding of bindings) {
    const id = binding.alias ?? binding.model;
    if (ids.has(id)) throw new Error('codex_router_model_conflict');
    ids.add(id);
    const info = catalog.model(binding);
    if (!info || info.contextWindow === null || !info.inputModalities.includes('text')) continue;
    if (!rich) { added.push({id, object: 'model', owned_by: binding.provider}); continue; }
    const overrides = binding.capabilityOverrides;
    const context = Math.min(info.contextWindow, overrides?.contextWindow ?? info.contextWindow);
    const reasoning = info.reasoning && overrides?.reasoning !== false;
    // Only the implemented protocol subset is advertised; catalog fields are not promises of hosted tools.
    added.push({...template, slug:id, display_name:info.name, description:`${info.name} (${binding.provider})`,
      context_window:context, max_context_window:context, auto_compact_token_limit:Math.floor(context * 0.85),
      input_modalities: ['text', ...(info.inputModalities.includes('image') && overrides?.images !== false ? ['image'] : [])],
      supported_reasoning_levels: reasoning ? ['low','medium','high'].map(effort => ({effort,description:effort})) : [],
      default_reasoning_level:reasoning ? 'medium' : 'none', support_verbosity:false,
    });
  }
  return {...body, [rich ? 'models' : 'data']: [...existing, ...added]};
}
/** No shared identity cache: the upstream's per-request catalog is merged on demand. */
export function catalogEtag(body: unknown, version: number | null, clientVersion: string): string {
  return `"${createHash('sha256').update(JSON.stringify([body,version,clientVersion])).digest('hex')}"`;
}
