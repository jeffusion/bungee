import { describe, expect, test } from 'bun:test';
import {
  ConfigPublicationMessageError,
  parseConfigMasterMessage as parseStrictConfigMasterMessage,
  parseConfigWorkerMessage as parseStrictConfigWorkerMessage,
  type ConfigPublicationMessageErrorCode,
} from '../../src/config-publication/messages';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import type { Sha256Digest } from '@jeffusion/bungee-types';

const REQUEST_HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH = `sha256:${'b'.repeat(64)}`;
const PLUGIN_CATALOG_HASH: Sha256Digest = `sha256:${'c'.repeat(64)}`;

function aggregate(routes: unknown[] = [], pluginActivations: Array<{ plugin_name: string }> = []) {
  return {
    logical_configuration: { services: [], routes, plugins: [] },
    plugin_activations: pluginActivations,
  };
}

function directRoute(index: number) {
  const suffix = index.toString(16).padStart(12, '0');
  return {
    id: `20000000-0000-4000-8000-${suffix}`,
    position: index,
    path: `/route-${index}`,
    direct_response: { enabled: true, status: 200 },
  };
}

function contentHash(value: unknown) {
  const parsed = parseNormalizeCompileAggregate(value);
  if (!parsed.ok) throw new Error('test aggregate must compile');
  return hashConfigurationContent(parsed.value);
}

const HASH = contentHash(aggregate());

function operation(
  state: 'committed' | 'publishing' | 'draining' | 'converged' | 'degraded' = 'committed',
  errorCode: 'replacement_convergence_failed' | 'old_worker_drain_failed' | null = null,
) {
  const recovering = state === 'draining'
    || (state === 'degraded' && errorCode === 'old_worker_drain_failed');
  return {
    mutation_id: 'mutation-1', request_hash: REQUEST_HASH, expected_revision: 1,
    committed_revision: 2, kind: 'config', target_worker_count: 2,
    drain_recovery_generation: recovering ? 3 : 0,
    last_drain_recovery_previous_generation: recovering ? 2 : null,
    created_at: 10, updated_at: 11, state,
    result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null,
    error_code: errorCode,
    error_detail: state === 'degraded' ? 'worker 2 did not converge' : null,
  };
}

const PUBLICATION = {
  mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 3,
};

const PROCESS_IDENTITY = {
  master_generation: 'a0000000-0000-4000-8000-000000000001',
  worker_instance_id: 'b0000000-0000-4000-8000-000000000001',
  worker_slot: 1,
};
const SLOT_ZERO_IDENTITY = { ...PROCESS_IDENTITY, worker_slot: 0 };

function parseConfigMasterMessage(input: unknown) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return parseStrictConfigMasterMessage(input);
  }
  const message = input as Record<string, unknown>;
  const aggregateValue = message.aggregate as { plugin_activations?: Array<{ plugin_name?: unknown }> } | undefined;
  const activatedPluginNames = aggregateValue?.plugin_activations?.map(({ plugin_name }) => plugin_name) ?? [];
  return parseStrictConfigMasterMessage({
    ...PROCESS_IDENTITY,
    ...message,
    ...((message.command === 'start-config-worker' || message.command === 'start-current-config-worker')
      && !('activated_plugin_names' in message)
      ? { activated_plugin_names: activatedPluginNames }
      : {}),
  });
}

function parseConfigWorkerMessage(input: unknown) {
  return parseStrictConfigWorkerMessage(typeof input === 'object' && input !== null && !Array.isArray(input)
    ? { ...PROCESS_IDENTITY, ...input }
    : input);
}

function expectInvalid(
  parse: (input: unknown) => unknown,
  input: unknown,
  code: ConfigPublicationMessageErrorCode,
): void {
  try {
    parse(input);
    throw new Error('expected parser to reject input');
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigPublicationMessageError);
    if (error instanceof ConfigPublicationMessageError) expect(error.code).toBe(code);
  }
}

