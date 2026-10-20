import { expect, test } from 'bun:test';
import { createMasterPluginCatalogApi } from '../../../src/master-runtime/master-plugin-catalog-api';
import type { PluginManifestRecord } from '../../../src/plugin-manifest-catalog/types';
import codexRouterManifest from '../../../../../plugins/codex-router/manifest.json';

test('Codex Router schema translation keys match the published language dictionaries', async () => {
  const codex = { name: codexRouterManifest.name, manifest: codexRouterManifest, configSchema: codexRouterManifest.configSchema } as unknown as PluginManifestRecord;
  const catalog = createMasterPluginCatalogApi({ catalog: { records: () => [codex] } });
  const state = { aggregate: { plugin_activations: [{ plugin_name: codex.name }] } } as never;
  const schemas = await (await catalog.handle(new Request('http://test/api/plugins/schemas'), state)).json();
  const translations = await (await catalog.handle(new Request('http://test/api/plugin-translations'), state)).json();
  expect(schemas['codex-router'].configSchema[0].label).toBe('plugins.codex-router.models.label');
  for (const language of ['zh-CN', 'en']) {
    const key = schemas['codex-router'].configSchema[0].label.replace('plugins.codex-router.', '');
    expect(translations[language].plugins['codex-router'][key]).toBe(language === 'zh-CN' ? '模型绑定' : 'Model bindings');
    const checkLabels = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if (name === 'label' && typeof child === 'string' && child.startsWith('plugins.')) {
          expect(child).toStartWith('plugins.codex-router.');
          const relative = child.slice('plugins.codex-router.'.length);
          expect(translations[language].plugins['codex-router'][relative]).toBeString();
        } else checkLabels(child);
      }
    };
    checkLabels(schemas['codex-router'].configSchema);
  }
});

const record = {
  name: 'sandbox-plugin',
  configSchema: [{ name: 'enabled', type: 'boolean', label: 'enabled.label' }],
  manifest: {
    name: 'sandbox-plugin',
    version: '1.0.0',
    schemaVersion: 3,
    artifactKind: 'runtime-plugin',
    main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad', 'sandboxUiExtension', 'controlPlane'],
    uiExtensionMode: 'sandbox-iframe',
    permissions: ['ui:popups', 'ui:navigation', 'api:routes'],
    control: { entry: 'server/control.ts', rpc: [] },
    contributes: {
      api: [{ path: '/accounts', methods: ['GET'], handler: 'accounts', execution: 'control' }],
      upstreamSources: [],
      unexpected: 'must not leak',
    },
    translations: { en: { 'enabled.label': 'Enabled' } },
    metadata: { name: 'metadata.name', description: 'metadata.description', icon: 'extension' },
  },
} as unknown as PluginManifestRecord;

const snapshot = (active: readonly string[]) => ({
  revision: 1,
  content_hash: 'sha256:' + 'a'.repeat(64),
  aggregate: { plugin_activations: active.map((plugin_name) => ({ plugin_name })) },
} as never);

function api() {
  return createMasterPluginCatalogApi({ catalog: { records: () => [record] } });
}

test('management setup reads the named provider while inactive and distinguishes missing, ready and unavailable state', async () => {
  const provider = { ...record, name: 'test-auth', manifest: { ...record.manifest, management: {loginComponent: 'Login', setupComponent: 'Setup'} } } as PluginManifestRecord;
  const calls: string[] = [];
  let status: unknown = {initialized: false};
  const catalog = createMasterPluginCatalogApi({ catalog: {records: () => [record, provider]}, readManagementSetup: async name => {
    calls.push(name);
    if (status instanceof Error) throw status;
    return status as {initialized: boolean};
  } });
  const path = '/api/plugins/test-auth/management-setup';
  expect(catalog.matches(path)).toBe(true);
  for (const initialized of [false, true]) {
    status = {initialized, privateData: 'must not leak'};
    const response = await catalog.handle(new Request('http://test' + path), snapshot([]));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({initialized});
  }
  for (const unavailable of [new Error('storage unavailable'), {}, {initialized: 'ready'}]) {
    status = unavailable;
    const response = await catalog.handle(new Request('http://test' + path), snapshot([]));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error: 'management_setup_unavailable'});
  }
  expect(calls).toEqual(Array(5).fill('test-auth'));
  for (const name of ['sandbox-plugin', 'missing', '%zz']) {
    expect((await catalog.handle(new Request(`http://test/api/plugins/${name}/management-setup`), snapshot([]))).status).toBe(404);
  }
  expect((await catalog.handle(new Request('http://test' + path, {method: 'POST'}), snapshot([]))).status).toBe(405);
  expect(calls).toHaveLength(5);
});

test('scope filtering excludes global plugins from route, service and upstream editors', async () => {
  const global = { ...record, name: 'global-plugin', manifest: { ...record.manifest, name: 'global-plugin', runtimeScope: 'global' } } as PluginManifestRecord;
  const catalog = createMasterPluginCatalogApi({ catalog: { records: () => [record, global] } });
  const state = snapshot(['sandbox-plugin', 'global-plugin']);
  for (const scope of ['route', 'service', 'upstream']) {
    const response = await catalog.handle(new Request(`http://test/api/plugins/schemas?enabledOnly=true&scope=${scope}`), state);
    const schemas = await response.json();
    expect(Object.keys(schemas)).toEqual(['sandbox-plugin']);
    expect(schemas['sandbox-plugin'].runtimeScope).toBe('scoped');
  }
  const all = await catalog.handle(new Request('http://test/api/plugins'), state);
  expect(await all.json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'global-plugin', runtimeScope: 'global', enabled: true })]));
  const settings = await catalog.handle(new Request('http://test/api/plugins/schemas?scope=global'), state);
  expect(Object.keys(await settings.json())).toEqual(['sandbox-plugin', 'global-plugin']);
  for (const query of ['scope=wrong', 'scope=route&scope=global']) {
    const invalid = await catalog.handle(new Request(`http://test/api/plugins/schemas?${query}`), state);
    expect(invalid.status).toBe(400);
  }
});

test('catalog metadata is manifest-only and sandbox access uses the request snapshot gate', async () => {
  const catalog = api();
  const plugins = await catalog.handle(new Request('http://test/api/plugins'), snapshot([]));
  expect(plugins.status).toBe(200);
  expect(await plugins.json()).toEqual([expect.objectContaining({ name: 'sandbox-plugin', enabled: false })]);

  const disabled = await catalog.handle(new Request('http://test/api/plugins/sandbox-plugin/sandbox'), snapshot([]));
  const unknown = await catalog.handle(new Request('http://test/api/plugins/unknown/sandbox'), snapshot(['unknown']));
  expect(disabled.status).toBe(404);
  expect(unknown.status).toBe(404);

  const enabled = await catalog.handle(new Request('http://test/api/plugins/sandbox-plugin/sandbox'), snapshot(['sandbox-plugin']));
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toEqual({
    sandbox: 'allow-scripts',
    allowedHostActions: ['ui-context', 'copy-styles', 'open-external', 'new-service', 'references', 'control'],
    controlAllowlist: [{ path: '/accounts', methods: ['GET'] }],
  });

  const schemas = await catalog.handle(new Request('http://test/api/plugins/schemas'), snapshot([]));
  const schemaBody = await schemas.json() as Record<string, { metadata?: { contributes?: Record<string, unknown> } }>;
  expect(schemaBody['sandbox-plugin']?.metadata?.contributes).toEqual(expect.objectContaining({ api: expect.any(Array) }));
  expect(schemaBody['sandbox-plugin']?.metadata?.contributes).not.toHaveProperty('unexpected');
});
