import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SQLitePluginStorage } from '../packages/core/src/plugin-storage';
import { HostSnapshotStore } from '../packages/core/src/plugin-services/snapshot-store';
import { PluginCommunicationStore } from '../packages/core/src/plugin-services/persistence';
import { MODELS_DEV_SETTINGS_KEY } from '../plugins/models-dev/server/store';
import {
  createGatewayFixture, reservePortBlock, startTrackedGatewayMaster, waitForHealth,
  waitUntil, recordOwnedWorkers, stopOwnedMaster, releasePortBlock, quarantinePortBlock,
  cleanupGatewayFixture, requestJson, safeGatewayError, type OwnedMaster,
  type GatewayMasterStartupState,
} from './support/token-stats-gateway';

const SERVICE = '10000000-0000-4000-8000-0000000000ae';
const UPSTREAM = '20000000-0000-4000-8000-0000000000ae';
const ROUTE = '30000000-0000-4000-8000-0000000000ae';
type Row = { attempt_id: string; model: string; cost_usd: number | null; input_tokens: number };

test('original-lab estimates and context tiers settle protected USD budgets across refresh and restart', async () => {
  const fixture = await createGatewayFixture();
  const lease = await reservePortBlock();
  const startup: GatewayMasterStartupState = { attempted: false, errors: [] };
  let master: OwnedMaster | undefined;
  let failed = false;
  let calls = 0;
  const evidence = join('/tmp/bungee-pricing-estimate', `integration-${randomUUID()}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    const input = await request.json() as { model: string; fixtureUsage: { input: number; cached: number } };
    calls++;
    return Response.json({ id: `pricing-${calls}`, object: 'chat.completion', model: input.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: input.fixtureUsage.input, completion_tokens: 100,
        total_tokens: input.fixtureUsage.input + 100, prompt_tokens_details: { cached_tokens: input.fixtureUsage.cached } } });
  } });
  const management = `http://127.0.0.1:${lease.base}`;
  const proxy = `http://127.0.0.1:${lease.block.ports[1]}`;
  const password = randomBytes(24).toString('base64url');
  let authorization = '';
  let keyId = '';
  let dataToken = '';
  let revision = 0;
  let workers: Array<{ pid: number; worker_instance_id: string }> = [];
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const result = await requestJson(`${management}${path}`, { method,
      headers: { ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, fixture);
    if (!result.response.ok) throw new Error(`management ${path} returned ${result.response.status}: ${result.text}`);
    return result.body as any;
  };
  const rows = (): Row[] => {
    const db = new Database(fixture.accessDbPath, { readonly: true });
    try { return db.query<Row, []>('SELECT attempt_id, model, cost_usd, input_tokens FROM token_stats_attempts ORDER BY rowid').all(); }
    finally { db.close(); }
  };
  const publish = async (version: number, multiplier = 1, corrupt = false) => {
    const db = new Database(fixture.configDbPath);
    try {
      const store = new HostSnapshotStore(new PluginCommunicationStore(db, undefined, { setup: false }).forNamespace('models-dev'),
        { owner: 'models-dev', id: 'models-dev.catalog.v1', schemaVersion: 1, maxVersions: 3 });
      const price = { input: 2 * multiplier, output: 10 * multiplier, cache_read: 0.1 * multiplier,
        tiers: [{ input: 4 * multiplier, output: 15 * multiplier, cache_read: 0.2 * multiplier,
          tier: { type: 'context', size: 272_000 } }], context_over_200k: { input: 100, output: 100 } };
      store.publish(version, { version, fetchedAt: Date.now(), catalog: corrupt ? null : {
        openai: { models: { 'gpt-6.1-sol': { cost: price }, 'gpt-4o-mini': { cost: price } } },
        mirror: { models: { 'gpt-6.1-sol': { cost: { input: 100, output: 100 } } } },
      } });
    } finally { db.close(); }
  };
  const ready = async (version: number, inputPrice: number) => {
    const observed = new Set<number>();
    await waitUntil(async () => {
      const result = await fetch(`${proxy}/catalog-fixture-ready`, { signal: AbortSignal.timeout(2_000) });
      const body = await result.json() as { pid: number; version: number; inputPrice: number };
      if (result.ok && body.version === version && body.inputPrice === inputPrice) observed.add(body.pid);
      return workers.every(worker => observed.has(worker.pid));
    }, `both workers did not load pricing version ${version}`, 25_000);
  };
  const post = async (model: string, input: number, cached: number, expected: number) => {
    const before = rows().length;
    const result = await fetch(`${proxy}/pricing-estimate/chat/completions`, { method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${dataToken}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'isolated price acceptance' }], fixtureUsage: { input, cached } }) });
    expect(result.status, await result.text()).toBe(200);
    await waitUntil(async () => rows().length === before + 1, 'stats row was not recorded', 10_000);
    const row = rows().at(-1)!;
    expect(row.model).toBe(model);
    expect(row.cost_usd).toBeCloseTo(expected, 9);
    await waitUntil(async () => {
      const ledger = await api(`/api/plugins/token-budget/control/keys/${keyId}`);
      return ledger.usage.attempts.some((attempt: any) => attempt.attemptId === row.attempt_id
        && attempt.status === 'settled' && attempt.costNanoUsd === Math.round(expected * 1e9));
    }, 'shared price did not durably settle USD budget', 10_000);
    const ledger = await api(`/api/plugins/token-budget/control/keys/${keyId}`);
    expect(ledger.value.money.cumulativeNanoUsd).toBe(rows().reduce((sum, row) => sum + Math.round(row.cost_usd! * 1e9), 0));
    return row;
  };
  const inventory = async () => {
    await waitUntil(async () => {
      const runtime = await api('/api/config/runtime');
      workers = runtime.workers ?? [];
      return runtime.revision === revision && runtime.publication?.serving_complete === true && workers.length === 2;
    }, 'configuration did not converge to two workers');
    await recordOwnedWorkers(master!, workers);
  };
  try {
    for (const name of ['key-access', 'token-budget', 'local-accounts']) {
      await cp(resolve(import.meta.dir, '../packages/core/dist/plugins', name), join(fixture.pluginsPath, name), { recursive: true, errorOnExist: true });
    }
    master = await startTrackedGatewayMaster(startup, fixture, lease);
    await waitForHealth(master, lease.base, fixture);
    const db = new Database(fixture.accessDbPath);
    try { await new SQLitePluginStorage(db, 'models-dev').set(MODELS_DEV_SETTINGS_KEY, { autoRefresh: false, intervalHours: 24, timeoutSeconds: 15 }); }
    finally { db.close(); }
    await publish(1);
    const initial = await api('/api/config');
    const aggregate = { ...initial.config,
      plugin_activations: ['models-dev', 'token-metering', 'token-stats', 'catalog-version-probe', 'key-access', 'token-budget', 'local-accounts'].map(plugin_name => ({ plugin_name })),
      logical_configuration: { plugins: [], services: [{ id: SERVICE, position: 1, name: 'estimate-acceptance', plugins: [],
        endpoints: [{ id: UPSTREAM, position: 1, target: `http://127.0.0.1:${upstream.port}/v1/`, weight: 100, priority: 1, is_disabled: false, plugins: [] }] }],
      routes: [{ id: ROUTE, position: 1, path: '/pricing-estimate', service_id: SERVICE, plugins: [] },
        { id: '30000000-0000-4000-8000-0000000000af', position: 2, path: '/catalog-fixture-ready', service_id: SERVICE, plugins: [] }] } };
    const mutation = randomUUID();
    await api('/api/config', 'PUT', { expected_revision: initial.revision, mutation_id: mutation, aggregate,
      managementSetup: { username: 'pricing-admin', password, passwordConfirmation: password } });
    revision = initial.revision + 1;
    await waitUntil(async () => (await (await fetch(`${management}/api/auth/mode`)).json() as any).mode === 'plugin', 'management authentication did not activate');
    expect((await fetch(`${management}/api/config`)).status).toBe(401);
    const login = await api('/api/auth/login', 'POST', { username: 'pricing-admin', password, transport: 'bearer' });
    authorization = `Bearer ${login.token}`;
    await inventory();
    await ready(1, 2);
    const issued = await api('/api/plugins/key-access/control/credentials', 'POST', { name: 'Estimate Acceptance' });
    keyId = issued.key.id; dataToken = issued.token;
    await api('/api/plugins/key-access/control/route-key', 'PUT', { keyId, routeId: ROUTE, protect: true });
    await api(`/api/plugins/token-budget/control/keys/${keyId}`, 'PUT', { mode: 'cumulative', unit: 'usd', limit: 100 });
    const denied = await fetch(`${proxy}/pricing-estimate/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401); await denied.text(); expect(calls).toBe(0);
    await post('gpt-6.1-sol', 100_000, 80_000, 0.049);
    await post('gpt-6.1-sol', 272_000, 270_000, 0.0635);
    await post('GPT-6.1-SOL-HIGH', 100_000, 80_000, 0.049);
    expect((await api('/api/plugins/token-stats/control/pricing/mappings')).mappings).toEqual([]);
    const oldRows = rows();
    await publish(2, 2); await ready(2, 4);
    await post('gpt-6.1-sol', 272_000, 270_000, 0.127);
    expect(rows().slice(0, oldRows.length)).toEqual(oldRows);
    await publish(3, 1, true);
    // Wait for the reconcile interval, then prove both views still price v2.
    await Bun.sleep(6_000); await ready(2, 4);
    await post('gpt-6.1-sol', 100_000, 80_000, 0.098);
    await publish(4); await ready(4, 2);
    await api('/api/plugins/token-stats/control/pricing/mappings', 'PUT', [{ source: 'gpt-6.1-sol', provider: 'mirror', model: 'gpt-6.1-sol' }]);
    await Bun.sleep(11_000);
    await post('gpt-6.1-sol', 100_000, 80_000, 10.01);
    const beforeRestart = rows();
    await stopOwnedMaster(master); master = undefined;
    master = await startTrackedGatewayMaster(startup, fixture, lease);
    // Authenticated runtime inventory replaces the anonymous helper after restart.
    await waitUntil(async () => (await fetch(`${management}/health`)).ok, 'restarted master did not become healthy');
    await inventory(); await ready(4, 2);
    expect(rows()).toEqual(beforeRestart);
    await post('gpt-6.1-sol', 100_000, 80_000, 10.01);

    if (process.env.BUNGEE_PRICING_BROWSER === '1') {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
        const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${management}/#/login`);
        const form = page.getByTestId('page-login').locator('form');
        await form.locator('input[autocomplete="username"]').fill('pricing-admin');
        await form.locator('input[autocomplete="current-password"]').fill(password);
        await form.locator('button.nx-btn-primary').click();
        await page.waitForURL(url => url.hash === '#/');
        await page.goto(`${management}/#/plugins/token-stats/statistics`);
        await page.getByTestId('token-stats-page-summary').waitFor();
        const uppercase = page.getByTestId('token-stats-model-row').filter({ hasText: 'GPT-6.1-SOL-HIGH' });
        await uppercase.waitFor(); expect(await uppercase.innerText()).toContain('$0.049');
        expect(await page.getByTestId('token-stats-model-list').innerText()).toContain('gpt-6.1-sol');
        await page.screenshot({ path: join(evidence, 'statistics.png'), fullPage: true });
        await page.goto(`${management}/#/plugins/token-stats/pricing`);
        await page.getByTestId('token-stats-settings').waitFor();
        expect(await page.getByTestId('client-model-input').inputValue()).toBe('gpt-6.1-sol');
        await page.screenshot({ path: join(evidence, 'settings.png'), fullPage: true });
        expect(errors).toEqual([]);
      } finally { await browser.close(); }
    }
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ workers: workers.map(w => w.pid), authenticated: true,
      calls, rows: rows(), browser: process.env.BUNGEE_PRICING_BROWSER === '1', budget: (await api(`/api/plugins/token-budget/control/keys/${keyId}`)).value.money }, null, 2));
    console.info(`pricing integration evidence: ${evidence}`);
  } catch (error) {
    failed = true;
    await writeFile(join(evidence, 'failure.txt'), safeGatewayError(error, fixture) + '\n' + (await master?.diagnostics?.() ?? ''));
    throw error;
  } finally {
    master ??= startup.master;
    let shutdownVerified = false;
    try { if (master) { await stopOwnedMaster(master); shutdownVerified = true; } }
    finally {
      await upstream.stop(true);
      let portsVerifiedClosed = false;
      try { await releasePortBlock(lease); portsVerifiedClosed = true; }
      catch (error) { quarantinePortBlock(lease); throw error; }
      if (!failed) await cleanupGatewayFixture(fixture, { startupAttempted: startup.attempted, master, shutdownVerified, portsVerifiedClosed });
    }
  }
}, 180_000);