describe('config publication master-to-worker messages', () => {
  test('requires immutable canonical activated plugin names matching the aggregate', () => {
    const value = aggregate([], [{ plugin_name: 'alpha' }, { plugin_name: 'zeta' }]);
    const valid = {
      command: 'start-current-config-worker', ...SLOT_ZERO_IDENTITY, revision: 1,
      content_hash: contentHash(value), plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      aggregate: value, activated_plugin_names: ['alpha', 'zeta'], publication: null,
    } as const;

    const parsed = parseStrictConfigMasterMessage(valid);
    if (!('activated_plugin_names' in parsed)) throw new Error('expected start command');
    expect(parsed.activated_plugin_names).toEqual(['alpha', 'zeta']);
    expect(Object.isFrozen(parsed.activated_plugin_names)).toBe(true);
    const { activated_plugin_names: _activatedPluginNames, ...missing } = valid;
    for (const input of [
      missing,
      { ...valid, activated_plugin_names: [] },
      { ...valid, activated_plugin_names: ['zeta', 'alpha'] },
      { ...valid, activated_plugin_names: ['alpha', 'alpha'] },
      { ...valid, activated_plugin_names: ['alpha', 'not valid'] },
    ]) expectInvalid(parseStrictConfigMasterMessage, input, 'invalid_message');
  });

  test.each([
    ['publication', {
      command: 'start-config-worker', worker_slot: 0, revision: 1, publication: PUBLICATION,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, aggregate: aggregate(),
    }],
    ['current', {
      command: 'start-current-config-worker', worker_slot: 0, revision: 1, publication: null,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, aggregate: aggregate(),
    }],
  ])('parses exact %s start shape', (_kind, input) => {
    expect(parseConfigMasterMessage(input)).toMatchObject(input);
  });

  test('rejects an unknown start field', () => {
    const valid = {
      command: 'start-config-worker', worker_slot: 0, revision: 1, publication: PUBLICATION,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, aggregate: aggregate(),
    };

    expectInvalid(parseConfigMasterMessage, { ...valid, unknown_field: false }, 'invalid_message');
  });

  test('requires an exact plugin catalog hash on start and drain commands', () => {
    const start = {
      command: 'start-config-worker', worker_slot: 0, revision: 1, publication: PUBLICATION,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, aggregate: aggregate(),
    };
    const drain = {
      command: 'drain-worker', worker_slot: 0, revision: 1, publication: PUBLICATION,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
    };
    const { plugin_catalog_hash: _startCatalog, ...startWithoutCatalog } = start;
    const { plugin_catalog_hash: _drainCatalog, ...drainWithoutCatalog } = drain;

    expect(parseConfigMasterMessage(start)).toMatchObject({ plugin_catalog_hash: PLUGIN_CATALOG_HASH });
    expect(parseConfigMasterMessage(drain)).toMatchObject({ plugin_catalog_hash: PLUGIN_CATALOG_HASH });
    for (const input of [
      startWithoutCatalog,
      { ...start, plugin_catalog_hash: OTHER_HASH.toUpperCase() },
      drainWithoutCatalog,
    ]) expectInvalid(parseConfigMasterMessage, input, 'invalid_message');
  });

  test('requires exact canonical process identity on master messages', () => {
    const valid = {
      command: 'drain-worker', ...SLOT_ZERO_IDENTITY, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    } as const;

    expect(parseStrictConfigMasterMessage(valid)).toEqual(valid);
    for (const input of [
      { command: 'drain-worker', worker_slot: 0, revision: 8, content_hash: HASH, publication: PUBLICATION },
      { ...valid, master_generation: PROCESS_IDENTITY.master_generation.toUpperCase() },
      { ...valid, worker_instance_id: 'not-a-uuid' },
      { ...valid, worker_slot: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, extra: true },
    ]) expectInvalid(parseStrictConfigMasterMessage, input, 'invalid_message');
  });

  test('parses an owned start command and a representative large aggregate', () => {
    // Given
    const routes = Array.from({ length: 320 }, (_, index) => directRoute(index));
    const input = {
      command: 'start-config-worker', worker_slot: 0, revision: 7, publication: PUBLICATION,
      content_hash: contentHash(aggregate(routes)), plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      aggregate: aggregate(routes),
    };

    // When
    const parsed = parseConfigMasterMessage(input);
    input.aggregate.logical_configuration.routes.splice(0);

    // Then
    expect('command' in parsed && parsed.command).toBe('start-config-worker');
    if (!('command' in parsed) || parsed.command !== 'start-config-worker') return;
    expect(parsed.aggregate.logical_configuration.routes).toHaveLength(320);
    expect(parsed.aggregate.logical_configuration.routes[319]?.path).toBe('/route-319');
    expect(parsed.aggregate).not.toBe(input.aggregate);
    expect(parsed.publication).toEqual(PUBLICATION);
  });

  test('parses current snapshot startup only with explicit null publication identity', () => {
    const input = {
      command: 'start-current-config-worker', worker_slot: 0, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      aggregate: aggregate(), publication: null,
    };

    expect(parseConfigMasterMessage(input)).toMatchObject(input);
  });

  test('parses drain commands without overloading shutdown', () => {
    expect(parseConfigMasterMessage({
      command: 'drain-worker', ...PROCESS_IDENTITY, worker_slot: 2, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    })).toEqual({ command: 'drain-worker', ...PROCESS_IDENTITY, worker_slot: 2, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION });
  });

  test('rejects malformed start fields, aliases, and unknown fields deterministically', () => {
    const valid = {
      command: 'start-config-worker', ...SLOT_ZERO_IDENTITY, revision: 1, publication: PUBLICATION,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, aggregate: aggregate(),
    };
    for (const input of [
      { ...valid, worker_slot: -1 },
      { ...valid, revision: 0 },
      { ...valid, content_hash: `sha256:${'A'.repeat(64)}` },
      { ...valid, content_hash: OTHER_HASH },
      { ...valid, unknown_field: 'unexpected' },
      { ...valid, workerSlot: 0 },
      { ...valid, aggregate: { ...aggregate(), extra: true } },
      { ...valid, publication: null },
      { ...valid, publication: { ...PUBLICATION, attempt_no: 0 } },
      { ...valid, publication: { ...PUBLICATION, attempt_no: Number.MAX_SAFE_INTEGER + 1 } },
      { ...valid, publication: { ...PUBLICATION, drain_recovery_generation: -1 } },
      { ...valid, publication: { ...PUBLICATION, mutation_id: ' invalid' } },
      { ...valid, publication: { ...PUBLICATION, extra: true } },
      { command: 'start-current-config-worker', worker_slot: 0, revision: 1,
        content_hash: HASH, aggregate: aggregate(), publication: PUBLICATION },
      { command: 'start-current-config-worker', worker_slot: 0, revision: 1,
        content_hash: HASH, aggregate: aggregate() },
    ]) expectInvalid(parseConfigMasterMessage, input, 'invalid_message');
  });

  test('rejects the pre-fencing publication start shape', () => {
    expectInvalid(parseConfigMasterMessage, {
      command: 'start-config-worker', ...SLOT_ZERO_IDENTITY, revision: 1,
      content_hash: HASH, aggregate: aggregate(),
    }, 'invalid_message');
  });

  test('rejects unsafe JSON graphs without invoking accessors or proxy traps', () => {
    let getterCalls = 0;
    const accessor = { ...aggregate() };
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get() { getterCalls += 1; return 'no'; },
    });
    const throwingProxy = new Proxy({}, { ownKeys() { throw new Error('trap'); } });
    const publicationProxy = new Proxy({}, { ownKeys() { throw new Error('publication trap'); } });
    const accessorPublication = { attempt_no: 2, drain_recovery_generation: 3 };
    Object.defineProperty(accessorPublication, 'mutation_id', {
      enumerable: true,
      get() { getterCalls += 1; return 'mutation-1'; },
    });
    const base = {
      command: 'start-config-worker', ...SLOT_ZERO_IDENTITY, revision: 1,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    };

    expectInvalid(parseConfigMasterMessage, { ...base, aggregate: accessor }, 'unsafe_message');
    expectInvalid(parseConfigMasterMessage, {
      ...base, aggregate: aggregate(), publication: accessorPublication,
    }, 'unsafe_message');
    expectInvalid(parseConfigMasterMessage, {
      ...base, aggregate: aggregate(), publication: publicationProxy,
    }, 'unsafe_message');
    expectInvalid(parseStrictConfigMasterMessage, throwingProxy, 'unsafe_message');
    expect(getterCalls).toBe(0);
  });

  test('rejects symbol, sparse, exotic, and cyclic message graphs', () => {
    const symbolAggregate = aggregate();
    Object.defineProperty(symbolAggregate, Symbol('hidden'), { value: true, enumerable: true });
    const sparseRoutes = new Array<unknown>(2);
    sparseRoutes[1] = directRoute(1);
    const cyclicAggregate: Record<string, unknown> = aggregate();
    cyclicAggregate.self = cyclicAggregate;
    const base = {
      command: 'start-config-worker', worker_slot: 0, revision: 1,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    };

    for (const unsafeAggregate of [symbolAggregate, aggregate(sparseRoutes), new Date(0), cyclicAggregate]) {
      expectInvalid(parseConfigMasterMessage, { ...base, aggregate: unsafeAggregate }, 'unsafe_message');
    }
  });

  test('keeps legacy shutdown and plugin runtime messages outside this contract', () => {
    expectInvalid(parseConfigMasterMessage, { command: 'shutdown' }, 'invalid_message');
    expectInvalid(parseConfigMasterMessage, { command: 'reconcile-plugin-runtime', generation: 1 }, 'invalid_message');
  });

  test('parses correlated control responses with structural conflict and uncertainty outcomes', () => {
    expect(parseConfigMasterMessage({
      status: 'config-control-response', ...SLOT_ZERO_IDENTITY, request_id: 'req-1',
      result: {
        kind: 'error', http_status: 409, code: 'stale_revision', outcome_unknown: false,
        expected_revision: 7, active_revision: 8,
      },
    })).toEqual({
      status: 'config-control-response', ...SLOT_ZERO_IDENTITY, request_id: 'req-1',
      result: {
        kind: 'error', http_status: 409, code: 'stale_revision', outcome_unknown: false,
        expected_revision: 7, active_revision: 8,
      },
    });
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-2',
      result: { kind: 'error', http_status: 503, code: 'repository_unavailable', outcome_unknown: true },
    })).toMatchObject({ result: { http_status: 503, outcome_unknown: true } });
    expectInvalid(parseConfigMasterMessage, {
      status: 'config-control-response', request_id: 'req-3',
      result: { kind: 'error', http_status: 422, code: 'invalid_configuration', outcome_unknown: true },
    }, 'invalid_message');
  });

  test('parses repository-mappable commit and operation results', () => {
    const committed = parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-7',
      result: {
        kind: 'commit', outcome: 'committed',
        snapshot: { revision: 2, content_hash: HASH, aggregate: aggregate() },
        operation: operation(),
      },
    });
    expect(committed).toMatchObject({
      result: { kind: 'commit', outcome: 'committed', snapshot: { revision: 2, content_hash: HASH } },
    });
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-8',
      result: { kind: 'operation', operation: operation('converged') },
    })).toMatchObject({ result: { kind: 'operation', operation: { state: 'converged', result_status: 200 } } });
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-9',
      result: { kind: 'operation', operation: null },
    })).toMatchObject({ result: { kind: 'operation', operation: null } });
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-10',
      result: { kind: 'commit', outcome: 'duplicate', operation: operation() },
    })).toMatchObject({ result: { kind: 'commit', outcome: 'duplicate' } });
  });

  test('parses every durable operation state and exact degraded error code', () => {
    for (const state of ['committed', 'publishing', 'draining', 'converged'] as const) {
      const parsed = parseConfigMasterMessage({
        status: 'config-control-response', request_id: `req-${state}`,
        result: { kind: 'operation', operation: operation(state) },
      });
      expect(parsed).toMatchObject({ result: { kind: 'operation', operation: { state } } });
    }
    for (const code of ['replacement_convergence_failed', 'old_worker_drain_failed'] as const) {
      const parsed = parseConfigMasterMessage({
        status: 'config-control-response', request_id: `req-${code}`,
        result: { kind: 'operation', operation: operation('degraded', code) },
      });
      expect(parsed).toMatchObject({
        result: { kind: 'operation', operation: { state: 'degraded', error_code: code } },
      });
    }
  });

  test('rejects incoherent durable operation metadata and result fields', () => {
    const valid = operation('draining');
    for (const candidate of [
      { ...valid, drain_recovery_generation: -1 },
      { ...valid, last_drain_recovery_previous_generation: 3 },
      { ...valid, last_drain_recovery_previous_generation: -1 },
      { ...valid, error_detail: 'unexpected' },
      { ...operation('degraded', 'old_worker_drain_failed'), error_detail: null },
      { ...operation('degraded', 'old_worker_drain_failed'), error_detail: 'x'.repeat(513) },
      { ...operation('degraded'), error_code: 'worker_convergence_failed' },
      { ...valid, unknown: true },
    ]) {
      expectInvalid(parseConfigMasterMessage, {
        status: 'config-control-response', request_id: 'req-invalid-operation',
        result: { kind: 'operation', operation: candidate },
      }, 'invalid_message');
    }
    const initialDrainFailure = {
      ...operation('degraded', 'old_worker_drain_failed'),
      drain_recovery_generation: 0,
      last_drain_recovery_previous_generation: null,
      error_detail: ' drain failed ',
    };
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-initial-drain-failure',
      result: { kind: 'operation', operation: initialDrainFailure },
    })).toMatchObject({
      result: { kind: 'operation', operation: { error_detail: ' drain failed ' } },
    });
  });

  test('requires exact repository error details for each status and code', () => {
    expect(parseConfigMasterMessage({
      status: 'config-control-response', request_id: 'req-11',
      result: {
        kind: 'error', http_status: 409, code: 'operation_in_progress', outcome_unknown: false,
        mutation_id: 'mutation-1', committed_revision: 2, operation_state: 'draining',
      },
    })).toMatchObject({ result: { code: 'operation_in_progress', operation_state: 'draining' } });
    expectInvalid(parseConfigMasterMessage, {
      status: 'config-control-response', request_id: 'req-12',
      result: { kind: 'error', http_status: 403, code: 'next_auth_required', outcome_unknown: false },
    }, 'invalid_message');
    expectInvalid(parseConfigMasterMessage, {
      status: 'config-control-response', request_id: 'req-13',
      result: { kind: 'error', http_status: 409, code: 'idempotency_key_reused', outcome_unknown: false },
    }, 'invalid_message');
    expectInvalid(parseConfigMasterMessage, {
      status: 'config-control-response', request_id: 'req-14',
      result: { kind: 'operation', operation: { ...operation(), result_status: 200 } },
    }, 'invalid_message');
  });
});

