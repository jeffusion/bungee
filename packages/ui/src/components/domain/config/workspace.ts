import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { ConfigurationImportEnvelope, ConfigurationPublication } from '$api/config';

export const IMPORT_LIMITS = { bytes: 1024 * 1024, depth: 16, nodes: 12000, items: 500 } as const;
export type DiffLabel = 'logLevel' | 'requestLimit' | 'authEnabled' | 'authTokens' | 'loggingEnabled' | 'bodyMax' | 'retention'
  | 'routes' | 'services' | 'activations' | 'bindings' | 'authHidden' | 'loggingHidden' | 'globalHidden' | 'unknown';
export type ConfigDiff = {
  label: DiffLabel; action: 'added' | 'removed' | 'changed' | 'reordered'; before: string; after: string;
  identity?: string; count?: number; bindings?: [number | null, number | null]; endpoints?: [number | null, number | null];
};
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : {};
const canonical = (v: unknown) => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const own = (v: unknown, key: string) => Object.hasOwn(record(v), key) ? record(v)[key] : undefined;

/** Bound work before inspection. No imported property name is ever a display label or DOM path. */
export function assertBounded(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0, chars = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++nodes > IMPORT_LIMITS.nodes || depth > IMPORT_LIMITS.depth) throw new Error('snapshot_limit');
    if (typeof v === 'string') chars += v.length;
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length > IMPORT_LIMITS.items) throw new Error('snapshot_limit');
      chars += keys.reduce((sum, key) => sum + key.length, 0);
      for (const child of Object.values(v)) stack.push([child, depth + 1]);
    }
    if (chars > IMPORT_LIMITS.bytes) throw new Error('snapshot_limit');
  }
}

const control = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
export function safeResourceIdentity(value: unknown, kind: 'route' | 'service' | 'plugin' | 'id'): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > 128 || control.test(value)) return undefined;
  if (kind === 'route') return /^\/[A-Za-z0-9/_.*:{}-]*$/.test(value) && !value.includes('..') && !/\d{8,}|[a-f0-9]{32,}/i.test(value) ? value : undefined;
  if (kind === 'plugin') return /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : undefined;
  if (kind === 'id') return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    || /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : undefined;
  return value.length <= 96 && /\p{L}/u.test(value) && /^[\p{L}\p{N} ._-]+$/u.test(value) ? value : undefined;
}
const hidden = (v: unknown) => v === undefined ? 'unset' : 'hidden';
const bool = (v: unknown) => v === undefined ? 'unset' : typeof v === 'boolean' ? v ? 'on' : 'off' : 'hidden';
function boundedNumber(v: unknown, min: number, max: number, format: (n: number) => string): string {
  return v === undefined ? 'unset' : typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? format(v) : 'hidden';
}

