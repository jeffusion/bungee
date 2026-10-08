import { kernelMonotonicNowNs } from '../master-runtime/kernel-monotonic-clock';
import type { CommittedConfigurationSnapshotV2 } from '@jeffusion/bungee-types';
import { randomUUID } from 'node:crypto';
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
  WorkerDrainStartedMessage,
  WorkerDrainFailedMessage,
  WorkerExitDeadlineEvidence,
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
  readonly bootNonce?: string;
  readonly bootId?: string;
  readonly monotonicNow?: () => bigint;
  readonly requestShutdown?: () => void;
  readonly persistTerminalEvidence?: (message: WorkerDrainedMessage | WorkerDrainFailedMessage) => Promise<void>;
  readonly lifecycle: ConfigWorkerLifecycle<ServingHandle>;
  readonly compileSnapshot?: (
    snapshot: CommittedConfigurationSnapshotV2,
    command: StartWorkerCommand,
  ) => RuntimeConfigSnapshot | Promise<RuntimeConfigSnapshot>;
}): ConfigWorkerRuntimeController {
  const { pid, lifecycle } = options;
  const identity = { ...options.identity };
  const bootNonce = options.bootNonce ?? randomUUID();
  const monotonicNow = options.monotonicNow ?? kernelMonotonicNowNs;
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(identity.worker_slot) || identity.worker_slot < 0
    || !isLowercaseUuid(bootNonce)
    || !isLowercaseUuid(identity.master_generation) || !isLowercaseUuid(identity.worker_instance_id)) {
    throw new ConfigWorkerRuntimeError('invalid_state', 'worker process identity is invalid');
  }
  const compileSnapshot = options.compileSnapshot ?? compileRuntimeConfigSnapshot;
  let queue = Promise.resolve();
  let attempt: WorkerStartAttempt | null = null;
  let serving: ServingState<ServingHandle> | null = null;
  let shutdownRequested = false;
  let shutdown: Promise<void> | null = null;
  let activeApply: Promise<ConfigWorkerRuntimeResult> | null = null;

  function exitEvidence(state: ServingState<ServingHandle>): WorkerExitDeadlineEvidence | null {
    if (state.exitDeadlineNs === undefined || state.exitBootId === undefined || state.cleanupState === undefined) return null;
    const remainingNs = state.exitDeadlineNs - monotonicNow();
    const remainingMs = remainingNs <= 0n ? 0 : Math.min(
      state.drainStarted?.policy.worker_exit_timeout_ms ?? 0,
      Number((remainingNs + 999_999n) / 1_000_000n),
    );
    return {
      boot_id: state.exitBootId,
      exit_deadline_ns: state.exitDeadlineNs.toString(),
      exit_remaining_ms: remainingMs,
      cleanup_state: state.cleanupState,
    };
  }

  function beginExitDeadline(state: ServingState<ServingHandle>): WorkerExitDeadlineEvidence | null {
    if (state.exitDeadlineNs === undefined) {
      if (options.bootId === undefined || options.bootId.length === 0) return null;
      state.exitBootId = options.bootId;
      state.exitDeadlineNs = monotonicNow()
        + BigInt(state.drainStarted!.policy.worker_exit_timeout_ms) * 1_000_000n;
      state.cleanupState = 'pending';
    }
    return exitEvidence(state);
  }

  function withExitState<Message extends WorkerDrainedMessage | WorkerDrainFailedMessage>(message: Message, state: ServingState<ServingHandle>): Message | null {
    const exit = exitEvidence(state);
    return exit === null ? null : { ...message, ...exit };
  }

  async function persistTerminalEvidence(state: ServingState<ServingHandle>): Promise<void> {
    if (state.exitDeadlineNs === undefined) throw new Error('kernel exit deadline evidence is unavailable');
    const message = state.drainResult?.ok ? state.drainResult.message : null;
    if (message === null || (message.status !== 'worker-drained' && message.status !== 'worker-drain-failed')) {
      throw new Error('worker terminal drain evidence is unavailable');
    }
    await withinExitDeadline(state, options.persistTerminalEvidence?.(message) ?? Promise.resolve());
    state.terminalEvidencePersisted = true;
  }

  async function withinExitDeadline<Result>(state: ServingState<ServingHandle>, operation: Promise<Result>): Promise<Result> {
    const exit = exitEvidence(state);
    if (exit === null || exit.exit_remaining_ms <= 0) throw new Error('worker exit deadline expired');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('worker exit deadline expired')), exit.exit_remaining_ms);
    });
    try { return await Promise.race([operation, expired]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }

  function shutdownError(): ConfigWorkerRuntimeResult {
    return { ok: false, error: new ConfigWorkerRuntimeError('shutdown', 'worker runtime is shut down') };
  }

  function stopServing(state: ServingState<ServingHandle>): Promise<void> {
    if (state.stopPromise !== undefined) return state.stopPromise;
    if (state.stopped === true) return Promise.resolve();
    const stopping = (async () => {
      let acceptingError: unknown;
      try {
        if (state.acceptingStopped !== true) {
          state.acceptingStopped = true;
          await lifecycle.stopAccepting(state.handle);
        }
      } catch (error) { acceptingError = error; }
      try {
        const stop = lifecycle.stop(state.handle);
        if (state.exitDeadlineNs === undefined) await stop;
        else await withinExitDeadline(state, stop);
        state.stopped = true;
        if (acceptingError !== undefined) throw acceptingError;
      } catch (error) {
        state.cleanupFailure = error;
        if (state.exitDeadlineNs !== undefined) state.cleanupState = 'failed';
        throw error;
      }
    })();
    state.stopPromise = stopping;
    return stopping;
  }

  async function finalizeTerminalCleanup(state: ServingState<ServingHandle> | null, clean: boolean): Promise<void> {
    if (state?.exitDeadlineNs === undefined || state.drainResult?.ok !== true) return;
    const message = state.drainResult.message;
    if (message.status !== 'worker-drained' && message.status !== 'worker-drain-failed') return;
    const cleanupSucceeded = clean && state.stopped === true && state.cleanupFailure === undefined;
    state.cleanupState = cleanupSucceeded ? 'success' : 'failed';
    const updated = withExitState(message, state);
    if (updated === null) throw new Error('kernel exit deadline expired before final cleanup evidence');
    state.drainResult = { ok: true, message: cleanupSucceeded
      ? updated
      : updated.status === 'worker-drained'
        ? { ...updated, status: 'worker-drain-failed', error_code: 'drain_failed', http_stopped: true }
        : { ...updated, error_code: updated.error_code === 'timeout' ? 'timeout' : 'drain_failed' } };
    state.terminalEvidencePersisted = false;
    await persistTerminalEvidence(state);
  }

  async function start(command: StartWorkerCommand): Promise<ConfigWorkerRuntimeResult> {
    if (attempt !== null) {
      if (sameStartIdentity(attempt.command, command)) return { ok: true, message: attempt.message };
      return { ok: true, message: workerFailure(command, identity, bootNonce, pid, 'worker already has a configuration target', [], serving) };
    }

    let compiled: RuntimeConfigSnapshot;
    try {
      compiled = await compileSnapshot(command, command);
    } catch (error) {
      const message = workerFailure(
        command,
        identity, bootNonce,
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
        identity, bootNonce,
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
        identity, bootNonce,
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
      status: 'config-ready', ...identity, boot_nonce: bootNonce, pid,
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
      || command.pid !== pid
      || command.boot_nonce !== bootNonce
      || serving.command.revision !== command.revision
      || serving.command.content_hash !== command.content_hash
      || serving.command.plugin_catalog_hash !== command.plugin_catalog_hash
      || !samePublicationIdentity(serving.command.publication, command.publication)) {
      return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'drain does not match the serving runtime') };
    }
    if (serving.drainStarted !== undefined) {
      if (serving.drainStarted.drain_id !== command.drain_id
        || JSON.stringify(serving.drainStarted.policy) !== JSON.stringify(command.policy)) {
        return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'conflicting worker drain task') };
      }
      return serving.drainResult ?? { ok: true, message: { ...serving.drainStarted,
        remaining_ms: Math.max(0, Math.ceil(command.policy.drain_timeout_ms - (performance.now() - (serving.drainStartedAt ?? performance.now())))) } };
    }
    if (serving.stopped === true) return shutdownError();
    if (options.bootId === undefined || command.start_boot_id !== options.bootId
      || monotonicNow() >= BigInt(command.start_deadline_ns)) {
      return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'worker drain start deadline expired or boot identity mismatched') };
    }
    const drainStartedAt = performance.now();
    serving.drainStartedAt = drainStartedAt;
    const started: WorkerDrainStartedMessage = {
      status: 'worker-draining', ...identity, boot_nonce: bootNonce, pid, revision: command.revision,
      content_hash: command.content_hash, plugin_catalog_hash: command.plugin_catalog_hash,
      drain_id: command.drain_id, policy: command.policy,
      remaining_ms: command.policy.drain_timeout_ms, publication: command.publication,
    };
    serving.drainStarted = started;
    serving.acceptingStopped = true;
    const result: ConfigWorkerRuntimeResult = { ok: true, message: started };
    // Do not hold the command RPC or runtime command queue while existing requests drain.
    serving.drainTask = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const forceAndRecord = async (errorCode: WorkerDrainFailedMessage['error_code']): Promise<void> => {
        if (lifecycle.forceStop === undefined) return;
        if (beginExitDeadline(serving!) === null) {
          try { await lifecycle.forceStop(serving!.handle); } catch { /* keep outcome unknown without kernel proof */ }
          return;
        }
        try { await withinExitDeadline(serving!, lifecycle.forceStop(serving!.handle)); }
        catch {
          // A failed HTTP force must still attempt resource cleanup within the same E.
          // Only successful lifecycle stop supplies the missing HTTP-stop evidence.
          try { await stopServing(serving!); }
          catch { options.requestShutdown?.(); return; }
        }
        const failedBase: Omit<WorkerDrainFailedMessage, keyof WorkerExitDeadlineEvidence> = {
          status: 'worker-drain-failed', ...identity, boot_nonce: bootNonce, pid,
          revision: command.revision, content_hash: command.content_hash,
          plugin_catalog_hash: command.plugin_catalog_hash, drain_id: command.drain_id,
          policy: command.policy, error_code: errorCode, http_stopped: true,
          publication: command.publication,
        };
        const failed = withExitState(failedBase as WorkerDrainFailedMessage, serving!);
        if (failed === null) return;
        serving!.drainResult = { ok: true, message: failed };
        serving!.terminalEvidencePersisted = false;
        try { await persistTerminalEvidence(serving!); } catch { /* still clean up; failed final evidence remains unknown */ }
        try { await stopServing(serving!); } catch { /* final cleanup status is recorded by the shared shutdown path */ }
        options.requestShutdown?.();
      };
      try {
        const acceptingStopped = lifecycle.stopAccepting(serving!.handle, command.policy.drain_timeout_ms);
        const timedOut = new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), command.policy.drain_timeout_ms);
          serving!.drainTimeout = timer;
        });
        const completed = Promise.all([acceptingStopped, lifecycle.drain(serving!.handle)]).then(() => true as const);
        if (!await Promise.race([completed, timedOut])) {
          await forceAndRecord('timeout');
          return;
        }
        if (shutdownRequested) return;
        const exit = beginExitDeadline(serving!);
        if (exit === null) return;
        const drained: WorkerDrainedMessage = {
          status: 'worker-drained', ...identity, boot_nonce: bootNonce, pid, revision: command.revision,
          content_hash: command.content_hash, plugin_catalog_hash: command.plugin_catalog_hash,
          drain_id: command.drain_id, policy: command.policy, ...exit, publication: command.publication,
        };
        serving!.drainResult = { ok: true, message: drained };
        serving!.terminalEvidencePersisted = false;
        try { await persistTerminalEvidence(serving!); } catch { /* cleanup still proceeds; exact proof remains unknown if final persistence also fails */ }
        try { await stopServing(serving!); } catch { /* unified shutdown records cleanup failure */ }
        options.requestShutdown?.();
      } catch {
        if (shutdownRequested) return;
        const remaining = Math.max(0, command.policy.drain_timeout_ms - (performance.now() - drainStartedAt));
        if (remaining > 0) await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
          serving!.drainTimeout = timer;
        });
        if (shutdownRequested) return;
        await forceAndRecord('drain_failed');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        serving!.drainTimeout = undefined;
      }
    })();
    return result;
  }

  async function applyParsed(message: ConfigMasterMessage): Promise<ConfigWorkerRuntimeResult> {
    if (shutdownRequested) return shutdownError();
    if (!sameProcessIdentity(message, identity)) {
      if (message.command === 'drain-worker') {
        return { ok: false, error: new ConfigWorkerRuntimeError('invalid_state', 'command process identity mismatch') };
      }
      return { ok: true, message: workerFailure(
        message, identity, bootNonce, pid, 'command process identity mismatch', [], serving,
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
    drainStatus(): ConfigWorkerRuntimeResult | null {
      if (serving?.drainStarted === undefined) return null;
      if (serving.drainResult !== undefined && serving.drainResult.ok) {
        const message = serving.drainResult.message;
        if (message.status === 'worker-drained' || message.status === 'worker-drain-failed') {
          if (serving.terminalEvidencePersisted !== true) {
            return { ok: true, message: { ...serving.drainStarted, remaining_ms: 0 } };
          }
          const updated = withExitState(message, serving);
          if (updated !== null) return { ok: true, message: updated };
        } else return serving.drainResult;
      }
      const started = serving.drainStarted;
      return { ok: true, message: { ...started,
        remaining_ms: Math.max(0, Math.ceil(started.policy.drain_timeout_ms - (performance.now() - (serving.drainStartedAt ?? performance.now())))) } };
    },
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
      const result = queue.then(() => {
        const execution = applyParsed(message);
        activeApply = execution;
        void execution.then(
          () => { if (activeApply === execution) activeApply = null; },
          () => { if (activeApply === execution) activeApply = null; },
        );
        return execution;
      });
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    failClosed(stopSupervision?: () => Promise<void>): Promise<void> {
      shutdownRequested = true;
      if (serving?.drainTimeout !== undefined) clearTimeout(serving.drainTimeout);
      if (shutdown !== null) return shutdown;
      const queued = queue;
      const active = activeApply;
      const stop = serving === null ? Promise.resolve() : stopServing(serving);
      shutdown = (async () => {
        const waits = active === null ? [queued, stop] : [queued, stop, active];
        const results = await Promise.allSettled(waits);
        const [queuedResult, stopResult, activeResult] = results;
        const errors: unknown[] = [];
        if (stopResult?.status === 'rejected') errors.push(stopResult.reason);
        if (activeResult?.status === 'rejected') errors.push(activeResult.reason);
        if (queuedResult?.status === 'rejected') errors.push(queuedResult.reason);
        let supervisionSucceeded = true;
        if (stopSupervision !== undefined) {
          try {
            const stopping = stopSupervision();
            if (serving?.exitDeadlineNs === undefined) await stopping;
            else await withinExitDeadline(serving, stopping);
          } catch (error) {
            supervisionSucceeded = false;
            errors.push(error);
          }
        }
        try {
          await finalizeTerminalCleanup(serving, stopResult?.status === 'fulfilled' && supervisionSucceeded);
        } catch (error) { errors.push(error); }
        if (errors.length > 0) throw new AggregateError(errors, 'worker runtime shutdown failed');
      })();
      queue = shutdown.then(() => undefined, () => undefined);
      return shutdown;
    },
  };
}
