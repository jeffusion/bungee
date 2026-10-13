import { test } from 'bun:test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

// Real Chromium, explicitly mocked management responses: render/interaction evidence, not Core E2E.
test('stopped publication can be retried once and follows recovery until serving is confirmed', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
const base = uiRuntime.origin, evidence = uiRuntime.evidence;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const errors: string[] = [];
const results: object[] = [];
try {
  browser = await chromium.launch({headless:true});
  for (const [name, width, locale] of [['desktop', 1440, 'en'], ['mobile', 390, 'zh-CN']] as const) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addInitScript(language => localStorage.setItem('locale', language), locale);
    const page = await context.newPage();
    // Recovery behavior does not depend on a remote font service.
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({status:200,contentType:'text/css',body:''}));
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('403 (Forbidden)')) errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', request => errors.push(`network: ${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400 && !(response.status() === 403 && response.url().endsWith('/retry'))) errors.push(`HTTP ${response.status()}: ${response.url()}`); });
    let runtime = configurationRuntimeFixture(publicationFixture({ serving_revision: name === 'mobile' ? null : 7 }));
    let posts = 0;
    let deniedRetries = 0;
    let runtimeReads = 0;
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/auth/mode') return route.fulfill({json:{mode:'anonymous',publicOrigin:base}});
      if (path === '/api/auth/verify') return route.fulfill({ json: { success: true, mode:'anonymous',subject:{id:'anonymous',provider:'anonymous'} } });
      if (path === '/api/config/runtime') { runtimeReads++; return route.fulfill({ json: runtime }); }
      if (path === '/api/config') return route.fulfill({ json: runtime });
      if (path.endsWith('/retry') && request.method() === 'POST') {
        if (deniedRetries === 0) {
          deniedRetries++;
          return route.fulfill({ status: 403, json: { error: 'forbidden' } });
        }
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
      if (path === '/api/stats/dashboard') return route.fulfill({json:{totalRequests:0,failedRequests:0,averageResponseTime:0,requestsPerMinute:0,overview:[],series:[]}});
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
    assert.ok((await alert.innerText()).includes(locale === 'en' ? 'Configuration recovery stopped' : '配置恢复已停止，当前接流尚未确认'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await retry.focus();
    await page.screenshot({ path: resolve(evidence, `${name}-stopped.png`) });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-testid="publication-recovery-error"]') !== null);
    assert.equal(posts, 0);
    assert.equal(deniedRetries, 1);
    assert.equal(runtime.publication.recovery?.state, 'stopped');
    assert.ok((await page.getByTestId('publication-recovery-attempts').innerText()).includes('6/6'));
    await retry.waitFor();
    await page.waitForFunction(() => (document.querySelector('[data-testid="publication-retry-button"]') as HTMLButtonElement)?.disabled === false);
    await retry.focus();
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
    results.push({ name, width, locale, posts, deniedRetries, runtimeReads, hiddenAfterSuccess: true, overflow: false });
    await context.close();
  }
} finally {
  try { await browser?.close(); } finally { await uiRuntime.close(); }
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ management: 'mocked', results, errors, evidence }, null, 2));

}, 120_000);

