import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';

// Real Chromium, explicitly mocked management responses: render/interaction evidence, not Core E2E.
const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const evidence = resolve(import.meta.dir, '../../../.omo/evidence/publication-recovery');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const results: object[] = [];
try {
  for (const [name, width, locale] of [['desktop', 1440, 'en'], ['mobile', 390, 'zh-CN']] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(language => localStorage.setItem('locale', language), locale);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', request => errors.push(`network: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    let runtime = configurationRuntimeFixture(publicationFixture({ serving_revision: name === 'mobile' ? null : 7 }));
    let posts = 0;
    let runtimeReads = 0;
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/verify') return route.fulfill({ json: { success: true } });
      if (path === '/api/config/runtime') { runtimeReads++; return route.fulfill({ json: runtime }); }
      if (path === '/api/config') return route.fulfill({ json: runtime });
      if (path.endsWith('/retry') && request.method() === 'POST') {
        posts++;
        const body = request.postDataJSON();
        assert.deepEqual(Object.keys(body).sort(), ['expected_revision', 'request_id']);
        assert.equal(body.expected_revision, 8);
        assert.match(body.request_id, /^[0-9a-f-]{36}$/);
        assert.equal(path, `/api/config/operations/${runtime.publication.operation!.operation_id}/retry`);
        runtime = configurationRuntimeFixture({ ...runtime.publication, retryable: false,
          recovery: { ...runtime.publication.recovery!, recovery_id: body.request_id, trigger: 'manual',
            state: 'running', attempt_count: 1, final_reason_code: null } });
        await new Promise(resolve => setTimeout(resolve, 250));
        return route.fulfill({ status: 202, json: runtime.publication.recovery });
      }
      if (path === '/api/runtime/upstreams') return route.fulfill({ json: {
        schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete',
        reason: null, admission: { revision: 7 }, workers: { observed: [], missing: [] }, upstreams: [],
      } });
      if (path === '/api/plugins') return route.fulfill({ json: [] });
      if (path === '/api/plugin-translations') return route.fulfill({ json: {} });
      if (path === '/api/stats/history/v2') return route.fulfill({ json: {
        timestamps: ['2026-09-13T12:00:00Z'], requests: [120], errors: [0], responseTime: [85], successRate: [100],
      } });
      if (path === '/api/stats/upstream-stats' || path === '/api/stats/upstream-status-codes') return route.fulfill({ json: { data: [], type: 'all' } });
      errors.push(`Unexpected management request: ${path}`);
      return route.fulfill({ status: 500, json: { error: 'unexpected_mock_request' } });
    });
    await page.goto(`${base}/#/`, { waitUntil: 'networkidle' });
    const alert = page.getByTestId('dashboard-publication-recovery');
    const retry = page.getByTestId('publication-retry-button');
    await alert.waitFor();
    assert.ok((await alert.innerText()).includes(locale === 'en' ? 'Configuration recovery stopped' : '当前配置尚未生效'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await retry.focus();
    await page.screenshot({ path: resolve(evidence, `${name}-stopped.png`) });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (document.querySelector('[data-testid="publication-retry-button"]') as HTMLButtonElement)?.disabled === true);
    await retry.waitFor({ state: 'hidden' });
    assert.equal(posts, 1);
    const reads = runtimeReads;
    await page.waitForTimeout(1200);
    assert.ok(runtimeReads > reads, 'active recovery polls every second');
    assert.ok((await page.getByTestId('publication-recovery-attempts').innerText()).includes('1/6'));
    await page.screenshot({ path: resolve(evidence, `${name}-running.png`) });
    runtime = configurationRuntimeFixture({ ...runtime.publication, serving_complete: true,
      serving_revision: 8, recovery: { ...runtime.publication.recovery!, state: 'succeeded', final_reason_code: 'target_serving' } });
    await alert.waitFor({ state: 'hidden', timeout: 3000 });
    assert.equal(await retry.count(), 0);
    await page.screenshot({ path: resolve(evidence, `${name}-resolved.png`) });
    results.push({ name, width, locale, posts, runtimeReads, hiddenAfterSuccess: true, overflow: false });
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ management: 'mocked', results, errors }, null, 2));
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ management: 'mocked', results, errors, evidence }, null, 2));
