import type { RepositorySnapshot } from './repository-types';

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

/** Owns a detached JSON graph so callers cannot change the publication projection. */
export function freezeSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  const owned = structuredClone(snapshot);
  freezeJson(owned);
  return owned;
}

export function freezeProjection<T>(value: T): T {
  const owned = structuredClone(value);
  freezeJson(owned);
  return owned;
}
