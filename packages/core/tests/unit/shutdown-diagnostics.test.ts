import { expect, test } from 'bun:test';
import { logger } from '../../src/logger';
import { readShutdownDiagnostic, recordShutdownFailure, SHUTDOWN_DIAGNOSTIC_MESSAGE } from '../../src/master-runtime/shutdown-diagnostics';

test('shutdown evidence keeps the direct failure chain and redacts credential fields', () => {
  const calls: Array<{ context: any; message?: string }> = [];
  const original = logger.error;
  logger.error = ((context: any, message?: string) => { calls.push({ context, message }); }) as typeof logger.error;
  const leaf = Object.assign(new Error('process query failed shutdown_secret=hidden'), { code: 'EACCES' });
  try {
    recordShutdownFailure('worker_exit_probe', { pid: 42, origin: 'adopted', lastProbe: 'unknown', probeAttempts: 1 }, new Error('worker verification failed', { cause: leaf }));
  } finally { logger.error = original; }
  expect(calls).toHaveLength(1);
  expect(calls[0]?.message).toBe(SHUTDOWN_DIAGNOSTIC_MESSAGE);
  const diagnostic = readShutdownDiagnostic(calls[0]?.context.shutdown);
  expect(diagnostic).toMatchObject({ stage: 'worker_exit_probe', pid: 42, origin: 'adopted', lastProbe: 'unknown', probeAttempts: 1,
    error: { message: 'worker verification failed', cause: { code: 'EACCES', message: 'process query failed shutdown_secret=[REDACTED]' } } });
  expect(JSON.stringify(diagnostic)).not.toContain('hidden');
});

test('diagnostic logging cannot change cleanup when its transport throws', () => {
  const original = logger.error;
  logger.error = (() => { throw new Error('log transport failed'); }) as typeof logger.error;
  try { expect(() => recordShutdownFailure('repository', {}, new Error('close failed'))).not.toThrow(); }
  finally { logger.error = original; }
});

test('CI evidence rejects arbitrary fields, bounds arrays and reapplies error redaction', () => {
  const diagnostic = readShutdownDiagnostic({
    stage: 'worker_shutdown', elapsedMs: Infinity, pid: -1, probeAttempts: 1.5,
    origin: 'secret-origin', lastProbe: 'secret-probe', commandOutcome: 'secret-command',
    expectedWorkers: 20, confirmedWorkers: 2, unconfirmedPids: Array.from({ length: 40 }, (_, i) => i + 1),
    authorization: 'secret-field', argv: ['secret-argument'],
    error: { name: 'Error', message: 'authorization=Bearer secret-token', stack: 'secret=secret-stack', cause: { message: 'access_token=secret-cause' }, environment: 'secret-env' },
  });
  expect(diagnostic?.unconfirmedPids).toHaveLength(16);
  expect(diagnostic).toMatchObject({ stage: 'worker_shutdown', expectedWorkers: 20, confirmedWorkers: 2,
    error: { message: expect.stringContaining('authorization=[REDACTED]'), stack: 'secret=[REDACTED]', cause: { message: 'access_token=[REDACTED]' } } });
  for (const key of ['elapsedMs', 'pid', 'probeAttempts', 'origin', 'lastProbe', 'commandOutcome', 'authorization', 'argv']) expect(diagnostic).not.toHaveProperty(key);
  for (const value of ['secret-token', 'secret-stack', 'secret-cause', 'secret-env']) expect(JSON.stringify(diagnostic)).not.toContain(value);
  expect(readShutdownDiagnostic({ stage: 'arbitrary-secret' })).toBeNull();
});