describe('config publication worker-to-master messages', () => {
  test('requires exact catalog and private port evidence on ready messages', () => {
    const ready = {
      status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 65535,
      plugin_runtime_generation: 0, required_plugins: [], serving_plugins: [], publication: PUBLICATION,
    };
    const { plugin_catalog_hash: _readyCatalog, ...readyWithoutCatalog } = ready;

    expect(parseConfigWorkerMessage(ready)).toMatchObject({
      plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 65535,
    });
    for (const private_port of [0, 65536, 1.5, '41000']) {
      expectInvalid(parseConfigWorkerMessage, { ...ready, private_port }, 'invalid_message');
    }
    expectInvalid(parseConfigWorkerMessage, readyWithoutCatalog, 'invalid_message');
  });

  test('requires target catalog hash on apply failure and serving catalog hash on drained ACK', () => {
    const failed = {
      status: 'config-apply-failed', worker_slot: 1, pid: 42,
      target_revision: 8, target_content_hash: OTHER_HASH,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: null, serving_content_hash: null,
      failed_plugins: [], error: 'start failed', publication: PUBLICATION,
    };
    const drained = {
      status: 'worker-drained', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    };
    const { target_plugin_catalog_hash: _failedCatalog, ...failedWithoutCatalog } = failed;
    const { plugin_catalog_hash: _drainedCatalog, ...drainedWithoutCatalog } = drained;

    expect(parseConfigWorkerMessage(failed)).toMatchObject({ target_plugin_catalog_hash: PLUGIN_CATALOG_HASH });
    expect(parseConfigWorkerMessage(drained)).toMatchObject({ plugin_catalog_hash: PLUGIN_CATALOG_HASH });
    expectInvalid(parseConfigWorkerMessage, failedWithoutCatalog, 'invalid_message');
    expectInvalid(parseConfigWorkerMessage, drainedWithoutCatalog, 'invalid_message');
  });

  test('requires one exact canonical process identity on every worker message', () => {
    // Given
    const valid = {
      status: 'worker-drained', ...PROCESS_IDENTITY, pid: 99, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    } as const;

    // When / Then
    expect(parseStrictConfigWorkerMessage(valid)).toEqual(valid);
    for (const input of [
      { status: 'worker-drained', worker_slot: 1, pid: 99, revision: 8 },
      { ...valid, master_generation: PROCESS_IDENTITY.master_generation.toUpperCase() },
      { ...valid, worker_instance_id: 'not-a-uuid' },
      { ...valid, worker_slot: -1 },
      { ...valid, process_identity: PROCESS_IDENTITY },
    ]) expectInvalid(parseStrictConfigWorkerMessage, input, 'invalid_message');
  });

  test('parses ready ACK with canonical plugin arrays', () => {
    const parsed = parseConfigWorkerMessage({
      status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41001,
      plugin_runtime_generation: 0,
      required_plugins: ['alpha', 'zeta-2'], serving_plugins: ['alpha'], publication: PUBLICATION,
    });
    expect(parsed).toMatchObject({ status: 'config-ready', required_plugins: ['alpha', 'zeta-2'] });
    expectInvalid(parseConfigWorkerMessage, {
      status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41001,
      plugin_runtime_generation: 0,
      required_plugins: ['zeta', 'alpha'], serving_plugins: [], publication: PUBLICATION,
    }, 'invalid_message');
    expectInvalid(parseConfigWorkerMessage, {
      status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [],
    }, 'invalid_message');
    for (const publication of [
      undefined,
      { ...PUBLICATION, attempt_no: 0 },
      { ...PUBLICATION, drain_recovery_generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...PUBLICATION, unknown: true },
    ]) {
      expectInvalid(parseConfigWorkerMessage, {
        status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
        content_hash: HASH, plugin_runtime_generation: 0,
        required_plugins: [], serving_plugins: [], ...(publication === undefined ? {} : { publication }),
      }, 'invalid_message');
    }
  });

  test('parses current startup ACK with null publication identity', () => {
    expect(parseConfigWorkerMessage({
      status: 'config-ready', worker_slot: 1, pid: 42, revision: 7,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41001,
      plugin_runtime_generation: 0,
      required_plugins: [], serving_plugins: [], publication: null,
    })).toMatchObject({ status: 'config-ready', publication: null });
  });

  test('parses apply failure only when serving revision and hash agree', () => {
    const base = {
      status: 'config-apply-failed', worker_slot: 1, pid: 42,
      target_revision: 8, target_content_hash: OTHER_HASH,
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      serving_revision: 7, serving_content_hash: HASH,
      failed_plugins: ['alpha'], error: 'compile failed', publication: PUBLICATION,
    };
    expect(parseConfigWorkerMessage(base)).toMatchObject(base);
    expectInvalid(parseConfigWorkerMessage, { ...base, serving_content_hash: null }, 'invalid_message');
    expectInvalid(parseConfigWorkerMessage, { ...base, error: ' compile failed' }, 'invalid_message');
    expectInvalid(parseConfigWorkerMessage, { ...base, error: 'x'.repeat(513) }, 'invalid_message');
    const oldShape = {
      status: base.status, worker_slot: base.worker_slot, pid: base.pid,
      target_revision: base.target_revision, target_content_hash: base.target_content_hash,
      serving_revision: base.serving_revision, serving_content_hash: base.serving_content_hash,
      failed_plugins: base.failed_plugins, error: base.error,
    };
    expectInvalid(parseConfigWorkerMessage, oldShape, 'invalid_message');
  });

  test('parses drained ACK and rejects mismatched scalar fields', () => {
    expect(parseConfigWorkerMessage({
      status: 'worker-drained', ...PROCESS_IDENTITY, worker_slot: 3, pid: 99, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION,
    })).toEqual({ status: 'worker-drained', ...PROCESS_IDENTITY, worker_slot: 3, pid: 99, revision: 8,
      content_hash: HASH, plugin_catalog_hash: PLUGIN_CATALOG_HASH, publication: PUBLICATION });
    expectInvalid(parseConfigWorkerMessage, {
      status: 'worker-drained', worker_slot: 3, pid: 0, revision: 8,
    }, 'invalid_message');
  });

  test('parses commit and operation requests without master-owned fields', () => {
    const commit = parseConfigWorkerMessage({
      command: 'commit-config', request_id: 'req-4', mutation: {
        mutation_id: 'mutation-4', expected_revision: 7, kind: 'config', aggregate: aggregate(),
      },
    });
    expect(commit).toMatchObject({ command: 'commit-config', mutation: { mutation_id: 'mutation-4' } });
    expect(parseConfigWorkerMessage({
      command: 'get-config-operation', ...PROCESS_IDENTITY, request_id: 'req-5', mutation_id: 'mutation-4',
    })).toEqual({ command: 'get-config-operation', ...PROCESS_IDENTITY, request_id: 'req-5', mutation_id: 'mutation-4' });
    for (const field of ['target_worker_slots', 'created_at', 'request_hash']) {
      expectInvalid(parseConfigWorkerMessage, {
        command: 'commit-config', request_id: 'req-6', mutation: {
          mutation_id: 'mutation-6', expected_revision: 7, kind: 'config', aggregate: aggregate(),
          [field]: field === 'target_worker_slots' ? [0] : 1,
        },
      }, 'invalid_message');
    }
  });
});
