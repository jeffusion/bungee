import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { ConfigRepository, ConfigRepositoryError, hashConfigurationContent, hashConfigurationRequest,
  type ConfigRepositoryOptions } from '../../src/config-storage';
import { CONFIG_MIGRATION_V1 } from '../../src/config-storage/migrations/v1';
import { CONFIG_MIGRATION_V2 } from '../../src/config-storage/migrations/v2';
import { CONFIG_MIGRATION_V3 } from '../../src/config-storage/migrations/v3';
import { CONFIG_MIGRATION_V4 } from '../../src/config-storage/migrations/v4';
import { CONFIG_MIGRATION_V5 } from '../../src/config-storage/migrations/v5';
import { CONFIG_MIGRATION_V6 } from '../../src/config-storage/migrations/v6';
import { CONFIG_MIGRATION_V7 } from '../../src/config-storage/migrations/v7';
import { CONFIG_MIGRATION_V8 } from '../../src/config-storage/migrations/v8';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

const ROOTS: string[] = [];
const REPOSITORIES: ConfigRepository[] = [];
const NOW = 1_700_000_000_000;
const AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [],
};

function open(options: ConfigRepositoryOptions = {}): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-recovery-store-'));
  ROOTS.push(root);
  const dbPath = join(root, 'config.db');
  const repository = ConfigRepository.open(dbPath, options);
  REPOSITORIES.push(repository);
  return { repository, dbPath };
}

function commit(repository: ConfigRepository, mutationId: string, revision = 1, slots: readonly number[] = [0]): void {
  expect(repository.commit({ mutation_id: mutationId, expected_revision: revision, aggregate: AGGREGATE,
    kind: 'config', created_at: NOW + revision, target_worker_slots: slots }).kind).toBe('committed');
}

function replacementFailure(repository: ConfigRepository, mutationId: string): void {
  commit(repository, mutationId);
  repository.beginPublication(mutationId, NOW + 2);
  repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', NOW + 3);
  repository.recordWorkerResult(mutationId, 0, { kind: 'failed', attempt_no: 1, error: 'worker rejected' }, NOW + 4);
  repository.finalizePublication(mutationId, {
    outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'worker rejected', recovery_disposition: 'retryable',
  }, NOW + 5);
}

function expectRecoveryError(action: () => unknown, code: ConfigRepositoryError['code']): void {
  let error: unknown;
  try { action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigRepositoryError);
  if (error instanceof ConfigRepositoryError) expect(error.code).toBe(code);
}

type RaceAction = 'commit' | 'manual';
type RaceNegative = 'extra' | 'terminal-before-start' | 'eof-residual' | 'duplicate-after-error';
type RaceCause = { readonly code: string; readonly message: string; readonly cause: RaceCause | null };
type RaceError = {
  readonly phase: 'open' | 'action' | 'protocol';
  readonly code: string;
  readonly message: string;
  readonly cause: RaceCause | null;
};
type RaceResult =
  | { readonly kind: 'committed'; readonly revision: number }
  | { readonly kind: 'manual'; readonly state: string; readonly recovery_id: string };
type RaceMessage =
  | { readonly phase: 'ready'; readonly child: string; readonly action: RaceAction }
  | { readonly phase: 'result'; readonly child: string; readonly action: RaceAction;
      readonly result: RaceResult }
  | { readonly phase: 'error'; readonly child: string; readonly action: RaceAction; readonly error: RaceError };
type RaceChild = {
  readonly identity: string;
  readonly action: RaceAction;
  readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly ready: Promise<RaceMessage>;
  readonly terminal: Promise<RaceMessage>;
  readonly stdoutDone: Promise<void>;
  readonly stderrDone: Promise<string>;
  readonly markStartSent: () => void;
};

const RACE_CHILD_WAIT_MS = 5_000;
const RACE_CHILD = `
  const { ConfigRepository } = await import('./src/config-storage/index.ts');
  const identity = process.env.BUNGEE_RACE_CHILD;
  const action = process.env.BUNGEE_RACE_ACTION;
  const dbPath = process.env.BUNGEE_RACE_DB;
  const source = process.env.BUNGEE_RACE_SOURCE;
  const mutation = process.env.BUNGEE_RACE_MUTATION;
  const recoveryId = process.env.BUNGEE_RACE_ID;
  const negative = process.env.BUNGEE_RACE_NEGATIVE;
  const aggregate = { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] };
  let repository;
  let started = false;
  let terminal = false;
  let buffer = '';
  let protocolFailed = false;
  let actionFailed = false;

  function describe(error) {
    if (error !== null && typeof error === 'object') {
      const value = error;
      const cause = value.cause === undefined ? null : describe(value.cause);
      return { code: typeof value.code === 'string' ? value.code : 'unknown',
        message: typeof value.message === 'string' ? value.message : String(value), cause };
    }
    return { code: 'unknown', message: String(error), cause: null };
  }

  function emit(message) { process.stdout.write(JSON.stringify({ child: identity, action, ...message }) + '\\n'); }
  function fail(phase, error, exitCode = 1) {
    if (phase === 'action') {
      if (actionFailed) return;
      actionFailed = true;
    } else {
      if (protocolFailed) return;
      protocolFailed = true;
    }
    terminal = true;
    emit({ phase: 'error', error: { phase, ...describe(error) } });
    repository?.close();
    process.exitCode = exitCode;
  }
  function actionFailure(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
  function runAction() {
    if (negative === 'extra' || negative === 'eof-residual') {
      emit({ phase: 'result', result: { kind: 'committed', revision: 3 } });
      if (negative === 'extra') process.stdout.write('not-json\\n');
      return;
    }
    if (negative === 'duplicate-after-error') {
      actionFailure('synthetic_action_failure', 'synthetic action failure');
      return;
    }
    if (action === 'commit') {
      const result = repository.commit({ mutation_id: mutation, expected_revision: 2, aggregate,
        kind: 'config', created_at: 1700000000007, target_worker_slots: [0] });
      if (result.kind !== 'committed') actionFailure(result.kind, 'commit did not win');
      emit({ phase: 'result', result: { kind: 'committed', revision: result.snapshot.revision } });
      return;
    }
    if (action === 'manual') {
      const result = repository.createManualRecovery(recoveryId, source, 2, 1700000000007);
      emit({ phase: 'result', result: { kind: 'manual', state: result.state, recovery_id: result.recovery_id } });
      return;
    }
    actionFailure('invalid_action', 'unsupported race action');
  }
  function handleLine(line) {
    let command;
    try { command = JSON.parse(line); } catch (error) { fail('protocol', error); return; }
    if (started) { fail('protocol', Object.assign(new Error('duplicate start'), { code: 'duplicate_start' })); return; }
    if (command === null || typeof command !== 'object' || command.phase !== 'start'
      || Object.keys(command).sort().join('\\0') !== 'action\\0child\\0phase'
      || command.child !== identity || command.action !== action) {
      fail('protocol', Object.assign(new Error('invalid start'), { code: 'invalid_start' })); return;
    }
    started = true;
    try { runAction(); terminal = true; }
    catch (error) { terminal = true; fail('action', error, 0); }
  }
  try {
    if (typeof identity !== 'string' || (action !== 'commit' && action !== 'manual') || typeof dbPath !== 'string') {
      throw Object.assign(new Error('race child environment is invalid'), { code: 'invalid_environment' });
    }
    repository = ConfigRepository.open(dbPath);
  } catch (error) {
    fail('open', error);
  }
  if (!protocolFailed) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) handleLine(line);
        newline = buffer.indexOf('\\n');
      }
    });
    process.stdin.on('end', () => {
      if (buffer.trim().length > 0) fail('protocol', Object.assign(new Error('stdin ended with residual data'), { code: 'eof_with_buffer' }));
      else if (!started) fail('protocol', Object.assign(new Error('stdin ended before start'), { code: 'eof_before_start' }));
      else if (!terminal) fail('protocol', Object.assign(new Error('stdin ended before result'), { code: 'eof_before_result' }));
      else repository?.close();
    });
    emit({ phase: 'ready' });
    if (negative === 'terminal-before-start') {
      terminal = true;
      emit({ phase: 'result', result: { kind: 'committed', revision: 3 } });
    }
  }
`;

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isRaceCause(value: unknown): value is RaceCause {
  return value === null || (isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string'
    && 'cause' in value && isRaceCause(value.cause));
}

