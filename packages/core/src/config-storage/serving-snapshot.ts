import type { Database } from 'bun:sqlite';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from './aggregate';
import { canonicalJson, hashConfigurationContent } from './content-hash';
import { validateDigest } from './repository-validation';
import type { RepositorySnapshot, ServingSnapshotKey } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteGet } from './sqlite-query';
import { withConsistentRead } from './consistent-read';

const MAX_AGGREGATE_BYTES = 1_048_576;

type ServingSnapshotRow = ServingSnapshotKey & { readonly aggregate_json: string };
type RevisionRow = { readonly revision: number; readonly content_hash: string };

function invalid(message: string): never {
  throw new ConfigRepositoryError('invalid_configuration', message);
}

function corrupt(message: string): never {
  throw new ConfigRepositoryError('serving_snapshot_corrupt', message);
}

function canonicalAggregate(
  aggregate: unknown,
): { readonly aggregateJson: string; readonly contentHash: string } {
  const result = parseNormalizeCompileAggregate(aggregate, undefined);
  if (!result.ok) invalid('configuration aggregate is invalid');
  const aggregateJson = canonicalJson(result.value);
  const bytes = new TextEncoder().encode(aggregateJson).byteLength;
  if (bytes < 2 || bytes > MAX_AGGREGATE_BYTES) {
    invalid('configuration aggregate is too large');
  }
  return { aggregateJson, contentHash: hashConfigurationContent(result.value) };
}

export function appendServingSnapshot(
  db: Database,
  snapshot: RepositorySnapshot,
  pluginCatalogHash: Sha256Digest,
): void {
  if (!Number.isSafeInteger(snapshot?.revision) || snapshot.revision <= 0 ||
      typeof snapshot.content_hash !== 'string' || !validateDigest(snapshot.content_hash) ||
      !validateDigest(pluginCatalogHash)) {
    invalid('serving snapshot identity is invalid');
  }
  const normalized = canonicalAggregate(snapshot.aggregate);
  if (normalized.contentHash !== snapshot.content_hash) {
    invalid('configuration aggregate content hash does not match');
  }

  const transaction = db.transaction(() => {
    const revision = sqliteGet<RevisionRow, [number]>(
      db,
      'SELECT revision,content_hash FROM configuration_revisions WHERE revision=?',
      snapshot.revision,
    );
    if (revision === null || revision.content_hash !== snapshot.content_hash) {
      invalid('serving snapshot revision does not match configuration history');
    }
    const existing = sqliteGet<ServingSnapshotRow, [number, string, string]>(
      db,
      `SELECT revision,content_hash,plugin_catalog_hash,aggregate_json
       FROM configuration_serving_snapshots
       WHERE revision=? AND content_hash=? AND plugin_catalog_hash=?`,
      snapshot.revision, snapshot.content_hash, pluginCatalogHash,
    );
    if (existing !== null) {
      if (existing.aggregate_json !== normalized.aggregateJson) {
        corrupt('configuration serving snapshot is immutable and inconsistent');
      }
      return;
    }
    db.run(`INSERT INTO configuration_serving_snapshots
      (revision,content_hash,plugin_catalog_hash,aggregate_json) VALUES (?,?,?,?)`,
      [snapshot.revision, snapshot.content_hash, pluginCatalogHash, normalized.aggregateJson]);
  });
  transaction.immediate();
}

export function getServingSnapshot(
  db: Database,
  key: ServingSnapshotKey,
): RepositorySnapshot | null {
  if (!Number.isSafeInteger(key?.revision) || key.revision <= 0 ||
      typeof key.content_hash !== 'string' || !validateDigest(key.content_hash) ||
      typeof key.plugin_catalog_hash !== 'string' || !validateDigest(key.plugin_catalog_hash)) {
    invalid('serving snapshot lookup identity is invalid');
  }
  return withConsistentRead(db, () => {
    const row = sqliteGet<ServingSnapshotRow, [number, string, string]>(
      db,
      `SELECT revision,content_hash,plugin_catalog_hash,aggregate_json
       FROM configuration_serving_snapshots
       WHERE revision=? AND content_hash=? AND plugin_catalog_hash=?`,
      key.revision, key.content_hash, key.plugin_catalog_hash,
    );
    if (row === null) return null;
    if (row.revision !== key.revision || row.content_hash !== key.content_hash ||
        row.plugin_catalog_hash !== key.plugin_catalog_hash ||
        !Number.isSafeInteger(row.revision) || row.revision <= 0 ||
        !validateDigest(row.content_hash) || !validateDigest(row.plugin_catalog_hash)) {
      corrupt('configuration serving snapshot identity is invalid');
    }
    const bytes = new TextEncoder().encode(row.aggregate_json).byteLength;
    if (bytes < 2 || bytes > MAX_AGGREGATE_BYTES) corrupt('configuration serving snapshot size is invalid');

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.aggregate_json);
    } catch {
      corrupt('configuration serving snapshot JSON is invalid');
    }
    let canonical: string;
    try {
      canonical = canonicalJson(parsed);
    } catch {
      corrupt('configuration serving snapshot JSON is invalid');
    }
    if (canonical !== row.aggregate_json) corrupt('configuration serving snapshot JSON is not canonical');

    const normalized = parseNormalizeCompileAggregate(parsed, undefined);
    if (!normalized.ok) corrupt('configuration serving snapshot aggregate is invalid');
    if (canonicalJson(normalized.value) !== row.aggregate_json) {
      corrupt('configuration serving snapshot aggregate normalization drifted');
    }
    if (hashConfigurationContent(normalized.value) !== key.content_hash) {
      corrupt('configuration serving snapshot content hash is invalid');
    }
    const revision = sqliteGet<RevisionRow, [number]>(
      db,
      'SELECT revision,content_hash FROM configuration_revisions WHERE revision=?',
      key.revision,
    );
    if (revision === null || revision.revision !== key.revision || revision.content_hash !== key.content_hash) {
      corrupt('configuration serving snapshot revision is invalid');
    }
    return { revision: row.revision, content_hash: row.content_hash, aggregate: normalized.value };
  });
}
