import { CONFIG_SCHEMA_STATEMENTS } from '../../src/config-storage/schema';
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigRepository,
  ConfigRepositoryError,
  ConfigurationHashError,
  type ConfigRepositoryOptions,
  type ConfigurationCompileOptions,
  hashConfigurationContent,
  hashConfigurationRequest,
  parseNormalizeCompileAggregate,
  validateSnapshotWithPlugins,
} from '../../src/config-storage';
import { isSqliteBusyError } from '../../src/config-storage/sqlite-errors';
import { canonicalJson } from '../../src/config-storage/content-hash';
import { replaceActiveMaterialization } from '../../src/config-storage/materialize';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from '../../src/config-storage/repository-snapshot';
import { CONFIG_MIGRATIONS, migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';
import { STATEFUL_INTEGRATION_TEST_TIMEOUT_MS } from '../helpers/test-budgets';

setDefaultTimeout(STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

const EMPTY_AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
};

const tempRoots: string[] = [];
const repositories: ConfigRepository[] = [];

const IDS = {
  service: '10000000-0000-4000-8000-000000000001',
  serviceUpstream: '30000000-0000-4000-8000-000000000001',
  serviceRoute: '20000000-0000-4000-8000-000000000001',
  directRoute: '20000000-0000-4000-8000-000000000002',
  routeUpstream: '30000000-0000-4000-8000-000000000002',
  globalBinding: '40000000-0000-4000-8000-000000000001',
  serviceBinding: '40000000-0000-4000-8000-000000000002',
  routeBinding: '40000000-0000-4000-8000-000000000003',
  upstreamBinding: '40000000-0000-4000-8000-000000000004',
} as const;

const COMPILE_OPTIONS: ConfigurationCompileOptions = {
  pluginSchemas: new Map([
    ['audit', [{ name: 'level', type: 'select', label: 'Level', required: true, options: [
      { label: 'Info', value: 'info' },
      { label: 'Debug', value: 'debug' },
    ] }]],
    ['installed-only', []],
  ]),
};

const CONCURRENT_OPEN_CHILD = `
  const { ConfigRepository } = await import('./src/config-storage/index.ts');
  let repository;
  try {
    repository = ConfigRepository.open(process.env.BUNGEE_MIGRATION_DB);
    console.log(JSON.stringify({ ok: true, revision: repository.getSnapshot().revision }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error?.code ?? 'unknown' }));
  } finally {
    repository?.close();
  }
`;

const CONSISTENT_READ_WRITER_CHILD = `
  const { ConfigRepository } = await import('./src/config-storage/index.ts');
  let repository;
  const emit = (value) => console.log(JSON.stringify(value));
  try {
    repository = ConfigRepository.open(process.env.BUNGEE_CONSISTENT_READ_DB);
    emit({ event: 'ready' });
    const { readFileSync } = await import('node:fs');
    let consumed = 0;
    let input = '';
    setInterval(() => {
      const gate = readFileSync(process.env.BUNGEE_TEST_HANDSHAKE, 'utf8');
      input += gate.slice(consumed);
      consumed = gate.length;
      let newline;
      while ((newline = input.indexOf('\\n')) >= 0) {
        const command = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (command !== 'commit') continue;
        emit({ event: 'attempting' });
        const result = repository.commit({ mutation_id: 'consistent-read-writer', expected_revision: 1,
          aggregate: { logical_configuration: { log_level: 'warn', services: [], routes: [], plugins: [] }, plugin_activations: [] },
          kind: 'config', created_at: 1700000000002, target_worker_slots: [] });
        emit({ event: 'done', kind: result.kind });
        repository.close();
        process.exit(0);
      }
    }, 5);
  } catch (error) {
    emit({ event: 'error', code: error?.code ?? 'unknown', message: error?.message ?? 'unknown', cause: error?.cause?.message ?? 'unknown' });
    process.exit(1);
  }
`;

const CONSISTENT_READ_READER_CHILD = `
  const { readFileSync } = await import('node:fs');
  const { Database } = await import('bun:sqlite');
  const { readRepositorySnapshot } = await import('./src/config-storage/repository-snapshot.ts');
  const raw = new Database(process.env.BUNGEE_CONSISTENT_READ_DB, { create: false, readwrite: true, strict: true });
  const emit = (value) => console.log(JSON.stringify(value));
  let consumed = 0;
  const byte = () => {
    const gate = process.env.BUNGEE_TEST_HANDSHAKE;
    while (readFileSync(gate, 'utf8').length <= consumed) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    return readFileSync(gate, 'utf8')[consumed++];
  };
  let firstTransaction = true;
  const db = new Proxy(raw, {
    get(target, property, receiver) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback) => {
        let usedDeferred = false;
        const transaction = target.transaction(() => {
          const result = callback();
          if (firstTransaction) {
            firstTransaction = false;
            emit({ event: 'ready', snapshot: result, deferred: usedDeferred, inTransaction: target.inTransaction });
            if (byte() !== 'p') throw new Error('reader probe handshake missing');
            emit({ event: 'stable', snapshot: readRepositorySnapshot(db), inTransaction: target.inTransaction });
            if (byte() !== 'r') throw new Error('reader release handshake missing');
          }
          return result;
        });
        return {
          deferred: () => { usedDeferred = true; return transaction.deferred(); },
          immediate: () => transaction.immediate(),
        };
      };
    },
  });
  try {
    readRepositorySnapshot(db);
    emit({ event: 'released' });
    raw.close(true);
    process.exit(0);
  } catch (error) {
    emit({ event: 'error', code: error?.code ?? 'unknown', message: error?.message ?? 'unknown', cause: error?.cause?.message ?? 'unknown' });
    raw.close(true);
    process.exit(1);
  }
`;

function richAggregate(): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate({
    logical_configuration: {
      log_level: 'debug',
      body_parser_limit: '2mb',
      auth: { enabled: true, tokens: ['literal-token'] },
      logging: { body: { enabled: true, max_size: 2048, retention_days: 3 } },
      services: [{
        id: IDS.service,
        position: 4,
        name: 'primary',
        endpoints: [{
          id: IDS.serviceUpstream,
          position: 3,
          target: 'https://service.example.com',
          weight: 80,
          priority: 2,
          is_disabled: false,
          description: 'service owner',
          request: { headers: { add: { authorization: 'secret' } } },
          plugins: [{ id: IDS.upstreamBinding, position: 7, name: 'audit', options: { level: 'info' }, enabled: true }],
        }],
        plugins: [{ id: IDS.serviceBinding, position: 2, name: 'audit', options: { level: 'debug' }, enabled: true }],
      }],
      routes: [{
        id: IDS.serviceRoute,
        position: 5,
        path: '/service',
        service_id: IDS.service,
        retry: { enabled: true, max_retries: 2 },
        plugins: [{ id: IDS.routeBinding, position: 9, name: 'audit', enabled: false, options: { level: 'info' } }],
      }, {
        id: IDS.directRoute,
        position: 8,
        path: '/direct',
        endpoints: [{
          id: IDS.routeUpstream,
          position: 6,
          target: 'https://route.example.com',
          weight: 20,
          priority: 1,
          is_disabled: true,
          condition: '{{ method === "POST" }}',
          plugins: [],
        }],
        plugins: [],
      }],
      plugins: [{ id: IDS.globalBinding, position: 1, name: 'audit', options: { level: 'debug' }, enabled: true }],
    },
    plugin_activations: [{ plugin_name: 'installed-only' }, { plugin_name: 'audit' }],
  }, COMPILE_OPTIONS);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function richAggregateWithLogLevel(logLevel: 'debug' | 'warn'): ConfigurationAggregateV2 {
  const aggregate = richAggregate();
  return {
    ...aggregate,
    logical_configuration: { ...aggregate.logical_configuration, log_level: logLevel },
  };
}

function openRepository(options: ConfigRepositoryOptions = {}): { readonly repository: ConfigRepository; readonly dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'bungee-config-repository-'));
  tempRoots.push(root);
  const dbPath = join(root, 'nested', 'config.db');
  const repository = openOfflineConfigurationRepository(dbPath, options);
  repositories.push(repository);
  return { repository, dbPath };
}