function isRaceError(value: unknown): value is RaceError {
  return isRecord(value)
    && (value.phase === 'open' || value.phase === 'action' || value.phase === 'protocol')
    && typeof value.code === 'string' && typeof value.message === 'string' && isRaceCause(value.cause);
}

function parseRaceMessage(value: unknown, identity: string, action: RaceAction, first: boolean): RaceMessage {
  if (!isRecord(value) || value.child !== identity || value.action !== action) {
    throw new Error(`race child identity mismatch: ${JSON.stringify(value)}`);
  }
  if (first) {
    if (value.phase === 'error') {
      if (!exactKeys(value, ['phase', 'child', 'action', 'error']) || !isRaceError(value.error)) {
        throw new Error(`invalid race error: ${JSON.stringify(value)}`);
      }
      return value as RaceMessage;
    }
    if (!exactKeys(value, ['phase', 'child', 'action']) || value.phase !== 'ready') {
      throw new Error(`race child did not become ready: ${JSON.stringify(value)}`);
    }
    return value as RaceMessage;
  }
  if (value.phase === 'result') {
    if (!exactKeys(value, ['phase', 'child', 'action', 'result']) || !isRecord(value.result)
      || (value.result.kind === 'committed'
        && (!exactKeys(value.result, ['kind', 'revision']) || typeof value.result.revision !== 'number'))
      || (value.result.kind === 'manual'
        && (!exactKeys(value.result, ['kind', 'state', 'recovery_id'])
          || typeof value.result.state !== 'string' || typeof value.result.recovery_id !== 'string'))
      || (value.result.kind !== 'committed' && value.result.kind !== 'manual')) {
      throw new Error(`invalid race result: ${JSON.stringify(value)}`);
    }
    return value as RaceMessage;
  }
  if (value.phase === 'error') {
    if (!exactKeys(value, ['phase', 'child', 'action', 'error']) || !isRaceError(value.error)) {
      throw new Error(`invalid race error: ${JSON.stringify(value)}`);
    }
    return value as RaceMessage;
  }
  throw new Error(`race child emitted an unexpected terminal phase: ${JSON.stringify(value)}`);
}

async function consumeRaceLines(
  stream: ReadableStream<Uint8Array>, onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstError: unknown;
  let readError: unknown;
  try {
    while (true) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        readError = error;
        break;
      }
      if (chunk.done) break;
      if (firstError !== undefined) continue;
      try {
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) onLine(line);
          newline = buffer.indexOf('\n');
        }
      } catch (error) {
        firstError = error;
      }
    }
    if (firstError === undefined && readError === undefined) {
      try {
        buffer += decoder.decode();
        if (buffer.trim().length > 0) onLine(buffer.trim());
      } catch (error) {
        firstError = error;
      }
    }
    if (firstError !== undefined) {
      if (readError !== undefined) {
        throw new AggregateError([firstError, readError], 'race stdout protocol error while draining', { cause: firstError });
      }
      throw firstError;
    }
    if (readError !== undefined) throw readError;
  } finally {
    reader.releaseLock();
  }
}

function raceErrorText(message: RaceMessage): string {
  if (message.phase !== 'error') return 'unknown race child error';
  const cause = message.error.cause === null ? ''
    : ` cause=${message.error.cause.code}:${message.error.cause.message}`;
  return `race child ${message.child} ${message.error.phase} error ${message.error.code}: ${message.error.message}${cause}`;
}

