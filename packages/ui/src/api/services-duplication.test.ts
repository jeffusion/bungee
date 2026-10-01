import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2, ServiceV2 } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../../../core/src/config-storage/aggregate';
import { duplicateEditorService, toEditorService, toV2Service } from './config-adapters';
import { ServicesAPI } from './services';

const source: ServiceV2 = {
  id: '10000000-0000-4000-8000-000000000001', position: 3, name: 'alpha',
  endpoints: [{
    id: '20000000-0000-4000-8000-000000000001', position: 5,
    target: 'https://alpha.example.test', weight: 75, priority: 2, is_disabled: false,
    plugins: [{
      id: '30000000-0000-4000-8000-000000000001', position: 7,
      name: 'provider', enabled: false, options: { accountRef: 'account-1', nested: { values: [42] } },
    }],
  }],
  plugins: [{
    id: '40000000-0000-4000-8000-000000000001', position: 9,
    name: 'audit', enabled: true, options: { nested: { values: ['keep'] } },
  }],
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.each([false, true])('duplicating a service passes real configuration validation (managed: %s)', async (managed) => {
  const service = structuredClone(source);
  if (managed) {
    service.endpoints[0]!.managedBy = {
      plugin: 'provider', contributionId: 'accounts', bindingId: service.endpoints[0]!.plugins[0]!.id,
    };
  }
  const aggregate: ConfigurationAggregateV2 = {
    logical_configuration: {
      services: [service], routes: [{
        id: '50000000-0000-4000-8000-000000000001', position: 0,
        path: '/alpha', service_id: service.id, plugins: [],
      }], plugins: [],
    },
    plugin_activations: [],
  };
  expect(parseNormalizeCompileAggregate(aggregate).ok).toBe(true);
  const editor = toEditorService(service);
  const before = structuredClone(editor);

  // Reproduce the original failure with the server's actual validator.
  const shallowCopy = toV2Service({ ...editor, name: 'alpha-copy' }, undefined, 4);
  const invalid = parseNormalizeCompileAggregate({
    ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services: [service, shallowCopy] },
  });
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.errors.map(error => error.code)).toEqual(['duplicate_id', 'duplicate_id', 'duplicate_id']);

  let committed: ConfigurationAggregateV2 | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), 'http://ui.test'), init);
    if (request.method === 'GET') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:before' });
    const body = await request.json();
    const validation = parseNormalizeCompileAggregate(body.aggregate);
    if (!validation.ok) return Response.json({ error: 'validation_failed', errors: validation.errors }, { status: 400 });
    committed = body.aggregate;
    return Response.json({ operation_id: body.mutation_id, revision: 5,
      operation: { mutation_id: body.mutation_id, state: 'committed' }, workers: [] }, { status: 202 });
  }) as typeof fetch;

  const draft = { ...duplicateEditorService(editor), name: 'alpha-copy' };
  const saved = await ServicesAPI.create(draft);
  expect(committed?.logical_configuration.services).toEqual([service, saved]);
  expect(committed?.logical_configuration.routes).toEqual(aggregate.logical_configuration.routes);
  expect(saved.id).not.toBe(service.id);
  expect(saved.position).toBe(4);
  expect(saved.endpoints[0]!.target).toBe(service.endpoints[0]!.target);
  expect(saved.endpoints[0]!.weight).toBe(75);
  expect(saved.endpoints[0]!.priority).toBe(2);
  expect(saved.endpoints[0]!.plugins[0]!.options).toEqual(service.endpoints[0]!.plugins[0]!.options);
  expect(saved.endpoints[0]!.plugins[0]!.enabled).toBe(false);
  expect(saved.plugins[0]!.options).toEqual(service.plugins[0]!.options);
  if (managed) expect(saved.endpoints[0]!.managedBy).toEqual({ ...service.endpoints[0]!.managedBy, bindingId: saved.endpoints[0]!.plugins[0]!.id });
  expect(editor).toEqual(before);
  const binding = draft.plugins![0]!;
  if (typeof binding === 'string') throw new Error('Expected plugin binding');
  (binding.options!.nested as { values: string[] }).values.push('edited-copy');
  expect(editor).toEqual(before);
});
