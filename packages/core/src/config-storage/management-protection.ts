import type { Database } from 'bun:sqlite';
import type { ManagementProtection } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { sqliteAll, sqliteGet } from './sqlite-query';
import { isPluginName } from './plugin-name';
import { readActiveRevision } from './current-revision';

export function validateManagementProtection(value: unknown): asserts value is ManagementProtection {
  const state = value as ManagementProtection | null;
  if (!state || typeof state.required !== 'boolean' || !Number.isSafeInteger(state.generation) || state.generation < 0 ||
      (state.required ? typeof state.selectedProvider !== 'string' || !isPluginName(state.selectedProvider) : state.selectedProvider !== null)) {
    throw new ConfigRepositoryError('schema_corrupt', 'management protection singleton is invalid');
  }
}

export function readManagementProtection(db: Database): ManagementProtection {
  const rows = sqliteAll<{ id: number; required: number; selected_provider: string | null; generation: number }, []>(db,
    'SELECT id,required,selected_provider,generation FROM management_protection');
  const row = rows[0];
  if (rows.length !== 1 || !row || row.id !== 1 || (row.required !== 0 && row.required !== 1)) {
    throw new ConfigRepositoryError('schema_corrupt', 'management protection singleton is missing or invalid');
  }
  const state = { required: row.required === 1, selectedProvider: row.selected_provider, generation: row.generation };
  validateManagementProtection(state);
  if (state.selectedProvider !== null && sqliteGet(db, 'SELECT plugin_name FROM plugin_activations WHERE plugin_name=?', state.selectedProvider) === null) {
    throw new ConfigRepositoryError('schema_corrupt', 'protected management provider activation is missing');
  }
  const current = sqliteGet<{ management_provider: string | null }, [number]>(db,
    'SELECT management_provider FROM configuration_operations WHERE committed_revision=?', readActiveRevision(db));
  if ((current?.management_provider ?? null) !== state.selectedProvider) {
    throw new ConfigRepositoryError('schema_corrupt', 'management protection does not match the active operation');
  }
  return state;
}

/** Request evidence is stored outside the exported configuration aggregate. */
export function readManagementRequestIdentity(db: Database, mutationId: string): {
  management_provider: string | null; offline_management: boolean;
} {
  const row = sqliteGet<{ management_provider: string | null; offline_management: number }, [string]>(db,
    'SELECT management_provider,offline_management FROM configuration_operations WHERE mutation_id=?', mutationId);
  if (!row || (row.offline_management !== 0 && row.offline_management !== 1) ||
      (row.management_provider !== null && !isPluginName(row.management_provider))) {
    throw new ConfigRepositoryError('schema_corrupt', 'management operation identity is invalid');
  }
  return { management_provider: row.management_provider, offline_management: row.offline_management === 1 };
}

export function writeManagementProtection(db: Database, current: ManagementProtection, provider: string | null): void {
  if (current.selectedProvider === provider && current.required === (provider !== null)) return;
  if (current.generation === Number.MAX_SAFE_INTEGER) throw new ConfigRepositoryError('repository_failure', 'management protection generation exhausted');
  db.run('UPDATE management_protection SET required=?,selected_provider=?,generation=? WHERE id=1',
    [provider === null ? 0 : 1, provider, current.generation + 1]);
}
