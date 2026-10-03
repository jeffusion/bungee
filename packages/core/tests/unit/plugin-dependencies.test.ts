import { createManagementAuthFixture } from '../helpers/management-auth';
import { afterEach, describe, expect, test } from 'bun:test';
import { PluginDependencyGraph, updatePluginActivations } from '../../src/plugin-dependencies';
import { buildPluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { parseNormalizeCompileAggregate } from '../../src/config-storage/aggregate';
import { ScopedPluginRegistry, type PluginClass } from '../../src/scoped-plugin-registry';
import { createRuntimeEligibleConfig } from '../../src/plugin-runtime-config';
import type { PluginRegistry } from '../../src/plugin-registry';
import { cleanupCatalogRoots, manifest, tempRoot, writePlugin } from './plugin-manifest-catalog-fixtures';

const chain = () => new PluginDependencyGraph([
  { name: 'consumer', version: '1.0.0', dependencies: { intermediate: '^1.0.0' } },
  { name: 'intermediate', version: '1.1.0', dependencies: { provider: '>=1.0.0 <2.0.0' } },
  { name: 'provider', version: '1.2.3' },
]);
afterEach(cleanupCatalogRoots);

describe('required plugin dependencies', () => {
  test('enables the complete transitive closure and retains providers after consumer disable', () => {
    const graph = chain();
    const enabled = updatePluginActivations(graph, [], 'consumer', true);
    expect(enabled).toEqual(['consumer', 'intermediate', 'provider']);
    expect(updatePluginActivations(graph, enabled, 'consumer', true)).toEqual(enabled);
    expect(updatePluginActivations(graph, enabled, 'consumer', false)).toEqual(['intermediate', 'provider']);
    expect(() => updatePluginActivations(graph, enabled, 'provider', false)).toThrow('consumer -> intermediate -> provider');
    expect(updatePluginActivations(graph, ['provider'], 'provider', false)).toEqual([]);
    expect(graph.dependentPaths('provider', ['intermediate', 'provider'])).toEqual([['intermediate', 'provider']]);
  });

  test.each([
    { dependencies: { missing: '^1.0.0' }, fragment: 'missing required plugin' },
    { dependencies: { provider: '^2.0.0' }, fragment: 'version mismatch' },
    { dependencies: { provider: 'garbage' }, fragment: 'invalid range' },
    { dependencies: { consumer: '^1.0.0' }, fragment: 'consumer -> consumer' },
  ])('rejects invalid catalogs before importing code: $fragment', async ({ dependencies, fragment }) => {
    const root = tempRoot();
    writePlugin(root, 'provider', manifest('provider'));
    writePlugin(root, 'consumer', manifest('consumer', { dependencies }));
    await expect(buildPluginManifestCatalog({ scanDirectories: [root] })).rejects.toThrow(fragment);
  });

  test('rejects indirect cycles and honors prerelease and compound version ranges', async () => {
    const root = tempRoot();
    writePlugin(root, 'consumer', manifest('consumer', { dependencies: { provider: '^1.0.0' } }));
    writePlugin(root, 'provider', manifest('provider', { dependencies: { consumer: '^1.0.0' } }));
    await expect(buildPluginManifestCatalog({ scanDirectories: [root] })).rejects.toThrow('consumer -> provider -> consumer');
    expect(() => new PluginDependencyGraph([
      { name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' } },
      { name: 'provider', version: '1.1.0-beta.1' },
    ])).toThrow('version mismatch');
    const graph = new PluginDependencyGraph([
      { name: 'consumer', version: '1.0.0', dependencies: { provider: '>=1.1.0-beta.1 <1.1.0 || ^2.0.0' } },
      { name: 'provider', version: '1.1.0-beta.1' },
    ]);
    expect(graph.closure(['consumer'])).toEqual(['provider', 'consumer']);
  });

  test('full aggregate writes reject incomplete closure without rewriting imported activations', async () => {
    const root = tempRoot();
    writePlugin(root, 'consumer', manifest('consumer', { dependencies: { provider: '^1.0.0' } }));
    writePlugin(root, 'provider', manifest('provider'));
    const catalog = await buildPluginManifestCatalog({ scanDirectories: [root] });
    const input = { logical_configuration: {}, plugin_activations: [{ plugin_name: 'consumer' }] };
    const parsed = parseNormalizeCompileAggregate(input, catalog.toCompileOptions());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toContainEqual(expect.objectContaining({
      path: 'plugin_activations', message: expect.stringContaining('consumer -> provider'),
    }));
    expect(input.plugin_activations).toEqual([{ plugin_name: 'consumer' }]);
    expect(parseNormalizeCompileAggregate({ ...input, plugin_activations: [
      { plugin_name: 'consumer' }, { plugin_name: 'provider' },
    ] }, catalog.toCompileOptions()).ok).toBe(true);
  });

  test('runtime closure checks and global provider insertion retain scoped bindings', () => {
    const registry = {
      getAllPluginManifests: () => new Map([
        ['consumer', { name: 'consumer', version: '1.0.0', runtimeScope: 'scoped', dependencies: { provider: '^1.0.0' } }],
        ['provider', { name: 'provider', version: '1.0.0', runtimeScope: 'global', mainPath: '/provider.ts' }],
      ]),
      getPluginStateSnapshot: () => ({ validation: 'validated' }),
    } as unknown as PluginRegistry;
    const binding = { name: 'consumer', options: { only: 'bound-route' } };
    const config = { routes: [{ path: '/bound', plugins: [binding], endpoints: [{ target: 'http://test' }] },
      { path: '/unbound', endpoints: [{ target: 'http://test' }] }] };
    expect(() => createRuntimeEligibleConfig(config, registry, new Set(['consumer']))).toThrow('consumer -> provider');
    const result = createRuntimeEligibleConfig(config, registry, new Set(['consumer', 'provider']));
    expect(result.plugins).toEqual([{ name: 'provider', path: '/provider.ts', enabled: true }]);
    expect(result.routes![0]!.plugins).toEqual([binding]);
    expect(result.routes![1]!.plugins).toEqual([]);
  });

  test('initializes global providers before consumers and destroys consumers before providers across scopes', async () => {
    const events: string[] = [];
    const registry = new ScopedPluginRegistry();
    registry.ensurePluginClassLoaded = async config => {
      const name = typeof config === 'string' ? config : config.name;
      return {
        name, version: '1.0.0', createHandler: async (_options, context) => {
          events.push(`init:${name}:${context.scope?.type}`);
          return { pluginName: name, config: {}, register() {}, async destroy() { events.push(`destroy:${name}`); } };
        },
      } satisfies PluginClass;
    };
    const graph = new PluginDependencyGraph([
      { name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' } },
      { name: 'provider', version: '1.0.0' },
    ]);
    const result = await registry.initializeFromConfig({
      plugins: [{ name: 'consumer', options: { priority: -100 } }, { name: 'provider', options: { priority: 100 } }],
      routes: [{ path: '/bound', plugins: [{ name: 'consumer' }], endpoints: [{ target: 'http://test' }] },
        { path: '/unbound', endpoints: [{ target: 'http://test' }] }],
    }, graph);
    expect(result).toEqual({ success: 3, failed: 0 });
    expect(events).toEqual(['init:provider:global', 'init:consumer:global', 'init:consumer:route']);
    expect(registry.getPluginRuntimeStateSnapshot('consumer').servingScopes).toEqual([{ type: 'global' }, { type: 'route', routeId: '/bound' }]);
    await registry.destroy();
    expect(events.slice(3)).toEqual(['destroy:consumer', 'destroy:consumer', 'destroy:provider']);
  });
});

test('activation API commits one revision for the closure, preserves providers, and rejects incomplete full PUT/import', async () => {
  const { ConfigRepository, hashConfigurationContent } = await import('../../src/config-storage');
  const { createConfigControlApi } = await import('../../src/master-runtime/control-api');
  const graph = chain();
  const compile = { pluginSchemas: new Map([['consumer', []], ['intermediate', []], ['provider', []]]), pluginDependencies: graph };
  const repository = ConfigRepository.open(`${tempRoot()}/config.db`, { compileOptions: compile });
  const credentials = createManagementAuthFixture(() => repository.getSnapshot().aggregate);
  let time = 1_700_000_000_000;
  const settle = () => {
    const publication = repository.getActivePublication();
    if (!publication) return;
    const id = publication.operation.mutation_id;
    repository.beginPublication(id, ++time);
    for (const target of publication.targets) {
      repository.beginWorkerAttempt(id, target.worker_slot, 0, 'initial', ++time);
      repository.recordWorkerResult(id, target.worker_slot, { kind: 'converged', attempt_no: 1, applied_revision: publication.snapshot.revision }, ++time);
    }
    repository.markDraining(id, ++time);
    repository.finalizePublication(id, { outcome: 'converged', old_workers_exited: true }, ++time);
  };
  try {
    const seeded = parseNormalizeCompileAggregate({ logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] }, compile);
    if (!seeded.ok) throw new Error('seed compilation failed');
    repository.commit({ mutation_id: 'dependency-seed', expected_revision: 1, aggregate: seeded.value,
      kind: 'config', created_at: ++time, target_worker_slots: [0] });
    settle();
    const api = createConfigControlApi({ repository, managementAuth:credentials.managementAuth, pluginDependencies: graph, admission: { snapshot: () => [] },
      workerCount: 1, clock: { now: () => ++time }, resolveAuthToken: value => value,
      parseAggregate: value => parseNormalizeCompileAggregate(value, compile),
      publicationTasks: { enqueue() {} }, isMutationReady: () => true,
    });
    const request = (path: string, method = 'POST', body?: unknown) => new Request(`http://test${path}`, {
      method, headers: { authorization: `Bearer ${credentials.current.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const before = repository.getSnapshot().revision;
    const response = await api.handle(request('/api/plugins/consumer/enable'));
    expect(response?.status).toBe(202);
    expect(repository.getSnapshot().revision).toBe(before + 1);
    expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([
      { plugin_name: 'consumer' }, { plugin_name: 'intermediate' }, { plugin_name: 'provider' },
    ]);
    settle();
    const blocked = await api.handle(request('/api/plugins/provider/disable'));
    expect(blocked?.status).toBe(422);
    expect((await blocked!.json()).message).toContain('consumer -> intermediate -> provider');
    expect(repository.getSnapshot().revision).toBe(before + 1);
    expect((await api.handle(request('/api/plugins/consumer/disable')))?.status).toBe(202);
    expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([{ plugin_name: 'intermediate' }, { plugin_name: 'provider' }]);
    settle();
    const active = repository.getSnapshot();
    const incomplete = { ...active.aggregate, plugin_activations: [{ plugin_name: 'consumer' }] };
    expect((await api.handle(request('/api/config', 'PUT', { expected_revision: active.revision, mutation_id: 'incomplete-put', aggregate: incomplete })))?.status).toBe(422);
    const base = { format: 'bungee-config-snapshot', format_version: 1, schema_version: 2,
      exported_at: ++time, source_revision: active.revision, content_hash: hashConfigurationContent(incomplete), aggregate: incomplete };
    expect((await api.handle(request('/api/config/import', 'POST', { expected_revision: active.revision,
      mutation_id: 'incomplete-import', envelope: { ...base, envelope_hash: hashConfigurationContent(base) } })))?.status).toBe(422);
    expect(repository.getSnapshot().revision).toBe(active.revision);
    expect((await api.handle(request('/api/plugins/intermediate/disable')))?.status).toBe(202);
    settle();
    expect((await api.handle(request('/api/plugins/provider/disable')))?.status).toBe(202);
    expect(repository.getSnapshot().aggregate.plugin_activations).toEqual([]);
  } finally { credentials.dispose(); repository.close(); }
});


test('global providers cannot be bound to route/service/upstream scopes', async () => {
  const { parseNormalizeCompile } = await import('../../src/config-storage/compiler');
  const root = tempRoot();
  writePlugin(root, 'provider', manifest('provider', { runtimeScope: 'global' }));
  const catalog = await buildPluginManifestCatalog({ scanDirectories: [root] });
  const binding = () => ({ id: crypto.randomUUID(), name: 'provider' });
  const input = {
    services: [{ id: crypto.randomUUID(), name: 'test', plugins: [binding()], endpoints: [
      { id: crypto.randomUUID(), target: 'http://test', plugins: [binding()] },
    ] }],
    routes: [{ id: crypto.randomUUID(), path: '/test', plugins: [binding()], endpoints: [
      { id: crypto.randomUUID(), target: 'http://test', plugins: [binding()] },
    ] }],
  };
  const result = parseNormalizeCompile(input, catalog.toCompileOptions());
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.filter(error => error.message.includes('Global provider'))).toHaveLength(4);
});

test('failed providers prevent dependent handlers from being initialized', async () => {
  const registry = new ScopedPluginRegistry();
  registry.setRetryOptions({ retryCount: 0 });
  const graph = new PluginDependencyGraph([
    { name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' } },
    { name: 'provider', version: '1.0.0' },
  ]);
  const initialized: string[] = [];
  registry.ensurePluginClassLoaded = async config => {
    const name = typeof config === 'string' ? config : config.name;
    return { name, version: '1.0.0', createHandler() {
      initialized.push(name);
      throw new Error('provider initialization failure');
    } };
  };
  expect(await registry.initializeFromConfig({ plugins: ['consumer', 'provider'] }, graph)).toEqual({ success: 0, failed: 2 });
  expect(initialized).toEqual(['provider']);
  expect(registry.getPluginRuntimeStateSnapshot('consumer').failureReason).toContain('consumer -> provider');
  await registry.destroy();
});

describe('manifest service contract validation before module import', () => {
  const contract = {id: 'count', version: 1, process: 'worker'};
  test.each([
    {name: 'undeclared provider contract', provider: {runtimeScope: 'global'}, consumer: {dependencies: {provider: '^1.0.0'}}, fragment: 'service contract unavailable'},
    {name: 'wrong version', provider: {runtimeScope: 'global', services: {provides: [{...contract, version: 2}]}}, consumer: {dependencies: {provider: '^1.0.0'}}, fragment: 'service contract unavailable'},
    {name: 'scoped provider', provider: {runtimeScope: 'scoped', services: {provides: [contract]}}, consumer: {dependencies: {provider: '^1.0.0'}}, fragment: 'service providers must be global'},
    {name: 'missing dependency', provider: {runtimeScope: 'global', services: {provides: [contract]}}, consumer: {}, fragment: 'declared dependency'},
    {name: 'invalid process', provider: {runtimeScope: 'global', services: {provides: [{...contract, process: 'master'}]}}, consumer: {dependencies: {provider: '^1.0.0'}}, fragment: 'worker'},
    {name: 'missing version', provider: {runtimeScope: 'global', services: {provides: [{id: 'count', process: 'worker'}]}}, consumer: {dependencies: {provider: '^1.0.0'}}, fragment: 'version'},
  ])('rejects $name', async ({provider, consumer, fragment}) => {
    const root = tempRoot();
    writePlugin(root, 'provider', manifest('provider', provider));
    writePlugin(root, 'consumer', manifest('consumer', {...consumer, services: {consumes: [{...contract, plugin: 'provider'}]}}));
    await expect(buildPluginManifestCatalog({scanDirectories: [root]})).rejects.toThrow(fragment);
  });
  test('accepts the explicit global worker contract and dependency', async () => {
    const root = tempRoot();
    writePlugin(root, 'provider', manifest('provider', {runtimeScope: 'global', services: {provides: [contract]}}));
    writePlugin(root, 'consumer', manifest('consumer', {dependencies: {provider: '^1.0.0'}, services: {consumes: [{...contract, plugin: 'provider'}]}}));
    await expect(buildPluginManifestCatalog({scanDirectories: [root]})).resolves.toBeDefined();
  });
});
