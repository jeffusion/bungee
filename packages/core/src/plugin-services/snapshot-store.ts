/**
 * Host-managed persistent atomic snapshot version store.
 *
 * A provider plugin (e.g. the future models-dev directory) gets versioned,
 * immutable, digest-addressed snapshot bodies with bounded retention WITHOUT
 * inventing its own chunking or widening the 1 MiB durable-command limit: the
 * body is stored as bounded chunks in the host `plugin_communication_records`
 * table (the audited v14 schema; no new table, no runtime DDL), and the version
 * becomes visible atomically by flipping its meta + the current pointer.
 *
 * Durability/atomicity contract:
 * - chunks are written first; a version is INVISIBLE until its meta row exists,
 *   so a crash mid-write leaves only unreachable chunks (reclaimed by `collect`);
 * - the current pointer is flipped last, so a reader never observes a half-written
 *   body as current;
 * - a returned source keeps the exact descriptor fixed and can `retain()`/`release()`
 *   the version; a retained version is never reclaimed, so an in-flight whole-body
 *   read can never have its bytes swapped or freed underneath it;
 * - retention is explicit and bounded (`maxVersions`, `maxBytes`), and GC never
 *   touches the current version, a retained version, or a version whose chunks
 *   are still referenced.
 */

import { createHash } from 'node:crypto';
import type { ChannelSnapshotDescriptor } from './peer-channel-protocol';
import type { PluginChannelSnapshotSource } from './peer-channel-hub';
import { CHANNEL_MAX_CHUNK_BYTES } from './peer-channel-protocol';
import { CHANNEL_SNAPSHOT_MAX_BYTES } from './peer-channel-hub';
import type { CommunicationNamespaceStore } from './persistence';
import { encodeRpcJson } from './wire-contract';

const DEFAULT_MAX_VERSIONS = 3;
const DEFAULT_CHUNK_BYTES = 60 * 1024;

/**
 * Retained-version refcounts shared by ALL store instances of one version family.
 * Two `store()` calls for the same (namespace, owner, family id) must share pin
 * management: otherwise one instance's GC could reclaim a version another instance
 * still has retained for an in-flight whole-body read.
 */
const SNAPSHOT_FAMILY_REFS = new Map<string, Map<number, number>>();

function familyRefs(prefix: string): Map<number, number> {
  let refs = SNAPSHOT_FAMILY_REFS.get(prefix);
  if (refs === undefined) { refs = new Map(); SNAPSHOT_FAMILY_REFS.set(prefix, refs); }
  return refs;
}

/** Minimal read surface shared by the namespace store and its transaction mutator. */
interface SnapshotRecordReader {
  get(key: string): { readonly payload: Uint8Array } | null;
}

export interface HostSnapshotStoreOptions {
  /** Descriptor owner identity (usually the providing plugin name). */
  readonly owner: string;
  /**
   * Immutable version-family id declared by the provider. Two `store()` calls
   * with the same id share ONE durable family (current pointer, version index,
   * retention, pins); a different id is a completely separate family. It is part
   * of the persistent identity, so the same family is readable again after a
   * process restart.
   */
  readonly id?: string;
  /** Runtime generation of the owner; part of the immutable descriptor. */
  readonly epoch?: number;
  readonly schemaVersion: number;
  readonly chunkBytes?: number;
  /** Retained versions, including the current one. */
  readonly maxVersions?: number;
  /** Bounded total retained body bytes. */
  readonly maxBytes?: number;
}

interface VersionMeta {
  readonly owner: string;
  readonly epoch: number;
  readonly version: number;
  readonly schemaVersion: number;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly chunkBytes: number;
  readonly chunks: number;
}

/**
 * One namespace-isolated, atomically published version family. The store never
 * exposes its keys, connection, or any other namespace.
 */
export class HostSnapshotStore {
  readonly #store: CommunicationNamespaceStore;
  readonly #owner: string;
  readonly #epoch: number;
  readonly #schemaVersion: number;
  readonly #chunkBytes: number;
  readonly #maxVersions: number;
  readonly #maxBytes: number;
  readonly #prefix: string;
  #maintenanceError: string | null = null;

