/**
 * models-dev in-process read view. The view is the ONLY object exposed through the
 * public local service; it never performs I/O. The provider's own durable snapshot
 * body is owned by the Host snapshot store (`services.snapshot.store()`), never by
 * an in-plugin fallback.
 */

import { createHash } from 'node:crypto';
import type { PluginChannelSnapshotRead } from '../../../packages/core/src/plugin-services/peer-channel-hub';
import type {
  ModelsDevCatalogService,
  ModelsDevCatalogStatus,
  ModelsDevModelMatch,
  ModelsDevModelPage,
  ModelsDevProviderMatch,
  ModelsDevProviderSummary,
} from '../contract';
import {
  buildCatalogIndex,
  emptyStatus,
  modelOptions,
  providerSummaries,
  resolveModelInCatalog,
  resolveProviderFromUrl,
  statusOf,
  type CatalogIndex,
} from './catalog';
import { parseCatalogRecord } from './store';
import type { CatalogRecord } from './catalog';

export interface SnapshotSource {
  readonly descriptor: {
    readonly owner: string; readonly epoch: number; readonly version: number; readonly schemaVersion: number;
    readonly digest: `sha256:${string}`; readonly size: number; readonly chunkBytes: number;
  };
  read(offset: number, length: number): Promise<Uint8Array>;
  retain?(): void;
  release?(): void;
}

/** Read-only view over the loaded catalog. Mutations are whole-index swaps. */
export class CatalogView implements ModelsDevCatalogService {
  #index: CatalogIndex | null = null;
  #state: 'empty' | 'ready' | 'stale' | 'failed' = 'empty';
  #error: string | null = null;

  apply(index: CatalogIndex, state: 'ready' | 'stale' = 'ready', error: string | null = null): void {
    this.#index = index;
    this.#state = state;
    this.#error = error;
  }

  /** A failed refresh keeps the last valid index and only records the error. */
  fail(error: string): void {
    this.#error = error;
    this.#state = this.#index === null ? 'failed' : 'stale';
  }

  loaded(): boolean { return this.#index !== null; }

  status(): ModelsDevCatalogStatus {
    return this.#index === null && this.#state === 'empty' ? emptyStatus() : statusOf(this.#index, this.#state === 'empty' ? 'ready' : this.#state, this.#error);
  }

  providers(): readonly ModelsDevProviderSummary[] { return providerSummaries(this.#index); }

  modelOptions(input?: { provider?: string; search?: string; page?: number; pageSize?: number }): ModelsDevModelPage {
    return modelOptions(this.#index, input);
  }

  resolveModel(input: Parameters<ModelsDevCatalogService['resolveModel']>[0]): ModelsDevModelMatch | null {
    return resolveModelInCatalog(this.#index, input);
  }

  resolveProvider(input: { url: string }): ModelsDevProviderMatch | null {
    return resolveProviderFromUrl(this.#index, input.url);
  }
}

/** Plain, own-property service object (the service facade only exposes own enumerable keys). */
export function catalogServiceOf(view: CatalogView): ModelsDevCatalogService {
  return {
    status: () => view.status(),
    providers: () => view.providers(),
    modelOptions: (input) => view.modelOptions(input),
    resolveModel: (input) => view.resolveModel(input),
    resolveProvider: (input) => view.resolveProvider(input),
  };
}

/** Shared content validation for the persisted control source and verified worker view. */
export function decodeCatalogSnapshot(bytes: Uint8Array, version: number): CatalogRecord {
  const record = parseCatalogRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (record.version !== version) throw new Error('catalog_version_mismatch');
  return record;
}

export async function readCatalogSnapshot(source: SnapshotSource): Promise<CatalogRecord> {
  const { size, chunkBytes, digest, version } = source.descriptor;
  if (!Number.isSafeInteger(size) || size < 1 || size > 32 * 1024 * 1024
    || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('catalog_snapshot_size');
  source.retain?.();
  try {
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += chunkBytes) {
      const length = Math.min(chunkBytes, size - offset);
      const chunk = await source.read(offset, length);
      if (chunk.byteLength !== length) throw new Error('catalog_snapshot_truncated');
      bytes.set(chunk, offset);
    }
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new Error('catalog_snapshot_digest');
    return decodeCatalogSnapshot(bytes, version);
  } finally { source.release?.(); }
}

/** Apply only a complete Host-verified snapshot; a failed read never clears the prior view. */
export function reconcileCatalogView(snapshot: PluginChannelSnapshotRead | null, view: CatalogView): 'applied' | 'unchanged' | 'failed' {
  try {
    if (snapshot === null) {
      if (!view.loaded()) return 'unchanged';
      view.fail('catalog_missing');
      return 'failed';
    }
    const currentVersion = view.status().version;
    if (currentVersion !== null && currentVersion >= snapshot.descriptor.version) return 'unchanged';
    const record = decodeCatalogSnapshot(snapshot.bytes, snapshot.descriptor.version);
    const index = buildCatalogIndex(record);
    view.apply(index, 'ready', null);
    return 'applied';
  } catch (error) {
    view.fail(error instanceof Error ? error.message.slice(0, 64) : 'catalog_read_failed');
    return 'failed';
  }
}
