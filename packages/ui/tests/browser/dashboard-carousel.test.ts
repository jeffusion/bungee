import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { LAYOUT_KEY } from '../../src/components/dashboard/layout';
import { dashboardSample, historySample, upstreamSample } from '../helpers/dashboard/stats';
import { observeNetwork } from '../helpers/dashboard/network';
import type { TimeRange } from '../../src/types';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';

browserTest('dashboard carousel', async () => {
const uiRuntime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/quota.html'] });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const origin = uiRuntime.origin;
  const ids = ['health.services', 'health.routes', 'chart.upstreams', 'chart.status'];
  const rowIds = ['service-overview-row', 'route-overview-row', 'upstream-distribution-row', 'upstream-status-row'];
  const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
  let count = 8, large = false, reordered = false, gets = 0, writes = 0;
  const services = Array.from({ length: 8 }, (_, index) => ({ id: `service-${index}`, position: index,
    name: `service-${index}-with-a-long-name`, endpoints: [{ id: `upstream-${index}`, position: 0, target: `https://upstream-${index}.example.test`, weight: 1, priority: 0, is_disabled: false, plugins: [] }], plugins: [] }));
  const routes = services.map((service, index) => ({ id: `route-${index}`, position: index, path: `/v1/route-${index}`, service_id: service.id, plugins: [] }));
  const stats = () => services.map((service, index) => {
    const success = large ? 999_999_999_990 : 90 + index;
    const clientErrors = 5, serverErrors = large ? 4 : 5;
    return upstreamSample(service.endpoints[0].target, {
      requestCounts: { success, failed: clientErrors + serverErrors },
      httpStatusCounts: { status2xx: success, status3xx: 0, status4xx: clientErrors, status5xx: serverErrors, statusOther: 0 },
      transportCounts: { completed: success + clientErrors + serverErrors, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
      successRequests: success, failedRequests: clientErrors + serverErrors,
    });
  });
  const chosen = <T,>(values: T[]) => reordered ? values.slice(0, count).toReversed() : values.slice(0, count);
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  observeNetwork(page, errors);
  await page.addInitScript(({ key, ids }) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem(key, JSON.stringify({ version: 5, cards: ids.map((id, index) => ({ id, x: index % 2 * 15, y: Math.floor(index / 2) * 6, w: 15, h: 6 })), mobile: ids.map(id => ({ id, height: 'standard' })) }));
  }, { key: LAYOUT_KEY, ids });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) {
      if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.fulfill({ contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'text/plain', body: '' });
      errors.push(`Unexpected external resource: ${route.request().url()}`); return route.abort();
    }
    if (request.method() !== 'GET') { writes++; return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    gets++;
    const reply = (json: unknown) => route.fulfill({ json });
    const logical = { ...config.config.logical_configuration, services: chosen(services), routes: chosen(routes), plugins: [] };
    if (url.pathname === '/api/config/runtime') return reply({ ...config, config: { ...config.config, logical_configuration: logical } });
    if (url.pathname === '/api/config') return reply({ revision: 1, content_hash: 'fixture', config: { logical_configuration: logical, plugin_activations: [] } });
    if (url.pathname === '/api/stats/dashboard') {
      const upstreams = chosen(stats());
      const aggregate = upstreams.reduce((counts, row) => ({ success: counts.success + row.requestCounts.success, failed: counts.failed + row.requestCounts.failed }), { success: 0, failed: 0 });
      const endTime = Date.now();
      const history = historySample([{ timestamp: Math.floor((endTime - 1) / 60_000) * 60_000, responseTime: 80,
        requestCounts: aggregate,
        httpStatusCounts: { status2xx: aggregate.success, status3xx: 0, status4xx: 5 * upstreams.length, status5xx: (large ? 4 : 5) * upstreams.length, statusOther: 0 },
        transportCounts: { completed: aggregate.success + aggregate.failed, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
        successRequests: aggregate.success, failedRequests: aggregate.failed,
      }]);
      return reply(dashboardSample((url.searchParams.get('range') ?? '1h') as TimeRange, endTime, history, upstreams));
    }
    if (url.pathname === '/api/runtime/upstreams') return reply({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
    if (url.pathname === '/api/plugins') return reply([]);
    if (url.pathname === '/api/plugins/schemas') return reply({});
    throw new Error(`Unexpected API: ${request.method()} ${url.pathname}`);
  });
  const start = new Date('2026-10-04T00:00:00Z');
  await page.clock.install({ time: start }); await page.clock.pauseAt(start);
  await page.goto(`${origin}/tests/fixtures/quota.html`);
  await page.getByTestId('page-dashboard').waitFor();
  const card = (id: string) => page.locator(`[data-card-id="${id}"]`);
  const current = (id: string) => card(id).locator('[data-carousel-slide][aria-hidden="false"]');
  const pages = (id: string) => card(id).locator('[data-carousel-page]');
  const viewport = (id: string) => card(id).locator('[id$="-viewport"]');
  const resize = async (id: string, height: number, width = 15) => {
    await card(id).evaluate((element, size) => {
      const grid = (element.closest('.grid-stack') as any).gridstack;
      grid.setAnimation(false); grid.update(element, { h: size.height, w: size.width });
    }, { height, width });
    await expect(card(id)).toHaveAttribute('gs-h', String(height));
    await page.clock.runFor(32);
  };
  const refresh = async () => {
    const before = gets;
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/stats/dashboard');
    await page.locator('.dashboard-live button').click();
    await response; await expect.poll(() => gets).toBeGreaterThan(before);
    await expect(page.locator('.dashboard-live button')).toBeEnabled();
  };
  for (const [i, id] of ids.entries()) {
    await card(id).getByTestId(rowIds[i]).first().waitFor();
    await expect.poll(() => pages(id).count()).toBeGreaterThan(1);
    assert(await pages(id).count() > 1, `${id} paginates overflow`);
    assert.equal(await card(id).getByTestId(rowIds[i]).count(), 8, `${id} retains every row exactly once`);
    const smallPages = await pages(id).count();
    await viewport(id).focus(); await viewport(id).press('End');
    const anchor = await current(id).getByTestId(rowIds[i]).first().textContent();
    await resize(id, 16);
    await expect.poll(() => pages(id).count(), { message: `${id} packs more rows after ResizeObserver measures the taller card` }).toBeLessThan(smallPages);
    assert((await current(id).getByTestId(rowIds[i]).allTextContents()).includes(anchor!), `${id} keeps the visible anchor after resize`);
    assert(await current(id).getByTestId(rowIds[i]).count() > 1, `${id} stacks several rows`);
    assert(await card(id).locator('[data-carousel-slide]').evaluateAll(elements => elements.every(element => element.scrollHeight <= element.clientHeight + 1)), `${id} full rows fit every page`);
    await resize(id, 6);
    await viewport(id).focus(); await viewport(id).press('Home');
    await resize(id, 40);
    await expect.poll(() => pages(id).count(), { message: `${id} removes pagination after ResizeObserver measures the all-fit card` }).toBe(1);
    assert.equal(await card(id).locator('[data-carousel-indicators]').count(), 0);
    await resize(id, 6);
    await expect.poll(() => pages(id).count()).toBeGreaterThan(1);
  }
  await page.getByTestId('dashboard-customize').focus(); await page.mouse.move(0, 0);
  await page.screenshot({ path: '/tmp/bungee-carousel-expanded-desktop.png', fullPage: true });
  // Refresh/reorder retains the visible row's stable key, then removes stale pages.
  await viewport(ids[0]).focus(); await viewport(ids[0]).press('End');
  const anchor = await current(ids[0]).getByTestId(rowIds[0]).first().textContent();
  reordered = true; await refresh();
  assert((await current(ids[0]).getByTestId(rowIds[0]).allTextContents()).includes(anchor!), 'refresh/reorder keeps the visible service anchor');
  await viewport(ids[0]).press('Home');
  const cdp = await page.context().newCDPSession(page);
  const swipe = async (id: string, dx: number, dy = 0) => {
    await card(id).scrollIntoViewIfNeeded();
    const bounds = (await viewport(id).boundingBox())!;
    const x = bounds.x + bounds.width * .65, y = bounds.y + Math.min(55, bounds.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 6, y: y + dy * step / 6 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  for (const width of [320]) {
    await page.setViewportSize({ width, height: 900 }); await page.clock.runFor(32);
    for (const id of ['health.routes']) {
      await viewport(id).focus(); await viewport(id).press('Home');
      await swipe(id, -100); assert.equal(await current(id).getAttribute('data-carousel-slide'), '1', `${id}: continuous left swipe at ${width}px`);
      await swipe(id, 100); assert.equal(await current(id).getAttribute('data-carousel-slide'), '0', `${id}: right swipe at ${width}px`);
      await swipe(id, 0, -60); assert.equal(await current(id).getAttribute('data-carousel-slide'), '0', `${id}: vertical gesture does not change pages`);
      assert(await card(id).locator('.dashboard-card-body').evaluate(element => element.scrollWidth <= element.clientWidth), `${id} fits mobile width: ${JSON.stringify(await card(id).evaluate(element => { const body = element.querySelector('.dashboard-card-body')!; return { outer: [element.clientWidth, element.scrollWidth], body: [body.clientWidth, body.scrollWidth] }; }))}`);
    }
  }
  for (const id of ids) assert(await card(id).locator('.dashboard-card-body').evaluate(element => element.scrollWidth <= element.clientWidth));
  await page.getByTestId('dashboard-customize').focus();
  await page.screenshot({ path: '/tmp/bungee-carousel-expanded-mobile.png', fullPage: true });
  // Actual mobile hit target: a route tap retains its edit link.
  const link = current('health.routes').getByRole('link').first();
  const href = await link.getAttribute('href'); assert.match(href ?? '', /^\/#\/routes\/edit\//);
  await link.scrollIntoViewIfNeeded(); await page.clock.runFor(350);
  await link.evaluate(element => element.addEventListener('click', event => {
    (window as any).routeTap = { href: element.getAttribute('href'), trusted: event.isTrusted, prevented: event.defaultPrevented };
    event.preventDefault(); // Keep this fixture on Dashboard after observing native activation.
  }, { once: true }));
  await link.tap(); await page.clock.runFor(350);
  assert.deepEqual(await page.evaluate(() => (window as any).routeTap), { href, trusted: true, prevented: false }, 'native route tap reaches its edit link without being intercepted');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.clock.runFor(32);
  count = 1; await refresh();
  for (const id of ids) { assert.equal(await pages(id).count(), 1); assert.equal(await card(id).locator('[data-carousel-indicators]').count(), 0); }
  count = 0; await refresh();
  for (const id of ids) { assert.equal(await pages(id).count(), 0); assert.equal(await card(id).locator('[aria-roledescription="carousel"]').count(), 0); }
  count = 8; large = true; await refresh();
  await page.setViewportSize({ width: 320, height: 900 }); await page.clock.runFor(32);
  await page.evaluate(() => (window as any).setTestLocale('zh-CN'));
  await card('chart.status').getByTestId('upstream-status-row').first().waitFor();
  await expect(card('chart.status').getByTestId('upstream-status-row').first()).toContainText('999,999,999,990');
  await expect(card('chart.upstreams').getByTestId('upstream-distribution-row').first()).toContainText('成功请求 999999999990');
  await expect(card('chart.upstreams').getByTestId('upstream-distribution-row').first()).toContainText('999,999,999,999');
  // Constrain the real card below its rendered row height to exercise native overflow.
  await card('chart.status').locator('.dashboard-card-body').evaluate(element => {
    const body = element as HTMLElement;
    body.style.height = '80px';
    body.style.flex = 'none';
  });
  await page.clock.runFor(32);
  assert(await current('chart.status').evaluate(element => element.scrollHeight > element.clientHeight), 'oversized single status row remains vertically scrollable');
  await swipe('chart.status', 0, -90); await page.clock.runFor(200);
  assert(await current('chart.status').evaluate(element => element.scrollTop > 0), 'vertical touch scrolls an oversized status row');
  await cdp.detach();
  assert.deepEqual(errors, []); assert.equal(writes, 0);
  console.log('PASS: four actual Dashboard cards, measured grouping/resize/all-fit/empty/refresh/anchor, continuous bidirectional mobile route swipes, native vertical scrolling, EN/ZH; 0 writes.');
} finally { try { await browser?.close(); } finally { await uiRuntime.close(); } }
}, 240_000);
