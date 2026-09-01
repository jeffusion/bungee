import type { CommittedConfigurationSnapshotV2 } from '@jeffusion/bungee-types';
import {
  compileRuntimeConfigSnapshot,
  type RuntimeConfigSnapshot,
} from '../config-storage/runtime-config';
import { isLowercaseUuid } from '../config-storage/validation';
import { parseConfigMasterMessage } from './master-messages';
import type {
  ConfigReadyMessage,
  ConfigMasterMessage,
  DrainWorkerCommand,
  StartWorkerCommand,
  WorkerDrainedMessage,
  ConfigProcessIdentity,
} from './types';
import { assertNeverConfigPublicationMessage, ConfigPublicationMessageError } from './types';
import { sameProcessIdentity, samePublicationIdentity } from './message-fields';
import { derivePluginReadiness, requiredPluginNames } from './worker-runtime-plugins';
import {
  ConfigWorkerLifecycleReadinessError,
  ConfigWorkerRuntimeError,
  sameStartIdentity,
  workerFailure,
  type ConfigWorkerLifecycle,
  type ConfigWorkerRuntimeController,
  type ConfigWorkerRuntimeResult,
  type ServingState,
  type WorkerStartAttempt,
} from './worker-runtime-contract';
export {
  ConfigWorkerRuntimeError,
  type ConfigWorkerLifecycle,
  type ConfigWorkerRuntimeController,
  type ConfigWorkerRuntimeErrorCode,
  type ConfigWorkerRuntimeMessage,
  type ConfigWorkerRuntimeResult,
} from './worker-runtime-contract';