function openOfflineConfigurationRepository(dbPath: string, options: ConfigRepositoryOptions = {}): ConfigRepository {
  return ConfigRepository.open(dbPath, options);
}

function command(
  mutationId: string,
  expectedRevision: number,
  aggregate: ConfigurationAggregateV2,
  kind: 'config' | 'admin_state' = 'config',
  createdAt = 1_700_000_000_000 + expectedRevision,
  targetWorkerSlots: readonly number[] = [0],
) {
  return {
    mutation_id: mutationId,
    expected_revision: expectedRevision,
    aggregate,
    kind,
    created_at: createdAt,
    target_worker_slots: targetWorkerSlots,
  };
}

function counts(dbPath: string): { readonly revisions: number; readonly operations: number; readonly services: number } {
  const db = new Database(dbPath, { readonly: true, strict: true });
  const result = {
    revisions: db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_revisions').get()?.count ?? -1,
    operations: db.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_operations').get()?.count ?? -1,
    services: db.query<{ count: number }, []>('SELECT count(*) AS count FROM services').get()?.count ?? -1,
  };
  db.close(true);
  return result;
}

function expectRepositoryError(error: unknown, code: ConfigRepositoryError['code']): void {
  expect(error).toBeInstanceOf(ConfigRepositoryError);
  if (!(error instanceof ConfigRepositoryError)) throw error;
  expect(error.code).toBe(code);
}

async function runConcurrentOpenChild(dbPath: string): Promise<{ readonly ok: boolean; readonly revision?: number; readonly code?: string }> {
  const child = Bun.spawn([process.execPath, '-e', CONCURRENT_OPEN_CHILD], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
    env: { BUNGEE_MIGRATION_DB: dbPath },
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const exitCode = await child.exited;
    const [output, errorOutput] = await Promise.all([stdout, stderr]);
    if (exitCode !== 0) throw new Error(`migration child exited ${exitCode}: ${errorOutput.trim() || '(no stderr)'}`);
    const line = output.trim().split('\n').at(-1);
    if (line === undefined || line.length === 0) throw new Error(`migration child produced no JSON: ${errorOutput.trim() || '(no stderr)'}`);
    return JSON.parse(line) as { ok: boolean; revision?: number; code?: string };
  } finally {
    clearTimeout(timer);
  }
}

function createJsonLineReader(stream: ReadableStream<Uint8Array>): () => Promise<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) return JSON.parse(line) as Record<string, unknown>;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        const line = buffer.trim();
        if (line.length > 0) return JSON.parse(line) as Record<string, unknown>;
        throw new Error('child closed before emitting JSON');
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

const handshakes = new WeakMap<Bun.Subprocess<'pipe', 'pipe', 'pipe'>, string>();
let handshakeSequence = 0;
async function sendChildCommand(child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>, command: string): Promise<void> {
  appendFileSync(handshakes.get(child)!, `${command}\n`);
}

async function sendChildByte(child: Bun.Subprocess<'pipe', 'pipe', 'pipe'>, value: string): Promise<void> {
  appendFileSync(handshakes.get(child)!, value);
}

function openProtocolChild(script: string, dbPath: string, migration = false): Bun.Subprocess<'pipe', 'pipe', 'pipe'> {
  const handshake = join(dirname(dbPath), `test-handshake-${++handshakeSequence}`);
  writeFileSync(handshake, '');
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe', stdin: 'pipe',
    env: { BUNGEE_TEST_HANDSHAKE: handshake, ...(migration
      ? { BUNGEE_MIGRATION_DB: dbPath } : { BUNGEE_CONSISTENT_READ_DB: dbPath }) },
  });
  handshakes.set(child, handshake);
  return child;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RFC 8785 configuration hashing', () => {
  test('produces stable hashes for canonical number, string, and UTF-16 key ordering vectors', () => {
    // Given
    const vectors = [
      {
        input: { numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27], minusZero: -0 },
        hash: 'sha256:28b12546ad0bf59867c0d6960ad712900ba199dc094be9da8a86bd78aae68ab7',
      },
      {
        input: {
          '\r': 'Carriage Return',
          '1': 'One',
          '\u0080': 'Control',
          ö: 'Latin Small Letter O With Diaeresis',
          '€': 'Euro Sign',
          '😀': 'Emoji: Grinning Face',
        },
        hash: 'sha256:9044f6b34e92c276de1aebc14fb1fcffa77bee065f936a90baa026a76d68d43f',
      },
      {
        input: { string: '€$\u000f\nA’B"\\"/' },
        hash: 'sha256:d7a98197da63d4cf829be0fd484f1d4e298443abb42f7f2d0321e42ebb5fcb60',
      },
    ] as const;

    // When / Then
    for (const vector of vectors) expect(hashConfigurationContent(vector.input)).toBe(vector.hash);
  });

  test('hashes equivalent object insertion orders identically', () => {
    // Given
    const first = { z: 1, ä: 3, a: 2 };
    const second = { a: 2, z: 1, ä: 3 };

    // When
    const firstHash = hashConfigurationContent(first);
    const secondHash = hashConfigurationContent(second);

    // Then
    expect(firstHash).toBe('sha256:07b4458b098bc3c88a87d9bdc024e1d7b326f13eb2238a687fd694dc040d8fcc');
    expect(secondHash).toBe(firstHash);
  });

  test('throws a typed error when RFC 8785 canonicalization fails', () => {
    // Given
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    // When / Then
    expect(() => hashConfigurationContent(cyclic)).toThrow(ConfigurationHashError);
  });

  test('binds request identity to kind, expected revision, and the complete normalized aggregate', () => {
    // Given
    const aggregate = richAggregate();
    const reordered = {
      plugin_activations: aggregate.plugin_activations,
      logical_configuration: aggregate.logical_configuration,
    };
    const baseline = hashConfigurationRequest({ kind: 'config', expected_revision: 1, aggregate, target_worker_slots: [3, 1] });

    // When / Then
    expect(hashConfigurationRequest({ aggregate: reordered, expected_revision: 1, kind: 'config', target_worker_slots: [1, 3] })).toBe(baseline);
    expect(hashConfigurationRequest({ kind: 'admin_state', expected_revision: 1, aggregate, target_worker_slots: [1, 3] })).not.toBe(baseline);
    expect(hashConfigurationRequest({ kind: 'config', expected_revision: 2, aggregate, target_worker_slots: [1, 3] })).not.toBe(baseline);
    expect(hashConfigurationRequest({ kind: 'config', expected_revision: 1, aggregate, target_worker_slots: [1] })).not.toBe(baseline);
    expect(hashConfigurationRequest({
      kind: 'config', expected_revision: 1, aggregate: richAggregateWithLogLevel('warn'), target_worker_slots: [1, 3],
    })).not.toBe(baseline);
  });
});