  constructor(store: CommunicationNamespaceStore, options: HostSnapshotStoreOptions) {
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const maxVersions = options.maxVersions ?? DEFAULT_MAX_VERSIONS;
    const maxBytes = options.maxBytes ?? CHANNEL_SNAPSHOT_MAX_BYTES;
    if (typeof options.owner !== 'string' || options.owner.length === 0) throw new Error('snapshot store requires an owner identity');
    if (!Number.isSafeInteger(options.schemaVersion) || options.schemaVersion < 1) throw new Error('snapshot store schema version is invalid');
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHANNEL_MAX_CHUNK_BYTES) throw new Error('snapshot store chunk size is invalid');
    if (!Number.isSafeInteger(maxVersions) || maxVersions < 1) throw new Error('snapshot store version retention is invalid');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CHANNEL_SNAPSHOT_MAX_BYTES) throw new Error('snapshot store byte retention is invalid');
    const familyId = options.id ?? '';
    if (options.id !== undefined && (typeof options.id !== 'string' || options.id.length === 0 || options.id.length > 256)) {
      throw new Error('snapshot store family id is invalid');
    }
    this.#store = store;
    this.#owner = options.owner;
    this.#epoch = options.epoch ?? 1;
    this.#schemaVersion = options.schemaVersion;
    this.#chunkBytes = chunkBytes;
    this.#maxVersions = maxVersions;
    this.#maxBytes = maxBytes;
    // The family id is part of the persistent identity: two declared families of
    // one provider never share a current pointer, version index or pins.
    const identity = familyId === '' ? `${store.namespace}/${options.owner}` : `${store.namespace}/${options.owner}/${familyId}`;
    this.#prefix = `hs:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
  }

  #chunkKey(version: number, index: number): string {
    return `${this.#prefix}:${version}:c${String(index).padStart(8, '0')}`;
  }

  #metaKey(version: number): string { return `${this.#prefix}:${version}:m`; }

  #currentKey(): string { return `${this.#prefix}:cur`; }

  #digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }

  #readMeta(version: number, reader: SnapshotRecordReader = this.#store): VersionMeta | null {
    const record = reader.get(this.#metaKey(version));
    if (record === null) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.payload)); }
    catch { throw new Error('snapshot store meta is unreadable'); }
    if (parsed === null || typeof parsed !== 'object') throw new Error('snapshot store meta is invalid');
    const meta = parsed as Partial<VersionMeta>;
    if (meta.owner !== this.#owner || meta.version !== version
      || !Number.isSafeInteger(meta.epoch) || !Number.isSafeInteger(meta.schemaVersion)
      || !Number.isSafeInteger(meta.size) || !Number.isSafeInteger(meta.chunkBytes)
      || !Number.isSafeInteger(meta.chunks) || typeof meta.digest !== 'string') {
      throw new Error('snapshot store meta is invalid');
    }
    return Object.freeze({
      owner: meta.owner, epoch: meta.epoch as number, version, schemaVersion: meta.schemaVersion as number,
      digest: meta.digest as `sha256:${string}`, size: meta.size as number,
      chunkBytes: meta.chunkBytes as number, chunks: meta.chunks as number,
    });
  }

  #descriptor(meta: VersionMeta): ChannelSnapshotDescriptor {
    return Object.freeze({
      owner: meta.owner, epoch: meta.epoch, version: meta.version, schemaVersion: meta.schemaVersion,
      digest: meta.digest, size: meta.size, chunkBytes: meta.chunkBytes,
    });
  }

  /**
   * Atomically publishes one immutable version. Returns the fixed descriptor, or
   * throws (quota/corruption) — a partially written version is never visible.
   */
  publish(version: number, body: unknown | Uint8Array): ChannelSnapshotDescriptor {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('snapshot store version is invalid');
    const bytes = body instanceof Uint8Array ? new Uint8Array(body) : new TextEncoder().encode(encodeRpcJson(body, this.#maxBytes));
    if (bytes.byteLength === 0 || bytes.byteLength > this.#maxBytes) throw new Error('snapshot store body exceeds the bounded retention budget');
    const chunks = Math.ceil(bytes.byteLength / this.#chunkBytes);
    const prior = this.#readMeta(version);
    if (prior !== null) {
      // Republishing the SAME immutable version must be idempotent; different
      // content under an existing version is refused.
      if (prior.digest !== this.#digest(bytes) || prior.size !== bytes.byteLength) throw new Error('snapshot store version already exists with different content');
      return this.#descriptor(prior);
    }
    const digest = this.#digest(bytes);
    const meta: VersionMeta = Object.freeze({
      owner: this.#owner, epoch: this.#epoch, version, schemaVersion: this.#schemaVersion,
      digest, size: bytes.byteLength, chunkBytes: this.#chunkBytes, chunks,
    });
    const versions = this.#publishedVersions(this.#store);
    const nextVersions = versions.includes(version) ? versions : [...versions, version].sort((left, right) => left - right);
    const encoder = new TextEncoder();
    // ONE immediate transaction for the whole version: chunks, meta, version index
    // and the visibility flip commit together. This both makes a partial version
    // impossible and pays exactly ONE durable commit instead of one per chunk
    // (per-chunk commits blocked the host event loop for seconds on a large body).
    this.#store.transact((mutator) => {
      for (let index = 0; index < chunks; index += 1) {
        const offset = index * this.#chunkBytes;
        const chunk = bytes.subarray(offset, Math.min(offset + this.#chunkBytes, bytes.byteLength));
        mutator.put(this.#chunkKey(version, index), chunk, { required: false, expiresAt: null });
      }
      mutator.put(this.#metaKey(version), encoder.encode(JSON.stringify(meta)), { required: false, expiresAt: null });
      mutator.put(this.#versionsKey(), encoder.encode(JSON.stringify({ versions: nextVersions })), { required: false, expiresAt: null });
      // Visibility flip is LAST, inside the same commit: a reader never observes a
      // half-written body as current, and a crash leaves only unreachable chunks.
      // A monotonic fence makes the flip safe under out-of-order publishes: a new
      // but LOWER version is still durable/retained, yet it can never move the
      // current pointer backwards. (Re-publishing an already-existing version
      // returned above without touching the pointer.)
      const current = this.#currentVersion(mutator);
      if (current === null || version > current) {
        mutator.put(this.#currentKey(), encoder.encode(String(version)), { required: false, expiresAt: null });
      }
    });
    this.maintain();
    return this.#descriptor(meta);
  }

  /** Post-commit GC failure cannot turn a durable publication into a failed publish. */
  maintain(): { readonly removed: number; readonly error: string | null } {
    try {
      const removed = this.collect();
      this.#maintenanceError = null;
      return Object.freeze({ removed, error: null });
    } catch {
      this.#maintenanceError = 'storage_failure';
      return Object.freeze({ removed: 0, error: this.#maintenanceError });
    }
  }

  maintenanceStatus(): { readonly pending: boolean; readonly error: string | null } {
    return Object.freeze({ pending: this.#maintenanceError !== null, error: this.#maintenanceError });
  }

  /** Source for the current version, or `null` when none was published. */
  current(): PluginChannelSnapshotSource | null {
    const pointer = this.#store.get(this.#currentKey());
    if (pointer === null) return null;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(pointer.payload); }
    catch { throw new Error('snapshot store current pointer is unreadable'); }
    const version = Number(text);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('snapshot store current pointer is invalid');
    return this.version(version);
  }

  /** Source for one explicitly named, still-retained version. */
  version(version: number): PluginChannelSnapshotSource | null {
    if (!Number.isSafeInteger(version) || version < 1) return null;
    // A present-but-corrupt meta/version index record is CORRUPTION, not
    // "absent": reporting `null` would let a reader believe the version never
    // existed. `#readMeta` throws on corruption and is intentionally not caught.
    const meta = this.#readMeta(version);
    if (meta === null) return null;
    const store = this.#store;
    const digest = meta.digest;
    const size = meta.size;
    const chunkBytes = meta.chunkBytes;
    const chunks = meta.chunks;
    const prefix = this.#prefix;
    const refs = familyRefs(prefix);
    let retained = false;
    const source: PluginChannelSnapshotSource = {
      descriptor: this.#descriptor(meta),
      retain: () => {
        if (retained) return;
        retained = true;
        refs.set(version, (refs.get(version) ?? 0) + 1);
      },
      release: () => {
        if (!retained) return;
        retained = false;
        const count = (refs.get(version) ?? 1) - 1;
        if (count <= 0) refs.delete(version);
        else refs.set(version, count);
      },
      read: async (offset: number, length: number): Promise<Uint8Array> => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset + length > size) {
          throw new Error('snapshot store read is out of range');
        }
        const out = new Uint8Array(length);
        let at = offset;
        let written = 0;
        while (written < length) {
          const index = Math.floor(at / chunkBytes);
          if (index >= chunks) throw new Error('snapshot store chunk is missing');
          const record = store.get(`${prefix}:${version}:c${String(index).padStart(8, '0')}`);
          if (record === null) throw new Error('snapshot store chunk is missing');
          const chunk = record.payload;
          const within = at - index * chunkBytes;
          const take = Math.min(chunk.byteLength - within, length - written);
          if (take <= 0) throw new Error('snapshot store chunk is truncated');
          out.set(chunk.subarray(within, within + take), written);
          written += take;
          at += take;
        }
        // Integrity is re-verified on every read: a tampered chunk is refused.
        if (this.#digest(out) !== digest && length === size && offset === 0) {
          // Full-body reads re-check the whole digest; partial reads rely on the
          // chunked layout plus the session's whole-body verification.
          throw new Error('snapshot store digest mismatch');
        }
        return out;
      },
    };
    return Object.freeze(source);
  }

  #currentVersion(reader: SnapshotRecordReader = this.#store): number | null {
    const pointer = reader.get(this.#currentKey());
    if (pointer === null) return null;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(pointer.payload); }
    catch { throw new Error('snapshot store current pointer is unreadable'); }
    const version = Number(text);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('snapshot store current pointer is invalid');
    return version;
  }

  #totalBytes(reader: SnapshotRecordReader): number {
    let total = 0;
    for (const version of this.#publishedVersions(reader)) {
      const meta = this.#readMeta(version, reader);
      if (meta !== null) total += meta.size;
    }
    return total;
  }

  /**
   * Durable published-version index. `list()` cannot be used here: it returns the
   * first N rows by key order, so a large body's chunk rows would push later
   * version metas out of view and GC would never run.
   */
  #versionsKey(): string { return `${this.#prefix}:versions`; }

  #publishedVersions(reader: SnapshotRecordReader): number[] {
    const record = reader.get(this.#versionsKey());
    if (record === null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.payload)); }
    catch { throw new Error('snapshot store version index is unreadable'); }
    if (parsed === null || typeof parsed !== 'object') throw new Error('snapshot store version index is invalid');
    const list = (parsed as { versions?: unknown }).versions;
    if (!Array.isArray(list)) throw new Error('snapshot store version index is invalid');
    return list.filter((value): value is number => Number.isSafeInteger(value) && value >= 1).sort((left, right) => left - right);
  }

  /**
   * Bounded GC in ONE transaction: drops the oldest unreferenced, non-current
   * versions until both the version count and the total byte budget fit. Never
   * touches a version a live read has retained, and never the current version.
   */
  collect(): number {
    const encoder = new TextEncoder();
    return this.#store.transact((mutator) => {
      let removed = 0;
      for (;;) {
        const versions = this.#publishedVersions(mutator);
        const total = this.#totalBytes(mutator);
        if (versions.length <= this.#maxVersions && total <= this.#maxBytes) break;
        const current = this.#currentVersion(mutator);
        const oldest = versions.find((version) => version !== current && (familyRefs(this.#prefix).get(version) ?? 0) === 0);
        if (oldest === undefined) break;
        const meta = this.#readMeta(oldest, mutator);
        if (meta === null) break;
        for (let index = 0; index < meta.chunks; index += 1) mutator.ack(this.#chunkKey(oldest, index));
        mutator.ack(this.#metaKey(oldest));
        mutator.put(this.#versionsKey(), encoder.encode(JSON.stringify({ versions: versions.filter((version) => version !== oldest) })), { required: false, expiresAt: null });
        removed += 1;
      }
      return removed;
    });
  }
}
