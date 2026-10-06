/**
 * Small private settings/status records and a one-time legacy catalog reader.
 * Catalog bodies and their versions are owned exclusively by the Host snapshot store.
 *
 * No consumer may import this module or read these keys.
 */

import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import type { CatalogRecord } from './catalog';

export const MODELS_DEV_SETTINGS_KEY = 'catalog:settings:v1';
export const MODELS_DEV_CATALOG_KEY = 'catalog:v1';
export const MODELS_DEV_STATUS_KEY = 'catalog:status:v1';

export interface ModelsDevSettings {
  autoRefresh: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
}
export const DEFAULT_MODELS_DEV_SETTINGS: ModelsDevSettings = { autoRefresh: true, intervalMinutes: 60, timeoutSeconds: 15 };

export interface ModelsDevPersistedStatus {
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

export function parseModelsDevSettings(value: unknown): ModelsDevSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['autoRefresh', 'intervalMinutes', 'timeoutSeconds'].includes(key))
    || typeof record.autoRefresh !== 'boolean'
    || !Number.isInteger(record.intervalMinutes) || (record.intervalMinutes as number) < 1 || (record.intervalMinutes as number) > 1440
    || !Number.isInteger(record.timeoutSeconds) || (record.timeoutSeconds as number) < 5 || (record.timeoutSeconds as number) > 120) {
    throw new Error('invalid_input');
  }
  return { autoRefresh: record.autoRefresh, intervalMinutes: record.intervalMinutes as number, timeoutSeconds: record.timeoutSeconds as number };
}

export function parsePersistedStatus(value: unknown): ModelsDevPersistedStatus {
  const empty: ModelsDevPersistedStatus = { lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0 };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const record = value as Record<string, unknown>;
  const numberOrNull = (candidate: unknown): number | null => typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : null;
  return {
    lastAttemptAt: numberOrNull(record.lastAttemptAt),
    lastSuccessAt: numberOrNull(record.lastSuccessAt),
    lastError: typeof record.lastError === 'string' && record.lastError.length > 0 && record.lastError.length <= 64 ? record.lastError : null,
    consecutiveFailures: Number.isSafeInteger(record.consecutiveFailures) && (record.consecutiveFailures as number) >= 0 ? record.consecutiveFailures as number : 0,
  };
}

/** Strict read helper: SQL/JSON failures propagate; only a real absence is `undefined`. */
async function strictRead(storage: PluginStorage, key: string): Promise<unknown | undefined> {
  if (typeof storage.readStrict === 'function') {
    const result = await storage.readStrict<unknown>(key);
    return result.found ? result.value : undefined;
  }
  const value = await storage.get<unknown>(key);
  return value === null ? undefined : value;
}

export async function readModelsDevSettings(storage: PluginStorage): Promise<ModelsDevSettings> {
  const stored = await strictRead(storage, MODELS_DEV_SETTINGS_KEY);
  // Absence uses defaults; an existing but unreadable value propagates (never a
  // silent default that could mask a storage fault).
  if (stored === undefined) return { ...DEFAULT_MODELS_DEV_SETTINGS };
  return parseModelsDevSettings(stored);
}

export async function writeModelsDevSettings(storage: PluginStorage, settings: ModelsDevSettings): Promise<void> {
  await storage.set(MODELS_DEV_SETTINGS_KEY, settings);
}

/**
 * Strict catalog read. `readStrict` is required: the legacy `get` swallows SQL and
 * JSON errors, which would turn a storage failure into a fabricated "no catalog".
 */
export async function readCatalogRecord(storage: PluginStorage): Promise<CatalogRecord | null> {
  if (typeof storage.readStrict !== 'function') throw new Error('models-dev requires strict plugin storage reads');
  const result = await storage.readStrict<unknown>(MODELS_DEV_CATALOG_KEY);
  if (!result.found) return null;
  return parseCatalogRecord(result.value);
}

export function parseCatalogRecord(value: unknown): CatalogRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('models-dev catalog record is invalid');
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1
    || typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt) || record.fetchedAt < 0
    || record.catalog === null || typeof record.catalog !== 'object' || Array.isArray(record.catalog)) {
    throw new Error('models-dev catalog record is invalid');
  }
  return { version: record.version as number, fetchedAt: record.fetchedAt as number, catalog: record.catalog };
}

export async function readPersistedStatus(storage: PluginStorage): Promise<ModelsDevPersistedStatus> {
  const stored = await strictRead(storage, MODELS_DEV_STATUS_KEY);
  return stored === undefined ? parsePersistedStatus(undefined) : parsePersistedStatus(stored);
}

export async function writePersistedStatus(storage: PluginStorage, status: ModelsDevPersistedStatus): Promise<void> {
  await (storage.uncached?.() ?? storage).set(MODELS_DEV_STATUS_KEY, status);
}
