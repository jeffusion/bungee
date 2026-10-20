import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectQuota } from '../helpers/dashboard/quota';

const runtime = dashboardRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/quota.html'] });
const run = (body: (page: import('playwright').Page, fixture: Awaited<ReturnType<typeof connectQuota>>) => Promise<void>, options: import('playwright').BrowserContextOptions = {}) =>
  runtime.run(async page => { const fixture = await connectQuota(page, runtime.origin); await body(page, fixture); fixture.assertClean(); }, options);

test('quota host overrides reserved props; same ID under another owner and range changes preserve the instance', () => run(async (page, f) => {
  expect(await page.evaluate(() => (window as any).quotaHostProps)).toEqual({ pluginName: 'chatgpt-oauth', selectedRange: '1h', headerReporterType: 'function' });
  expect(await page.evaluate(() => (window as any).quotaMounts)).toBe(1);
  const before = { lists: f.lists, gets: f.gets };
  f.peer = true; await page.evaluate(() => (window as any).refreshTestPlugins());
  await expect(page.getByTestId('quota-peer')).toHaveText('token-stats');
  const peerPanel = page.locator('article').filter({ has: page.getByTestId('quota-peer') });
  await expect(peerPanel.getByTestId('native-widget-summary')).toHaveCount(0);
  f.peer = false; await page.evaluate(() => (window as any).refreshTestPlugins());
  await expect(page.getByTestId('quota-peer')).toHaveCount(0);
  await page.getByRole('radiogroup').getByRole('radio').last().click();
  await expect.poll(() => page.evaluate(() => (window as any).quotaHostProps.selectedRange)).toBe('24h');
  expect(await page.evaluate(() => (window as any).quotaMounts)).toBe(1);
  expect({ lists: f.lists, gets: f.gets }).toEqual(before);
}), 60_000);

test('disabled quota contributions and owner impostors cannot mount or fetch', () => runtime.run(async page => {
  const f = await connectQuota(page, runtime.origin, false);
  await expect(f.widget).toHaveCount(0);
  await expect(page.getByTestId('native-widget-summary')).toHaveCount(0);
  expect(f.lists).toBe(0); expect(f.gets).toBe(0);
  expect(await page.evaluate(() => (window as any).quotaMounts ?? 0)).toBe(0);
  await page.clock.fastForward(120_000);
  expect(f.lists).toBe(0); expect(f.gets).toBe(0); f.assertClean();
}), 60_000);

test('quota current windows, partial snapshots and malformed payloads preserve useful data', () => run(async (_page, f) => {
  f.count = 10; f.holdUsage = true;
  await f.refresh().click(); await expect.poll(() => f.active).toBe(4);
  f.holdUsage = false; f.usageReleases.splice(0).forEach(release => release());
  await f.ready(); await expect(f.rows()).toHaveCount(10); expect(f.maxActive).toBeLessThanOrEqual(4);
  await expect(f.rows().nth(0).getByRole('meter', { includeHidden: true })).toHaveCount(2);
  await expect(f.rows().nth(1).getByRole('meter', { includeHidden: true })).toHaveCount(1);

  await expect(f.rows().nth(9).getByTestId('quota-count')).toHaveText('3');

  for (const index of [0, 3, 4]) f.failingRefs.set(f.accounts[index].id, 1);
  await f.refresh().click(); await f.ready();
  await expect(f.rows().nth(0).getByTestId('quota-state')).toBeVisible();
  await expect(f.rows().nth(3).getByTestId('quota-count')).toHaveText('1');
  await expect(f.rows().nth(4).getByTestId('quota-state')).toBeVisible();

  f.failingRefs.clear(); f.malformedList = true; await f.refresh().click(); await f.ready();
  await expect(f.rows()).toHaveCount(10); await expect(f.widget.getByRole('alert')).toBeVisible();
  f.malformedList = false; f.malformedAccount = true; await f.refresh().click(); await f.ready();
  await expect(f.rows()).toHaveCount(10); await expect(f.widget.getByRole('alert')).toBeVisible();
  f.malformedAccount = false; f.count = 0; await f.refresh().click(); await f.ready();
  await expect(f.rows()).toHaveCount(0); await expect(f.widget.getByRole('alert')).toHaveCount(0);
}), 60_000);

