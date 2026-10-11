import type { ConfigRepository } from './config-repository';
import { ConfigRepositoryError, type ConfigRepositoryErrorCode, type ConfigurationRecovery } from './repository-types';

/** Every callable storage endpoint is named here; no arbitrary property dispatch. */
export const STORAGE_METHODS = [
  'commitPrepared', 'appendServingSnapshot', 'getServingSnapshot', 'claimController',
  'getActivePublication', 'getOperation', 'getOperationState', 'getCurrentOperationState',
  'getRecovery', 'getCurrentRecovery', 'getLatestRecovery', 'createManualRecovery',
  'claimRecoveryAttempt', 'scheduleRecoveryRetry', 'succeedRecovery', 'stopRecovery', 'requeueRecovery',
  'beginPublication', 'beginWorkerAttempt', 'beginDrainingRecovery', 'recordWorkerResult',
  'finalizePublication', 'markDraining', 'verify',
] as const satisfies readonly (keyof ConfigRepository)[];

export type StorageMethod = typeof STORAGE_METHODS[number];
export type StorageParameters<M extends StorageMethod> = Parameters<ConfigRepository[M]>;
export type StorageResult<M extends StorageMethod> = ReturnType<ConfigRepository[M]>;
export const READ_METHODS: ReadonlySet<StorageMethod> = new Set([
  'getServingSnapshot', 'getActivePublication', 'getOperation', 'getOperationState',
  'getCurrentOperationState', 'getRecovery', 'getCurrentRecovery', 'getLatestRecovery', 'verify',
]);

export type StorageRequest =
  | { readonly id: number; readonly method: 'open'; readonly args: readonly [string] }
  | { readonly id: number; readonly method: 'close'; readonly args: readonly [] }
  | { [M in StorageMethod]: { readonly id: number; readonly method: M; readonly args: StorageParameters<M> } }[StorageMethod];

export type StorageError = {
  readonly code: ConfigRepositoryErrorCode;
  readonly message: string;
  readonly recovery?: ConfigurationRecovery;
};
export type StorageResponse =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly id: number; readonly ok: false; readonly error: StorageError };

/** Never send SQL text, stack traces, filesystem paths or arbitrary cause objects. */
export function safeStorageError(error: unknown): StorageError {
  const code = error instanceof ConfigRepositoryError ? error.code : 'repository_failure';
  return { code, message: `configuration storage failed (${code})`,
    ...(error instanceof ConfigRepositoryError && error.recovery ? { recovery: error.recovery } : {}) };
}

export class ConfigurationStorageResultUnknownError extends ConfigRepositoryError {
  constructor(readonly method: StorageMethod, readonly mutationId?: string) {
    super('result_unknown', 'configuration storage write result is unknown; query the original mutation ID before retrying');
  }
}
