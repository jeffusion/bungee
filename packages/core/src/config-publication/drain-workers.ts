import { randomUUID } from 'node:crypto';
import { kernelMonotonicNowNs } from '../master-runtime/kernel-monotonic-clock';
import { DEFAULT_PUBLICATION_POLICY, resolvePublicationPolicy, type PublicationPolicy } from '@jeffusion/bungee-types';
import type {
  PublicationFailure,
  PublicationScheduler,
  ServingConfigWorker,
  WorkerExitEvidence,
} from './coordinator-types';
import type { WorkerDrainedMessage, WorkerDrainFailedMessage, WorkerDrainStartedMessage } from './types';
import { waitForDrainAck } from './worker-wait';
import { terminateWithEscalation } from './process-termination';
import { bestEffort } from './waiter-safety';

export type WorkerDrainEvidence = {
  readonly worker: ServingConfigWorker;
  readonly acknowledgementFailure: PublicationFailure | null;
  readonly unknownStage?: 'start' | 'drain' | 'exit' | 'rejected';
  readonly terminationError?: unknown;
  readonly waitError?: unknown;
  readonly exitEvidence: WorkerExitEvidence | null;
};

type FrozenDrainTask = {
  readonly drainId: string;
  readonly policy: Readonly<PublicationPolicy>;
  readonly sent: boolean;
  readonly startBootId?: string;
  readonly startDeadlineNs?: string;
};
const drainTasks = new WeakMap<ServingConfigWorker['process'], FrozenDrainTask>();
const reportedTerminalMismatches = new WeakSet<ServingConfigWorker['process']>();
const reportedTerminalProbeFailures = new WeakSet<ServingConfigWorker['process']>();

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message.slice(0, 512) : fallback;
}

function matchesDrainStatus(
  message: WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage,
  worker: ServingConfigWorker,
  drainId: string,
  bootNonce: string,
  policy: PublicationPolicy,
): boolean {
  return message.drain_id === drainId && message.boot_nonce === bootNonce
    && message.pid === worker.process.pid && message.worker_slot === worker.process.slot
    && message.master_generation === worker.process.identity.master_generation
    && message.worker_instance_id === worker.process.identity.worker_instance_id
    && message.revision === worker.revision && message.content_hash === worker.content_hash
    && message.plugin_catalog_hash === worker.plugin_catalog_hash
    && JSON.stringify(message.publication) === JSON.stringify(worker.publication)
    && JSON.stringify(message.policy) === JSON.stringify(policy)
    && (message.status === 'worker-draining' || message.boot_id === worker.process.kernelBootId);
}

function terminalMatchesWorker(
  message: WorkerDrainedMessage | WorkerDrainFailedMessage,
  worker: ServingConfigWorker,
  task?: Pick<FrozenDrainTask, 'drainId' | 'policy'>,
): boolean {
  return message.pid === worker.process.pid
    && message.master_generation === worker.process.identity.master_generation
    && message.worker_instance_id === worker.process.identity.worker_instance_id
    && message.worker_slot === worker.process.slot
    && (worker.boot_nonce === undefined || message.boot_nonce === worker.boot_nonce)
    && message.revision === worker.revision && message.content_hash === worker.content_hash
    && message.plugin_catalog_hash === worker.plugin_catalog_hash
    && JSON.stringify(message.publication) === JSON.stringify(worker.publication)
    && message.boot_id === worker.process.kernelBootId && message.exit_remaining_ms > 0
    && message.cleanup_state !== 'pending'
    && (task === undefined || (message.drain_id === task.drainId
      && JSON.stringify(message.policy) === JSON.stringify(task.policy)));
}