function spawnRaceChild(
  dbPath: string, action: RaceAction, source: string, mutation: string, recoveryId: string, identity: string,
  negative?: RaceNegative,
): RaceChild {
  const child = Bun.spawn([process.execPath, '-e', RACE_CHILD], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe', stdin: 'pipe',
    env: { BUNGEE_RACE_DB: dbPath, BUNGEE_RACE_ACTION: action, BUNGEE_RACE_SOURCE: source,
      BUNGEE_RACE_MUTATION: mutation, BUNGEE_RACE_ID: recoveryId, BUNGEE_RACE_CHILD: identity,
      BUNGEE_RACE_NEGATIVE: negative ?? '' },
  });
  const ready = deferred<RaceMessage>();
  const terminal = deferred<RaceMessage>();
  let startSent = false;
  let sequence = 0;
  let protocolError: Error | undefined;
  const failProtocol = (error: unknown): void => {
    if (protocolError !== undefined) return;
    protocolError = error instanceof Error ? error : new Error(String(error));
    ready.reject(protocolError);
    terminal.reject(protocolError);
  };
  const stdoutDone = consumeRaceLines(child.stdout, (line) => {
    const message = parseRaceMessage(JSON.parse(line), identity, action, sequence === 0);
    if (sequence === 0) ready.resolve(message);
    else if (sequence === 1) {
      if (!startSent) throw Object.assign(new Error(`race child emitted terminal before start was sent: ${line}`), { code: 'terminal_before_start' });
      terminal.resolve(message);
    } else throw Object.assign(new Error(`race child emitted too many messages: ${line}`), { code: 'extra_message' });
    sequence += 1;
  }).then(() => {
    if (sequence !== 2) throw new Error(`race child message sequence ended at ${sequence}`);
  }).catch((error) => {
    failProtocol(error);
    throw error;
  });
  const stderrDone = new Response(child.stderr).text();
  void stdoutDone.catch(() => undefined);
  void stderrDone.catch(() => undefined);
  void ready.promise.catch(() => undefined);
  void terminal.promise.catch(() => undefined);
  return { identity, action, process: child, ready: ready.promise, terminal: terminal.promise, stdoutDone, stderrDone,
    markStartSent: () => { startSent = true; } };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), RACE_CHILD_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function sendRaceInput(child: RaceChild, input: string): Promise<void> {
  child.process.stdin.write(input);
  child.markStartSent();
  await bounded(Promise.resolve(child.process.stdin.flush()), `${child.identity} start send`);
  child.process.stdin.end();
}

async function sendRaceStart(child: RaceChild): Promise<void> {
  await sendRaceInput(child, `${JSON.stringify({ phase: 'start', child: child.identity, action: child.action })}\n`);
}

function activeRecoveryCount(repository: ConfigRepository): number {
  return repository['db'].query<{ readonly count: number }, []>(
    "SELECT count(*) AS count FROM configuration_recoveries WHERE state IN ('scheduled','running')",
  ).get()?.count ?? -1;
}

async function runRaceRound(
  repository: ConfigRepository, dbPath: string, actions: readonly RaceAction[], source: string,
  mutation: string, recoveryId: string, round: number,
): Promise<readonly {
  readonly identity: string; readonly action: RaceAction; readonly ok: boolean; readonly kind?: string; readonly code?: string;
  readonly revision?: number; readonly recovery_id?: string;
}[]> {
  const children: RaceChild[] = [];
  let originalError: unknown;
  try {
    for (const [index, action] of actions.entries()) {
      const child = spawnRaceChild(dbPath, action, source, mutation, recoveryId, `race-${round}-${index}`);
      children.push(child);
      const ready = await bounded(child.ready, `${child.identity} ready`);
      if (ready.phase === 'error') throw new Error(raceErrorText(ready));
    }
    expect(repository.getSnapshot().revision).toBe(2);
    expect(repository.getOperation(mutation)).toBeNull();
    expect(repository.getRecovery(recoveryId)).toBeNull();
    expect(repository.getCurrentRecovery()).toMatchObject({ source_mutation_id: source, trigger: 'automatic', state: 'stopped' });
    expect(activeRecoveryCount(repository)).toBe(0);
    await Promise.all(children.map((child) => sendRaceStart(child)));
    const observations = await Promise.all(children.map(async (child) => {
      const [message, exitCode, stdout, stderr] = await Promise.all([
        bounded(child.terminal, `${child.identity} result`),
        bounded(child.process.exited, `${child.identity} exit`),
        bounded(child.stdoutDone, `${child.identity} stdout close`),
        bounded(child.stderrDone, `${child.identity} stderr close`).catch((error) => {
          throw new Error(`${child.identity} stderr read failed`, { cause: error });
        }),
      ]);
      if (exitCode !== 0) throw new Error(`${child.identity} exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`);
      if (stderr.trim().length > 0) throw new Error(`${child.identity} wrote stderr: ${stderr.trim()}`);
      if (message.phase === 'error') {
        if (message.error.phase === 'open' || message.error.code === 'repository_failure') throw new Error(raceErrorText(message));
        return { identity: child.identity, action: child.action, ok: false, code: message.error.code };
      }
      if (message.phase !== 'result') throw new Error(`invalid race terminal message: ${JSON.stringify(message)}`);
      return { identity: child.identity, action: child.action, ok: true, kind: message.result.kind,
        revision: message.result.kind === 'committed' ? message.result.revision : undefined,
        recovery_id: message.result.kind === 'manual' ? message.result.recovery_id : undefined };
    }));
    return observations;
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const child of children) {
      if (child.process.exitCode === null) {
        try { child.process.kill(); } catch (error) { cleanupErrors.push(error); }
      }
    }
    await Promise.all(children.map(async (child) => {
      try { await bounded(child.process.exited, `${child.identity} cleanup exit`); } catch (error) { cleanupErrors.push(error); }
      try { await bounded(child.stdoutDone, `${child.identity} cleanup stdout close`); } catch (error) { cleanupErrors.push(error); }
      try { await bounded(child.stderrDone, `${child.identity} cleanup stderr close`); } catch (error) { cleanupErrors.push(error); }
    }));
    if (originalError === undefined && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'race child cleanup failed');
  }
}

