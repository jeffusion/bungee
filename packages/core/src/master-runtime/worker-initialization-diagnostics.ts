import { logger } from '../logger';

export const WORKER_INITIALIZATION_DIAGNOSTIC_MESSAGE = 'Worker initialization failed';
const PHASES = ['kernel_clock', 'descriptor_read', 'descriptor_validation', 'os_identity_capture', 'control_attach', 'adapter_stopped'] as const;
export type WorkerInitializationPhase = typeof PHASES[number];
const ERROR_TYPES = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'ProcessIdentityUnavailableError', 'ProcessIdentityMissingError', 'SupervisionProtocolError', 'unknown'] as const;
const ERROR_CODES = ['ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'EIO', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'timeout', 'cancelled', 'invalid_mac', 'identity_mismatch', 'malformed_message', 'unattached_controller', 'stale_controller', 'sequence_replay', 'challenge_expired', 'status_correlation_mismatch', 'unknown'] as const;
export type WorkerInitializationDiagnostic = Readonly<{
  phase: WorkerInitializationPhase;
  pid: number;
  reporterPid: number;
  origin: 'spawned' | 'adopted';
  elapsedMs: number;
  errorType: typeof ERROR_TYPES[number];
  errorCode: typeof ERROR_CODES[number];
}>;

// Only enum-valued names/codes are observed. Messages, stacks, argv and output
// are never read, including in nested causes. A hostile getter is not a failure.
function classify(error: unknown): Pick<WorkerInitializationDiagnostic, 'errorType' | 'errorCode'> {
  let errorType: WorkerInitializationDiagnostic['errorType'] = 'unknown';
  let errorCode: WorkerInitializationDiagnostic['errorCode'] = 'unknown';
  try {
    for (let depth = 0; depth < 4 && error !== null && typeof error === 'object'; depth++) {
      const record = error as { readonly name?: unknown; readonly code?: unknown; readonly cause?: unknown };
      const name = record.name;
      const code = record.code;
      if (errorType === 'unknown' && (ERROR_TYPES as readonly unknown[]).includes(name)) errorType = name as typeof errorType;
      if (errorCode === 'unknown' && (ERROR_CODES as readonly unknown[]).includes(code)) errorCode = code as typeof errorCode;
      error = record.cause;
    }
  } catch { /* retain only fields already checked against the allowlists */ }
  return { errorType, errorCode };
}

/** One best-effort record on final initialization failure, never on retries. */
export function recordWorkerInitializationFailure(
  evidence: Omit<WorkerInitializationDiagnostic, 'reporterPid' | 'errorType' | 'errorCode'>,
  error: unknown,
): void {
  try {
    const initialization = readWorkerInitializationDiagnostic({
      phase: evidence.phase, pid: evidence.pid, origin: evidence.origin, elapsedMs: evidence.elapsedMs,
      reporterPid: process.pid, ...classify(error),
    });
    if (initialization !== null) logger.error({ initialization }, WORKER_INITIALIZATION_DIAGNOSTIC_MESSAGE);
  } catch { /* preserve the original rejection even if logging is unavailable */ }
}

export function readWorkerInitializationDiagnostic(value: unknown): WorkerInitializationDiagnostic | null {
  try {
    if (value === null || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const { phase, origin, errorType, errorCode } = record;
    if (!(PHASES as readonly unknown[]).includes(phase)
      || !['spawned', 'adopted'].includes(origin as string)
      || !(ERROR_TYPES as readonly unknown[]).includes(errorType)
      || !(ERROR_CODES as readonly unknown[]).includes(errorCode)) return null;
    const numbers: Record<string, number> = {};
    for (const key of ['pid', 'reporterPid', 'elapsedMs'] as const) {
      const number = record[key];
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < (key === 'elapsedMs' ? 0 : 1) || number > 2_147_483_647) return null;
      numbers[key] = number;
    }
    return {
      phase: phase as WorkerInitializationPhase,
      origin: origin as WorkerInitializationDiagnostic['origin'],
      errorType: errorType as WorkerInitializationDiagnostic['errorType'],
      errorCode: errorCode as WorkerInitializationDiagnostic['errorCode'],
      pid: numbers.pid!, reporterPid: numbers.reporterPid!, elapsedMs: numbers.elapsedMs!,
    };
  } catch { return null; }
}