async function completedTerminalExit(
  worker: ServingConfigWorker,
  scheduler: PublicationScheduler,
  task?: Pick<FrozenDrainTask, 'drainId' | 'policy'>,
  timeoutMs = 100,
): Promise<WorkerExitEvidence | null> {
  const startedAt = performance.now();
  let outcome = 'timeout';
  let probeError: string | undefined;
  try {
    // A stalled OS probe must not hold the retirement task beyond its window.
    const evidence = await new Promise<WorkerExitEvidence | null>((resolve) => {
      const timeout = scheduler.schedule(timeoutMs, () => resolve(null));
      Promise.resolve().then(() => worker.process.verifyExactExit?.()).then(
        result => { outcome = result == null ? 'unconfirmed' : 'verified'; bestEffort(() => timeout.cancel()); resolve(result ?? null); },
        error => { outcome = 'error'; probeError = errorDetail(error, 'exit probe failed'); bestEffort(() => timeout.cancel()); resolve(null); },
      );
    });
    const message = evidence?.terminalDrain;
    if (evidence == null && !reportedTerminalProbeFailures.has(worker.process)) {
      reportedTerminalProbeFailures.add(worker.process);
      console.error(JSON.stringify({ event: 'worker_terminal_exit_probe', pid: worker.process.pid,
        outcome, elapsedMs: Math.round(performance.now() - startedAt), error: probeError }));
    }
    if (evidence !== null && evidence !== undefined && !reportedTerminalMismatches.has(worker.process)
      && (message === undefined || !terminalMatchesWorker(message, worker, task))) {
      reportedTerminalMismatches.add(worker.process);
      console.error(JSON.stringify({ event: 'worker_terminal_exit_mismatch', pid: worker.process.pid, evidencePid: evidence.pid,
        expected: { ...worker.process.identity, boot_nonce: worker.boot_nonce, revision: worker.revision,
          content_hash: worker.content_hash, plugin_catalog_hash: worker.plugin_catalog_hash,
          publication: worker.publication, boot_id: worker.process.kernelBootId, task }, terminal: message ?? null }));
    }
    return evidence !== null && evidence !== undefined && evidence.pid === worker.process.pid
      && message !== undefined && terminalMatchesWorker(message, worker, task) ? evidence : null;
  } catch { return null; }
}

function terminalFailure(message: WorkerDrainedMessage | WorkerDrainFailedMessage, slot: number): PublicationFailure | null {
  if (message.cleanup_state === 'failed') return { slot, code: 'apply_failed',
    detail: 'worker terminal cleanup failed', recovery_disposition: 'retryable' };
  if (message.status === 'worker-drain-failed') return {
    slot, code: message.error_code === 'timeout' ? 'timeout' : 'apply_failed',
    detail: message.error_code === 'timeout' ? 'worker drain timed out' : 'worker drain failed',
    recovery_disposition: 'retryable',
  };
  return null;
}

async function waitForTerminalDrainStatus(
  worker: ServingConfigWorker,
  scheduler: PublicationScheduler,
  drainId: string,
  bootNonce: string,
  policy: PublicationPolicy,
  timeoutMs: number,
  beforePoll: () => void,
): Promise<WorkerDrainedMessage | WorkerDrainFailedMessage | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    beforePoll();
    const completed = await completedTerminalExit(worker, scheduler, { drainId, policy }, Math.min(100, deadline - Date.now()));
    if (completed !== null) return completed.terminalDrain!;
    if (Date.now() >= deadline) break;
    try {
      const message = await worker.process.drainStatus?.(Math.max(1, Math.min(1_000, deadline - Date.now()))) ?? null;
      if (message !== null && matchesDrainStatus(message, worker, drainId, bootNonce, policy)) {
        if (message.status === 'worker-drained' || message.status === 'worker-drain-failed') return message;
      }
    } catch {
      // A missing signed status is unknown; retain ownership and retry within E.
    }
    await new Promise<void>((resolve) => {
      scheduler.schedule(Math.max(1, Math.min(100, deadline - Date.now())), resolve);
    });
  }
  return null;
}