async function expectNegativeRaceCase(negative: RaceNegative): Promise<void> {
  const { dbPath } = open();
  const child = spawnRaceChild(dbPath, 'commit', 'negative-source', 'negative-mutation',
    'abababab-abab-4bab-8bab-000000000000', `negative-${negative}`, negative);
  let originalError: unknown;
  try {
    const ready = await bounded(child.ready, `${child.identity} ready`);
    expect(ready.phase).toBe('ready');
    const startedAt = performance.now();
    let stdoutError: unknown;
    if (negative === 'terminal-before-start') {
      child.process.stdin.end();
      stdoutError = await captureNegativeProtocolError(
        bounded(child.stdoutDone, `${child.identity} stdout close`), negative, 'Error', /terminal before start/, 'terminal_before_start',
      );
    } else {
      const start = `${JSON.stringify({ phase: 'start', child: child.identity, action: child.action })}\n`;
      const input = negative === 'eof-residual' ? `${start}residual`
        : negative === 'duplicate-after-error' ? `${start}${start}` : start;
      await sendRaceInput(child, input);
      stdoutError = await captureNegativeProtocolError(
        bounded(child.stdoutDone, `${child.identity} stdout close`), negative,
        negative === 'extra' ? 'SyntaxError' : 'Error',
        negative === 'extra' ? /JSON|Unexpected token/ : /too many messages.*(?:eof_with_buffer|duplicate_start)/,
        negative === 'extra' ? undefined : 'extra_message',
      );
    }
    const exitCode = await bounded(child.process.exited, `${child.identity} exit`);
    expect(exitCode).toBe(negative === 'extra' ? 0 : 1);
    if (!(stdoutError instanceof Error)) throw new Error(`${negative} produced a non-Error rejection`);
    expect(Number.isFinite(performance.now() - startedAt)).toBe(true);
    console.log(`[negative:${negative}] ${stdoutError.name} ${stdoutError.message} code=${'code' in stdoutError ? String(stdoutError.code) : '(none)'} elapsed_ms=${(performance.now() - startedAt).toFixed(1)}`);
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (child.process.exitCode === null) {
      try { child.process.kill(); } catch (error) { cleanupErrors.push(error); }
    }
    try { await bounded(child.process.exited, `${child.identity} cleanup exit`); } catch (error) { cleanupErrors.push(error); }
    try { await bounded(child.stdoutDone, `${child.identity} cleanup stdout close`); } catch { /* expected negative parser rejection */ }
    try { await bounded(child.stderrDone, `${child.identity} cleanup stderr close`); } catch (error) { cleanupErrors.push(error); }
    if (originalError === undefined && cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'negative race cleanup failed');
  }
}

async function captureNegativeProtocolError(
  promise: Promise<unknown>, negative: RaceNegative, name: string, message: RegExp, code?: string,
): Promise<unknown> {
  let error: unknown;
  try {
    await promise;
    throw new Error(`${negative} stdout completed without a protocol error`);
  } catch (caught) {
    error = caught;
  }
  if (!(error instanceof Error)) throw new Error(`${negative} rejected with a non-Error`, { cause: error });
  if (/timed out/i.test(error.message)) throw new Error(`${negative} protocol check timed out`, { cause: error });
  expect(error.name).toBe(name);
  expect(error.message).toMatch(message);
  if (code !== undefined) expect('code' in error ? error.code : undefined).toBe(code);
  return error;
}

function v8Fixture(errorCode: 'replacement_convergence_failed' | 'control_readiness_failed' | 'old_worker_drain_failed' | null): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-recovery-v8-'));
  ROOTS.push(root);
  const dbPath = join(root, 'config.db');
  const db = new Database(dbPath, { create: true, readwrite: true, strict: true });
  db.transaction(() => {
    CONFIG_MIGRATION_V1.up(db); CONFIG_MIGRATION_V2.up(db); CONFIG_MIGRATION_V3.up(db); CONFIG_MIGRATION_V4.up(db);
    CONFIG_MIGRATION_V5.up(db); CONFIG_MIGRATION_V6.up(db); CONFIG_MIGRATION_V7.up(db); CONFIG_MIGRATION_V8.up(db);
    db.run(`INSERT INTO configuration_revisions(revision,content_hash,kind,created_at)
      VALUES (2,?,'config',10)`, [hashConfigurationContent(AGGREGATE)]);
    const slots = errorCode === 'replacement_convergence_failed' || errorCode === 'old_worker_drain_failed' ? [0] : [];
    const state = errorCode === null ? 'converged' : 'degraded';
    const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: 1,
      aggregate: AGGREGATE, target_worker_slots: slots });
    db.run(`INSERT INTO configuration_operations
      (mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,
       result_status,error_code,error_detail,drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at)
      VALUES ('v8-source',?,1,2,'config',?,?,?, ?,?,0,NULL,10,10)`, [
      requestHash, slots.length, state, state === 'converged' ? 200 : 202,
      errorCode, errorCode === null ? null : 'v8 failure',
    ]);
    if (errorCode === 'replacement_convergence_failed') {
      db.run(`INSERT INTO configuration_operation_workers
        (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,
         last_begin_reason,state,applied_revision,last_error,updated_at)
        VALUES ('v8-source',0,2,0,1,0,'initial','failed',NULL,'v8 failure',10)`);
    } else if (errorCode === 'old_worker_drain_failed') {
      db.run(`INSERT INTO configuration_operation_workers
        (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,
         last_begin_reason,state,applied_revision,last_error,updated_at)
        VALUES ('v8-source',0,2,0,1,0,'initial','converged',2,NULL,10)`);
    }
    db.run('UPDATE configuration_state SET active_revision=2,updated_at=10 WHERE id=1');
  }).immediate();
  db.close(true);
  return dbPath;
}

