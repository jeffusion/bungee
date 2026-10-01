import { logger } from '../logger';
import { serializeErrorChain, type SafeErrorChain } from './error-chain';

export const SHUTDOWN_DIAGNOSTIC_MESSAGE = 'Shutdown step failed';
export const SHUTDOWN_STAGES = [
  'management_listener', 'control_listener', 'background_tasks', 'before_stop',
  'exit_subscription', 'plugin_subscriptions', 'plugin_bridge', 'plugin_control',
  'stats', 'publication_tasks', 'repair_tasks', 'startup_ingress', 'startup_workers',
  'admission', 'worker_snapshot', 'worker_shutdown', 'ingress_shutdown',
  'repository', 'instance_lock', 'worker_exit_probe', 'ingress_exit_probe', 'process_identity_probe',
  'daemon_metadata_stopping', 'daemon_metadata_cleanup',
] as const;
export type ShutdownStage = typeof SHUTDOWN_STAGES[number];

export type ShutdownEvidence = {
  readonly elapsedMs?: number;
  readonly timeoutMs?: number;
  readonly lifecycle?: 'normal_shutdown' | 'startup_failure';
  readonly pid?: number;
  readonly origin?: 'spawned' | 'adopted';
  readonly capturedIdentity?: boolean;
  readonly lastProbe?: 'exact' | 'dead' | 'mismatch' | 'unknown' | 'not_run' | 'threw';
  readonly probeAttempts?: number;
  readonly deadlineExceeded?: boolean;
  readonly commandOutcome?: 'accepted' | 'failed';
  readonly expectedWorkers?: number;
  readonly confirmedWorkers?: number;
  readonly unconfirmedPids?: readonly number[];
};
export type ShutdownDiagnostic = ShutdownEvidence & {
  readonly stage: ShutdownStage;
  readonly reporterPid?: number;
  readonly error?: SafeErrorChain;
};

export function shutdownElapsedMs(startedAt: number): number {
  return Math.min(3_600_000, Math.max(0, Math.round(performance.now() - startedAt)));
}

/** Diagnostics are best-effort and never replace the original cleanup result. */
export function recordShutdownFailure(stage: ShutdownStage, evidence: ShutdownEvidence, error?: unknown): void {
  try {
    logger.error({ shutdown: { stage, ...evidence, reporterPid: process.pid, ...(error === undefined ? {} : { error: serializeErrorChain(error) }) } }, SHUTDOWN_DIAGNOSTIC_MESSAGE);
  } catch { /* logging must not interrupt later cleanup or change exit evidence */ }
}

// CI consumes the same bounded fields, rather than copying arbitrary log metadata.
// Reconstruct only Error's known fields to reuse the production redaction contract.
function errorFromRecord(value: unknown, depth = 0, budget = { remaining: 32 }): Error {
  if (depth >= 5 || budget.remaining-- <= 0 || value === null || typeof value !== 'object') return new Error('[truncated]');
  const record = value as Record<string, unknown>;
  const message = typeof record.message === 'string' ? record.message.slice(0, 512) : 'unknown error';
  const error = Array.isArray(record.errors)
    ? new AggregateError(record.errors.slice(0, Math.min(8, Math.max(0, budget.remaining))).map(item => errorFromRecord(item, depth + 1, budget)), message)
    : new Error(message);
  if (typeof record.name === 'string') error.name = record.name.slice(0, 64);
  if (typeof record.stack === 'string') error.stack = record.stack.slice(0, 512);
  else error.stack = undefined;
  if (typeof record.code === 'string') Object.assign(error, { code: record.code });
  if (record.cause !== undefined) error.cause = errorFromRecord(record.cause, depth + 1, budget);
  return error;
}

export function readShutdownDiagnostic(value: unknown): ShutdownDiagnostic | null {
  if (value === null || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (!(SHUTDOWN_STAGES as readonly unknown[]).includes(source.stage)) return null;
  const result: Record<string, unknown> = { stage: source.stage };
  for (const key of ['elapsedMs', 'timeoutMs', 'pid', 'reporterPid', 'probeAttempts', 'expectedWorkers', 'confirmedWorkers'] as const) {
    const number = source[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 && number <= 2_147_483_647) result[key] = number;
  }
  for (const key of ['capturedIdentity', 'deadlineExceeded'] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  for (const [key, allowed] of [
    ['lifecycle', ['normal_shutdown', 'startup_failure']],
    ['origin', ['spawned', 'adopted']],
    ['lastProbe', ['exact', 'dead', 'mismatch', 'unknown', 'not_run', 'threw']],
    ['commandOutcome', ['accepted', 'failed']],
  ] as const) {
    if ((allowed as readonly unknown[]).includes(source[key])) result[key] = source[key];
  }
  if (Array.isArray(source.unconfirmedPids)) {
    result.unconfirmedPids = source.unconfirmedPids.filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647).slice(0, 16);
  }
  if (source.error !== undefined) result.error = serializeErrorChain(errorFromRecord(source.error));
  return result as ShutdownDiagnostic;
}
