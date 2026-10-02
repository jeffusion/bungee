import type {
  ConfigurationAggregateV2,
  PublicationPolicy,
  Sha256Digest,
} from '@jeffusion/bungee-types';

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

export type WorkerExitCleanupState = 'pending' | 'success' | 'failed';

export type WorkerExitDeadlineEvidence = {
  readonly boot_id: string;
  readonly exit_deadline_ns: string;
  readonly exit_remaining_ms: number;
  readonly cleanup_state: WorkerExitCleanupState;
};

export type DrainWorkerCommand = {
  readonly command: 'drain-worker';
  readonly boot_nonce: string;
  readonly start_boot_id: string;
  readonly start_deadline_ns: string;
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly publication: ConfigPublicationIdentity | null;
  readonly drain_id: string;
  readonly policy: Readonly<PublicationPolicy>;
} & ConfigProcessIdentity;

export type ConfigReadyMessage = {
  readonly status: 'config-ready';
  readonly boot_nonce: string;
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
  readonly boot_nonce: string;
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
  readonly boot_nonce: string;
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly drain_id: string;
  readonly policy: Readonly<PublicationPolicy>;
  readonly publication: ConfigPublicationIdentity | null;
} & WorkerExitDeadlineEvidence & ConfigProcessIdentity;

export type WorkerDrainStartedMessage = {
  readonly status: 'worker-draining';
  readonly boot_nonce: string;
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly drain_id: string;
  readonly policy: Readonly<PublicationPolicy>;
  readonly remaining_ms: number;
  readonly publication: ConfigPublicationIdentity | null;
} & ConfigProcessIdentity;

export type WorkerDrainFailedMessage = {
  readonly status: 'worker-drain-failed';
  readonly boot_nonce: string;
  readonly pid: number;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
  readonly plugin_catalog_hash: Sha256Digest;
  readonly drain_id: string;
  readonly policy: Readonly<PublicationPolicy>;
  readonly error_code: 'timeout' | 'drain_failed';
  readonly http_stopped: true;
  readonly publication: ConfigPublicationIdentity | null;
} & WorkerExitDeadlineEvidence & ConfigProcessIdentity;

export type ConfigMutationEnvelope = {
  readonly mutation_id: string;
  readonly expected_revision: number;
  readonly kind: 'config' | 'admin_state';
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

export type ConfigMasterMessage =
  | StartConfigWorkerCommand
  | StartCurrentConfigWorkerCommand
  | DrainWorkerCommand;

export type ConfigWorkerMessage =
  | ConfigReadyMessage
  | ConfigApplyFailedMessage
  | WorkerDrainStartedMessage
  | WorkerDrainFailedMessage
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