afterEach(() => {
  for (const repository of REPOSITORIES.splice(0)) repository.close();
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable configuration recoveries', () => {
  test('rolls back degraded finalization and automatic recovery together on a fault', () => {
    const failure = new Error('automatic recovery fault');
    const { repository } = open({ faultInjection: (stage) => {
      if (stage === 'after_automatic_recovery') throw failure;
    } });
    commit(repository, 'atomic-fault');
    repository.beginPublication('atomic-fault', NOW + 2);
    repository.beginWorkerAttempt('atomic-fault', 0, 0, 'initial', NOW + 3);
    repository.recordWorkerResult('atomic-fault', 0, { kind: 'failed', attempt_no: 1, error: 'failure' }, NOW + 4);
    expect(() => repository.finalizePublication('atomic-fault', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failure', recovery_disposition: 'retryable',
    }, NOW + 5)).toThrow(ConfigRepositoryError);
    expect(repository.getOperation('atomic-fault')).toMatchObject({ state: 'publishing', result_status: null });
    expect(repository['db'].query<{ readonly count: number }, []>(
      'SELECT count(*) AS count FROM configuration_recoveries',
    ).get()?.count).toBe(0);
  });

  test('atomically schedules automatic recovery and keeps terminal operation immutable', () => {
    const { repository } = open();
    replacementFailure(repository, 'auto-recovery');

    const operation = repository.getOperation('auto-recovery');
    const recoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('auto-recovery')?.recovery_id;
    const recovery = recoveryId === undefined ? null : repository.getRecovery(recoveryId);
    if (operation === null || recovery === null) throw new Error('automatic recovery state missing');
    expect(operation).toMatchObject({ state: 'degraded', error_code: 'replacement_convergence_failed' });
    expect(recovery).toMatchObject({
      recovery_id: recoveryId, source_mutation_id: 'auto-recovery', target_revision: 2,
      trigger: 'automatic', state: 'scheduled', attempt_count: 0, max_attempts: 6, next_retry_at: NOW + 255,
    });
    expect(repository.commit({ mutation_id: 'blocked-by-recovery', expected_revision: 2, aggregate: AGGREGATE,
      kind: 'config', created_at: NOW + 6, target_worker_slots: [0] })).toEqual({
      kind: 'recovery_in_progress', recovery_id: recovery.recovery_id, target_revision: 2, state: 'scheduled',
    });
    expectRecoveryError(() => repository.createManualRecovery(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'auto-recovery', 2, NOW + 7,
    ), 'recovery_in_progress');
    expectRecoveryError(() => repository.stopRecovery(
      recovery.recovery_id, 0, 'deterministic_control_failure', 'wrong category', NOW + 7,
    ), 'source_not_retryable');
    expect(() => repository['db'].run("UPDATE configuration_operations SET error_detail='changed' WHERE mutation_id='auto-recovery'"))
      .toThrow();
    expect(repository.finalizePublication('auto-recovery', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'worker rejected', recovery_disposition: 'retryable',
    }, NOW + 6)).toEqual(operation);
    expect(repository.getCurrentRecovery()).toEqual(recovery);
  });

  test('consumes deterministic and fatal finalization dispositions in the same transaction', () => {
    const { repository } = open();
    for (const [index, [mutationId, disposition, reason]] of ([
      ['deterministic-finalize', 'deterministic_worker_rejection', 'deterministic_worker_rejection'],
      ['fatal-finalize', 'fatal', null],
    ] as const).entries()) {
      const offset = index * 10;
      commit(repository, mutationId, index + 1);
      repository.beginPublication(mutationId, NOW + offset + 2);
      repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', NOW + offset + 3);
      repository.recordWorkerResult(mutationId, 0, { kind: 'failed', attempt_no: 1, error: 'failure' }, NOW + offset + 4);
      repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failure',
        recovery_disposition: disposition,
      }, NOW + offset + 5);
      const row = repository['db'].query<{ readonly state: string; readonly attempt_count: number; readonly final_reason_code: string | null }, [string]>(
        'SELECT state,attempt_count,final_reason_code FROM configuration_recoveries WHERE source_mutation_id=?',
      ).get(mutationId);
      if (reason === null) {
        expect(row).toMatchObject({ state: 'stopped', attempt_count: 0, final_reason_code: 'fatal_source_failure' });
        const manual = repository.createManualRecovery('22222222-2222-4222-8222-222222222222', mutationId, index + 2, NOW + offset + 6);
        expect(manual).toMatchObject({ trigger: 'manual', state: 'scheduled', next_retry_at: null });
      }
      else expect(row).toMatchObject({ state: 'stopped', attempt_count: 0, final_reason_code: reason });
    }
  });

  test('reopens a fatal source marker without making it claimable and permits a manual cycle', () => {
    const opened = open();
    const { repository, dbPath } = opened;
    commit(repository, 'fatal-reopen');
    repository.beginPublication('fatal-reopen', NOW + 2);
    repository.beginWorkerAttempt('fatal-reopen', 0, 0, 'initial', NOW + 3);
    repository.recordWorkerResult('fatal-reopen', 0, { kind: 'failed', attempt_no: 1, error: 'fatal source' }, NOW + 4);
    repository.finalizePublication('fatal-reopen', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'fatal source', recovery_disposition: 'fatal',
    }, NOW + 5);
    const recoveryId = repository['db'].query<{ recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?').get('fatal-reopen')?.recovery_id;
    if (recoveryId === undefined) throw new Error('fatal recovery marker was not created');
    repository.close();
    REPOSITORIES.splice(REPOSITORIES.indexOf(repository), 1);
    const reopened = ConfigRepository.open(dbPath);
    REPOSITORIES.push(reopened);
    expect(reopened.getRecovery(recoveryId)).toMatchObject({ state: 'stopped', attempt_count: 0, final_reason_code: 'fatal_source_failure' });
    expect(reopened.getCurrentRecovery()).toMatchObject({ state: 'stopped', final_reason_code: 'fatal_source_failure' });
    expect(reopened.createManualRecovery('44444444-4444-4444-8444-444444444444', 'fatal-reopen', 2, NOW + 6))
      .toMatchObject({ trigger: 'manual', state: 'scheduled', next_retry_at: null });
  });

  test('guards sequence assignment, deletion, and sqlite_sequence integrity', () => {
    const { repository } = open();
    replacementFailure(repository, 'sequence-source');
    const db = repository['db'];
    const automaticId = db.query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('sequence-source')?.recovery_id;
    if (automaticId === undefined) throw new Error('automatic recovery missing');
    expect(db.query<{ readonly recovery_sequence: number }, [string]>(
      'SELECT recovery_sequence FROM configuration_recoveries WHERE recovery_id=?',
    ).get(automaticId)?.recovery_sequence).toBe(1);
    expect(() => db.run('UPDATE configuration_recoveries SET recovery_sequence=99 WHERE recovery_id=?', [automaticId])).toThrow();
    expect(() => db.run(`INSERT INTO configuration_recoveries
      (recovery_sequence,recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,created_at,updated_at)
      VALUES (99,'22222222-2222-4222-8222-222222222222','sequence-source',2,'manual','stopped',0,6,${NOW + 6},${NOW + 6})`)).toThrow();
    repository.stopRecovery(automaticId, 0, 'deterministic_worker_rejection', 'stopped', NOW + 6);
    expect(() => db.run(`INSERT INTO configuration_recoveries
      (recovery_sequence,recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,
       next_retry_at,created_at,updated_at)
      VALUES (NULL,'77777777-7777-4777-8777-777777777777','sequence-source',2,'manual','running',1,6,${NOW + 20},${NOW + 7},${NOW + 7})`)).toThrow();
    db.run(`INSERT INTO configuration_recoveries
      (recovery_sequence,recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,created_at,updated_at)
      VALUES (NULL,'33333333-3333-4333-8333-333333333333','sequence-source',2,'manual','stopped',0,6,${NOW + 7},${NOW + 7})`);
    expect(db.query<{ readonly recovery_sequence: number }, [string]>(
      'SELECT recovery_sequence FROM configuration_recoveries WHERE recovery_id=?',
    ).get('33333333-3333-4333-8333-333333333333')?.recovery_sequence).toBe(2);
    expect(() => db.run('DELETE FROM configuration_recoveries WHERE recovery_id=?', [automaticId])).toThrow();
    db.run("UPDATE sqlite_sequence SET seq=99 WHERE name='configuration_recoveries'");
    expectRecoveryError(() => repository.getSnapshot(), 'schema_corrupt');
  });

  test('audits global creation time and sequence order after trigger-restored corruption', () => {
    // These probes model accidental/host-code corruption; they do not defend against a DB owner who can rewrite every table.
    const { repository } = open();
    replacementFailure(repository, 'sequence-order-source');
    const db = repository['db'];
    const automaticId = db.query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('sequence-order-source')?.recovery_id;
    if (automaticId === undefined) throw new Error('automatic recovery missing');
    repository.stopRecovery(automaticId, 0, 'deterministic_worker_rejection', 'stopped', NOW + 6);
    expectRecoveryError(() => repository.createManualRecovery(
      '44444444-4444-4444-8444-444444444444', 'sequence-order-source', 2, NOW + 4,
    ), 'invalid_operation');
    for (const [id, createdAt] of [
      ['55555555-5555-4555-8555-555555555555', NOW + 7],
      ['66666666-6666-4666-8666-666666666666', NOW + 8],
    ] as const) {
      db.run(`INSERT INTO configuration_recoveries
        (recovery_sequence,recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,
         final_reason_code,final_reason_detail,created_at,updated_at)
        VALUES (NULL,?,'sequence-order-source',2,'manual','stopped',0,6,'deterministic_worker_rejection','stopped',?,?)`,
      [id, createdAt, createdAt]);
    }
    db.run('DROP TRIGGER configuration_recoveries_sequence_update_guard');
    db.run('UPDATE configuration_recoveries SET recovery_sequence=99 WHERE recovery_sequence=1');
    db.run('UPDATE configuration_recoveries SET recovery_sequence=1 WHERE recovery_sequence=2');
    db.run('UPDATE configuration_recoveries SET recovery_sequence=2 WHERE recovery_sequence=99');
    db.run(`CREATE TRIGGER configuration_recoveries_sequence_update_guard
      BEFORE UPDATE OF recovery_sequence ON configuration_recoveries
      BEGIN
        SELECT RAISE(ABORT,'recovery sequence is immutable');
      END`);
    expectRecoveryError(() => repository.getSnapshot(), 'schema_corrupt');
  });

  test('uses an independent canonical UUID when the mutation ID is already a UUID', () => {
    let { repository, dbPath } = open();
    const mutationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    replacementFailure(repository, mutationId);
    const recoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get(mutationId)?.recovery_id;
    if (recoveryId === undefined) throw new Error('automatic recovery missing');
    expect(recoveryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(recoveryId).not.toBe(mutationId);
    const sequence = repository['db'].query<{ readonly recovery_sequence: number }, [string]>(
      'SELECT recovery_sequence FROM configuration_recoveries WHERE recovery_id=?',
    ).get(recoveryId)?.recovery_sequence;
    repository.close();
    REPOSITORIES.splice(REPOSITORIES.indexOf(repository), 1);
    repository = ConfigRepository.open(dbPath);
    REPOSITORIES.push(repository);
    expect(repository['db'].query<{ readonly recovery_sequence: number }, [string]>(
      'SELECT recovery_sequence FROM configuration_recoveries WHERE recovery_id=?',
    ).get(recoveryId)?.recovery_sequence).toBe(sequence);
  });

  test('races two independent SQLite processes without partial commit or recovery', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { repository, dbPath } = open();
      const source = `race-source-${round}`;
      replacementFailure(repository, source);
      const automaticId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
        'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
      ).get(source)?.recovery_id;
      if (automaticId === undefined) throw new Error('automatic recovery missing');
      repository.stopRecovery(automaticId, 0, 'deterministic_worker_rejection', 'race setup', NOW + 6);
      const recoveryId = `abababab-abab-4bab-8bab-${String(round).padStart(2, '0')}0000000000`;
      const mutation = `race-commit-${round}`;
      const actions = round % 2 === 0 ? ['manual', 'commit'] as const : ['commit', 'manual'] as const;
      const outcomes = await runRaceRound(repository, dbPath, actions, source, mutation, recoveryId, round);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
      const winner = outcomes.find((outcome) => outcome.ok);
      if (winner === undefined) throw new Error('race winner missing');
      expect(winner.kind).toBe(winner.action === 'manual' ? 'manual' : 'committed');
      const loser = outcomes.find((outcome) => !outcome.ok);
      if (loser === undefined) throw new Error('race loser missing');
      if (winner.action === 'manual') {
        expect(winner).toMatchObject({ recovery_id: recoveryId });
        expect(loser).toMatchObject({ action: 'commit', code: 'recovery_in_progress' });
        expect(repository.getSnapshot().revision).toBe(2);
        expect(repository.getOperation(mutation)).toBeNull();
        expect(repository.getRecovery(recoveryId)).toMatchObject({
          source_mutation_id: source, target_revision: 2, trigger: 'manual', state: 'scheduled',
        });
        expect(activeRecoveryCount(repository)).toBe(1);
      } else {
        expect(winner).toMatchObject({ revision: 3 });
        expect(loser).toMatchObject({ action: 'manual', code: 'stale_revision' });
        expect(repository.getSnapshot().revision).toBe(3);
        expect(repository.getOperation(mutation)).toMatchObject({ mutation_id: mutation, committed_revision: 3 });
        expect(repository.getRecovery(recoveryId)).toBeNull();
        expect(activeRecoveryCount(repository)).toBe(0);
      }
    }
  }, { timeout: 90_000 });

  test('rejects malformed race child protocol at the process and parser boundary', async () => {
    for (const negative of ['extra', 'terminal-before-start', 'eof-residual', 'duplicate-after-error'] as const) {
      await expectNegativeRaceCase(negative);
    }
  });

  test('supports manual idempotency, CAS attempt transitions, exact retry times, and reopen requeue', () => {
    let { repository, dbPath } = open();
    replacementFailure(repository, 'manual-source');
    const automaticId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('manual-source')?.recovery_id;
    const automatic = automaticId === undefined ? null : repository.getRecovery(automaticId);
    if (automatic === null) throw new Error('automatic recovery missing');
    if (automaticId === undefined) throw new Error('automatic recovery missing');
    repository.stopRecovery(automaticId, 0, 'deterministic_worker_rejection', 'manual takeover', NOW + 6);
    expectRecoveryError(() => repository.createManualRecovery(
      '99999999-9999-4999-8999-999999999999', 'manual-source', 2, NOW + 5,
    ), 'invalid_operation');

    const manualId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const manual = repository.createManualRecovery(manualId, 'manual-source', 2, NOW + 7);
    expect(repository.createManualRecovery(manualId, 'manual-source', 2, NOW + 8)).toEqual(manual);
    expectRecoveryError(() => repository.createManualRecovery(manualId, 'other-source', 2, NOW + 8), 'idempotency_key_reused');
    expect(repository.claimRecoveryAttempt(manualId, 0, NOW + 8)).toMatchObject({ state: 'running', attempt_count: 1 });
    const claimed = repository.getRecovery(manualId);
    if (claimed === null) throw new Error('claimed recovery missing');
    expect(repository.claimRecoveryAttempt(manualId, 0, NOW + 9)).toEqual(claimed);
    repository.close();
    REPOSITORIES.splice(REPOSITORIES.indexOf(repository), 1);
    repository = ConfigRepository.open(dbPath);
    REPOSITORIES.push(repository);
    expect(repository.getRecovery(manualId)).toEqual(claimed);
    const requeued = repository.requeueRecovery(manualId, 1, NOW + 10);
    expect(requeued).toMatchObject({ state: 'scheduled', attempt_count: 1, next_retry_at: null });
    expect(repository.claimRecoveryAttempt(manualId, 1, NOW + 11)).toMatchObject({ state: 'running', attempt_count: 2 });
    expect(repository.scheduleRecoveryRetry(manualId, 2, NOW + 100, NOW + 12)).toMatchObject({
      state: 'scheduled', attempt_count: 2, next_retry_at: NOW + 100,
    });
    expectRecoveryError(() => repository.claimRecoveryAttempt(manualId, 2, NOW + 13), 'retry_not_due');
    expect(repository.claimRecoveryAttempt(manualId, 2, NOW + 100)).toMatchObject({ state: 'running', attempt_count: 3 });
    expect(repository.succeedRecovery(manualId, 3, 'target_serving', null, NOW + 101)).toMatchObject({
      state: 'succeeded', attempt_count: 3, next_retry_at: null, final_reason_code: 'target_serving',
    });
  });

  test('does not schedule recovery for old-worker drain failure and rejects stale manual source', () => {
    const { repository } = open();
    commit(repository, 'drain-failure');
    repository.beginPublication('drain-failure', NOW + 2);
    repository.beginWorkerAttempt('drain-failure', 0, 0, 'initial', NOW + 3);
    repository.recordWorkerResult('drain-failure', 0, { kind: 'converged', attempt_no: 1, applied_revision: 2 }, NOW + 4);
    repository.markDraining('drain-failure', NOW + 5);
    repository.finalizePublication('drain-failure', {
      outcome: 'degraded', error_code: 'old_worker_drain_failed', error_detail: 'drain failed', recovery_disposition: 'retryable', old_workers_exited: true,
    }, NOW + 6);
    expect(repository.getRecovery('drain-failure')).toBeNull();

    const next = repository.commit({ mutation_id: 'next', expected_revision: 2, aggregate: AGGREGATE,
      kind: 'config', created_at: NOW + 7, target_worker_slots: [0] });
    expect(next.kind).toBe('committed');
    expect(() => repository.createManualRecovery('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'drain-failure', 3, NOW + 8))
      .toThrow(ConfigRepositoryError);
  });

  test('fails closed when a persisted recovery row is corrupted', () => {
    const { repository } = open();
    replacementFailure(repository, 'corrupt-recovery');
    const db = repository['db'];
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run("UPDATE configuration_recoveries SET attempt_count=7 WHERE source_mutation_id='corrupt-recovery'");
    db.run('PRAGMA ignore_check_constraints=OFF');
    const recoveryId = db.query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('corrupt-recovery')?.recovery_id;
    if (recoveryId === undefined) throw new Error('corrupt recovery missing');
    expect(() => repository.getRecovery(recoveryId)).toThrow(ConfigRepositoryError);
  });

  test('prioritizes active current recovery over a newer terminal recovery', () => {
    const { repository } = open();
    replacementFailure(repository, 'priority-source');
    repository['db'].run(`INSERT INTO configuration_recoveries
      (recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,
       next_retry_at,final_reason_code,final_reason_detail,created_at,updated_at)
      VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','priority-source',2,'manual','stopped',0,6,
       NULL,'deterministic_worker_rejection','newer terminal',${NOW + 100},${NOW + 100})`);
    repository['db'].run(`INSERT INTO configuration_recoveries
      (recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,
       next_retry_at,final_reason_code,final_reason_detail,created_at,updated_at)
      VALUES ('11111111-1111-4111-8111-111111111111','priority-source',2,'manual','stopped',0,6,
       NULL,'deterministic_worker_rejection','same timestamp, later sequence',${NOW + 100},${NOW + 100})`);
    expect(repository.getLatestRecovery(2)).toMatchObject({
      recovery_id: '11111111-1111-4111-8111-111111111111', state: 'stopped', updated_at: NOW + 100,
    });
    expect(repository.getCurrentRecovery()).toMatchObject({ state: 'scheduled', target_revision: 2 });
    expect(() => repository['db'].run(`INSERT INTO configuration_recoveries
      (recovery_id,source_mutation_id,target_revision,trigger,state,attempt_count,max_attempts,created_at,updated_at)
      VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','priority-source',2,'manual','scheduled',0,6,${NOW + 101},${NOW + 101})`)).toThrow();
  });

  test('rejects recovery side effects after the active revision drifts', () => {
    const { repository } = open();
    replacementFailure(repository, 'drift-source');
    const automaticId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('drift-source')?.recovery_id;
    if (automaticId === undefined) throw new Error('automatic recovery missing');
    repository.succeedRecovery(automaticId, 0, 'already_serving', null, NOW + 6);
    const manualId = '12121212-1212-4121-8121-121212121212';
    repository.createManualRecovery(manualId, 'drift-source', 2, NOW + 7);
    const db = repository['db'];
    db.run(`INSERT INTO configuration_revisions(revision,content_hash,kind,created_at)
      VALUES (3,?,'config',${NOW + 10})`, [hashConfigurationContent(AGGREGATE)]);
    const requestHash = hashConfigurationRequest({ kind: 'config', expected_revision: 2,
      aggregate: AGGREGATE, target_worker_slots: [0] });
    db.run(`INSERT INTO configuration_operations
      (mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,
       result_status,error_code,error_detail,drain_recovery_generation,last_drain_recovery_previous_generation,created_at,updated_at)
      VALUES ('drift-target',?,2,3,'config',1,'converged',200,NULL,NULL,0,NULL,${NOW + 10},${NOW + 10})`, [requestHash]);
    db.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,drain_recovery_generation,attempt_no,last_begin_previous_attempt_no,
       last_begin_reason,state,applied_revision,last_error,updated_at)
      VALUES ('drift-target',0,3,0,1,0,'initial','converged',3,NULL,${NOW + 10})`);
    db.run('UPDATE configuration_state SET active_revision=3,updated_at=? WHERE id=1', [NOW + 10]);
    expectRecoveryError(() => repository.getSnapshot(), 'schema_corrupt');
    expectRecoveryError(() => repository.claimRecoveryAttempt(manualId, 0, NOW + 11), 'stale_revision');
    const stopped = repository.stopRecovery(manualId, 0, 'revision_superseded', null, NOW + 12);
    expect(stopped).toMatchObject({
      state: 'stopped', final_reason_code: 'revision_superseded',
    });
    expect(repository.succeedRecovery(automaticId, 0, 'already_serving', null, NOW + 13)).toMatchObject({
      state: 'succeeded', final_reason_code: 'already_serving',
    });
    expect(repository.stopRecovery(manualId, 0, 'revision_superseded', null, NOW + 14)).toEqual(stopped);
  });

  test('rejects invalid running fields and invalid terminal reasons with typed failures', () => {
    const { repository } = open();
    expectRecoveryError(() => repository.createManualRecovery(
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'missing-source', 1, NOW,
    ), 'invalid_operation');
    replacementFailure(repository, 'matrix-corruption');
    const recoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('matrix-corruption')?.recovery_id;
    if (recoveryId === undefined) throw new Error('recovery missing');
    expectRecoveryError(() => repository.succeedRecovery(
      recoveryId, 0, 'deterministic_worker_rejection', null, NOW + 6,
    ), 'invalid_operation');
    repository.claimRecoveryAttempt(recoveryId, 0, NOW + 256);
    repository['db'].run('PRAGMA ignore_check_constraints=ON');
    repository['db'].run('UPDATE configuration_recoveries SET next_retry_at=? WHERE recovery_id=?', [NOW + 20, recoveryId]);
    repository['db'].run('PRAGMA ignore_check_constraints=OFF');
    expectRecoveryError(() => repository.getRecovery(recoveryId), 'schema_corrupt');
  });

  test('mirrors the terminal attempt matrix and exhausts exactly six attempts', () => {
    let { repository, dbPath } = open();
    replacementFailure(repository, 'matrix-source');
    const automaticId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('matrix-source')?.recovery_id;
    if (automaticId === undefined) throw new Error('automatic recovery missing');
    repository.stopRecovery(automaticId, 0, 'deterministic_worker_rejection', 'stopped', NOW + 6);
    const alreadyServingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    repository.createManualRecovery(alreadyServingId, 'matrix-source', 2, NOW + 7);
    expect(repository.succeedRecovery(alreadyServingId, 0, 'already_serving', null, NOW + 8)).toMatchObject({
      state: 'succeeded', attempt_count: 0, final_reason_code: 'already_serving',
    });
    const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    repository.createManualRecovery(id, 'matrix-source', 2, NOW + 9);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      repository.claimRecoveryAttempt(id, attempt, NOW + 9 + attempt * 2);
      if (attempt < 5) repository.scheduleRecoveryRetry(id, attempt + 1, NOW + 11 + attempt * 2, NOW + 10 + attempt * 2);
    }
    repository.close();
    REPOSITORIES.splice(REPOSITORIES.indexOf(repository), 1);
    repository = ConfigRepository.open(dbPath);
    REPOSITORIES.push(repository);
    expectRecoveryError(() => repository.requeueRecovery(id, 6, NOW + 30), 'attempts_exhausted');
    expect(repository.stopRecovery(id, 6, 'retry_exhausted', null, NOW + 31)).toMatchObject({
      state: 'stopped', attempt_count: 6, final_reason_code: 'retry_exhausted',
    });
  });

  test('backfills only active replacement/control degraded v8 operations with independent UUIDs', () => {
    for (const errorCode of ['replacement_convergence_failed', 'control_readiness_failed', 'old_worker_drain_failed', null] as const) {
      const dbPath = v8Fixture(errorCode);
      const beforeDb = new Database(dbPath, { create: false, readwrite: false, strict: true });
      const beforeOperation = beforeDb.query<Record<string, unknown>, []>(
        'SELECT * FROM configuration_operations',
      ).get();
      beforeDb.close(true);
      const repository = ConfigRepository.open(dbPath);
      REPOSITORIES.push(repository);
      const afterOperation = repository['db'].query<Record<string, unknown>, []>(
        'SELECT * FROM configuration_operations',
      ).get();
      expect(afterOperation).toEqual(beforeOperation);
      const recovery = repository['db'].query<{ readonly recovery_id: string; readonly source_mutation_id: string; readonly next_retry_at: number | null }, []>(
        'SELECT recovery_id,source_mutation_id,next_retry_at FROM configuration_recoveries',
      ).get();
      if (errorCode === null || errorCode === 'old_worker_drain_failed') {
        expect(recovery).toBeNull();
      } else {
        expect(recovery).toMatchObject({ source_mutation_id: 'v8-source' });
        expect(recovery?.next_retry_at).toBe(260);
        expect(recovery?.recovery_id).not.toBe('v8-source');
        expect(recovery?.recovery_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        repository.close();
        REPOSITORIES.splice(REPOSITORIES.indexOf(repository), 1);
        const reopened = ConfigRepository.open(dbPath);
        REPOSITORIES.push(reopened);
        expect(reopened['db'].query<{ readonly count: number }, []>(
          'SELECT count(*) AS count FROM configuration_recoveries',
        ).get()?.count).toBe(1);
        expect(reopened['db'].query<{ readonly recovery_id: string }, []>(
          'SELECT recovery_id FROM configuration_recoveries',
        ).get()?.recovery_id).toBe(recovery?.recovery_id);
      }
    }
  });
});
