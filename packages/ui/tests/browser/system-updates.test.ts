import { beforeAll, afterAll, test, expect as assert } from 'bun:test';
import { chromium, expect, type Browser, type Page } from 'playwright/test';
import type { SystemUpdateStatus } from '@jeffusion/bungee-types';
import { collectApiEvidence } from '../helpers/editors/api-evidence';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/components/system-updates.html'] });
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

const initial = (): SystemUpdateStatus => ({ running_version: '6.6.0', selected_version: null,
  latest: { version: '6.7.0', published_at: '2026-10-25T08:00:00Z', url: 'https://github.com/jeffusion/bungee/releases/tag/v6.7.0', asset_ready: true },
  checked_at: Date.now(), check_error: null, checking: false, can_upgrade: true, unavailable_reason: null, operation: null });

async function scenario(run: (page: Page, state: {
  status: SystemUpdateStatus; posts: unknown[]; confirmations: unknown[]; checks: number; reads: number;
  response: 'accepted' | 'lost' | 'unauthorized'; confirmResponse: 'accepted' | 'lost' | 'unauthorized';
}) => Promise<void>, language = 'en', startOpen = true, status = initial()) {
  const context = await browser.newContext({ locale: language });
  const state = { status, posts: [] as unknown[], confirmations: [] as unknown[], checks: 0, reads: 0,
    response: 'accepted' as 'accepted' | 'lost' | 'unauthorized', confirmResponse: 'accepted' as 'accepted' | 'lost' | 'unauthorized' };
  try {
    const page = await context.newPage();
    const evidence = collectApiEvidence(page), errors = evidence.errors;
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path === '/api/system/updates') { state.reads++; return route.fulfill({ json: state.status }); }
      if (request.method() === 'POST' && path === '/api/system/updates/check') { state.checks++; return route.fulfill({ json: state.status }); }
      if (request.method() === 'POST' && path === '/api/system/updates/confirm') {
        const body = request.postDataJSON(); state.confirmations.push(body);
        assert(body).toEqual({ operation_id: state.status.operation!.id,
          current_version: state.status.operation!.source_version, target_version: state.status.operation!.target_version });
        if (state.confirmResponse === 'unauthorized') { evidence.expectStatus(route, 401); return route.fulfill({ status: 401, json: { error: 'unauthorized' } }); }
        if (state.confirmResponse === 'lost') { evidence.expectFailure(request, 'net::ERR_FAILED'); return route.abort('failed'); }
        state.status.operation!.phase = 'restarting';
        return route.fulfill({ status: 202, json: state.status });
      }
      if (request.method() === 'POST' && path === '/api/system/updates') {
        state.posts.push(request.postDataJSON());
        if (state.response === 'unauthorized') { evidence.expectStatus(route, 401); return route.fulfill({ status: 401, json: { error: 'unauthorized' } }); }
        if (state.response === 'lost') { evidence.expectFailure(request, 'net::ERR_FAILED'); return route.abort('failed'); }
        const body = request.postDataJSON();
        state.status.operation = { id: body.operation_id, source_version: body.current_version, target_version: body.target_version,
          phase: 'downloading', error: null, started_at: Date.now(), updated_at: Date.now() };
        state.status.can_upgrade = false;
        return route.fulfill({ status: 202, json: state.status });
      }
      errors.push(`Unexpected API ${request.method()} ${path}`);
      return route.fulfill({ status: 501, json: { error: 'unexpected_fixture_request' } });
    });
    await page.goto(`${runtime.origin}/tests/fixtures/components/system-updates.html?language=${language}`);
    await expect.poll(() => state.reads).toBeGreaterThan(0);
    if (startOpen) {
      await page.getByTestId('system-updates-trigger').click();
      await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    }
    await run(page, state);
    evidence.verify();
    assert(errors).toEqual([]);
  } finally { await context.close(); }
}

test('current version hides the update entry while pending and failed operations remain accessible', async () => {
  const status = initial();
  status.latest!.version = status.running_version;
  status.can_upgrade = false;
  await scenario(async (page, state) => {
    await expect(page.getByTestId('system-updates-trigger')).toHaveCount(0);

    state.status.operation = { id: '27a59927-c8ea-4b75-af70-56bd9845d833', source_version: '6.5.0',
      target_version: '6.6.0', phase: 'awaiting_confirmation', error: null, started_at: Date.now(), updated_at: Date.now() };
    await page.reload();
    await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('updates-install')).toBeEnabled();

    state.status.operation.phase = 'failed';
    state.status.operation.error = 'shutdown_failed';
    await page.reload();
    await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('update-operation')).toHaveAttribute('data-phase', 'failed');

    state.status.operation = null;
    state.status.check_error = 'release_check_failed';
    await page.reload();
    await expect(page.getByTestId('system-updates-trigger')).toBeVisible();
    assert(state.posts).toHaveLength(0);
    assert(state.confirmations).toHaveLength(0);
  }, 'en', false, status);
}, 30_000);

