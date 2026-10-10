import { expect, test } from 'bun:test';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { ConfigurationStorageResultUnknownError, hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import type { ConfigurationOperation } from '../../src/config-storage';

function harness(unknownCommit: boolean, committed?: () => Promise<void>) {
  const aggregate = { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] };
  const events: string[] = [];
  const operation: ConfigurationOperation = { mutation_id: 'original-id', request_hash: hashConfigurationContent(aggregate),
    expected_revision: 1, committed_revision: 2, kind: 'config', state: 'committed', result_status: null,
    error_code: null, error_detail: null, target_worker_count: 1, drain_recovery_generation: 0,
    last_drain_recovery_previous_generation: null, created_at: 1, updated_at: 1 };
  const identity = { subject: { id: 'fixture', capabilities: [] }, provider: null };
  const options = {
    managementAuth: {
      authenticate: async () => identity, identity: () => identity, recheck: async () => true,
      authorized: async () => true, validateWrite: async () => undefined, selected: () => null,
    } as never,
    repository: {
      getSnapshot: () => ({ revision: 1, content_hash: hashConfigurationContent(aggregate), aggregate }),
      getCurrentRecovery: async () => null,
      getActivePublication: async () => null,
      getOperationState: async () => { events.push('operation.read'); return { operation, workers: [] }; },
      commit: async () => {
        events.push('commit');
        if (unknownCommit) throw new ConfigurationStorageResultUnknownError('commitPrepared', 'original-id');
        return { kind: 'committed' as const, snapshot: { revision: 2, content_hash: hashConfigurationContent(aggregate), aggregate }, operation };
      },
    },
    onConfigurationCommitted: committed,
    admission: { snapshot: () => [] }, workerCount: 1, clock: { now: () => 1 }, resolveAuthToken: (value: string) => value,
    parseAggregate: parseNormalizeCompileAggregate, publicationTasks: { enqueue() {} }, isMutationReady: () => true,
    pluginControlPreflight: {
      controlNames: new Set(['control']),
      async activate() { events.push('activate'); }, async deactivate() { events.push('deactivate'); },
    },
  };
  return { events, api: createConfigControlApi(options), request: new Request('http://control.test/api/config', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: 1, mutation_id: 'original-id',
      aggregate: { ...aggregate, plugin_activations: [{ plugin_name: 'control' }] } }),
  }) };
}

test('unknown durable commit returns the original ID and retains preflight controls for restart reconciliation', async () => {
  const fixture = harness(true);
  const response = await fixture.api.handle(fixture.request);
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({ error: 'result_unknown', mutation_id: 'original-id' });
  expect(fixture.events).toEqual(['activate', 'commit']);
});

test('publication waits for asynchronous committed-state consumers', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fixture = harness(false, async () => { fixture.events.push('callback.begin'); await gate; fixture.events.push('callback.end'); });
  let settled = false;
  const pending = fixture.api.handle(fixture.request).then(response => { settled = true; return response; });
  for (let step = 0; step < 100 && !fixture.events.includes('callback.begin'); step++) await Promise.resolve();
  expect(fixture.events).toEqual(['activate', 'commit', 'callback.begin']);
  expect(settled).toBe(false);
  release(); expect((await pending)?.status).toBe(202);
  expect(fixture.events).toEqual(['activate', 'commit', 'callback.begin', 'callback.end', 'operation.read']);
});
