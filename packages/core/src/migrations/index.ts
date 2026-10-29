import { LLM_TPS_SAMPLES } from './llm-tps-samples';
import { LLM_TPS_MODEL } from './llm-tps-model';
import { LLM_TPS_UPSTREAM_HOST } from './llm-tps-upstream-host';
import { ACCESS_BASELINE } from './baseline';
import { ACCESS_LOG_TRANSPORT_TYPE } from './access-log-transport-type';
import type { Migration } from './migration.types';
/** Frozen baseline and consecutive incremental migrations. */
export const migrations: readonly Migration[] = [ACCESS_BASELINE, LLM_TPS_SAMPLES, LLM_TPS_MODEL, LLM_TPS_UPSTREAM_HOST, ACCESS_LOG_TRANSPORT_TYPE];
export type { Migration, MigrationResult, MigrationRecord } from './migration.types';
export { MigrationManager } from './migration-manager';