export function createConfigWorkerRuntimeController<ServingHandle>(options: {
  readonly pid: number;
  readonly identity: ConfigProcessIdentity;
  readonly lifecycle: ConfigWorkerLifecycle<ServingHandle>;
  readonly compileSnapshot?: (
    snapshot: CommittedConfigurationSnapshotV2,
    command: StartWorkerCommand,
  ) => RuntimeConfigSnapshot | Promise<RuntimeConfigSnapshot>;
}): ConfigWorkerRuntimeController {
  const { pid, lifecycle } = options;
  const identity = { ...options.identity };
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(identity.worker_slot) || identity.worker_slot < 0
    || !isLowercaseUuid(identity.master_generation) || !isLowercaseUuid(identity.worker_instance_id)) {
    throw new ConfigWorkerRuntimeError('invalid_state', 'worker process identity is invalid');
  }
  const compileSnapshot = options.compileSnapshot ?? compileRuntimeConfigSnapshot;
  let queue = Promise.resolve();
  let attempt: WorkerStartAttempt | null = null;
  let serving: ServingState<ServingHandle> | null = null;
  let shutdownRequested = false;
  let shutdown: Promise<void> | null = null;

  function shutdownError(): ConfigWorkerRuntimeResult {
    return { ok: false, error: new ConfigWorkerRuntimeError('shutdown', 'worker runtime is shut down') };
  }

  async function stopServing(state: ServingState<ServingHandle>): Promise<void> {
    if (state.stopped === true) return;
    try {
      if (state.acceptingStopped !== true) {
        state.acceptingStopped = true;
        await lifecycle.stopAccepting(state.handle);
      }
    } finally {
      state.stopped = true;
      await lifecycle.stop(state.handle);
    }
  }

  async function start(command: StartWorkerCommand): Promise<ConfigWorkerRuntimeResult> {
    if (attempt !== null) {
      if (sameStartIdentity(attempt.command, command)) return { ok: true, message: attempt.message };
      return { ok: true, message: workerFailure(command, identity, pid, 'worker already has a configuration target', [], serving) };
    }

    let compiled: RuntimeConfigSnapshot;
    try {
      compiled = await compileSnapshot(command, command);
    } catch (error) {
      const message = workerFailure(
        command,
        identity,
        pid,
        'runtime configuration compilation failed',
        [],
        null,
      );
      attempt = { command, message };
      return { ok: true, message };
    }
    if (shutdownRequested) return shutdownError();

    const required = requiredPluginNames(compiled.config);
    let started: Awaited<ReturnType<ConfigWorkerLifecycle<ServingHandle>['start']>>;
    try {
      started = await lifecycle.start(compiled.config, command);
    } catch (error) {
      const readinessFailure = error instanceof ConfigWorkerLifecycleReadinessError;
      const message = workerFailure(
        command,
        identity,
        pid,
        readinessFailure ? error.message : 'worker lifecycle start failed',
        readinessFailure ? error.failedPlugins : [],
        null,
      );
      attempt = { command, message };
      return { ok: true, message };
    }
    if (shutdownRequested) {
      try {
        await lifecycle.stopAccepting(started.handle);
      } finally {
        await lifecycle.stop(started.handle);
      }
      return shutdownError();
    }
    const readiness = derivePluginReadiness(required, started.plugin_runtime_generation, started.plugin_status);
    const validPrivatePort = Number.isSafeInteger(started.private_port) && started.private_port > 0 && started.private_port <= 65_535;
    if (readiness.failed.length > 0 || !validPrivatePort) {
      let cleanupFailed = false;
      try {
        await lifecycle.stop(started.handle);
      } catch (error) {
        cleanupFailed = true;
      }
      const message = workerFailure(
        command,
        identity,
        pid,
        !validPrivatePort
          ? cleanupFailed ? 'worker private port is invalid; cleanup failed' : 'worker private port is invalid'
          : cleanupFailed ? 'required plugins are not serving; cleanup failed' : 'required plugins are not serving',
        readiness.failed,
        null,
      );
      attempt = { command, message };
      return { ok: true, message };
    }
    const ready: ConfigReadyMessage = {
      status: 'config-ready', ...identity, pid,
      revision: command.revision, content_hash: command.content_hash,
      plugin_catalog_hash: command.plugin_catalog_hash, private_port: started.private_port,
      plugin_runtime_generation: started.plugin_runtime_generation,
      required_plugins: required, serving_plugins: readiness.serving,
      publication: command.publication,
    };
    serving = { command, handle: started.handle, ready };
    attempt = { command, message: ready };
    return { ok: true, message: ready };
  }

  async function drain(command: DrainWorkerCommand): Promise<ConfigWorkerRuntimeResult> {
    if (serving === null
      || !sameProcessIdentity(serving.command, command)
      || serving.command.revision !== command.revision
      || serving.command.content_hash !== command.content_hash
      || serving.command.plugin_catalog_hash !== command.plugin_catalog_hash
      || !samePublicationIdentity(serving.command.publication, command.publication)) {
      return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'drain does not match the serving runtime') };
    }
    if (serving.drainResult !== undefined) return serving.drainResult;
    try {
      serving.acceptingStopped = true;
      await lifecycle.stopAccepting(serving.handle);
      await lifecycle.drain(serving.handle);
    } catch (error) {
      const result: ConfigWorkerRuntimeResult = {
        ok: false,
        error: new ConfigWorkerRuntimeError('invalid_state', 'worker drain failed', error),
      };
      serving.drainResult = result;
      return result;
    }
    if (shutdownRequested) return shutdownError();
    const drained: WorkerDrainedMessage = {
      status: 'worker-drained', ...identity, pid, revision: command.revision,
      content_hash: command.content_hash, plugin_catalog_hash: command.plugin_catalog_hash,
      publication: command.publication,
    };
    const result: ConfigWorkerRuntimeResult = { ok: true, message: drained };
    serving.drainResult = result;
    return result;
  }

  async function applyParsed(message: ConfigMasterMessage): Promise<ConfigWorkerRuntimeResult> {
    if (shutdownRequested) return shutdownError();
    if ('status' in message) {
      return { ok: false, error: new ConfigWorkerRuntimeError('unsupported_message', 'control responses are not worker lifecycle commands') };
    }
    if (message.command === 'master-heartbeat') {
      return { ok: false, error: new ConfigWorkerRuntimeError('unsupported_message', 'heartbeats are process runtime messages') };
    }
    if (!sameProcessIdentity(message, identity)) {
      if (message.command === 'drain-worker') {
        return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'command process identity mismatch') };
      }
      return { ok: true, message: workerFailure(
        message, identity, pid, 'command process identity mismatch', [], serving,
      ) };
    }
    switch (message.command) {
      case 'start-config-worker': return start(message);
      case 'start-current-config-worker': return start(message);
      case 'drain-worker': return drain(message);
      default: return assertNeverConfigPublicationMessage(message);
    }
  }

  return {
    apply(input: unknown): Promise<ConfigWorkerRuntimeResult> {
      let message: ConfigMasterMessage;
      try {
        message = parseConfigMasterMessage(input);
      } catch (error) {
        if (error instanceof ConfigPublicationMessageError) {
          return Promise.resolve({
            ok: false,
            error: new ConfigWorkerRuntimeError('invalid_message', error.message, error),
          });
        }
        return Promise.resolve({
          ok: false,
          error: new ConfigWorkerRuntimeError('invalid_message', 'config message parsing failed', error),
        });
      }
      const result = queue.then(() => applyParsed(message));
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    failClosed(): Promise<void> {
      shutdownRequested = true;
      if (shutdown !== null) return shutdown;
      shutdown = queue.then(async () => {
        if (serving !== null) await stopServing(serving);
      });
      queue = shutdown.then(() => undefined, () => undefined);
      return shutdown;
    },
  };
}