export async function drainWorkers(
  workers: readonly ServingConfigWorker[],
  scheduler: PublicationScheduler,
  publicationPolicy: PublicationPolicy = DEFAULT_PUBLICATION_POLICY,
  beforePoll: () => void = () => undefined,
): Promise<readonly WorkerDrainEvidence[]> {
  const policy = Object.freeze({ ...resolvePublicationPolicy(publicationPolicy) });
  return await Promise.all(workers.map(async (worker) => {
    const { process } = worker;
    if (process.kernelBootId === undefined) return { worker, acknowledgementFailure: { slot: process.slot, code: 'timeout',
      detail: 'kernel boot identity is unavailable; worker exit outcome is unknown', recovery_disposition: 'retryable' },
    unknownStage: 'exit', exitEvidence: null };
    let observed: WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null = null;
    try { observed = await process.drainStatus?.(policy.drain_start_timeout_ms) ?? null; }
    catch (error) {
      const remembered = drainTasks.get(process);
      const completed = await completedTerminalExit(worker, scheduler, remembered);
      if (completed !== null) {
        const terminal = completed.terminalDrain!;
        drainTasks.delete(process);
        return { worker, acknowledgementFailure: terminalFailure(terminal, process.slot), exitEvidence: completed };
      }
      return { worker, acknowledgementFailure: { slot: process.slot, code: 'timeout',
        detail: errorDetail(error, 'worker drain status is unknown'), recovery_disposition: 'retryable' },
      unknownStage: remembered?.sent ? 'exit' : 'start', exitEvidence: null };
    }
    const rememberedTask = drainTasks.get(process);
    let drainId = observed?.drain_id ?? rememberedTask?.drainId ?? randomUUID();
    let taskPolicy = Object.freeze({ ...(observed?.policy ?? rememberedTask?.policy ?? policy) });
    if (rememberedTask !== undefined && observed !== null
      && (observed.drain_id !== rememberedTask.drainId
        || JSON.stringify(observed.policy) !== JSON.stringify(rememberedTask.policy))) {
      return { worker, acknowledgementFailure: { slot: process.slot, code: 'mismatched_message',
        detail: 'worker reported a different drain task than the frozen retirement task',
        recovery_disposition: 'deterministic_protocol_failure' }, exitEvidence: null };
    }
    let drainTask: FrozenDrainTask = rememberedTask ?? { drainId, policy: taskPolicy, sent: observed !== null };
    if (observed !== null && !drainTask.sent) drainTask = { ...drainTask, sent: true };
    drainTasks.set(process, drainTask);
    let remainingDrainMs = observed?.status === 'worker-draining' ? observed.remaining_ms : taskPolicy.drain_timeout_ms;
    const identityMatches = observed === null || (observed.master_generation === process.identity.master_generation
      && observed.worker_instance_id === process.identity.worker_instance_id
      && observed.worker_slot === process.slot && observed.pid === process.pid
      && (worker.boot_nonce === undefined || observed.boot_nonce === worker.boot_nonce)
      && observed.revision === worker.revision && observed.content_hash === worker.content_hash
      && observed.plugin_catalog_hash === worker.plugin_catalog_hash
      && JSON.stringify(observed.publication) === JSON.stringify(worker.publication));
    if (!identityMatches) {
      return { worker, acknowledgementFailure: { slot: process.slot, code: 'mismatched_message',
        detail: 'existing worker drain status does not match the retired worker', recovery_disposition: 'deterministic_protocol_failure' }, exitEvidence: null };
    }
    const bootNonce = observed?.boot_nonce ?? worker.boot_nonce;
    if (bootNonce === undefined) {
      return { worker, acknowledgementFailure: { slot: process.slot, code: 'mismatched_message',
        detail: 'retired worker boot nonce is unavailable', recovery_disposition: 'deterministic_protocol_failure' }, exitEvidence: null };
    }
    let acknowledgementFailure: PublicationFailure | null = observed?.status === 'worker-drain-failed'
      ? { slot: process.slot, code: observed.error_code === 'timeout' ? 'timeout' : 'apply_failed',
        detail: observed.error_code === 'timeout' ? 'worker drain timed out' : 'worker drain failed',
        recovery_disposition: 'retryable' }
      : null;
    let naturallyDrained = observed?.status === 'worker-drained';
    let forceStopped = observed?.status === 'worker-drain-failed' && observed.http_stopped;
    let terminalStatus: WorkerDrainedMessage | WorkerDrainFailedMessage | null =
      observed?.status === 'worker-drained' || observed?.status === 'worker-drain-failed' ? observed : null;
    if (observed?.status !== 'worker-drained' && observed?.status !== 'worker-drain-failed') {
      let startFailure: PublicationFailure | null = null;
      let startedEvidence: WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null =
        observed?.status === 'worker-draining' ? observed : null;
      let confirmedByStatus = observed?.status === 'worker-draining';
      if (startedEvidence === null) {
        if (drainTask.sent) {
          return { worker, acknowledgementFailure: { slot: process.slot, code: 'timeout',
            detail: 'previously sent drain task has no start status; do not reopen its C window',
            recovery_disposition: 'retryable' }, unknownStage: 'exit', exitEvidence: null };
        }
        const started = waitForDrainAck({ worker, scheduler, timeoutMs: policy.drain_start_timeout_ms,
          drainId, bootNonce, policy: taskPolicy, phase: 'started' });
        const startBootId = process.kernelBootId;
        const startDeadlineNs = (kernelMonotonicNowNs() + BigInt(policy.drain_start_timeout_ms) * 1_000_000n).toString();
        drainTask = { drainId, policy: taskPolicy, sent: true, startBootId, startDeadlineNs };
        drainTasks.set(process, drainTask);
        const sendFailure: Promise<PublicationFailure | null> = process.send({ command: 'drain-worker', ...process.identity,
          boot_nonce: bootNonce, pid: process.pid,
          start_boot_id: startBootId,
          start_deadline_ns: startDeadlineNs,
          revision: worker.revision, content_hash: worker.content_hash,
          plugin_catalog_hash: worker.plugin_catalog_hash, publication: worker.publication,
          drain_id: drainId, policy: taskPolicy })
          .then(() => null, (error): PublicationFailure => ({ slot: process.slot,
          code: typeof error === 'object' && error !== null
            && ['timeout', 'network'].includes(String((error as { readonly code?: unknown }).code)) ? 'timeout' : 'apply_failed',
          detail: errorDetail(error, 'worker drain command failed'), recovery_disposition: 'retryable' }));
        startFailure = await Promise.race([
          started.result,
          sendFailure.then((failure) => failure ?? new Promise<PublicationFailure | null>(() => undefined)),
        ]);
        startedEvidence = started.message;
        if (startFailure !== null) {
          acknowledgementFailure = startFailure;
          try {
            const current = await process.drainStatus?.(Math.min(policy.drain_timeout_ms, 1_000)) ?? null;
            if (current !== null && matchesDrainStatus(current, worker, drainId, bootNonce, taskPolicy)) {
              startedEvidence = current;
              confirmedByStatus = true;
              started.fail(startFailure);
            } else {
              started.fail(startFailure);
              const completed = await completedTerminalExit(worker, scheduler, { drainId, policy: taskPolicy });
              if (completed !== null) {
                drainTasks.delete(process);
                return { worker, acknowledgementFailure: terminalFailure(completed.terminalDrain!, process.slot), exitEvidence: completed };
              }
              return { worker, acknowledgementFailure: startFailure,
                unknownStage: startFailure.code === 'timeout' ? 'exit' : 'rejected', exitEvidence: null };
            }
          } catch {
            started.fail(startFailure);
            const completed = await completedTerminalExit(worker, scheduler, { drainId, policy: taskPolicy });
            if (completed !== null) {
              drainTasks.delete(process);
              return { worker, acknowledgementFailure: terminalFailure(completed.terminalDrain!, process.slot), exitEvidence: completed };
            }
            return { worker, acknowledgementFailure: startFailure,
              unknownStage: startFailure.code === 'timeout' ? 'exit' : 'rejected', exitEvidence: null };
          }
        }
      }
      if (startedEvidence === null) {
        return { worker, acknowledgementFailure: startFailure ?? { slot: process.slot, code: 'timeout',
          detail: 'worker drain start could not be confirmed', recovery_disposition: 'retryable' },
        unknownStage: drainTask.sent ? 'exit' : 'start', exitEvidence: null };
      }
      if (!confirmedByStatus && startedEvidence.status === 'worker-draining' && process.drainStatus !== undefined) {
        try {
          const current = await process.drainStatus(Math.max(1, Math.min(startedEvidence.remaining_ms, 1_000)));
          if (current !== null && matchesDrainStatus(current, worker, drainId, bootNonce, taskPolicy)) startedEvidence = current;
        } catch {
          // The already received exact signed start message remains sufficient to wait D.
        }
      }
      if (startedEvidence.status === 'worker-drained' || startedEvidence.status === 'worker-drain-failed') {
        terminalStatus = startedEvidence;
      } else {
        remainingDrainMs = startedEvidence.remaining_ms;
        const drained = waitForDrainAck({ worker, scheduler, timeoutMs: Math.max(1, remainingDrainMs),
          drainId, bootNonce, policy: taskPolicy, phase: 'drained' });
        const drainFailure = await drained.result;
        let terminalPollTimedOut = false;
        if (drained.message?.status === 'worker-drained' || drained.message?.status === 'worker-drain-failed') {
          terminalStatus = drained.message;
        } else if (drainFailure !== null && process.drainStatus !== undefined) {
          terminalStatus = await waitForTerminalDrainStatus(worker, scheduler, drainId, bootNonce, taskPolicy,
            taskPolicy.worker_exit_timeout_ms, beforePoll);
          terminalPollTimedOut = terminalStatus === null;
        }
        if (terminalStatus === null) {
          return { worker, acknowledgementFailure: drainFailure ?? { slot: process.slot, code: 'timeout',
            detail: 'worker drain outcome is unknown; retired ownership is retained', recovery_disposition: 'retryable' },
          unknownStage: terminalPollTimedOut ? 'exit' : 'drain', exitEvidence: null };
        }
      }
      naturallyDrained = terminalStatus?.status === 'worker-drained';
      forceStopped = terminalStatus?.status === 'worker-drain-failed' && terminalStatus.http_stopped;
      if (terminalStatus?.status === 'worker-drain-failed') acknowledgementFailure = {
        slot: process.slot, code: terminalStatus.error_code === 'timeout' ? 'timeout' : 'apply_failed',
        detail: terminalStatus.error_code === 'timeout' ? 'worker drain timed out' : 'worker drain failed',
        recovery_disposition: 'retryable' };
      else if (naturallyDrained && (startFailure === null || startFailure.code === 'timeout')) acknowledgementFailure = null;
    }
    if (!naturallyDrained && !forceStopped) {
      return { worker, acknowledgementFailure: acknowledgementFailure ?? { slot: process.slot, code: 'timeout',
        detail: 'worker drain outcome is unknown; retired ownership is retained', recovery_disposition: 'retryable' },
      unknownStage: 'drain', exitEvidence: null };
    }
    if (terminalStatus === null) {
      return { worker, acknowledgementFailure: acknowledgementFailure ?? { slot: process.slot, code: 'timeout',
        detail: 'worker exit budget is exhausted or unconfirmed', recovery_disposition: 'retryable' },
      unknownStage: 'exit', exitEvidence: null };
    }
    if (terminalStatus.exit_remaining_ms <= 0) {
      const completed = await completedTerminalExit(worker, scheduler, { drainId, policy: taskPolicy });
      if (completed !== null && completed.terminalDrain?.exit_deadline_ns === terminalStatus.exit_deadline_ns) {
        const failure = terminalFailure(completed.terminalDrain, process.slot);
        drainTasks.delete(process);
        return { worker, acknowledgementFailure: failure ?? acknowledgementFailure, exitEvidence: completed };
      }
      return { worker, acknowledgementFailure: acknowledgementFailure ?? { slot: process.slot, code: 'timeout',
        detail: 'worker exit budget is exhausted or unconfirmed', recovery_disposition: 'retryable' },
      unknownStage: 'exit', exitEvidence: null };
    }
    const exitDeadline: import('./types').WorkerExitDeadlineEvidence = {
      boot_id: terminalStatus.boot_id, exit_deadline_ns: terminalStatus.exit_deadline_ns,
      exit_remaining_ms: terminalStatus.exit_remaining_ms, cleanup_state: terminalStatus.cleanup_state,
    };
    const termination = await terminateWithEscalation(process, scheduler, exitDeadline.exit_remaining_ms, 0, false,
      exitDeadline);
    const exitedTerminal = termination.exitEvidence?.terminalDrain;
    const terminalExitMatches = termination.exitEvidence !== null && exitedTerminal !== undefined
      && matchesDrainStatus(exitedTerminal, worker, drainId, bootNonce, taskPolicy)
      && exitedTerminal.exit_deadline_ns === terminalStatus.exit_deadline_ns
      && exitedTerminal.exit_remaining_ms > 0
      && exitedTerminal.cleanup_state !== 'pending';
    if (termination.exitEvidence !== null && !terminalExitMatches) {
      acknowledgementFailure = { slot: process.slot, code: 'mismatched_message',
        detail: `${acknowledgementFailure?.detail ? `${acknowledgementFailure.detail}; ` : ''}exact process exit lacks matching signed terminal cleanup evidence`,
        recovery_disposition: 'deterministic_protocol_failure' };
      return { worker, acknowledgementFailure,
        ...termination, exitEvidence: { exited: true, pid: termination.exitEvidence.pid } };
    }
    if (terminalExitMatches && exitedTerminal !== undefined) {
      acknowledgementFailure = terminalFailure(exitedTerminal, process.slot) ?? acknowledgementFailure;
    }
    if (termination.exitEvidence !== null && terminalExitMatches) drainTasks.delete(process);
    // Shutdown may race the worker's own completed cleanup and lose its HTTP
    // response. Matching signed cleanup plus exact exit supersedes that command
    // transport error; a real drain/cleanup failure remains above.
    const { terminationError: _commandError, ...confirmedTermination } = termination;
    return { worker, acknowledgementFailure, ...(terminalExitMatches ? confirmedTermination : termination) };
  }));
}

