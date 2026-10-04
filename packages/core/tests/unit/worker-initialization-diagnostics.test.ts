import { expect, test } from 'bun:test';
import { logger } from '../../src/logger';
import {
  readWorkerInitializationDiagnostic,
  recordWorkerInitializationFailure,
  WORKER_INITIALIZATION_DIAGNOSTIC_MESSAGE,
  type WorkerInitializationDiagnostic,
} from '../../src/master-runtime/worker-initialization-diagnostics';

const evidence = { phase: 'os_identity_capture', pid: 42, origin: 'spawned', elapsedMs: 30000 } as const;

test('initialization diagnostics observe bounded enum fields without reading private error content', () => {
  const records: WorkerInitializationDiagnostic[] = [];
  const original = logger.error;
  logger.error = ((context: any, message?: string) => {
    expect(message).toBe(WORKER_INITIALIZATION_DIAGNOSTIC_MESSAGE);
    records.push(context.initialization);
  }) as typeof logger.error;
  const cause: Record<string, unknown> = { name: 'Error', code: 'EACCES' };
  cause.cause = cause;
  const error = { name: 'ProcessIdentityUnavailableError', cause };
  for (const target of [error, cause]) {
    for (const key of ['message', 'stack', 'argv', 'stdout', 'stderr']) {
      Object.defineProperty(target, key, { get() { throw new Error('private field was read'); } });
    }
  }
  try {
    recordWorkerInitializationFailure(evidence, error);
    expect(records).toEqual([{ ...evidence, reporterPid: process.pid, errorType: 'ProcessIdentityUnavailableError', errorCode: 'EACCES' }]);
    expect(readWorkerInitializationDiagnostic(records[0])).toEqual(records[0]);
  } finally { logger.error = original; }
});

test('initialization diagnostics discard unknown names, codes, extra metadata and throwing getters', () => {
  const records: WorkerInitializationDiagnostic[] = [];
  const original = logger.error;
  logger.error = ((context: any) => { records.push(context.initialization); }) as typeof logger.error;
  try {
    recordWorkerInitializationFailure(evidence, { name: 'SECRET-TOKEN', code: '/private/path', cause: null });
    recordWorkerInitializationFailure(evidence, { get name() { throw new Error('private'); } });
    expect(records).toHaveLength(2);
    for (const record of records) expect(record).toMatchObject({ errorType: 'unknown', errorCode: 'unknown' });
    expect(JSON.stringify(records)).not.toContain('SECRET');
    expect(JSON.stringify(records)).not.toContain('private');
    expect(readWorkerInitializationDiagnostic({ ...(records[0] as object), message: 'SECRET-TOKEN' })).toEqual(records[0]);
    expect(readWorkerInitializationDiagnostic({ ...(records[0] as object), phase: 'SECRET-TOKEN' })).toBeNull();
    expect(readWorkerInitializationDiagnostic({ ...(records[0] as object), pid: -1 })).toBeNull();
    expect(readWorkerInitializationDiagnostic({ ...(records[0] as object), elapsedMs: NaN })).toBeNull();
    expect(readWorkerInitializationDiagnostic({ ...(records[0] as object), errorCode: 'SECRET-TOKEN' })).toBeNull();
    expect(readWorkerInitializationDiagnostic({ get phase() { throw new Error('private'); } })).toBeNull();
    let reads = 0;
    const changing = { ...(records[0] as object), get phase() { return ++reads === 1 ? 'os_identity_capture' : 'SECRET-TOKEN'; } };
    expect(readWorkerInitializationDiagnostic(changing)?.phase).toBe('os_identity_capture');
    expect(reads).toBe(1);
  } finally { logger.error = original; }
});

test('initialization diagnostics never throw when the logger fails', () => {
  const original = logger.error;
  logger.error = (() => { throw new Error('logger unavailable'); }) as typeof logger.error;
  try { expect(() => recordWorkerInitializationFailure(evidence, new Error('private'))).not.toThrow(); }
  finally { logger.error = original; }
});
