import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  ConfigRepository, compileRuntimeConfigSnapshot, hashConfigurationContent,
  parseNormalizeCompileAggregate,
} from '../../src/config-storage';
import { createConfigControlApi } from '../../src/master-runtime/control-api';

const IDs = {
  service: '10000000-0000-4000-8000-000000000081',
  route: '20000000-0000-4000-8000-000000000081',
  serviceRoute: '20000000-0000-4000-8000-000000000082',
  upstream: '30000000-0000-4000-8000-000000000081',
  serviceUpstream: '30000000-0000-4000-8000-000000000082',
};

function input(websocket?: unknown): unknown {
  const policy = websocket === undefined ? {} : { websocket };
  return {
    logical_configuration: {
      services: [{ id: IDs.service, name: 'responses', endpoints: [{ id: IDs.serviceUpstream, target: 'https://service.example' }] }],
      routes: [
        { id: IDs.route, path: '/direct', endpoints: [{ id: IDs.upstream, target: 'http://direct.example' }], ...policy },
        { id: IDs.serviceRoute, path: '/service', service_id: IDs.service, ...structuredClone(policy) },
      ],
    },
    plugin_activations: [],
  };
}

function aggregate(websocket?: unknown): ConfigurationAggregateV2 {
  const result = parseNormalizeCompileAggregate(input(websocket));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

describe('explicit route WebSocket configuration', () => {
  test('omitted setting remains omitted and disabled, while both boolean values compile for direct and service routes', () => {
    for (const enabled of [undefined, false, true]) {
      const value = aggregate(enabled === undefined ? undefined : { enabled });
      const runtime = compileRuntimeConfigSnapshot({ revision: 1, content_hash: hashConfigurationContent(value), aggregate: value });
      for (const route of runtime.config.routes) {
        expect(route.websocket?.enabled ?? false).toBe(enabled ?? false);
        if (enabled === undefined) expect(route).not.toHaveProperty('websocket');
        else expect(route.websocket).toEqual({ enabled });
      }
      expect(runtime.config.routes[0]?.endpoints?.[0]?.target).toBe('http://direct.example');
      expect(runtime.config.routes[1]?.service).toBe('responses');
    }
  });

  test('rejects malformed objects, non-boolean enabled and unknown WebSocket subfields', () => {
    for (const value of [null, true, 'true', [], {}, { enabled: 1 }, { enabled: 'false' }, { enabled: null }, { enabled: false, ticket: true }]) {
      const result = parseNormalizeCompileAggregate(input(value));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.some(({ path }) => path.startsWith('logical_configuration.routes[0].websocket'))).toBe(true);
      if (typeof value === 'object' && value !== null && 'ticket' in value) {
        expect(result.errors).toContainEqual(expect.objectContaining({ code: 'unknown_field', path: 'logical_configuration.routes[0].websocket.ticket' }));
      }
    }
  });

  test('enabled state participates in content hashes', () => {
    expect(hashConfigurationContent(aggregate({ enabled: true }))).not.toBe(hashConfigurationContent(aggregate({ enabled: false })));
    expect(hashConfigurationContent(aggregate())).not.toBe(hashConfigurationContent(aggregate({ enabled: true })));
  });

  test('SQLite policy storage, sealed export, preview and re-import preserve the enabled state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bungee-websocket-config-'));
    const source = ConfigRepository.open(join(directory, 'source.db'), { workerCount: 1 });
    const target = ConfigRepository.open(join(directory, 'target.db'), { workerCount: 1 });
    const api = (repository: ConfigRepository) => createConfigControlApi({
      workerCount: 1, repository, parseAggregate: parseNormalizeCompileAggregate,
      managementAuth: { authenticate: async () => ({}), recheck: async () => true, identity: () => ({}), authorized: () => true, validateWrite: () => {}, selected: () => null },
      publicationTasks: { enqueue: () => {} }, admission: { snapshot: () => [] },
      clock: { now: () => 1 }, isMutationReady: () => true, resolveAuthToken: (value: unknown) => value,
    } as any);
    try {
      const value = aggregate({ enabled: true });
      const committed = source.commit({ mutation_id: 'websocket-source', expected_revision: source.getSnapshot().revision,
        aggregate: value, kind: 'config', created_at: 1, target_worker_slots: [0] });
      expect(committed.kind).toBe('committed');
      const stored = source.getSnapshot();
      expect(stored.aggregate).toEqual(value);
      expect(source.getDatabase().query<{ policy_json: string }, []>('SELECT policy_json FROM routes ORDER BY position').all()
        .map(({ policy_json }) => JSON.parse(policy_json).websocket)).toEqual([{ enabled: true }, { enabled: true }]);

      const exported = await api(source).handle(new Request('http://localhost/api/config/export'));
      expect(exported?.status).toBe(200);
      const envelope = await exported!.json();
      expect(envelope.aggregate).toEqual(value);
      expect(envelope.content_hash).toBe(hashConfigurationContent(value));
      const request = (path: string, body: unknown) => api(target).handle(new Request(`http://localhost/api/config/${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      const preview = await request('validate', { envelope });
      expect(preview?.status).toBe(200);
      expect((await preview!.json()).aggregate).toEqual(value);
      const imported = await request('import', { envelope, expected_revision: target.getSnapshot().revision, mutation_id: 'websocket-import' });
      expect(imported?.status).toBe(202);
      const restored = target.getSnapshot();
      expect(restored.aggregate).toEqual(value);
      expect(restored.content_hash).toBe(stored.content_hash);
      expect(compileRuntimeConfigSnapshot(restored).config.routes.map(({ websocket }) => websocket)).toEqual([{ enabled: true }, { enabled: true }]);
    } finally {
      source.close(); target.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
