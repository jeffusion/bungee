import { createHash } from 'node:crypto';
import type { DispatchRequestInput } from '@jeffusion/bungee-core/plugin';
import type { ModelBinding } from './config';

function header(headers: Record<string, string>, name: string): string {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
}

/** Request headers are captured at entry dispatch, before provider rewrites. */
export function catalogKeys({context, principal, servingRevision}: DispatchRequestInput, bindings: readonly ModelBinding[]): {validator: string; snapshot: string} | null {
  const directory = context.method === 'GET' && /\/models$/.test(context.originalUrl.pathname);
  const generation = context.method === 'POST' && /\/responses$/.test(context.originalUrl.pathname);
  if ((!directory && !generation) || !context.routeId) return null;
  const versions = context.originalUrl.searchParams.getAll('client_version');
  const version = directory ? versions.length === 1 ? versions[0] : '' : header(context.headers, 'version');
  if (!version || version.length > 128 || /[\u0000-\u0020\u007f]/.test(version)) return null;
  // Account headers partition records only; authorization still belongs to the host.
  const scope = [
    context.routeId, servingRevision ?? null, bindings,
    principal ? [principal.domain, principal.keyId, principal.credentialVersion] : ['anonymous', '', 0],
    header(context.headers, 'authorization'), header(context.headers, 'x-api-key'), header(context.headers, 'api-key'),
    header(context.headers, 'chatgpt-account-id'),
  ];
  const key = (version: string) => createHash('sha256').update(JSON.stringify([...scope, version])).digest('hex');
  // Codex queries the release version but sends the full version in generation headers.
  // Normalize only notification matching; upstream snapshots retain the exact query version.
  return {validator: key(version.replace(/^(\d+\.\d+\.\d+)[-+].*$/, '$1')), snapshot: key(version)};
}

/** Ephemeral control-process LRU. Reads affect eviction, never the publication TTL. */
export class CatalogValidators {
  private readonly entries = new Map<string, {etag: string; expires: number}>();
  constructor(private readonly now = Date.now) {}
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }
  get(key: string): string | null {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.etag;
  }
  put(key: string, etag: string): null {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^"[a-f0-9]{64}"$/.test(etag)) throw new Error('codex_router_invalid_catalog_validator');
    this.sweep();
    this.entries.delete(key);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, {etag, expires: this.now() + 600_000});
    return null;
  }
  clear(): void { this.entries.clear(); }
}
