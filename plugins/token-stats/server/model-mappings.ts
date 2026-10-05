import type { PluginStorage } from '../../../packages/core/src/plugin.types';

/** Pricing aliases never rewrite a request or the recorded model name. */
export interface PriceModelMapping { source: string; provider: string; model: string }
export interface PriceModelOption { provider: string; providerName: string; model: string; name: string }
export const PRICE_MODEL_MAPPINGS_KEY = 'pricing:model-mappings:v1';
export const MAX_PRICE_MODEL_MAPPINGS = 100;

/** SQLite KV get() is best-effort and hides failures; pricing aliases need strict reads. */
export async function readPriceModelMappings(storage: PluginStorage): Promise<PriceModelMapping[]> {
  if (!storage.observation) return parsePriceModelMappings(await storage.get(PRICE_MODEL_MAPPINGS_KEY) ?? []);
  return storage.observation.withDatabase(db => {
    const row = db.query<{ value: string; ttl: number | null }, [string, string]>(
      'SELECT value, ttl FROM plugin_storage WHERE plugin_name = ? AND key = ?',
    ).get('token-stats', PRICE_MODEL_MAPPINGS_KEY);
    if (!row || (row.ttl !== null && row.ttl < Math.floor(Date.now() / 1000))) return [];
    return parsePriceModelMappings(JSON.parse(row.value));
  });
}

export function isUnchangedPriceModelMapping(mapping: PriceModelMapping, existing: readonly PriceModelMapping[]): boolean {
  return existing.some(item => item.source === mapping.source && item.provider === mapping.provider && item.model === mapping.model);
}

export function parsePriceModelMappings(value: unknown): PriceModelMapping[] {
  if (!Array.isArray(value) || value.length > MAX_PRICE_MODEL_MAPPINGS) throw new Error('invalid_input');
  const sources = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['source', 'provider', 'model'].includes(key))) throw new Error('invalid_input');
    const { source, provider, model } = item;
    for (const [text, limit] of [[source, 256], [provider, 128], [model, 256]] as const) {
      if (typeof text !== 'string' || !text.trim() || text !== text.trim() || text.length > limit
        || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('invalid_input');
    }
    if (sources.has(source)) throw new Error('invalid_input');
    sources.add(source);
    return { source, provider, model };
  });
}
