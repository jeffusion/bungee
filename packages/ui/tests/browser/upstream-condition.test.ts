import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { parseNormalizeCompileAggregate } from '../../../core/src/config-storage/aggregate';

browserTest('upstream condition', async () => {
const uiRoot = fileURLToPath(new URL('../../dist/', import.meta.url));
const manifest = await Bun.file(new URL('../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
const compileOptions = { pluginSchemas: new Map([[manifest.name, manifest.configSchema]]) };
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  return new Response(Bun.file(`${uiRoot}${path === '/' ? 'index.html' : path.slice(1)}`));
} });
const browser = await chromium.launch({ headless: true }).catch(async error => { await server.stop(true); throw error; });
try {
  for (const { managed, initialCondition, blank } of [
    { managed: false, initialCondition: undefined, blank: '' },
    { managed: false, initialCondition: "{{ body.model?.endsWith('-luna') }}", blank: '' },
    { managed: true, initialCondition: "{{ body.model?.endsWith('-luna') }}", blank: ' \t ' },
  ]) {
    let revision = 1;
    let config: ConfigurationAggregateV2 = { logical_configuration: {
      services: [{ id: '10000000-0000-4000-8000-000000000001', position: 0, name: 'original', plugins: [],
        endpoints: [{ id: '20000000-0000-4000-8000-000000000001', position: 0,
          target: 'https://example.test', weight: 100, priority: 1, is_disabled: false,
          ...(initialCondition === undefined ? {} : { condition: initialCondition }),
          ...(managed ? { managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt',
            bindingId: '30000000-0000-4000-8000-000000000001' } } : {}),
          plugins: managed ? [{ id: '30000000-0000-4000-8000-000000000001', position: 0,
            name: 'chatgpt-oauth', enabled: false, options: { accountRef: 'fixture-account' } }] : [],
        }] }],
      routes: [{ id: '40000000-0000-4000-8000-000000000001', position: 0, path: '/original',
        service_id: '10000000-0000-4000-8000-000000000001', plugins: [] }], plugins: [],
    }, plugin_activations: [] };
    const original = structuredClone(config);
    const errors: string[] = [];
    const writes: ConfigurationAggregateV2[] = [];
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript(() => localStorage.setItem('locale', 'en'));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.hostname !== '127.0.0.1') return route.fulfill({ body: '' });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const respond = (json: unknown, status = 200) => route.fulfill({ json, status });
      if (url.pathname === '/api/auth/mode') return respond({ mode: 'anonymous', publicOrigin: `http://127.0.0.1:${server.port}` });
      if (url.pathname === '/api/auth/verify') return respond({ success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } });
      if (url.pathname === '/api/plugin-translations') return respond({});
      if (url.pathname === '/api/plugins') return respond([]);
      if (url.pathname === '/api/plugins/schemas') return respond({});
      if (url.pathname === '/api/config' && request.method() === 'GET') return respond({ config, revision, content_hash: 'sha256:fixture' });
      if (url.pathname === '/api/config' && request.method() === 'PUT') {
        const body = request.postDataJSON();
        assert.equal(body.expected_revision, revision);
        const validation = parseNormalizeCompileAggregate(body.aggregate, compileOptions);
        if (!validation.ok) return respond({ error: 'invalid_configuration', errors: validation.errors }, 422);
        config = body.aggregate;
        revision++;
        writes.push(config);
        return respond({ operation_id: body.mutation_id, revision,
          operation: { mutation_id: body.mutation_id, state: 'committed' }, workers: [] }, 202);
      }
      if (url.pathname === '/api/config/runtime') return respond({ config, revision,
        content_hash: 'sha256:fixture', workers: [], publication: { operation: null, recovery: null,
          retryable: false, serving_complete: true, serving_revision: revision, target_revision: revision } });
      if (url.pathname === '/api/runtime/upstreams') return respond({ schema: 'bungee-runtime-upstreams-v1',
        generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision },
        workers: { observed: [], missing: [] }, upstreams: [] });
      errors.push(`Unmocked ${request.method()} ${url.pathname}`);
      return respond({ error: 'unexpected_request' }, 500);
    });
    await page.goto(`http://127.0.0.1:${server.port}/#/services`);
    await page.getByRole('button', { name: 'Show', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.locator('[title="original-copy"]').waitFor();
    await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
    await page.locator('button[data-testid="service-nav-endpoints"]').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('upstream-condition-input').fill(blank);
    await page.getByTestId('upstream-modal-save').click();
    await page.getByTestId('service-nav-identity').click();
    await page.getByTestId('service-name-input').fill('renamed');
    const response = page.waitForResponse(response => response.request().method() === 'PUT');
    await page.getByTestId('service-save-button').click();
    assert.equal((await response).status(), 202);
    await page.locator('[title="renamed"]').waitFor();
    assert.equal(writes.length, 2);
    const saved = config.logical_configuration.services[1]!;
    assert.equal(saved.name, 'renamed');
    assert.equal(Object.hasOwn(saved.endpoints[0]!, 'condition'), false);
    assert.deepEqual(config.logical_configuration.services[0], original.logical_configuration.services[0]);
    assert.deepEqual(config.logical_configuration.routes, original.logical_configuration.routes);
    if (managed) assert.equal(saved.endpoints[0]!.managedBy!.bindingId, saved.endpoints[0]!.plugins[0]!.id);
    assert.deepEqual(errors, []);
    console.log(`PASS copy → clear condition → rename → save (managed=${managed}, initialCondition=${initialCondition ?? 'unset'})`);
    await page.close();
  }
} finally {
  try { await browser.close(); } finally { await server.stop(true); }
}
}, 240_000);