describe('configuration schema migration definition', () => {
  test('defines baseline DDL as ordered executable statements', () => {
    // Given / When / Then
    expect(CONFIG_SCHEMA_STATEMENTS.length).toBe(26);
    const db = new Database(':memory:', {strict:true});
    try {for (const statement of CONFIG_SCHEMA_STATEMENTS) expect(() => db.run(statement)).not.toThrow();}
    finally {db.close(true);}
  });
});

describe('ConfigRepository initialization and migration', () => {

  test('persists publication policy as part of the revision and content hash', () => {
    const { repository } = openRepository();
    const aggregate: ConfigurationAggregateV2 = {
      logical_configuration: {
        publication: {
          drain_start_timeout_ms: 300_000,
          drain_timeout_ms: 5_000,
          worker_exit_timeout_ms: 600_000,
        },
        services: [], routes: [], plugins: [],
      },
      plugin_activations: [],
    };

    const result = repository.commit(command('publication-policy', 1, aggregate));

    expect(result.kind).toBe('committed');
    expect(repository.getSnapshot()).toEqual({
      revision: 2,
      content_hash: hashConfigurationContent(aggregate),
      aggregate,
    });
    expect(repository['db'].query<{ publication_json: string | null }, []>(
      'SELECT publication_json FROM settings WHERE id=1',
    ).get()?.publication_json).toBe(canonicalJson(aggregate.logical_configuration.publication));
    const roundTripped = parseNormalizeCompileAggregate(JSON.parse(JSON.stringify(aggregate)));
    expect(roundTripped).toEqual({ ok: true, value: aggregate });
    if (roundTripped.ok) expect(hashConfigurationContent(roundTripped.value)).toBe(hashConfigurationContent(aggregate));
  });

  test('opens a real file with verified connection invariants and an anonymous empty revision', () => {
    // Given / When
    const { repository, dbPath } = openRepository();
    const snapshot = repository.getSnapshot();
    const inspector = new Database(dbPath, { readonly: true, strict: true });
    const connection = repository['db'];
    const readPragma = <Row>(sql: string): Row | null => {
      const statement = connection.prepare<Row, []>(sql);
      try {
        return statement.get();
      } finally {
        statement.finalize();
      }
    };
    const pragmas = {
      journalMode: readPragma<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode,
      synchronous: readPragma<{ synchronous: number }>('PRAGMA synchronous')?.synchronous,
      foreignKeys: readPragma<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
      busyTimeout: readPragma<{ timeout: number }>('PRAGMA busy_timeout')?.timeout,
      revisions: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM configuration_revisions').get()?.count,
      migrations: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM schema_migrations').get()?.count,
      stateColumns: inspector.query<{ name: string }, []>(
        "SELECT name FROM pragma_table_info('configuration_state') ORDER BY cid",
      ).all().map(({ name }) => name),
    };
    inspector.close(true);

    // Then
    expect(snapshot).toEqual({
      revision: 1,
      content_hash: 'sha256:940d0b92023c44d9446da69bcd50f522cccd62a4e6dae6e0b1cc582ea2fa03e1',
      aggregate: EMPTY_AGGREGATE,
    });
    expect(pragmas).toEqual({
      journalMode: 'delete',
      synchronous: 2,
      foreignKeys: 1,
      busyTimeout: 5000,
      revisions: 1,
      migrations: 1,
      stateColumns: ['id', 'schema_version', 'active_revision', 'created_at', 'updated_at'],
    });
  });

  test('reopens an initialized database without creating another revision', () => {
    // Given
    const { repository, dbPath } = openRepository();
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    // When
    const reopened = openOfflineConfigurationRepository(dbPath);
    repositories.push(reopened);

    // Then
    expect(reopened.getSnapshot().revision).toBe(1);
  });
});