export function configurationDiff(before: unknown, after: unknown, credentials: readonly string[] = []): ConfigDiff[] {
  try { assertBounded(before); assertBounded(after); } catch { return [{ label: 'unknown', action: 'changed', before: 'hidden', after: 'hidden' }]; }
  const rows: ConfigDiff[] = [];
  const a = own(before, 'logical_configuration'), b = own(after, 'logical_configuration');
  const aa = own(a, 'auth'), ba = own(b, 'auth');
  const secrets = [...credentials, ...[own(aa, 'tokens'), own(ba, 'tokens')].flatMap(v => Array.isArray(v) ? v : [])]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const al = own(a, 'logging'), bl = own(b, 'logging'), ab = own(al, 'body'), bb = own(bl, 'body');
  function field(label: DiffLabel, x: unknown, y: unknown, format: (v: unknown) => string = hidden) {
    if (!equal(x, y)) rows.push({ label, action: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: format(x), after: format(y) });
  }
  field('logLevel', own(a, 'log_level'), own(b, 'log_level'), v => v === undefined ? 'unset' : typeof v === 'string' && ['debug', 'info', 'warn', 'error'].includes(v) ? v : 'hidden');
  field('requestLimit', own(a, 'body_parser_limit'), own(b, 'body_parser_limit'), v => v === undefined ? 'unset' : typeof v === 'string' && /^\d{1,6}(?:\.\d{1,3})?(?:b|kb|mb|gb)$/i.test(v) ? v : 'hidden');
  field('authEnabled', own(aa, 'enabled'), own(ba, 'enabled'), bool);
  field('authTokens', own(aa, 'tokens'), own(ba, 'tokens'));
  field('loggingEnabled', own(ab, 'enabled'), own(bb, 'enabled'), bool);
  field('bodyMax', own(ab, 'max_size'), own(bb, 'max_size'), v => boundedNumber(v, 1024, 102400, n => `${n / 1024} KiB`));
  field('retention', own(ab, 'retention_days'), own(bb, 'retention_days'), v => boundedNumber(v, 1, 30, String));
  function unknown(label: DiffLabel, x: unknown, y: unknown, known: string[]) {
    const extra = (v: unknown) => Object.entries(record(v)).filter(([key]) => !known.includes(key)).sort(([a], [b]) => a.localeCompare(b));
    if (!equal(extra(x), extra(y))) rows.push({ label, action: 'changed', before: 'hidden', after: 'hidden' });
  }
  unknown('authHidden', aa, ba, ['enabled', 'tokens']);
  unknown('loggingHidden', ab, bb, ['enabled', 'max_size', 'retention_days']);
  unknown('loggingHidden', al, bl, ['body']);
  unknown('globalHidden', a, b, ['log_level', 'body_parser_limit', 'auth', 'logging', 'routes', 'services', 'plugins']);
  unknown('unknown', before, after, ['logical_configuration', 'plugin_activations']);
  function resources(label: 'routes' | 'services' | 'activations' | 'bindings', x: unknown, y: unknown) {
    if (equal(x, y)) return;
    if (!Array.isArray(x) || !Array.isArray(y)) { field(label, x, y); return; }
    if (x.length === y.length && equal(x.map(canonical).sort(), y.map(canonical).sort())) {
      rows.push({ label, action: 'reordered', before: 'hidden', after: 'hidden', count: x.length }); return;
    }
    const publicIdentity = (v: unknown) => label === 'routes' ? safeResourceIdentity(own(v, 'path'), 'route')
      : label === 'services' ? safeResourceIdentity(own(v, 'name'), 'service') ?? safeResourceIdentity(own(v, 'id'), 'id')
      : safeResourceIdentity(own(v, label === 'activations' ? 'plugin_name' : 'name'), 'plugin');
    const identity = (v: unknown) => { const result = publicIdentity(v); return result && !secrets.some(secret => result.includes(secret)) ? result : undefined; };
    const count = (v: unknown, key: string) => Array.isArray(own(v, key)) ? (own(v, key) as unknown[]).length : null;
    const key = (v: unknown) => safeResourceIdentity(own(v, 'id'), 'id') ?? identity(v);
    const xKeys = x.map(key), yKeys = y.map(key);
    const identifiable = (keys: Array<string | undefined>) => keys.every(k => k !== undefined) && new Set(keys).size === keys.length;
    const add = (old: unknown, next: unknown, action: ConfigDiff['action']) => rows.push({ label, action,
      identity: identity(next ?? old), before: 'hidden', after: 'hidden', count: 1,
      ...(label !== 'activations' ? { bindings: [count(old, 'plugins'), count(next, 'plugins')] as [number | null, number | null] } : {}),
      ...(label === 'services' ? { endpoints: [count(old, 'endpoints'), count(next, 'endpoints')] as [number | null, number | null] } : {}) });
    if (!x.length) { y.forEach(v => add(undefined, v, 'added')); return; }
    if (!y.length) { x.forEach(v => add(v, undefined, 'removed')); return; }
    if (!identifiable(xKeys) || !identifiable(yKeys)) {
      rows.push({ label, action: 'changed', before: 'hidden', after: 'hidden', count: Math.max(x.length, y.length) }); return;
    }
    const previous = new Map(xKeys.map((k, i) => [k!, x[i]])), next = new Map(yKeys.map((k, i) => [k!, y[i]]));
    for (const [key, old] of previous) if (!next.has(key)) add(old, undefined, 'removed');
    for (const [key, value] of next) {
      if (!previous.has(key)) add(undefined, value, 'added');
      else if (!equal(previous.get(key), value)) add(previous.get(key), value, 'changed');
    }
    if (equal([...previous.keys()].sort(), [...next.keys()].sort()) && !equal(xKeys, yKeys)) rows.push({ label, action: 'reordered', before: 'hidden', after: 'hidden', count: x.length });
  }
  resources('routes', own(a, 'routes'), own(b, 'routes'));
  resources('services', own(a, 'services'), own(b, 'services'));
  resources('bindings', own(a, 'plugins'), own(b, 'plugins'));
  resources('activations', own(before, 'plugin_activations'), own(after, 'plugin_activations'));
  return rows;
}