test('quota polling starts at 60 seconds and a completed stale response cannot replace newer accounts', () => run(async (page, f) => {
  // Advance only the quota lifecycle: finish the initial dashboard runtime read
  // before pausing its unrelated poll, whose network timeout uses the same clock.
  await page.waitForFunction(() => (window as any).testRuntimeStatus() === 'fresh');
  await page.evaluate(() => (window as any).pauseTestRuntimePolling());
  // Preserve normal fetch and AbortSignal. Only JSON delivery is held, after the
  // original response body has really arrived, so cancellation cannot erase it.
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const gate = { nextId: 0, holdNext: false, heldId: null as number | null,
      requests: {} as Record<number, { rows: number; state: string }>,
      releases: {} as Record<number, () => void> };
    (window as any).quotaBodies = gate;
    window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (new URL(response.url).pathname === '/api/plugins/chatgpt-oauth/control/accounts') {
        const id = ++gate.nextId, hold = gate.holdNext;
        gate.holdNext = false;
        const json = response.json.bind(response);
        response.json = async () => {
          const body = await json();
          const record = gate.requests[id] = { rows: body.accounts.length, state: 'received' };
          if (hold) {
            record.state = 'held'; gate.heldId = id;
            await new Promise<void>(resolve => { gate.releases[id] = resolve; });
          }
          record.state = 'returned';
          // This frame is a fence after the async API/client/widget continuations.
          requestAnimationFrame(() => { record.state = 'processed'; });
          return body;
        };
      }
      return response;
    }, window.fetch);
  });
  const before = f.lists;
  await page.clock.runFor(59_999); expect(f.lists).toBe(before);
  await page.clock.runFor(1); await f.ready(); await expect.poll(() => f.lists).toBe(before + 1);
  f.count = 10;
  await page.evaluate(() => { (window as any).quotaBodies.holdNext = true; });
  await f.refresh().click();
  await page.waitForFunction(() => (window as any).quotaBodies.heldId !== null);
  const oldId = await page.evaluate(() => (window as any).quotaBodies.heldId as number);
  expect(await page.evaluate(id => (window as any).quotaBodies.requests[id], oldId)).toEqual({ rows: 10, state: 'held' });
  await expect(f.refresh()).toHaveAttribute('aria-busy', 'true');
  f.count = 1; await page.clock.fastForward(60_000); await f.ready(); await expect(f.rows()).toHaveCount(1);
  const latestId = await page.evaluate(() => (window as any).quotaBodies.nextId as number);
  expect(latestId).toBeGreaterThan(oldId);
  expect(await page.evaluate(id => (window as any).quotaBodies.requests[id].rows, latestId)).toBe(1);
  const usageRequests = f.gets;
  await page.evaluate(id => (window as any).quotaBodies.releases[id](), oldId);
  await page.waitForFunction(id => (window as any).quotaBodies.requests[id].state === 'returned', oldId);
  await page.clock.runFor(32);
  expect(await page.evaluate(id => (window as any).quotaBodies.requests[id], oldId)).toEqual({ rows: 10, state: 'processed' });
  expect(f.gets).toBe(usageRequests);
  await expect(f.rows()).toHaveCount(1);
}), 60_000);

test('quota header generations reject retired callbacks; disabling cancels in-flight usage and timers', () => run(async (page, f) => {
  await page.evaluate(() => (window as any).withdrawTestPlugin()); await expect(f.widget).toHaveCount(0);
  await page.evaluate(() => (window as any).refreshTestPlugins()); await f.ready();
  const summary = await f.panel.getByTestId('native-widget-summary').textContent();
  await page.evaluate(() => {
    const old = (window as any).quotaHeaderCallbacks[0];
    old({ summary: 'LATE OLD INSTANCE', refresh: { label: 'OLD', busy: true, disabled: true, run() {} } }); old(null);
  });
  await expect(f.panel.getByTestId('native-widget-summary')).toHaveText(summary!);
  await expect(f.refresh()).toHaveAttribute('aria-busy', 'false');
  f.count = 10; f.holdUsage = true; await f.refresh().click(); await expect.poll(() => f.active).toBe(4);
  await f.expectUsageAborts(() => page.evaluate(() => (window as any).disableTestPlugin()));
  await expect(f.widget).toHaveCount(0);
  await expect.poll(() => f.active).toBe(0);
  await expect(page.getByTestId('native-widget-summary')).toHaveCount(0);
  const before = { lists: f.lists, gets: f.gets };
  f.holdUsage = false; f.usageReleases.splice(0).forEach(release => release());
  await page.clock.fastForward(120_000); expect({ lists: f.lists, gets: f.gets }).toEqual(before);
}), 60_000);
