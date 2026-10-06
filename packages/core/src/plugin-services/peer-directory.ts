/**
 * Host-private read-only publication directory exchanged over an already
 * authenticated peer link.
 *
 * It is NOT a second protocol: the query and its answer travel through the
 * existing peer link + the existing native RPC mux (`link.request` on the sender
 * side, the mapped `onRequest` handler on the receiver side), and the answer is
 * a bounded JSON page — the exact metadata a host needs to route to a peer's
 * REAL publication (provider/service/major/scope/scopeKey/ready and the actual
 * kernel binding), never a contract schema (a consumer already owns its DSL) and
 * never a plugin-visible handle.
 *
 * The reserved principal/provider are host-minted constants. A plugin cannot
 * send a peer frame at all, and even a host-built frame carrying them is only
 * admitted by the mux for a directory read, so a plugin can never claim them.
 *
 * Consistency: every page carries a revision derived from the full entry set, so
 * a reader can detect a directory that changed while paging and reload instead
 * of mixing two generations.
 */

import { createHash } from 'node:crypto';
import type { RpcJson } from './wire-contract';
import type { HostRpcPublicationView } from './host-rpc';
import type { PluginServiceProcess, PluginServiceScope } from './contracts';

/** Reserved host principal; never a plugin name and never plugin-addressable. */
export const PLUGIN_PEER_DIRECTORY_PRINCIPAL = '!bungee-host';
/** Reserved directory target; never a published plugin service. */
export const PLUGIN_PEER_DIRECTORY_PROVIDER = '!bungee-host.directory';
export const PLUGIN_PEER_DIRECTORY_SERVICE = 'publication-directory';
export const PLUGIN_PEER_DIRECTORY_MAJOR = 1;
export const PLUGIN_PEER_DIRECTORY_METHOD = 'page';
export const PLUGIN_PEER_DIRECTORY_VERSION = 1;

/**
 * One page must stay inside both the canonical RPC JSON envelope (64 KiB) and
 * the frame body cap (64 KiB), so it keeps a real margin below both.
 */
export const PLUGIN_PEER_DIRECTORY_PAGE_MAX_BYTES = 60 * 1024;
/** Entries per page and pages per load are both bounded. */
export const PLUGIN_PEER_DIRECTORY_PAGE_ENTRIES = 64;
export const PLUGIN_PEER_DIRECTORY_MAX_PAGES = 8;
export const PLUGIN_PEER_DIRECTORY_DEADLINE_MS = 2_000;

const REVISION = /^[0-9a-f]{64}$/;
const RESERVED_NAMES = new Set([PLUGIN_PEER_DIRECTORY_PRINCIPAL, PLUGIN_PEER_DIRECTORY_PROVIDER]);

export interface PeerDirectoryBinding {
  readonly endpoint: string;
  readonly process: PluginServiceProcess;
  readonly instance: string;
  readonly generation: number;
  readonly catalog: string;
  readonly scope: PluginServiceScope;
  readonly subject: string;
}

export interface PeerDirectoryEntry {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scope: PluginServiceScope;
  readonly scopeKey: string;
  readonly ready: boolean;
  readonly binding: PeerDirectoryBinding;
}

export interface PeerDirectoryPage {
  readonly version: typeof PLUGIN_PEER_DIRECTORY_VERSION;
  readonly revision: string;
  readonly total: number;
  readonly cursor: number;
  readonly more: boolean;
  readonly entries: readonly PeerDirectoryEntry[];
}

export interface PeerDirectoryQuery {
  readonly version: typeof PLUGIN_PEER_DIRECTORY_VERSION;
  readonly cursor: number;
}

/** True only for the exact reserved host-private read; nothing else may use it. */
export function isHostDirectoryQuery(input: {
  readonly target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string };
  readonly caller: { readonly subject: string; readonly scope: PluginServiceScope };
  readonly binding: { readonly scope: PluginServiceScope };
}): boolean {
  return input.target.provider === PLUGIN_PEER_DIRECTORY_PROVIDER
    && input.target.service === PLUGIN_PEER_DIRECTORY_SERVICE
    && input.target.major === PLUGIN_PEER_DIRECTORY_MAJOR
    && input.target.method === PLUGIN_PEER_DIRECTORY_METHOD
    && input.caller.subject === PLUGIN_PEER_DIRECTORY_PRINCIPAL
    && input.caller.scope === 'global'
    && input.binding.scope === 'global';
}

