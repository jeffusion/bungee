import { afterAll as afterDataPlaneTests } from 'bun:test';
import { createDataPlaneRuntime } from '../helpers/data-plane-runtime';
const dataPlaneRuntime = await createDataPlaneRuntime();
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PluginRegistry } from '../../src/plugin-registry';
const { compileRuntimeConfigSnapshot, parseNormalizeCompileAggregate } = await import('../../src/config-storage');
const { setBoundControlClientProvider } = await import('../../src/config-worker/runtime-dependencies');
const { createRuntimeEligibleConfig } = await import('../../src/plugin-runtime-config');
const { ScopedPluginRegistry, setScopedPluginRegistry } = await import('../../src/scoped-plugin-registry');
const { handleRequest } = await import('../../src/worker/request/handler');
const { setPluginRegistry } = await import('../../src/worker/state/plugin-manager');
const { initializeRuntimeState, runtimeState } = await import('../../src/worker/state/runtime-state');

const originalFetch = global.fetch;
const root = fileURLToPath(new URL('../../../..', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url), 'utf8'));
const ids = {
  service: '10000000-0000-4000-8000-000000000091',
  route: '20000000-0000-4000-8000-000000000091',
  free: '30000000-0000-4000-8000-000000000091',
  paid: '30000000-0000-4000-8000-000000000092',
  freeBinding: '40000000-0000-4000-8000-000000000091',
  paidBinding: '40000000-0000-4000-8000-000000000092',
};

afterEach(() => {
  global.fetch = originalFetch;
  setBoundControlClientProvider(null);
  setScopedPluginRegistry(null);
  setPluginRegistry(null);
  runtimeState.clear();
});

describe('ChatGPT OAuth account routing', () => {
  for (const target of ['service', 'direct'] as const) {
    test(`${target} routes keep same-URL accounts and OAuth hooks isolated across reloads`, async () => {
      const endpoints = (['free', 'paid'] as const).map((account, position) => ({
        id: ids[account], position, target: 'https://chatgpt.com',
        priority: account === 'free' ? 1 : 2,
        ...(account === 'free' ? { condition: "{{ body.model?.endsWith('-luna') }}" } : {}),
        managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId: ids[`${account}Binding`] },
        plugins: [{ id: ids[`${account}Binding`], position: 0, name: 'chatgpt-oauth', enabled: true, options: { accountRef: account } }],
      }));
      const parsed = parseNormalizeCompileAggregate({
        logical_configuration: {
          services: target === 'service' ? [{ id: ids.service, position: 0, name: 'openai', endpoints }] : [],
          routes: [{
            id: ids.route, position: 0, path: '/codex/',
            path_rewrite: { '^/codex': '' }, timeouts: { request_ms: 1000 },
            ...(target === 'service' ? { service_id: ids.service } : { endpoints }),
          }],
        },
        plugin_activations: [{ plugin_name: 'chatgpt-oauth' }],
      });
      if (!parsed.ok) throw new Error(`invalid fixture: ${JSON.stringify(parsed.errors)}`);
      const config = compileRuntimeConfigSnapshot({
        revision: 1, content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        aggregate: parsed.value,
      }).config;
      const before = structuredClone(config);
      const pluginRegistry = {
        getAllPluginManifests: () => new Map([['chatgpt-oauth', manifest]]),
        getPluginStateSnapshot: () => ({ validation: 'validated', persistedEnabled: 'enabled', manifest }),
      } as unknown as PluginRegistry;
      setPluginRegistry(pluginRegistry);

      const leases: Array<{ endpointId: string; accountRef: unknown }> = [];
      setBoundControlClientProvider((binding, attempt) => ({
        call: async <T>(method: string): Promise<T> => {
          expect(method).toBe('getCredential');
          expect(attempt?.revision).toBe(1);
          const accountRef = binding.bindingOptions.accountRef;
          expect(binding.bindingId).toBe(accountRef === 'free' ? ids.freeBinding : ids.paidBinding);
          leases.push({ endpointId: attempt!.endpointId, accountRef });
          return {
            version: 1, expiresAt: Date.now() + 60_000,
            headers: { Authorization: `Bearer ${accountRef}`, 'Chatgpt-Account-Id': accountRef },
          } as T;
        },
      }));
      const sent: Array<{ model: string; accountRef: string | null }> = [];
      global.fetch = (async (url, init) => {
        expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');
        const body = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        const accountRef = headers.get('Chatgpt-Account-Id');
        expect(headers.get('Authorization')).toBe(`Bearer ${accountRef}`);
        sent.push({ model: body.model, accountRef });
        return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch;

      let registry: ScopedPluginRegistry | undefined;
      try {
        for (const reverse of [false, true]) {
          const nextConfig = structuredClone(config);
          if (reverse) (target === 'service' ? nextConfig.services![0].endpoints : nextConfig.routes[0].endpoints!).reverse();
          const eligible = createRuntimeEligibleConfig(nextConfig, pluginRegistry, new Set(['chatgpt-oauth']));
          const nextRegistry = new ScopedPluginRegistry(root);
          const initialized = await nextRegistry.initializeFromConfig(eligible);
          setScopedPluginRegistry(nextRegistry);
          await registry?.destroy();
          registry = nextRegistry;
          expect(initialized).toEqual({ success: 2, failed: 0 });
          initializeRuntimeState(nextConfig);
          for (const [model, accountRef] of [
            ['gpt-5.6-luna', 'free'], ['gpt-6-luna', 'free'], ['gpt-6.1-sol', 'paid'],
          ]) {
            const response = await handleRequest(new Request('http://proxy.test/codex/v1/responses', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model, input: 'test', stream: false }),
            }), nextConfig, { servingRevision: 1 });
            const body = await response.json();
            expect(response.status).toBe(200);
            expect(body.status).toBe('completed');
            expect(sent.at(-1)).toEqual({ model, accountRef });
            expect(leases.at(-1)).toEqual({ endpointId: accountRef === 'free' ? ids.free : ids.paid, accountRef });
          }
        }
        expect(sent).toHaveLength(6);
        expect(leases).toHaveLength(6);
        expect(config).toEqual(before);
      } finally {
        await registry?.destroy();
      }
    });
  }
});

afterDataPlaneTests(() => dataPlaneRuntime.close());