export async function drainWorkersUntilKnown(
  workers: readonly ServingConfigWorker[],
  scheduler: PublicationScheduler,
  policy: PublicationPolicy,
  beforePoll: () => void = () => undefined,
): Promise<readonly WorkerDrainEvidence[]> {
  const latest = new Map<ServingConfigWorker['process'], WorkerDrainEvidence>();
  let retry = [...workers];
  while (retry.length > 0) {
    beforePoll();
    const evidence = await drainWorkers(retry, scheduler, policy, beforePoll);
    const next: ServingConfigWorker[] = [];
    for (const item of evidence) {
      latest.set(item.worker.process, item);
      if (item.unknownStage === 'start' || item.unknownStage === 'drain') next.push(item.worker);
    }
    retry = next;
    if (retry.length > 0) await new Promise<void>((resolve) => scheduler.schedule(100, resolve));
  }
  return workers.flatMap((worker) => {
    const evidence = latest.get(worker.process);
    return evidence === undefined ? [] : [evidence];
  });
}

export function drainFailures(evidence: readonly WorkerDrainEvidence[]): readonly PublicationFailure[] {
  return evidence.flatMap(({ worker, acknowledgementFailure, terminationError, waitError, exitEvidence }) => {
    const failures: PublicationFailure[] = acknowledgementFailure === null ? [] : [acknowledgementFailure];
    if (terminationError !== undefined) failures.push({ slot: worker.process.slot, code: 'apply_failed',
      detail: errorDetail(terminationError, 'worker termination failed'), recovery_disposition: 'retryable' });
    if (waitError !== undefined) failures.push({ slot: worker.process.slot, code: 'apply_failed',
      detail: errorDetail(waitError, 'worker exit evidence unavailable'), recovery_disposition: 'retryable' });
    if (exitEvidence === null) failures.push({ slot: worker.process.slot, code: 'timeout',
      detail: 'worker exit unconfirmed', recovery_disposition: 'retryable' });
    return failures;
  });
}

export function allDrainExitsConfirmed(evidence: readonly WorkerDrainEvidence[]): boolean {
  return evidence.every(({ exitEvidence }) => exitEvidence !== null
    && exitEvidence.terminalDrain !== undefined && exitEvidence.terminalDrain.cleanup_state !== 'pending');
}