/** Local shape and complexity boundary. Server validation remains authoritative. */
export function parseImportPreview(text: string): ConfigurationImportEnvelope {
  if (text.length > IMPORT_LIMITS.bytes || new TextEncoder().encode(text).byteLength > IMPORT_LIMITS.bytes) throw new Error('snapshot_limit');
  const envelope = JSON.parse(text); assertBounded(envelope);
  const keys = ['format', 'format_version', 'schema_version', 'exported_at', 'source_revision', 'content_hash', 'aggregate', 'envelope_hash'];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).length !== keys.length || keys.some(k => !Object.hasOwn(envelope, k))
    || envelope.format !== 'bungee-config-snapshot' || envelope.format_version !== 1 || envelope.schema_version !== 2
    || !Number.isSafeInteger(envelope.source_revision) || envelope.source_revision < 1
    || !Number.isSafeInteger(envelope.exported_at) || envelope.exported_at < 0
    || typeof envelope.content_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(envelope.content_hash)
    || typeof envelope.envelope_hash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(envelope.envelope_hash)
    || !envelope.aggregate || !Array.isArray(envelope.aggregate.plugin_activations)
    || !envelope.aggregate.logical_configuration || Array.isArray(envelope.aggregate.logical_configuration)
    || ['routes', 'services', 'plugins'].some(k => !Array.isArray(envelope.aggregate.logical_configuration[k]))) throw new Error('invalid_snapshot');
  return envelope;
}
export function aggregateCounts(aggregate: ConfigurationAggregateV2) {
  return { routes: aggregate.logical_configuration.routes.length, services: aggregate.logical_configuration.services.length,
    bindings: aggregate.logical_configuration.plugins.length, activations: aggregate.plugin_activations.length };
}
export function publicationBusy(publication: ConfigurationPublication | null): boolean {
  return !!publication && (['committed', 'publishing', 'draining'].includes(publication.operation?.state ?? '')
    || ['scheduled', 'running'].includes(publication.recovery?.state ?? ''));
}
export function servingStatus(publication: ConfigurationPublication | null, fresh: boolean): 'confirmed' | 'unconfirmed' | 'unknown' {
  if (!fresh || !publication || typeof publication.serving_complete !== 'boolean' || publication.serving_revision === undefined) return 'unknown';
  return publication.serving_complete && Number.isSafeInteger(publication.serving_revision) ? 'confirmed' : 'unconfirmed';
}
export const pendingPublicationKey = 'bungee:settings-publication';
export function readPendingPublication(storage: Pick<Storage, 'getItem'> = sessionStorage): { mutationId: string; accepted: boolean } | null {
  const value = storage.getItem(pendingPublicationKey);
  if (value === null) return null;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (uuid.test(value)) return { mutationId: value, accepted: false };
  const metadata = JSON.parse(value);
  if (!metadata || Object.keys(metadata).sort().join(',') !== 'accepted,mutationId,version'
    || metadata.version !== 1 || metadata.accepted !== true || typeof metadata.mutationId !== 'string'
    || !uuid.test(metadata.mutationId)) throw new Error('invalid_publication_identity');
  return { mutationId: metadata.mutationId, accepted: true };
}