describe('ConfigRepository normalized commits', () => {
  test('terminalizes control readiness from every active phase without changing worker rows', () => {
    for (const phase of ['committed', 'publishing', 'draining'] as const) {
      const { repository, dbPath } = openRepository();
      const mutationId = `control-readiness-${phase}`;
      const committed = repository.commit(command(mutationId, 1, EMPTY_AGGREGATE, 'config', 1_700_000_000_001, [0]));
      expect(committed.kind).toBe('committed');
      if (committed.kind !== 'committed') continue;
      if (phase !== 'committed') repository.beginPublication(mutationId, 1_700_000_000_002);
      if (phase === 'draining') {
        repository.beginWorkerAttempt(mutationId, 0, 0, 'initial', 1_700_000_000_003);
        repository.recordWorkerResult(mutationId, 0, {
          kind: 'converged', attempt_no: 1, applied_revision: 2,
        }, 1_700_000_000_004);
        repository.markDraining(mutationId, 1_700_000_000_005);
        repository.beginDrainingRecovery(mutationId, 0, 1_700_000_000_006);
      }
      const before = repository.getOperationState(mutationId);
      const terminal = repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'control_readiness_failed', error_detail: 'control plane unavailable', recovery_disposition: 'retryable',
      }, 1_700_000_000_007);

      expect(terminal).toMatchObject({
        state: 'degraded', result_status: 202,
        error_code: 'control_readiness_failed', error_detail: 'control plane unavailable',
      });
      expect(repository.getOperationState(mutationId)?.workers).toEqual(before?.workers);
      expect(repository.getCurrentOperationState()?.operation).toEqual(terminal);
      const recoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
        'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
      ).get(mutationId)?.recovery_id;
      if (recoveryId !== undefined) repository.stopRecovery(
        recoveryId, 0, 'deterministic_control_failure', 'stopped', 1_700_000_000_008,
      );
      expect(repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'control_readiness_failed', error_detail: 'control plane unavailable', recovery_disposition: 'retryable',
      }, 1_700_000_000_008)).toEqual(terminal);
      expect(() => repository.finalizePublication(mutationId, {
        outcome: 'degraded', error_code: 'control_readiness_failed', error_detail: 'different detail', recovery_disposition: 'retryable',
      }, 1_700_000_000_008)).toThrow(ConfigRepositoryError);
      if (phase === 'draining') {
        repository.close();
        repositories.splice(repositories.indexOf(repository), 1);
        const reopened = openOfflineConfigurationRepository(dbPath);
        repositories.push(reopened);
        expect(reopened.getOperationState(mutationId)?.workers).toEqual(before?.workers);
        expect(reopened.getCurrentOperationState()?.operation).toEqual(terminal);
        expect(() => verifySchemaFingerprint(reopened['db'])).not.toThrow();
        expect(reopened['db'].query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(reopened['db'].query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(reopened.commit(command(`${mutationId}-next`, 2, EMPTY_AGGREGATE, 'config', 1_700_000_000_009, [0])).kind)
          .toBe('committed');
      } else {
        expect(repository.commit(command(`${mutationId}-next`, 2, EMPTY_AGGREGATE, 'config', 1_700_000_000_009, [0])).kind)
          .toBe('committed');
      }
    }
  });

  test('round-trips a rich aggregate and stores only deterministic normalized rows', () => {
    // Given
    const aggregate = richAggregateWithLogLevel('debug');
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });

    // When
    const result = repository.commit(command('rich-commit', 1, aggregate));
    const inspector = new Database(dbPath, { readonly: true, strict: true });
    const servicePolicy = inspector.query<{ policy_json: string }, []>('SELECT policy_json FROM services').get()?.policy_json;
    const upstreamPolicy = inspector.query<{ policy_json: string }, [string]>(
      'SELECT policy_json FROM upstreams WHERE id=?',
    ).get(IDS.serviceUpstream)?.policy_json;
    const tableColumns = inspector.query<{ name: string }, []>(`SELECT p.name FROM sqlite_master AS m,
      pragma_table_info(m.name) AS p WHERE m.type='table'`).all().map(({ name }) => name);
    const rows = {
      services: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM services').get()?.count,
      routes: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM routes').get()?.count,
      upstreams: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM upstreams').get()?.count,
      bindings: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_bindings').get()?.count,
      activations: inspector.query<{ count: number }, []>('SELECT count(*) AS count FROM plugin_activations').get()?.count,
    };
    inspector.close(true);

    // Then
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.snapshot).toEqual({
      revision: 2,
      content_hash: hashConfigurationContent(aggregate),
      aggregate,
    });
    expect(result.operation).toMatchObject({
      mutation_id: 'rich-commit', expected_revision: 1, committed_revision: 2,
      request_hash: hashConfigurationRequest({ kind: 'config', expected_revision: 1, aggregate, target_worker_slots: [0] }),
      state: 'committed', result_status: null, error_code: null,
    });
    expect(rows).toEqual({ services: 1, routes: 2, upstreams: 2, bindings: 4, activations: 2 });
    expect(servicePolicy).toBe('{}');
    expect(upstreamPolicy).toBe('{"description":"service owner","request":{"headers":{"add":{"authorization":"secret"}}}}');
    expect(tableColumns).not.toContain('aggregate');
    expect(tableColumns).not.toContain('config_json');
  });

  test('commits the exact empty configuration snapshot and pending worker state', () => {
    // Given
    const { repository, dbPath } = openRepository();

    // When
    const result = repository.commit(command('empty-config', 1, EMPTY_AGGREGATE));

    // Then
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.snapshot).toEqual({
      revision: 2, content_hash: hashConfigurationContent(EMPTY_AGGREGATE), aggregate: EMPTY_AGGREGATE,
    });
    expect(result.operation).toMatchObject({ mutation_id: 'empty-config', committed_revision: 2, target_worker_count: 1 });
    expect(repository.getOperationState('empty-config')?.workers).toEqual([
      expect.objectContaining({ worker_slot: 0, target_revision: 2, state: 'pending' }),
    ]);
    expect(counts(dbPath)).toEqual({ revisions: 2, operations: 1, services: 0 });
  });

  test('returns stale without reserving the mutation id and lets invalid reuse beat stale', () => {
    // Given
    const aggregate = richAggregate();
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    expect(repository.commit(command('first', 1, aggregate)).kind).toBe('committed');

    // When
    const stale = repository.commit(command('stale', 1, aggregate));
    const reused = repository.commit(command('first', 1, richAggregateWithLogLevel('warn')));

    // Then
    expect(stale).toEqual({ kind: 'stale_revision', expected_revision: 1, active_revision: 2 });
    expect(reused).toEqual({ kind: 'idempotency_key_reused', mutation_id: 'first' });
    expect(counts(dbPath)).toEqual({ revisions: 2, operations: 1, services: 1 });
  });

  test('returns the original operation for duplicate retries before and after a later commit', () => {
    // Given
    const aggregate = richAggregate();
    const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
    const firstCommand = command('duplicate', 1, aggregate);
    const committed = repository.commit(firstCommand);

    // When
    const before = repository.commit({ ...firstCommand, created_at: firstCommand.created_at + 10_000 });
    repository.beginPublication('duplicate', firstCommand.created_at + 1);
    repository.beginWorkerAttempt('duplicate', 0, 0, 'initial', firstCommand.created_at + 2);
    repository.recordWorkerResult('duplicate', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, firstCommand.created_at + 3);
    repository.finalizePublication('duplicate', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failed', recovery_disposition: 'retryable',
    }, firstCommand.created_at + 4);
    const duplicateRecoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('duplicate')?.recovery_id;
    if (duplicateRecoveryId !== undefined) repository.stopRecovery(
      duplicateRecoveryId, 0, 'deterministic_worker_rejection', 'stopped', firstCommand.created_at + 5,
    );
    const later = repository.commit(command('later', 2, richAggregateWithLogLevel('warn')));
    const after = repository.commit({ ...firstCommand, created_at: firstCommand.created_at + 20_000 });

    // Then
    expect(committed.kind).toBe('committed');
    expect(before.kind).toBe('duplicate');
    expect(later.kind).toBe('committed');
    expect(after.kind).toBe('duplicate');
    if (before.kind === 'duplicate' && after.kind === 'duplicate') {
      expect(before.operation.committed_revision).toBe(2);
      expect(before.operation.state).toBe('committed');
      expect(after.operation).toMatchObject({
        mutation_id: before.operation.mutation_id,
        committed_revision: before.operation.committed_revision,
        state: 'degraded',
      });
      expect(Object.hasOwn(before, 'snapshot')).toBe(false);
      expect(Object.hasOwn(after, 'snapshot')).toBe(false);
    }
  });

  test('treats aggregate, kind, and expected revision changes as idempotency key reuse', () => {
    // Given
    const aggregate = richAggregate();
    const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
    expect(repository.commit(command('identity', 1, aggregate)).kind).toBe('committed');

    // When / Then
    expect(repository.commit(command('identity', 1, richAggregateWithLogLevel('warn')))).toEqual({
      kind: 'idempotency_key_reused', mutation_id: 'identity',
    });
    expect(repository.commit(command('identity', 1, aggregate, 'admin_state'))).toEqual({
      kind: 'idempotency_key_reused', mutation_id: 'identity',
    });
    expect(repository.commit(command('identity', 2, aggregate))).toEqual({
      kind: 'idempotency_key_reused', mutation_id: 'identity',
    });
  });

  test('builds a committed result without rereading active state after its transaction', () => {
    // Given
    const aggregate = richAggregate();
    const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
    Object.defineProperty(repository, 'getSnapshot', { value: () => { throw new Error('post-commit reread'); } });

    // When
    const result = repository.commit(command('prepared-result', 1, aggregate));

    // Then
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.snapshot).toEqual({
      revision: 2,
      content_hash: hashConfigurationContent(aggregate),
      aggregate,
    });
  });

  test('keeps a later commit valid when it omits global auth', () => {
    // Given
    const initial = richAggregate();
    const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
    expect(repository.commit(command('initial-auth', 1, initial)).kind).toBe('committed');
    repository.beginPublication('initial-auth', 1_700_000_000_001);
    repository.beginWorkerAttempt('initial-auth', 0, 0, 'initial', 1_700_000_000_002);
    repository.recordWorkerResult('initial-auth', 0, {
      kind: 'failed', attempt_no: 1, error: 'failed',
    }, 1_700_000_000_003);
    repository.finalizePublication('initial-auth', {
      outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'failed', recovery_disposition: 'retryable',
    }, 1_700_000_000_004);
    const authRecoveryId = repository['db'].query<{ readonly recovery_id: string }, [string]>(
      'SELECT recovery_id FROM configuration_recoveries WHERE source_mutation_id=?',
    ).get('initial-auth')?.recovery_id;
    if (authRecoveryId !== undefined) repository.stopRecovery(
      authRecoveryId, 0, 'deterministic_worker_rejection', 'stopped', 1_700_000_000_005,
    );
    const { auth, ...withoutAuth } = initial.logical_configuration;
    const later = { ...initial, logical_configuration: withoutAuth };

    // When
    const result = repository.commit(command('without-auth', 2, later));

    // Then
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(Object.hasOwn(result.snapshot.aggregate.logical_configuration, 'auth')).toBe(false);
  });

  test('reopens plugin-bound materialization structurally without a schema catalog', () => {
    // Given
    const aggregate = richAggregate();
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    const committed = repository.commit(command('catalog', 1, aggregate));
    expect(committed.kind).toBe('committed');
    expect(repository.getSnapshot().aggregate).toEqual(aggregate);
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);

    // When
    const reopened = openOfflineConfigurationRepository(dbPath);
    repositories.push(reopened);

    // Then
    const snapshot = reopened.getSnapshot();
    expect(snapshot.aggregate).toEqual(aggregate);
    expect(validateSnapshotWithPlugins(snapshot, COMPILE_OPTIONS)).toEqual(snapshot);
    expect(() => validateSnapshotWithPlugins(snapshot, {
      pluginSchemas: new Map([['audit', []], ['installed-only', []]]),
    })).toThrow(ConfigRepositoryError);
  });

  test('rejects a Service timeout field before writing a new configuration', () => {
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    const current = repository.getSnapshot();
    const invalid = structuredClone(richAggregate()) as unknown as {
      logical_configuration: { services: Array<Record<string, unknown>> };
    };
    invalid.logical_configuration.services[0]!.timeouts = { connect_ms: 100, send_ms: 200, read_ms: 300 };

    expect(() => repository.commit(command('reject-service-timeouts', 1, invalid as unknown as ConfigurationAggregateV2)))
      .toThrow(ConfigRepositoryError);
    expect(repository.getSnapshot()).toEqual(current);
    expect(counts(dbPath)).toEqual({ revisions: 1, operations: 0, services: 0 });
  });

  test('commits the Route first-response timeout contract', () => {
    const aggregate = richAggregate();
    const logical = structuredClone(aggregate.logical_configuration);
    const serviceRoute = logical.routes.find((route) => route.id === IDS.serviceRoute);
    if (!serviceRoute) throw new Error('service route fixture missing');
    Object.assign(serviceRoute, { timeouts: { request_ms: 2000, first_response_ms: 1000 } });
    const next: ConfigurationAggregateV2 = { ...aggregate, logical_configuration: logical };
    const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });

    const invalid = structuredClone(next);
    const invalidRoute = invalid.logical_configuration.routes.find((route) => route.id === IDS.serviceRoute);
    if (!invalidRoute) throw new Error('service route fixture missing');
    Object.assign(invalidRoute, { timeouts: { request_ms: 2000, first_response_ms: 2001 } });
    expect(() => repository.commit(command('route-first-response-invalid', 1, invalid))).toThrow(ConfigRepositoryError);
    expect(repository.getSnapshot().revision).toBe(1);

    const result = repository.commit(command('route-first-response', 1, next));
    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.snapshot.aggregate.logical_configuration.routes.find((route) => route.id === IDS.serviceRoute)?.timeouts)
        .toEqual({ request_ms: 2000, first_response_ms: 1000 });
    }
  });

  test('structurally commits plugin bindings without a catalog but applies one when configured', () => {
    // Given
    const aggregate = richAggregate();
    const { repository: structural } = openRepository();
    const { repository: catalogValidated, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    const invalidOptions = {
      ...aggregate,
      logical_configuration: {
        ...aggregate.logical_configuration,
        plugins: [{ ...aggregate.logical_configuration.plugins[0], options: { level: 'verbose' } }],
      },
    };

    // When / Then
    expect(structural.commit(command('structural-plugin', 1, aggregate)).kind).toBe('committed');
    expect(() => catalogValidated.commit(command('catalog-plugin', 1, invalidOptions))).toThrow(ConfigRepositoryError);
    expect(counts(dbPath).operations).toBe(0);
  });

  test('rolls back deletes, revision, operation, and state when the injected transaction seam fails', () => {
    // Given
    const aggregate = richAggregate();
    const failure = new Error('injected transaction failure');
    let reachedTransactionStage = false;
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS, faultInjection: (stage) => {
      if (stage !== 'after_materialization') return;
      reachedTransactionStage = true;
      throw failure;
    } });
    expect(repository.getDatabase().query<{ version: number; name: string }, []>(
      'SELECT version,name FROM schema_migrations WHERE version=1',
    ).get()).toEqual({ version: 1, name: 'current_storage_baseline' });
    expect(repository.getDatabase().query<{ name: string }, []>("PRAGMA table_info('settings')")
      .all().map(({ name }) => name)).toContain('publication_json');

    // When
    let thrown: unknown;
    try {
      repository.commit(command('rollback', 1, aggregate));
    } catch (error) {
      thrown = error;
    }

    // Then
    expect(reachedTransactionStage).toBe(true);
    expectRepositoryError(thrown, 'repository_failure');
    if (!(thrown instanceof ConfigRepositoryError)) return;
    expect(thrown.cause).toBe(failure);
    expect(repository.getSnapshot().revision).toBe(1);
    expect(counts(dbPath)).toEqual({ revisions: 1, operations: 0, services: 0 });
  });

  test('rejects malformed commands and invalid aggregates before writing', () => {
    // Given
    const { repository, dbPath } = openRepository();
    const malformed = command(' bad', 1, EMPTY_AGGREGATE);
    const invalidAggregate = {
      ...command('invalid-aggregate', 1, EMPTY_AGGREGATE),
      aggregate: { ...EMPTY_AGGREGATE, logical_configuration: { services: 'bad', routes: [], plugins: [] } },
    };

    // When / Then
    expect(() => Reflect.apply(repository.commit, repository, [malformed])).toThrow(ConfigRepositoryError);
    expect(() => Reflect.apply(repository.commit, repository, [invalidAggregate])).toThrow(ConfigRepositoryError);
    expect(counts(dbPath)).toEqual({ revisions: 1, operations: 0, services: 0 });
  });

  test('two repository connections observe commits and enforce sequential CAS', () => {
    // Given
    const aggregate = richAggregate();
    const { repository: first, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    const second = openOfflineConfigurationRepository(dbPath, { compileOptions: COMPILE_OPTIONS });
    repositories.push(second);

    // When
    const committed = first.commit(command('writer-one', 1, aggregate));
    const stale = second.commit(command('writer-two', 1, aggregate));

    // Then
    expect(committed.kind).toBe('committed');
    expect(second.getSnapshot().revision).toBe(1);
    expect(stale).toEqual({ kind: 'stale_revision', expected_revision: 1, active_revision: 2 });
  });

  test('classifies SQLite base, extended, and unrelated error codes', () => {
    const withCode = (code: string): Error => Object.assign(new Error(code), { code });
    const withErrno = (errno: number): Error => Object.assign(new Error(String(errno)), { errno });

    expect(isSqliteBusyError(withCode('SQLITE_BUSY'))).toBe(true);
    expect(isSqliteBusyError(withCode('SQLITE_LOCKED'))).toBe(true);
    expect(isSqliteBusyError(withCode('SQLITE_BUSY_RECOVERY'))).toBe(true);
    expect(isSqliteBusyError(withCode('SQLITE_LOCKED_SHAREDCACHE'))).toBe(true);
    expect(isSqliteBusyError(withErrno(261))).toBe(true);
    expect(isSqliteBusyError(withErrno(262))).toBe(true);
    expect(isSqliteBusyError(withErrno(19))).toBe(false);
    expect(isSqliteBusyError(withCode('SQLITE_CONSTRAINT'))).toBe(false);
  });

  test('keeps DELETE-journal reader snapshots stable while a writer waits', async () => {
    const { repository, dbPath } = openRepository();
    const oldSnapshot = repository.getSnapshot();
    const writer = openProtocolChild(CONSISTENT_READ_WRITER_CHILD, dbPath);
    const writerLines = createJsonLineReader(writer.stdout);
    const writerStderr = new Response(writer.stderr).text();
    let reader: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
    try {
      expect(await writerLines()).toEqual({ event: 'ready' });
      reader = openProtocolChild(CONSISTENT_READ_READER_CHILD, dbPath);
      const readerLines = createJsonLineReader(reader.stdout);
      const readerStderr = new Response(reader.stderr).text();
      expect(await readerLines()).toMatchObject({ event: 'ready', snapshot: oldSnapshot, deferred: true, inTransaction: true });

      await sendChildCommand(writer, 'commit');
      expect(await writerLines()).toEqual({ event: 'attempting' });
      await sendChildByte(reader, 'p');
      expect(await readerLines()).toMatchObject({ event: 'stable', snapshot: oldSnapshot, inTransaction: true });
      expect(writer.exitCode).toBeNull();

      await sendChildByte(reader, 'r');
      expect(await readerLines()).toEqual({ event: 'released' });
      expect(await writerLines()).toEqual({ event: 'done', kind: 'committed' });
      expect(await writer.exited).toBe(0);
      expect(await reader.exited).toBe(0);
      expect(await writerStderr).toBe('');
      expect(await readerStderr).toBe('');
    } finally {
      if (writer.exitCode === null) writer.kill();
      if (reader?.exitCode === null) reader.kill();
    }

    const reopened = openOfflineConfigurationRepository(dbPath); repositories.push(reopened);
    const fresh = reopened.getSnapshot();
    expect(fresh.revision).toBe(2);
    expect(fresh.aggregate.logical_configuration.log_level).toBe('warn');
    expect(repository['db'].inTransaction).toBe(false);
  }, { timeout: 30_000 });

  test('returns repository_failure for a blocked consistent read and recovers the same connection', () => {
    const { repository, dbPath } = openRepository();
    const blocker = new Database(dbPath, { create: false, readwrite: true, strict: true });
    repository['db'].run('PRAGMA busy_timeout = 1');
    blocker.run('BEGIN EXCLUSIVE');

    let thrown: unknown;
    try {
      repository.getOperation('missing');
    } catch (error) {
      thrown = error;
    }
    expectRepositoryError(thrown, 'repository_failure');
    if (thrown instanceof ConfigRepositoryError) {
      expect(isSqliteBusyError(thrown.cause)).toBe(true);
      expect(thrown.cause).toMatchObject({ code: expect.stringMatching(/^SQLITE_(BUSY|LOCKED)/) });
    }
    expect(repository['db'].inTransaction).toBe(false);

    blocker.run('ROLLBACK');
    blocker.close(true);
    repository['db'].run('PRAGMA busy_timeout = 5000');
    expect(repository.getSnapshot().revision).toBe(1);
    expect(repository.commit(command('after-read-busy', 1, EMPTY_AGGREGATE)).kind).toBe('committed');
    expect(repository['db'].inTransaction).toBe(false);
  });

  test('serializes concurrent initial opens and migrations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-concurrent-migration-'));
    tempRoots.push(root);
    const dbPath = join(root, 'config.db');
    const outcomes = await Promise.all([runConcurrentOpenChild(dbPath), runConcurrentOpenChild(dbPath)]);

    expect(outcomes).toEqual([{ ok: true, revision: 1 }, { ok: true, revision: 1 }]);
    const repository = openOfflineConfigurationRepository(dbPath);
    repositories.push(repository);
    expect(repository.getSnapshot().revision).toBe(1);
    expect(repository['db'].inTransaction).toBe(false);
  }, { timeout: 30_000 });

  test('classifies SQLite busy errors and keeps the repository usable after release', () => {
    const { repository, dbPath } = openRepository();
    const blocker = new Database(dbPath, { create: false, readwrite: true, strict: true });
    repository['db'].run('PRAGMA busy_timeout = 1');
    blocker.run('BEGIN IMMEDIATE');

    let thrown: unknown;
    try {
      repository.commit(command('busy', 1, EMPTY_AGGREGATE));
    } catch (error) {
      thrown = error;
    }
    expectRepositoryError(thrown, 'repository_failure');
    expect(thrown).toMatchObject({ cause: expect.any(Error) });
    expect(repository['db'].inTransaction).toBe(false);

    blocker.run('ROLLBACK');
    blocker.close(true);
    repository['db'].run('PRAGMA busy_timeout = 5000');
    expect(repository.commit(command('after-busy', 1, EMPTY_AGGREGATE)).kind).toBe('committed');
    expect(repository['db'].inTransaction).toBe(false);
  });

  test('classifies a blocked consistent read and keeps the repository usable after release', () => {
    const { repository, dbPath } = openRepository();
    const blocker = new Database(dbPath, { create: false, readwrite: true, strict: true });
    repository['db'].run('PRAGMA busy_timeout = 1');
    blocker.run('BEGIN EXCLUSIVE');

    let thrown: unknown;
    try {
      repository.getOperation('missing');
    } catch (error) {
      thrown = error;
    }
    expectRepositoryError(thrown, 'repository_failure');
    if (thrown instanceof ConfigRepositoryError) {
      expect(isSqliteBusyError(thrown.cause)).toBe(true);
      expect(thrown.cause).toMatchObject({ code: expect.stringMatching(/^SQLITE_(BUSY|LOCKED)/) });
    }
    expect(repository['db'].inTransaction).toBe(false);

    blocker.run('ROLLBACK');
    blocker.close(true);
    repository['db'].run('PRAGMA busy_timeout = 5000');
    expect(repository.getSnapshot().revision).toBe(1);
    expect(repository.commit(command('after-read-busy', 1, EMPTY_AGGREGATE)).kind).toBe('committed');
    expect(repository['db'].inTransaction).toBe(false);
  });
});