/** A reserved host name is never accepted as a plugin identity in the normal path. */
export function isReservedHostName(value: string): boolean {
  return RESERVED_NAMES.has(value) || value.startsWith('!bungee-host');
}

function canonicalJson(value: RpcJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as { readonly [key: string]: RpcJson };
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`;
}

/** Stable reference of a complete entry set; changes exactly when the set does. */
export function directoryRevision(entries: readonly PeerDirectoryEntry[]): string {
  const canonical = canonicalJson(entries.map(entry => ({
    provider: entry.provider, service: entry.service, major: entry.major,
    scope: entry.scope, scopeKey: entry.scopeKey, ready: entry.ready,
    binding: {
      endpoint: entry.binding.endpoint, process: entry.binding.process, instance: entry.binding.instance,
      generation: entry.binding.generation, catalog: entry.binding.catalog,
      scope: entry.binding.scope, subject: entry.binding.subject,
    },
  })) as unknown as RpcJson);
  return createHash('sha256').update(canonical).digest('hex');
}

function isBinding(value: unknown): value is PeerDirectoryBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 7) return false;
  return typeof record.endpoint === 'string' && record.endpoint.length > 0 && record.endpoint.length <= 256
    && (record.process === 'control' || record.process === 'worker' || record.process === 'ingress')
    && typeof record.instance === 'string' && record.instance.length > 0 && record.instance.length <= 256
    && Number.isSafeInteger(record.generation) && (record.generation as number) >= 1
    && typeof record.catalog === 'string' && record.catalog.length > 0 && record.catalog.length <= 256
    && (record.scope === 'global' || record.scope === 'binding')
    && typeof record.subject === 'string' && record.subject.length > 0 && record.subject.length <= 256;
}

function isEntry(value: unknown): value is PeerDirectoryEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7
    && typeof record.provider === 'string' && record.provider.length > 0 && record.provider.length <= 128
    && typeof record.service === 'string' && record.service.length > 0 && record.service.length <= 128
    && Number.isSafeInteger(record.major) && (record.major as number) >= 1
    && (record.scope === 'global' || record.scope === 'binding')
    && typeof record.scopeKey === 'string' && record.scopeKey.length > 0 && record.scopeKey.length <= 128
    && typeof record.ready === 'boolean'
    && isBinding(record.binding);
}

/** Strict, bounded decode of one directory page; anything else is refused. */
export function decodePeerDirectoryPage(value: unknown): PeerDirectoryPage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 6) return null;
  if (record.version !== PLUGIN_PEER_DIRECTORY_VERSION) return null;
  if (typeof record.revision !== 'string' || !REVISION.test(record.revision)) return null;
  if (!Number.isSafeInteger(record.total) || (record.total as number) < 0) return null;
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) return null;
  if (typeof record.more !== 'boolean') return null;
  if (!Array.isArray(record.entries) || record.entries.length > PLUGIN_PEER_DIRECTORY_PAGE_ENTRIES) return null;
  if (!record.entries.every(isEntry)) return null;
  const entries = record.entries as PeerDirectoryEntry[];
  if ((record.cursor as number) + entries.length > (record.total as number)) return null;
  // A page claiming more work must carry at least one entry to make progress.
  if (record.more === true && entries.length === 0) return null;
  return Object.freeze({
    version: PLUGIN_PEER_DIRECTORY_VERSION,
    revision: record.revision,
    total: record.total as number,
    cursor: record.cursor as number,
    more: record.more,
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry, binding: Object.freeze({ ...entry.binding }) }))),
  });
}

/** Strict decode of one directory query body (its only legal shape). */
export function decodePeerDirectoryQuery(value: unknown): PeerDirectoryQuery | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  if (record.version !== PLUGIN_PEER_DIRECTORY_VERSION) return null;
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) return null;
  return Object.freeze({ version: PLUGIN_PEER_DIRECTORY_VERSION, cursor: record.cursor as number });
}

/**
 * Projects the adapter's real publication view onto the minimal routable
 * directory DTO. Only `global` scope is exposed: a binding-scope publication is
 * never a cross-process routing target, so it is not advertised at all.
 */
export function toDirectoryEntries(view: readonly HostRpcPublicationView[], process: PluginServiceProcess): PeerDirectoryEntry[] {
  const entries: PeerDirectoryEntry[] = [];
  for (const publication of view) {
    if (publication.scope !== 'global' || publication.binding.scope !== 'global') continue;
    if (publication.binding.process !== process) continue;
    if (isReservedHostName(publication.provider)) continue;
    entries.push(Object.freeze({
      provider: publication.provider,
      service: publication.service,
      major: publication.major,
      scope: 'global' as const,
      scopeKey: 'global',
      ready: publication.ready,
      binding: Object.freeze({
        endpoint: publication.binding.endpoint, process: publication.binding.process,
        instance: publication.binding.instance, generation: publication.binding.generation,
        catalog: publication.binding.catalog, scope: publication.binding.scope,
        subject: publication.binding.subject,
      }),
    }));
  }
  entries.sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.service.localeCompare(right.service)
    || left.major - right.major || left.scopeKey.localeCompare(right.scopeKey));
  return entries;
}

/** One bounded page of an already sorted entry set. */
export function buildDirectoryPage(
  entries: readonly PeerDirectoryEntry[],
  revision: string,
  cursor: number,
): { readonly page: PeerDirectoryPage; readonly encodedBytes: number } | null {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entries.length) return null;
  const slice: PeerDirectoryEntry[] = [];
  for (const entry of entries.slice(cursor)) {
    const candidate = Object.freeze({
      version: PLUGIN_PEER_DIRECTORY_VERSION, revision, total: entries.length, cursor,
      more: false, entries: Object.freeze([...slice, entry]),
    });
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PLUGIN_PEER_DIRECTORY_PAGE_MAX_BYTES) break;
    slice.push(entry);
    if (slice.length >= PLUGIN_PEER_DIRECTORY_PAGE_ENTRIES) break;
  }
  if (slice.length === 0 && cursor < entries.length) return null;
  const page: PeerDirectoryPage = Object.freeze({
    version: PLUGIN_PEER_DIRECTORY_VERSION,
    revision,
    total: entries.length,
    cursor,
    more: cursor + slice.length < entries.length,
    entries: Object.freeze(slice),
  });
  return { page, encodedBytes: Buffer.byteLength(JSON.stringify(page), 'utf8') };
}

/* -------------------------------------------------------------------------- */
/* Channel publication directory (same link, same host-private principal)      */
/* -------------------------------------------------------------------------- */

/**
 * A second, independent page of the SAME host-private directory read: the
 * channel (stream/snapshot/event) publications of this process. It is a separate
 * `method` on the same reserved service so the RPC publication page keeps its
 * exact wire shape and its existing consumers keep working unchanged.
 */
export const PLUGIN_PEER_CHANNEL_DIRECTORY_METHOD = 'channel-page';

export interface PeerChannelDirectoryEntry {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scope: PluginServiceScope;
  readonly scopeKey: string;
  readonly ready: boolean;
  readonly kind: 'stream' | 'snapshot' | 'event';
}

export interface PeerChannelDirectoryPage {
  readonly version: typeof PLUGIN_PEER_DIRECTORY_VERSION;
  readonly revision: string;
  readonly total: number;
  readonly cursor: number;
  readonly more: boolean;
  readonly entries: readonly PeerChannelDirectoryEntry[];
}

/** True only for the exact reserved host-private channel-page read. */
export function isHostChannelDirectoryQuery(input: {
  readonly target: { readonly provider: string; readonly service: string; readonly major: number; readonly method: string };
  readonly caller: { readonly subject: string; readonly scope: PluginServiceScope };
  readonly binding: { readonly scope: PluginServiceScope };
}): boolean {
  return input.target.provider === PLUGIN_PEER_DIRECTORY_PROVIDER
    && input.target.service === PLUGIN_PEER_DIRECTORY_SERVICE
    && input.target.major === PLUGIN_PEER_DIRECTORY_MAJOR
    && input.target.method === PLUGIN_PEER_CHANNEL_DIRECTORY_METHOD
    && input.caller.subject === PLUGIN_PEER_DIRECTORY_PRINCIPAL
    && input.caller.scope === 'global'
    && input.binding.scope === 'global';
}

const CHANNEL_KINDS = new Set(['stream', 'snapshot', 'event']);

function isChannelEntry(value: unknown): value is PeerChannelDirectoryEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 7
    && typeof record.provider === 'string' && record.provider.length > 0 && record.provider.length <= 128
    && typeof record.service === 'string' && record.service.length > 0 && record.service.length <= 128
    && Number.isSafeInteger(record.major) && (record.major as number) >= 1
    && (record.scope === 'global' || record.scope === 'binding')
    && typeof record.scopeKey === 'string' && record.scopeKey.length > 0 && record.scopeKey.length <= 128
    && typeof record.ready === 'boolean'
    && typeof record.kind === 'string' && CHANNEL_KINDS.has(record.kind);
}

/** Strict, bounded decode of one channel directory page; anything else is refused. */
export function decodePeerChannelDirectoryPage(value: unknown): PeerChannelDirectoryPage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 6) return null;
  if (record.version !== PLUGIN_PEER_DIRECTORY_VERSION) return null;
  if (typeof record.revision !== 'string' || !REVISION.test(record.revision)) return null;
  if (!Number.isSafeInteger(record.total) || (record.total as number) < 0) return null;
  if (!Number.isSafeInteger(record.cursor) || (record.cursor as number) < 0) return null;
  if (typeof record.more !== 'boolean') return null;
  if (!Array.isArray(record.entries) || record.entries.length > PLUGIN_PEER_DIRECTORY_PAGE_ENTRIES) return null;
  if (!record.entries.every(isChannelEntry)) return null;
  const entries = record.entries as PeerChannelDirectoryEntry[];
  if ((record.cursor as number) + entries.length > (record.total as number)) return null;
  if (record.more === true && entries.length === 0) return null;
  return Object.freeze({
    version: PLUGIN_PEER_DIRECTORY_VERSION,
    revision: record.revision,
    total: record.total as number,
    cursor: record.cursor as number,
    more: record.more,
    entries: Object.freeze(entries.map(entry => Object.freeze({ ...entry }))),
  });
}

/** Stable reference of a complete channel entry set; changes exactly when it does. */
export function channelDirectoryRevision(entries: readonly PeerChannelDirectoryEntry[]): string {
  const canonical = canonicalJson(entries.map(entry => ({
    provider: entry.provider, service: entry.service, major: entry.major,
    scope: entry.scope, scopeKey: entry.scopeKey, ready: entry.ready, kind: entry.kind,
  })) as unknown as RpcJson);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Projects the channel adapter's real local publication view onto the directory DTO. */
export function toChannelDirectoryEntries(view: readonly {
  readonly provider: string; readonly service: string; readonly major: number;
  readonly scope: PluginServiceScope; readonly scopeKey: string; readonly ready: boolean;
  readonly lane: 'stream' | 'snapshot' | 'event';
}[], process?: PluginServiceProcess): PeerChannelDirectoryEntry[] {
  const entries: PeerChannelDirectoryEntry[] = [];
  for (const publication of view) {
    if (publication.scope !== 'global') continue;
    if (isReservedHostName(publication.provider)) continue;
    entries.push(Object.freeze({
      provider: publication.provider,
      service: publication.service,
      major: publication.major,
      scope: 'global' as const,
      scopeKey: 'global',
      ready: publication.ready,
      kind: publication.lane,
    }));
  }
  void process;
  entries.sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.service.localeCompare(right.service)
    || left.major - right.major || left.kind.localeCompare(right.kind));
  return entries;
}

/** One bounded page of an already sorted channel entry set. */
export function buildChannelDirectoryPage(
  entries: readonly PeerChannelDirectoryEntry[],
  revision: string,
  cursor: number,
): { readonly page: PeerChannelDirectoryPage; readonly encodedBytes: number } | null {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > entries.length) return null;
  const slice: PeerChannelDirectoryEntry[] = [];
  for (const entry of entries.slice(cursor)) {
    const candidate = Object.freeze({
      version: PLUGIN_PEER_DIRECTORY_VERSION, revision, total: entries.length, cursor,
      more: false, entries: Object.freeze([...slice, entry]),
    });
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > PLUGIN_PEER_DIRECTORY_PAGE_MAX_BYTES) break;
    slice.push(entry);
    if (slice.length >= PLUGIN_PEER_DIRECTORY_PAGE_ENTRIES) break;
  }
  if (slice.length === 0 && cursor < entries.length) return null;
  const page: PeerChannelDirectoryPage = Object.freeze({
    version: PLUGIN_PEER_DIRECTORY_VERSION,
    revision,
    total: entries.length,
    cursor,
    more: cursor + slice.length < entries.length,
    entries: Object.freeze(slice),
  });
  return { page, encodedBytes: Buffer.byteLength(JSON.stringify(page), 'utf8') };
}
