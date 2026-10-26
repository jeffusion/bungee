import { afterAll, beforeAll } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';
import { expect } from 'playwright/test';
import { resolve } from 'node:path';
import {collectApiEvidence} from './api-evidence';
import { startUiRuntime } from '../../../../../tests/helpers/ui-runtime';

/** Register a file-owned runtime; each call to withPage owns a fresh context. */
export function editorFixture(scenarios: string[]) {
  let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
  const paths = Object.fromEntries(scenarios.map(name => [name, resolve(import.meta.dir, `../../fixtures/editors/${name}.html`)]));
  beforeAll(async () => {
    runtime = await startUiRuntime({ mode: 'component-fixture', entries: Object.values(paths) });
    try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
  }, 120_000);
  afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
  const fixtureUrl = (name: string) => `${runtime.origin}/@fs${paths[name]}`;
  async function withPage(query: string, run: (page: Page,evidence:ReturnType<typeof collectApiEvidence>) => Promise<void>, options?: {beforeMount?:(page:Page)=>Promise<void>; hash?:string}) {
    const scenario = new URLSearchParams(query).get('scenario')!;
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const evidence=collectApiEvidence(page),errors=evidence.errors;
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === 'GET' && path === '/api/plugins/schemas') return route.fulfill({ json: {
          'fixture-plugin': { name: 'fixture-plugin', configSchema: [{ name: 'visible', type: 'string', label: 'Visible' }] },
        } });
        if (request.method() === 'GET' && path === '/api/plugins') return route.fulfill({ json: [{ name: 'fixture-plugin', enabled: true }] });
        if (['service', 'upstreams'].includes(scenario) && request.method() === 'GET' && path === '/api/runtime/upstreams') return route.fulfill({json:{schema:'bungee-runtime-upstreams-v1',generated_at:Date.now(),availability:'complete',reason:null,admission:{revision:1},workers:{observed:[],missing:[]},upstreams:[]}});
        if (request.method() === 'GET' && path === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { plugin_activations: [], logical_configuration: { routes: [], services: [], plugins: [] } } } });
        errors.push(`Unexpected ${request.method()} ${path}`);
        return route.fulfill({ status: 500, json: { error: 'unexpected_request' } });
      });
      await options?.beforeMount?.(page);
      const initialConfig = scenario === 'service' ? page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/config') : undefined;
      await page.goto(`${fixtureUrl(scenario)}?${query}${options?.hash??''}`);
      if(initialConfig) { await (await initialConfig).finished(); await page.evaluate(async()=>{await Promise.resolve();}); }
      try { await run(page,evidence); } catch (error) { throw new AggregateError([error, ...errors.map(message => new Error(message))], 'Component browser assertion failed'); }
      expect(errors).toEqual([]);evidence.verify();
    } finally { await context.close(); }
  }
  return { withPage, fixtureUrl };
}