describe('ConfigRepository schema enforcement and corruption handling', () => {
  test('routine reads avoid database page scans while explicit integrity checks still run them', () => {
    const { repository } = openRepository();
    const db = repository.getDatabase();
    const prepare = db.prepare.bind(db);
    const scanFailure = new Error('database page scan unavailable');
    const intercept = spyOn(db, 'prepare').mockImplementation((sql: string, ...args: any[]) => {
      if (sql === 'PRAGMA integrity_check') throw scanFailure;
      return prepare(sql, ...args);
    });
    try {
      expect(repository.getSnapshot().revision).toBe(1);
      expect(repository.getCurrentRecovery()).toBeNull();
      expect(() => verifyRepositoryIntegrity(db)).toThrow(scanFailure.message);
    } finally {
      intercept.mockRestore();
    }
  });

  test('creates STRICT tables whose checks and concrete foreign keys reject invalid writes', () => {
    // Given
    const { dbPath } = openRepository();
    const inspector = new Database(dbPath, { readwrite: true, strict: true });
    inspector.run('PRAGMA foreign_keys = ON');
    inspector.run('PRAGMA busy_timeout = 5000');
    const definitions = inspector.query<{ name: string; sql: string }, []>(`SELECT name,sql FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();

    // When / Then
    expect(definitions).toHaveLength(14);
    expect(definitions.every(({ sql }) => sql.includes('STRICT'))).toBe(true);
    expect(() => inspector.run(`INSERT INTO services (id,position,name,policy_json)
      VALUES ('10000000-0000-4000-8000-000000000099','wrong','bad','{}')`)).toThrow();
    expect(() => inspector.run(`INSERT INTO configuration_revisions
      (revision,content_hash,kind,created_at) VALUES (2,'sha256:ABC','config',1)`)).toThrow();
    expect(() => inspector.run(`INSERT INTO routes (id,position,path,service_id,policy_json)
      VALUES ('20000000-0000-4000-8000-000000000099',0,'/missing','10000000-0000-4000-8000-000000000099','{}')`)).toThrow();
    expect(() => inspector.run(`INSERT INTO upstreams
      (id,owner_kind,service_id,route_id,position,target,weight,priority,is_disabled,policy_json)
      VALUES ('30000000-0000-4000-8000-000000000099','service',NULL,NULL,0,'https://bad',1,1,0,'{}')`)).toThrow();
    expect(() => inspector.run(`INSERT INTO plugin_bindings
      (id,scope_kind,scope_owner,service_id,route_id,upstream_id,position,plugin_name,options_json,enabled)
      VALUES ('40000000-0000-4000-8000-000000000099','service','missing',NULL,NULL,NULL,0,'audit',NULL,1)`)).toThrow();
    expect(() => inspector.run(`INSERT INTO plugin_activations (plugin_name) VALUES ('Bad Name')`)).toThrow();
    expect(() => inspector.run(`INSERT INTO plugin_activations (plugin_name) VALUES ('bad/name')`)).toThrow();
    expect(() => inspector.run(`INSERT INTO configuration_revisions
      (revision,content_hash,kind,created_at) VALUES (9007199254740992,
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','config',1)`)).toThrow();
    expect(() => inspector.run(`INSERT INTO services (id,position,name,policy_json)
      VALUES ('10000000-0000-4000-8000-000000000098',9007199254740992,'unsafe','{}')`)).toThrow();
    inspector.close(true);
  });

  test('enforces safe integer bounds on every persisted repository integer contract', () => {
    // Given
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    repository.commit(command('integer-checks', 1, richAggregate()));
    const inspector = new Database(dbPath, { readwrite: true, strict: true });
    inspector.run('PRAGMA foreign_keys=ON');
    inspector.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,attempt_no,last_begin_previous_attempt_no,last_begin_reason,
       state,applied_revision,last_error,updated_at)
      VALUES ('integer-checks',9,2,0,NULL,NULL,'pending',NULL,NULL,1700000000001)`);
    const unsafe = '9007199254740992';
    const mutations = [
      `UPDATE configuration_state SET active_revision=${unsafe}`,
      `UPDATE configuration_revisions SET revision=${unsafe} WHERE revision=2`,
      `UPDATE configuration_revisions SET created_at=${unsafe} WHERE revision=2`,
      `UPDATE configuration_operations SET expected_revision=${unsafe}`,
      `UPDATE configuration_operations SET committed_revision=${unsafe}`,
      `UPDATE configuration_operations SET created_at=${unsafe},updated_at=${unsafe}`,
      `UPDATE configuration_operation_workers SET worker_slot=${unsafe}`,
      `UPDATE configuration_operation_workers SET attempt_no=${unsafe}`,
      `UPDATE services SET position=${unsafe}`,
      `UPDATE routes SET position=${unsafe}`,
      `UPDATE upstreams SET position=${unsafe}`,
      `UPDATE plugin_bindings SET position=${unsafe}`,
    ] as const;

    // When / Then
    for (const sql of mutations) expect(() => inspector.run(sql)).toThrow();
    expect(() => inspector.run(`INSERT INTO configuration_operation_workers
      (mutation_id,worker_slot,target_revision,attempt_no,last_begin_previous_attempt_no,last_begin_reason,
       state,applied_revision,last_error,updated_at)
      VALUES ('integer-checks',10,${unsafe},0,NULL,NULL,'pending',NULL,NULL,1700000000001)`)).toThrow();
    inspector.close(true);
  });

  test('fails closed when persisted positions and operation metadata are not safe integers', () => {
    // Given
    const corruptions = [
      'UPDATE services SET position=9007199254740992',
      'UPDATE configuration_operations SET expected_revision=9007199254740992',
      'UPDATE configuration_operations SET created_at=9007199254740992,updated_at=9007199254740992',
    ] as const;

    // When / Then
    for (const sql of corruptions) {
      const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
      repository.commit(command('safe-integers', 1, richAggregate()));
      repository.close();
      repositories.splice(repositories.indexOf(repository), 1);
      const corruptor = new Database(dbPath, { readwrite: true, strict: true });
      corruptor.run('PRAGMA ignore_check_constraints=ON');
      corruptor.run(sql);
      corruptor.close(true);
      expect(() => openOfflineConfigurationRepository(dbPath, { compileOptions: COMPILE_OPTIONS })).toThrow(ConfigRepositoryError);
    }
  });

  test('fails closed when constrained normalized row values are corrupted', () => {
    // Given
    const corruptions = [
      "UPDATE upstreams SET owner_kind='other'",
      'UPDATE upstreams SET is_disabled=2',
      'UPDATE upstreams SET weight=1e999',
      "UPDATE plugin_bindings SET scope_kind='other'",
      'UPDATE plugin_bindings SET enabled=2',
      "UPDATE plugin_bindings SET plugin_name='Invalid Name'",
      "UPDATE services SET id='not-a-uuid'",
    ] as const;

    // When / Then
    for (const sql of corruptions) {
      const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
      repository.commit(command('row-validation', 1, richAggregate()));
      const connection = repository['db'];
      connection.run('PRAGMA foreign_keys=OFF');
      connection.run('PRAGMA ignore_check_constraints=ON');
      connection.run(sql);
      connection.run('PRAGMA ignore_check_constraints=OFF');
      connection.run('PRAGMA foreign_keys=ON');
      expect(() => repository.verify()).toThrow(ConfigRepositoryError);
    }
  });

  test('fails closed on unconsumed relation rows at every owner scope', () => {
    // Given
    const mutations = [
      `INSERT INTO upstreams
        (id,owner_kind,service_id,route_id,position,target,weight,priority,is_disabled,policy_json)
        VALUES ('30000000-0000-4000-8000-000000000099','route',NULL,'${IDS.serviceRoute}',99,'https://ignored.example.com',1,1,0,'{}')`,
      `INSERT INTO plugin_bindings
        (id,scope_kind,scope_owner,service_id,route_id,upstream_id,position,plugin_name,options_json,enabled)
        VALUES ('40000000-0000-4000-8000-000000000091','service','10000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000099',NULL,NULL,1,'audit',NULL,1)`,
      `INSERT INTO plugin_bindings
        (id,scope_kind,scope_owner,service_id,route_id,upstream_id,position,plugin_name,options_json,enabled)
        VALUES ('40000000-0000-4000-8000-000000000092','route','20000000-0000-4000-8000-000000000099',NULL,'20000000-0000-4000-8000-000000000099',NULL,1,'audit',NULL,1)`,
      `INSERT INTO plugin_bindings
        (id,scope_kind,scope_owner,service_id,route_id,upstream_id,position,plugin_name,options_json,enabled)
        VALUES ('40000000-0000-4000-8000-000000000093','upstream','30000000-0000-4000-8000-000000000099',NULL,NULL,'30000000-0000-4000-8000-000000000099',1,'audit',NULL,1)`,
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
      repository.commit(command('unconsumed-row', 1, richAggregate()));
      const connection = repository['db'];
      connection.run('PRAGMA foreign_keys=OFF');
      connection.run(sql);
      connection.run('PRAGMA foreign_keys=ON');
      expect(() => repository.verify()).toThrow(ConfigRepositoryError);
    }
  });

  test('fails closed when policy JSON contains materialized reserved keys', () => {
    // Given
    const mutations = [
      `UPDATE services SET policy_json='{"endpoints":[],"id":"shadow"}'`,
      `UPDATE routes SET policy_json='{"path":"/shadow","plugins":[]}'`,
      `UPDATE upstreams SET policy_json='{"target":"https://shadow.example.com","weight":9}'`,
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
      repository.commit(command('reserved-policy', 1, richAggregate()));
      const connection = repository['db'];
      connection.run(sql);
      expect(() => repository.verify()).toThrow(ConfigRepositoryError);
    }
  });

  test('fails closed when any persisted JSON text is not exactly canonical', () => {
    // Given
    const mutations = [
      `UPDATE settings SET auth_json='{ "tokens": ["literal-token"], "enabled": true }'`,
      `UPDATE settings SET logging_json='{"body":{"retention_days":3,"max_size":2048,"enabled":true}}'`,
      `UPDATE services SET policy_json='{"health_check": {"enabled":true}}'`,
      `UPDATE routes SET policy_json='{"retry":{"max_retries":2,"enabled":true}}' WHERE id='${IDS.serviceRoute}'`,
      `UPDATE upstreams SET policy_json='{"headers":{"add":{"authorization":"secret"}},"description":"service owner"}' WHERE id='${IDS.serviceUpstream}'`,
      `UPDATE plugin_bindings SET options_json='{ "level": "info" }' WHERE options_json IS NOT NULL`,
    ] as const;

    // When / Then
    for (const sql of mutations) {
      const { repository } = openRepository({ compileOptions: COMPILE_OPTIONS });
      repository.commit(command('canonical-json', 1, richAggregate()));
      repository['db'].run(sql);
      expect(() => repository.verify()).toThrow(ConfigRepositoryError);
    }
  });

  test('rejects revision increment beyond the JavaScript safe integer range without writes', () => {
    // Given
    const { repository, dbPath } = openRepository();
    const corruptor = repository['db'];
    corruptor.run(`INSERT INTO configuration_revisions (revision,content_hash,kind,created_at)
      VALUES (9007199254740991,'sha256:940d0b92023c44d9446da69bcd50f522cccd62a4e6dae6e0b1cc582ea2fa03e1','config',1)`);
    corruptor.run('UPDATE configuration_state SET active_revision=9007199254740991 WHERE id=1');

    // When / Then
    expect(() => repository.commit(command('revision-overflow', Number.MAX_SAFE_INTEGER, EMPTY_AGGREGATE))).toThrow(ConfigRepositoryError);
    expect(counts(dbPath).revisions).toBe(2);
  });

  test('fails closed when normalized JSON no longer matches its committed hash', () => {
    // Given
    const { repository, dbPath } = openRepository({ compileOptions: COMPILE_OPTIONS });
    repository.commit(command('corrupt-policy-source', 1, richAggregate()));
    repository.close();
    repositories.splice(repositories.indexOf(repository), 1);
    const corruptor = new Database(dbPath, { readwrite: true, strict: true });
    corruptor.run(`UPDATE services SET policy_json='{"health_check":{"enabled":true}}'`);
    corruptor.close(true);

    // When / Then
    expect(() => openOfflineConfigurationRepository(dbPath, { compileOptions: COMPILE_OPTIONS })).toThrow(ConfigRepositoryError);
  });

  test('fails closed for malformed JSON, FK mismatch, and invalid migration history', () => {
    // Given
    const corruptions = [
      "PRAGMA ignore_check_constraints=ON; UPDATE settings SET auth_json='{' WHERE id=1",
      'PRAGMA foreign_keys=OFF; UPDATE configuration_state SET active_revision=99 WHERE id=1',
      "UPDATE configuration_revisions SET content_hash='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE revision=1",
      "INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES (2,'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','config',1)",
      "UPDATE schema_migrations SET version=2 WHERE version=1",
      "INSERT INTO schema_migrations(version,name) VALUES (2,'future')",
      "UPDATE schema_migrations SET name='wrong-prefix' WHERE version=1",
      "UPDATE schema_migrations SET name='wrong-prefix' WHERE version=1",
    ] as const;

    // When / Then
    for (const sql of corruptions) {
      const { repository, dbPath } = openRepository();
      repository.close();
      repositories.splice(repositories.indexOf(repository), 1);
      const corruptor = new Database(dbPath, { readwrite: true, strict: true });
      corruptor.run(sql);
      corruptor.close(true);
      try {
        openOfflineConfigurationRepository(dbPath);
        throw new Error('corrupt database unexpectedly opened');
      } catch (error) {
        expectRepositoryError(error, 'schema_corrupt');
      }
    }
  });
});
