import { canonicalJson } from './content-hash';
import { ConfigRepositoryError } from './repository-types';

export type PersistedJsonObject = Record<string, unknown>;

export function parseCanonicalObject(
  text: string,
  field: string,
  reserved: ReadonlySet<string> = new Set(),
): PersistedJsonObject {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('expected a JSON object');
    }
    if (text !== canonicalJson(value)) throw new TypeError('expected canonical JSON text');
    const entries = Object.entries(value);
    const key = entries.find(([name]) => reserved.has(name))?.[0];
    if (key !== undefined) throw new TypeError(`reserved key ${key}`);
    return Object.fromEntries(entries);
  } catch (error) {
    throw new ConfigRepositoryError('schema_corrupt', `${field} is invalid`, error);
  }
}
