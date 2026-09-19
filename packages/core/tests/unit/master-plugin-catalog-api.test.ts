import { expect, test } from 'bun:test';
import { createMasterPluginCatalogApi } from '../../src/master-runtime/master-plugin-catalog-api';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';

const record = {
  name: 'sandbox-plugin',
  configSchema: [{ name: 'enabled', type: 'boolean', label: 'enabled.label' }],
  manifest: {
    name: 'sandbox-plugin',
    version: '1.0.0',
    schemaVersion: 2,
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
