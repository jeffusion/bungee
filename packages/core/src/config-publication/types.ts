import type {
  ConfigurationAggregateV2,
  Sha256Digest,
} from '@jeffusion/bungee-types';
import type { ConfigurationOperation } from '../config-storage/repository-types';

export type ConfigPublicationIdentity = {
  readonly mutation_id: string;
  readonly attempt_no: number;
  readonly drain_recovery_generation: number;
};

export type ConfigProcessIdentity = {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
};

type StartWorkerCommandBase = ConfigProcessIdentity & {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregateV2;
  readonly activated_plugin_names: readonly string[];
};

export type StartConfigWorkerCommand = StartWorkerCommandBase & {
  readonly command: 'start-config-worker';
  readonly publication: ConfigPublicationIdentity;
};

export type StartCurrentConfigWorkerCommand = StartWorkerCommandBase & {
  readonly command: 'start-current-config-worker';
  readonly publication: null;
};

export type StartWorkerCommand = StartConfigWorkerCommand | StartCurrentConfigWorkerCommand;

export type DrainWorkerCommand = {
  readonly command: 'drain-worker';
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly publication: ConfigPublicationIdentity | null;
} & ConfigProcessIdentity;

export type MasterHeartbeatCommand = ConfigProcessIdentity & {
  readonly command: 'master-heartbeat';
  readonly master_pid: number;
  readonly sequence: number;
};

export type ConfigReadyMessage = {
  readonly status: 'config-ready';
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly private_port: number;
  readonly plugin_runtime_generation: number;
  readonly required_plugins: readonly string[];
  readonly serving_plugins: readonly string[];
  readonly publication: ConfigPublicationIdentity | null;
} & ConfigProcessIdentity;

export type ConfigApplyFailedMessage = {
  readonly status: 'config-apply-failed';
  readonly pid: number;
  readonly target_revision: number;
  readonly target_content_hash: Sha256Digest;
  readonly target_plugin_catalog_hash: Sha256Digest;
  readonly serving_revision: number | null;
  readonly serving_content_hash: Sha256Digest | null;
  readonly failed_plugins: readonly string[];
  readonly error: string;
  readonly publication: ConfigPublicationIdentity | null;
} & ConfigProcessIdentity;

export type WorkerDrainedMessage = {
  readonly status: 'worker-drained';
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly publication: ConfigPublicationIdentity | null;
} & ConfigProcessIdentity;

export type ConfigMutationEnvelope = {
  readonly mutation_id: string;
  readonly expected_revision: number;
  readonly kind: 'config' | 'admin_state';
  readonly aggregate: ConfigurationAggregateV2;
};

export type ConfigPublicationSnapshot = {
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregateV2;
};

export type CommitConfigRequest = ConfigProcessIdentity & {
  readonly command: 'commit-config';
  readonly request_id: string;
  readonly mutation: ConfigMutationEnvelope;
};

export type GetConfigOperationRequest = ConfigProcessIdentity & {
  readonly command: 'get-config-operation';
  readonly request_id: string;
  readonly mutation_id: string;
};

export type ConfigControlError =
  | { readonly kind: 'error'; readonly http_status: 409; readonly code: 'stale_revision';
      readonly expected_revision: number; readonly active_revision: number; readonly outcome_unknown: false }
  | { readonly kind: 'error'; readonly http_status: 409; readonly code: 'idempotency_key_reused';
      readonly mutation_id: string; readonly outcome_unknown: false }
  | { readonly kind: 'error'; readonly http_status: 409; readonly code: 'operation_in_progress';
      readonly mutation_id: string; readonly committed_revision: number;
      readonly operation_state: 'committed' | 'publishing' | 'draining'; readonly outcome_unknown: false }
  | { readonly kind: 'error'; readonly http_status: 422;
      readonly code: 'invalid_configuration'; readonly outcome_unknown: false }
  | { readonly kind: 'error'; readonly http_status: 503;
      readonly code: 'repository_unavailable'; readonly outcome_unknown: true };

export type ConfigControlResult =
  | { readonly kind: 'commit'; readonly outcome: 'committed';
      readonly snapshot: ConfigPublicationSnapshot; readonly operation: ConfigurationOperation }
  | { readonly kind: 'commit'; readonly outcome: 'duplicate'; readonly operation: ConfigurationOperation }
  | { readonly kind: 'operation'; readonly operation: ConfigurationOperation | null }
  | ConfigControlError;

export type ConfigControlResponse = ConfigProcessIdentity & {
  readonly status: 'config-control-response';
  readonly request_id: string;
  readonly result: ConfigControlResult;
};

export type ConfigMasterMessage =
  | StartConfigWorkerCommand
  | StartCurrentConfigWorkerCommand
  | DrainWorkerCommand
  | MasterHeartbeatCommand
  | ConfigControlResponse;

export type ConfigWorkerMessage =
  | ConfigReadyMessage
  | ConfigApplyFailedMessage
  | WorkerDrainedMessage
  | CommitConfigRequest
  | GetConfigOperationRequest;

export type ConfigPublicationMessageErrorCode = 'unsafe_message' | 'invalid_message';

export class ConfigPublicationMessageError extends Error {
  readonly name = 'ConfigPublicationMessageError';

  constructor(
    readonly code: ConfigPublicationMessageErrorCode,
    readonly path: string,
    readonly cause?: unknown,
  ) {
    super(`Invalid config publication message at ${path || '<root>'}`, { cause });
  }
}

export function assertNeverConfigPublicationMessage(value: never): never {
  throw new ConfigPublicationMessageError('invalid_message', 'variant', value);
}