test('idle status refreshes only on entry or manually; an upgrade polls until it finishes', async () => {
  await scenario(async (page, state) => {
    await page.clock.install();
    await page.reload();
    await expect(page.getByTestId('system-updates-trigger')).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    const reads = state.reads;
    await page.clock.fastForward(65_000);
    assert(state.reads).toBe(reads);
    await page.screenshot({ path: '/tmp/bungee-system-updates-header.png' });
    await page.getByTestId('system-updates-trigger').hover();
    await page.screenshot({ path: '/tmp/bungee-system-updates-header-hover.png' });
    await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    assert(state.reads).toBe(reads + 1);
    await page.clock.fastForward(65_000);
    assert(state.reads).toBe(reads + 1);
    await page.getByTestId('updates-check').click();
    await expect.poll(() => state.checks).toBe(1);
    await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    await page.getByTestId('updates-upgrade').click();
    await page.getByTestId('confirmation-accept').click();
    await expect(page.getByTestId('update-operation')).toHaveAttribute('data-phase', 'downloading');
    await expect(page.getByTestId('updates-check')).toBeEnabled();
    const downloadingReads = state.reads;
    state.status.operation!.phase = 'awaiting_confirmation';
    await page.clock.runFor(2_000);
    await expect(page.getByTestId('updates-install')).toBeEnabled();
    assert(state.reads).toBeGreaterThan(downloadingReads);
    state.status.operation!.phase = 'succeeded';
    await page.clock.runFor(2_000);
    await expect(page.getByTestId('update-operation')).toHaveAttribute('data-phase', 'succeeded');
    const finishedReads = state.reads;
    await page.clock.fastForward(65_000);
    assert(state.reads).toBe(finishedReads);
    assert(state.posts).toHaveLength(1);
    assert(state.confirmations).toHaveLength(0);
  }, 'zh-CN', false);
}, 30_000);

test('two confirmations separate download from restart; fixed countdown reloads once while restarting', async () => {
  await scenario(async (page, state) => {
    assert(state.posts).toHaveLength(0);
    await page.getByTestId('updates-check').click();
    await expect.poll(() => state.checks).toBe(1);
    await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    await page.getByTestId('updates-upgrade').click();
    await page.getByTestId('confirmation-cancel').click();
    await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    assert(state.posts).toHaveLength(0);
    await page.getByTestId('updates-upgrade').click();
    await page.getByTestId('confirmation-accept').evaluate(node => { (node as HTMLElement).click(); (node as HTMLElement).click(); });
    await expect.poll(() => state.posts.length).toBe(1);
    const body = state.posts[0] as any;
    assert(body).toEqual({ operation_id: assert.any(String), current_version: '6.6.0', target_version: '6.7.0' });
    assert(body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId('updates-upgrade')).toBeDisabled();
    await expect(page.getByTestId('update-operation')).toBeVisible();
    state.status.operation!.phase = 'awaiting_confirmation';
    await expect(page.getByTestId('updates-install')).toBeEnabled();
    await page.getByTestId('updates-install').click();
    await page.getByTestId('confirmation-cancel').click();
    assert(state.confirmations).toHaveLength(0);
    await expect(page.getByTestId('update-countdown')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/bungee-system-updates-ready-en.png' });
    let reloads = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads++; });
    await page.getByTestId('updates-install').click();
    const began = Date.now();
    const loaded = page.waitForEvent('load');
    await page.getByTestId('confirmation-accept').evaluate(node => { (node as HTMLElement).click(); (node as HTMLElement).click(); });
    await expect.poll(() => state.confirmations.length).toBe(1);
    await expect(page.getByTestId('update-countdown')).toBeVisible();
    await page.screenshot({ path: '/tmp/bungee-system-updates-countdown-en.png' });
    await page.waitForFunction(() => {
      const intent = JSON.parse(sessionStorage.getItem('bungee.system-update.reload')!);
      return Date.now() >= intent.at - 1000;
    });
    assert(reloads).toBe(0);
    await loaded;
    assert(Date.now() - began).toBeGreaterThanOrEqual(10_000);
    assert(state.status.operation!.phase).toBe('restarting');
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bungee.system-update.reload'))).toBeNull();
    assert(reloads).toBe(1);assert(state.posts).toHaveLength(1);assert(state.confirmations).toHaveLength(1);
  });
}, 30_000);

