import type { AppConfig } from '@jeffusion/bungee-types';
import type { PluginRuntimeOrchestratorStatusReport } from '../plugin-runtime-orchestrator';
import type {
  ConfigApplyFailedMessage,
  ConfigProcessIdentity,
  ConfigReadyMessage,
  StartWorkerCommand,
  WorkerDrainedMessage,
} from './types';

export interface ConfigWorkerLifecycle<ServingHandle> {
  start(config: AppConfig, command: StartWorkerCommand): Promise<{
    readonly handle: ServingHandle;
    readonly private_port: number;
    readonly plugin_runtime_generation: number;
    readonly plugin_status: PluginRuntimeOrchestratorStatusReport;
  }>;
  stop(handle: ServingHandle): Promise<void>;
  stopAccepting(handle: ServingHandle): Promise<void>;
  drain(handle: ServingHandle): Promise<void>;
}

export class ConfigWorkerLifecycleReadinessError extends Error {
  constructor(readonly failedPlugins: readonly string[]) {
    super('required plugins are not serving');
    this.name = 'ConfigWorkerLifecycleReadinessError';
  }
}

export type ConfigWorkerRuntimeErrorCode =
  | 'invalid_message'
  | 'unsupported_message'
  | 'invalid_state'
  | 'shutdown';

export class ConfigWorkerRuntimeError extends Error {
  readonly name = 'ConfigWorkerRuntimeError';

  constructor(
    readonly code: ConfigWorkerRuntimeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, { cause });
  }
}

export type ConfigWorkerRuntimeMessage =
  | ConfigReadyMessage
  | ConfigApplyFailedMessage
  | WorkerDrainedMessage;

export type ConfigWorkerRuntimeResult =
  | { readonly ok: true; readonly message: ConfigWorkerRuntimeMessage }
  | { readonly ok: false; readonly error: ConfigWorkerRuntimeError };

export interface ConfigWorkerRuntimeController {
  apply(input: unknown): Promise<ConfigWorkerRuntimeResult>;
  failClosed(): Promise<void>;
}

export type ServingState<ServingHandle> = {
  readonly command: StartWorkerCommand;
  readonly handle: ServingHandle;
  readonly ready: ConfigReadyMessage;
  drainResult?: ConfigWorkerRuntimeResult;
  acceptingStopped?: true;
  stopped?: true;
};

export type WorkerStartAttempt = {
  readonly command: StartWorkerCommand;
  readonly message: ConfigReadyMessage | ConfigApplyFailedMessage;
};

export function workerFailure(
  command: StartWorkerCommand,
  identity: ConfigProcessIdentity,
  pid: number,
  error: string,
  failedPlugins: readonly string[],
  serving: ServingState<unknown> | null,
): ConfigApplyFailedMessage {
  return {
    status: 'config-apply-failed', ...identity, pid,
    target_revision: command.revision, target_content_hash: command.content_hash,
    target_plugin_catalog_hash: command.plugin_catalog_hash,
    serving_revision: serving?.command.revision ?? null,
    serving_content_hash: serving?.command.content_hash ?? null,
    failed_plugins: failedPlugins,
    error,
    publication: command.publication,
  };
}

export function sameStartIdentity(left: StartWorkerCommand, right: StartWorkerCommand): boolean {
  return left.worker_slot === right.worker_slot
    && left.revision === right.revision
    && left.content_hash === right.content_hash
    && left.plugin_catalog_hash === right.plugin_catalog_hash
    && left.master_generation === right.master_generation
    && left.worker_instance_id === right.worker_instance_id
    && left.command === right.command
    && left.activated_plugin_names.length === right.activated_plugin_names.length
    && left.activated_plugin_names.every((name, index) => name === right.activated_plugin_names[index])
    && (left.publication === null
      ? right.publication === null
      : right.publication !== null
        && left.publication.mutation_id === right.publication.mutation_id
        && left.publication.attempt_no === right.publication.attempt_no
        && left.publication.drain_recovery_generation === right.publication.drain_recovery_generation);
}
