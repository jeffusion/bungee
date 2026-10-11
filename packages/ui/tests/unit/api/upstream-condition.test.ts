import { afterEach, expect, test } from 'bun:test';
import type { ConfigurationAggregateV2, ServiceV2 } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../../../../core/src/config-storage/aggregate';
import { ConfigurationValidationError } from '../../../src/api/config';
import { duplicateEditorService, toEditorService, toEditorRoute } from '../../../src/api/config-adapters';
import { ServicesAPI } from '../../../src/api/services';
import { RoutesAPI } from '../../../src/api/routes';

const condition = "{{ body.model?.endsWith('-luna') }}";
const service: ServiceV2 = {
  id: '10000000-0000-4000-8000-000000000001', position: 0, name: 'original', plugins: [],
  endpoints: [{ id: '20000000-0000-4000-8000-000000000001', position: 0,
    target: 'https://example.test', weight: 100, priority: 1, is_disabled: false, condition, plugins: [] }],
};
const aggregate: ConfigurationAggregateV2 = {
  logical_configuration: { services: [service], routes: [], plugins: [] }, plugin_activations: [],
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockValidatedSave() {
  let submitted: ConfigurationAggregateV2 | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(String(input), 'http://ui.test'), init);
    if (request.method === 'GET') return Response.json({ config: aggregate, revision: 4, content_hash: 'sha256:fixture' });
    const body = await request.json();
    submitted = body.aggregate;
    const result = parseNormalizeCompileAggregate(body.aggregate);
    if (!result.ok) return Response.json({ error: 'invalid_configuration', errors: result.errors }, { status: 422 });
    return Response.json({ operation_id: body.mutation_id, revision: 5,
      operation: { mutation_id: body.mutation_id, state: 'committed' }, workers: [] }, { status: 202 });
  }) as typeof fetch;
  return () => submitted!;
}

test.each(['', ' ', '\t\n'])('clearing an upstream condition allows a service rename (blank: %j)', async blank => {
  const submitted = mockValidatedSave();
  const draft = toEditorService(service);
  draft.name = 'renamed';
  draft.endpoints[0]!.condition = blank;
  const saved = await ServicesAPI.update(service.name, draft, service);
  expect(saved.name).toBe('renamed');
  expect(saved.id).toBe(service.id);
  const expected = { ...service.endpoints[0]! };
  delete expected.condition;
  expect(saved.endpoints[0]!).toEqual(expected);
  expect(saved.endpoints[0]!).not.toHaveProperty('condition');
  expect(submitted().logical_configuration.services[0]!.endpoints[0]!).not.toHaveProperty('condition');
  expect(service.endpoints[0]!.condition).toBe(condition);
});

test('new services and direct routes omit empty upstream conditions', async () => {
  let submitted = mockValidatedSave();
  const draft = duplicateEditorService(toEditorService(service));
  draft.name = 'created';
  draft.endpoints[0]!.condition = '';
  await ServicesAPI.create(draft);
  expect(submitted().logical_configuration.services.at(-1)!.endpoints[0]!).not.toHaveProperty('condition');

  submitted = mockValidatedSave();
  const route = toEditorRoute({ id: '30000000-0000-4000-8000-000000000001', position: 0,
    path: '/created', endpoints: [{ ...service.endpoints[0]!, id: '40000000-0000-4000-8000-000000000001' }], plugins: [] }, []);
  route.endpoints![0]!.condition = ' ';
  await RoutesAPI.create(route);
  expect(submitted().logical_configuration.routes[0]!.endpoints![0]!).not.toHaveProperty('condition');
});

test('renaming preserves a nonempty condition exactly', async () => {
  mockValidatedSave();
  const draft = toEditorService(service);
  draft.name = 'renamed';
  draft.endpoints[0]!.condition = `  ${condition}  `;
  const saved = await ServicesAPI.update(service.name, draft, service);
  expect(saved.endpoints[0]!.condition).toBe(draft.endpoints[0]!.condition);
});

test.each(['{{ body.model === }}', '{{ process.exit() }}', '{{ }}'])('invalid nonempty conditions still fail validation: %s', async invalid => {
  mockValidatedSave();
  const draft = toEditorService(service);
  draft.endpoints[0]!.condition = invalid;
  await expect(ServicesAPI.update(service.name, draft, service)).rejects.toBeInstanceOf(ConfigurationValidationError);
});