test('lost download responses recover by querying only; other-page upgrades preserve the draft', async () => {
  await scenario(async (page, state) => {
    state.response = 'lost';
    const failed = page.waitForEvent('requestfailed', request => request.method() === 'POST'
      && new URL(request.url()).pathname === '/api/system/updates');
    await page.getByTestId('updates-upgrade').click();
    await page.getByTestId('confirmation-accept').click();
    await failed;
    await expect(page.getByTestId('update-unknown')).toBeVisible();
    await expect(page.getByTestId('updates-upgrade')).toBeDisabled();
    const reads = state.reads;
    await page.reload();
    await expect.poll(() => state.reads).toBeGreaterThan(reads);
    await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('update-unknown')).toBeVisible();
    await expect(page.getByTestId('updates-upgrade')).toBeDisabled();
    const body = state.posts[0] as any;
    state.status.operation = { id: body.operation_id, source_version: body.current_version, target_version: body.target_version,
      phase: 'awaiting_confirmation', error: null, started_at: Date.now(), updated_at: Date.now() };
    await expect(page.getByTestId('update-unknown')).toHaveCount(0);
    await expect(page.getByTestId('update-operation')).toBeVisible();
    await expect(page.getByTestId('updates-install')).toBeEnabled();
    assert(state.confirmations).toHaveLength(0);
    await page.getByRole('button', { name: /Close|关闭/, exact: true }).click();
    await page.getByRole('textbox', { name: 'Draft' }).fill('unsaved work');
    await page.getByTestId('system-updates-trigger').click();
    state.status.operation.phase = 'succeeded';
    state.status.running_version = '6.7.0';
    state.status.selected_version = '6.7.0';
    state.status.can_upgrade = false;
    await expect(page.getByTestId('update-operation')).toHaveAttribute('data-phase', 'succeeded');
    await page.screenshot({ path: '/tmp/bungee-system-updates-zh.png' });
    await page.getByRole('button', { name: /Close|关闭/, exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('unsaved work');
    assert(state.posts).toHaveLength(1);
  }, 'zh-CN');
}, 30_000);

test('lost installation confirmation preserves the fixed reload deadline across refresh and failed status', async () => {
  await scenario(async (page, state) => {
    await page.getByTestId('updates-upgrade').click();await page.getByTestId('confirmation-accept').click();
    await expect.poll(() => state.posts.length).toBe(1);
    state.status.operation!.phase = 'awaiting_confirmation';
    await expect(page.getByTestId('updates-install')).toBeEnabled();
    state.confirmResponse = 'lost';
    const failed = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/system/updates/confirm');
    await page.getByTestId('updates-install').click();await page.getByTestId('confirmation-accept').click();await failed;
    await expect(page.getByTestId('update-unknown')).toBeVisible();
    const intent = await page.evaluate(() => JSON.parse(sessionStorage.getItem('bungee.system-update.reload')!));
    await page.reload();await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('updates-install')).toBeDisabled();
    assert(await page.evaluate(() => JSON.parse(sessionStorage.getItem('bungee.system-update.reload')!))).toEqual(intent);
    let reloads = 0;page.on('framenavigated', frame => { if (frame === page.mainFrame()) reloads++; });
    const loaded = page.waitForEvent('load');
    state.status.operation!.phase = 'failed'; state.status.operation!.error = 'shutdown_failed';
    await expect(page.getByTestId('update-operation')).toHaveAttribute('data-phase', 'failed');
    await expect(page.getByTestId('update-countdown')).toBeVisible();
    await loaded;
    assert(Date.now()).toBeGreaterThanOrEqual(intent.at);
    assert(await page.evaluate(() => sessionStorage.getItem('bungee.system-update.reload'))).toBeNull();
    assert(reloads).toBe(1);assert(state.posts).toHaveLength(1);assert(state.confirmations).toHaveLength(1);
  }, 'zh-CN');
}, 30_000);

test('an unauthorized second confirmation never replays on reauthentication', async () => {
  await scenario(async (page, state) => {
    await page.getByTestId('updates-upgrade').click();await page.getByTestId('confirmation-accept').click();
    await expect.poll(() => state.posts.length).toBe(1);state.status.operation!.phase = 'awaiting_confirmation';
    await expect(page.getByTestId('updates-install')).toBeEnabled();state.confirmResponse = 'unauthorized';
    await page.getByTestId('updates-install').click();await page.getByTestId('confirmation-accept').click();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bungee.system-update.reload'))).toBeNull();
    await page.reload();await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('updates-install')).toBeEnabled();
    assert(state.confirmations).toHaveLength(1);await expect(page.getByTestId('update-countdown')).toHaveCount(0);
  });
}, 30_000);

test('an unauthorized upgrade never resubmits after the page is restored', async () => {
  await scenario(async (page, state) => {
    state.response = 'unauthorized';
    await page.getByTestId('updates-upgrade').click();
    await page.getByTestId('confirmation-accept').click();
    await expect.poll(() => state.posts.length).toBe(1);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('bungee.system-update.pending'))).toBeNull();
    await page.reload();
    await page.getByTestId('system-updates-trigger').click();
    await expect(page.getByTestId('updates-upgrade')).toBeEnabled();
    assert(state.posts).toHaveLength(1);
  });
}, 30_000);