test('runtime facts distinguish historical failure, active cleanup, dependency failure and stale reads in both languages', async () => {
  const ui = await startUiRuntime({ mode: 'built-page' });
  const evidence = await mkdtemp(join(tmpdir(), 'bungee-runtime-facts-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const errors: string[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const [locale, width] of [['en', 1440], ['zh-CN', 390]] as const) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addInitScript(language => localStorage.setItem('locale', language), locale);
      const page = await context.newPage();
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error' && !message.text().includes('503 (Service Unavailable)')) errors.push(message.text());
      });
      page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
      let unavailable = false;
      let writes = 0;
      const id = '10000000-0000-4000-8000-000000000001';
      let runtime = configurationRuntimeFixture(publicationFixture({
        operation: { operation_id: id, committed_revision: 8, state: 'degraded', result_status: 202,
          error_code: 'old_worker_drain_failed', updated_at: 1791820800000 },
        recovery: null, retryable: false, serving_complete: true, serving_revision: 8, cleanup: null,
      }));
      runtime = { ...runtime, health: { observed_at: Date.now(), component_recovery: [], dependencies: [] } };
      await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() !== 'GET') { writes++; errors.push(`Unexpected write: ${path}`); }
        const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
        if (path === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: ui.origin });
        if (path === '/api/auth/verify') return json({ success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } });
        if (path === '/api/config/runtime') return unavailable ? json({ error: 'repository_unavailable' }, 503) : json(runtime);
        if (path === '/api/config') return json(runtime);
        if (path === `/api/config/operations/${id}`) return json({ operation: { mutation_id: id, committed_revision: 8,
          state: 'degraded', result_status: 202, error_code: 'old_worker_drain_failed', error_detail: 'PRIVATE-DRAIN-DETAIL', updated_at: 1791820800000 }, workers: [] });
        if (path === '/api/plugins') return json([]);
        if (path === '/api/plugin-translations') return json({});
        if (path === '/api/resources/api-key') return json({ keys: [] });
        if (path === '/api/logs/cleanup/config') return json({ enabled: true, retentionDays: 1, scheduleIntervalHours: 1, isActive: true });
        errors.push(`Unexpected API: ${path}`); return json({ error: 'unexpected_request' }, 500);
      });
      await page.goto(`${ui.origin}/#/config`, { waitUntil: 'networkidle' });
      const historical = locale === 'en' ? 'Historical finalization failure' : '历史收尾失败记录';
      await page.getByTestId('settings-publication-state').getByText(new RegExp(historical)).waitFor();
      assert.equal(await page.getByTestId('configuration-publication-banner').count(), 0);
      await page.getByTestId('publication-history-time').waitFor();
      const details = page.locator('[aria-controls="settings-publication-details"]');
      await details.click();
      await page.getByTestId('cleanup-unavailable').waitFor();
      assert.equal((await page.locator('body').innerText()).includes('PRIVATE-DRAIN-DETAIL'), false);
      await page.screenshot({ path: resolve(evidence, `${locale}-historical.png`) });
      runtime = { ...runtime, publication: { ...runtime.publication, cleanup: { active: true, state: 'pending', reason_code: null,
        pending_count: 2, exit_unknown_count: 0, failed_count: 0, unknown_count: 2, remaining_ms: 8000,
        members: [{ slot: 0, exit_state: 'live', cleanup_state: 'unknown', remaining_ms: 9000 },
          { slot: 1, exit_state: 'live', cleanup_state: 'unknown', remaining_ms: 8000 }] } } };
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh status' : '刷新状态', exact: true }).click();
      await page.getByTestId('configuration-publication-banner').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-testid="cleanup-remaining"]')?.textContent?.includes('8000 ms'));
      assert.equal(await page.getByTestId('publication-history-time').count(), 0);
      runtime = { ...runtime, publication: { ...runtime.publication, cleanup: { ...runtime.publication.cleanup!, remaining_ms: 2000 } } };
      await page.waitForFunction(() => document.querySelector('[data-testid="cleanup-remaining"]')?.textContent?.includes('2000 ms'), { timeout: 3000 });
      runtime = { ...runtime, publication: { ...runtime.publication, cleanup: { ...runtime.publication.cleanup!,
        state: 'stopped', reason_code: 'exit_unknown', pending_count: 1, exit_unknown_count: 1, remaining_ms: 0 } } };
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh status' : '刷新状态', exact: true }).click();
      await page.getByTestId('cleanup-reason').waitFor();
      assert.ok((await page.getByTestId('cleanup-reason').innerText()).includes(locale === 'en' ? 'Exit confirmation' : '退出确认'));
      await page.screenshot({ path: resolve(evidence, `${locale}-cleanup-stopped.png`) });
      runtime = { ...runtime, publication: { ...runtime.publication, cleanup: { ...runtime.publication.cleanup!, state: 'released', active: false,
        reason_code: null,
        pending_count: 0, exit_unknown_count: 0, failed_count: 1, unknown_count: 0, remaining_ms: null,
        members: [{ slot: 0, exit_state: 'confirmed', cleanup_state: 'failed', remaining_ms: null }] } } };
      runtime = { ...runtime, health: { observed_at: Date.now(), component_recovery: [{ component: 'plugin_state', state: 'stopped',
        attempt_count: 6, max_attempts: 6, next_retry_at: null, reason_code: 'retry_exhausted' }],
        dependencies: [{ component: 'management_provider', state: 'unavailable', fresh: true, observed_at: Date.now() }] } };
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh status' : '刷新状态', exact: true }).click();
      await page.getByTestId('component-recovery').getByText(/6\/6/).waitFor();
      assert.ok((await page.getByTestId('configuration-publication-banner').innerText()).includes(locale === 'en' ? 'runtime component or dependency' : '运行组件或依赖'));
      assert.ok((await page.getByTestId('cleanup-summary').innerText()).includes(locale === 'en' ? 'Cleanup failed 1' : '清理失败 1'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(evidence, `${locale}-current-fault.png`) });
      runtime = { ...runtime, health: { observed_at: Date.now(), component_recovery: [],
        dependencies: [{ component: 'management_provider', state: 'ready', fresh: false, observed_at: 1 }] } };
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh status' : '刷新状态', exact: true }).click();
      await page.getByTestId('runtime-dependency').getByText(new RegExp(locale === 'en' ? 'Stale' : '过期')).waitFor();
      assert.ok((await page.getByTestId('configuration-publication-banner').innerText()).includes(locale === 'en' ? 'runtime component or dependency' : '运行组件或依赖'));
      await page.screenshot({ path: resolve(evidence, `${locale}-dependency-stale.png`) });
      unavailable = true;
      await page.getByRole('button', { name: locale === 'en' ? 'Refresh status' : '刷新状态', exact: true }).click();
      await page.getByTestId('runtime-uncertain').waitFor();
      await page.getByTestId('cleanup-unavailable').waitFor();
      await page.getByTestId('health-unavailable').waitFor();
      assert.ok((await page.getByTestId('settings-serving-state').innerText()).toLowerCase().includes(locale === 'en' ? 'unknown' : '未知'));
      assert.equal(writes, 0);
      await page.screenshot({ path: resolve(evidence, `${locale}-stale.png`) });
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ management: 'mocked', locales: ['en', 'zh-CN'], errors, evidence }));
  } finally { try { await browser?.close(); } finally { await ui.close(); } }
}, 120_000);
