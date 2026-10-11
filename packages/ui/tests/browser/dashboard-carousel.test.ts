import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { LAYOUT_KEY } from '../../src/components/dashboard/layout';
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
  const stats = services.map((service, index) => ({ upstream: service.endpoints[0].target, count: 100 + index, totalRequests: 100 + index, percentage: 12.5,
    successRequests: 90 + index, failedRequests: 10, successRate: 90, failureRate: 10,
    status2xx: 90 + index, status3xx: 0, status4xx: 5, status5xx: 5, statusOther: 0, failed2xx: 2 }));
  const chosen = <T,>(values: T[]) => reordered ? values.slice(0, count).toReversed() : values.slice(0, count);
  const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ key, ids }) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem(key, JSON.stringify({ version: 5, cards: ids.map((id, index) => ({ id, x: index % 2 * 15, y: Math.floor(index / 2) * 6, w: 15, h: 6 })), mobile: ids.map(id => ({ id, height: 'standard' })) }));
  }, { key: LAYOUT_KEY, ids });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() !== 'GET') { writes++; return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    gets++;
    const reply = (json: unknown) => route.fulfill({ json });
    const logical = { ...config.config.logical_configuration, services: chosen(services), routes: chosen(routes), plugins: [] };
    if (url.pathname === '/api/config/runtime') return reply({ ...config, config: { ...config.config, logical_configuration: logical } });
    if (url.pathname.startsWith('/api/config')) return reply({ revision: 1, content_hash: 'fixture', config: { logical_configuration: logical, plugin_activations: [] } });
    if (url.pathname === '/api/stats/dashboard') return reply({ startTime: Date.now() - 3600000, endTime: Date.now(), range: '1h', units: { history: 'request_chain', upstreams: 'upstream_attempt' }, history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [] }, upstreams: chosen(stats).map(row => large ? { ...row, totalRequests: 999999999999, successRequests: 999999999990, failedRequests: 9, status2xx: 999999999990 } : row) });
    if (url.pathname === '/api/runtime/upstreams') return reply({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
    if (url.pathname === '/api/plugins') return reply([]);
    if (url.pathname === '/api/plugins/schemas') return reply({});
    return reply({ data: [] });
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
    await page.waitForTimeout(200);
  };
  const refresh = async () => {
    const before = gets;
    await page.locator('.dashboard-live button').click();
    await page.locator('.dashboard-live button').waitFor({ state: 'visible' });
    await page.waitForTimeout(250); assert(gets > before);
  };
  for (const [i, id] of ids.entries()) {
    await card(id).getByTestId(rowIds[i]).first().waitFor();
    await page.waitForTimeout(150);
    assert(await pages(id).count() > 1, `${id} paginates overflow`);
    assert.equal(await card(id).getByTestId(rowIds[i]).count(), 8, `${id} retains every row exactly once`);
    const smallPages = await pages(id).count();
    await viewport(id).focus(); await viewport(id).press('End');
    const anchor = await current(id).getByTestId(rowIds[i]).first().textContent();
    await resize(id, 16);
    assert(await pages(id).count() < smallPages, `${id} packs more rows in a taller card`);
    assert((await current(id).getByTestId(rowIds[i]).allTextContents()).includes(anchor!), `${id} keeps the visible anchor after resize`);
    assert(await current(id).getByTestId(rowIds[i]).count() > 1, `${id} stacks several rows`);
    assert(await card(id).locator('[data-carousel-slide]').evaluateAll(elements => elements.every(element => element.scrollHeight <= element.clientHeight + 1)), `${id} full rows fit every page`);
    await resize(id, 6);
    await viewport(id).focus(); await viewport(id).press('Home');
    await page.locator('.dashboard-live button').focus(); await card(id).locator('[aria-roledescription="carousel"]').hover(); await page.mouse.move(0, 0);
    await page.clock.runFor(4999); assert.equal(await current(id).getAttribute('data-carousel-slide'), '0');
    await page.clock.runFor(1); assert.equal(await current(id).getAttribute('data-carousel-slide'), '1', `${id} uses the default 5s interval`);
    await viewport(id).focus(); await viewport(id).press('Home');
    await viewport(id).press('ArrowRight'); assert.equal(await current(id).getAttribute('data-carousel-slide'), '1');
    await resize(id, 40);
    assert.equal(await pages(id).count(), 1, `${id} removes pagination when all rows fit`);
    assert.equal(await card(id).locator('[data-carousel-indicators]').count(), 0);
    await resize(id, 6);
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
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(200);
    for (const id of ids) {
      await viewport(id).focus(); await viewport(id).press('Home');
      await swipe(id, -100); assert.equal(await current(id).getAttribute('data-carousel-slide'), '1', `${id}: continuous left swipe at ${width}px`);
      await swipe(id, 100); assert.equal(await current(id).getAttribute('data-carousel-slide'), '0', `${id}: right swipe at ${width}px`);
      await swipe(id, 0, -60); assert.equal(await current(id).getAttribute('data-carousel-slide'), '0', `${id}: vertical gesture does not change pages`);
      assert(await card(id).locator('.dashboard-card-body').evaluate(element => element.scrollWidth <= element.clientWidth), `${id} fits mobile width: ${JSON.stringify(await card(id).evaluate(element => { const body = element.querySelector('.dashboard-card-body')!; return { outer: [element.clientWidth, element.scrollWidth], body: [body.clientWidth, body.scrollWidth] }; }))}`);
    }
  }
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
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.waitForTimeout(200);
  count = 1; await refresh();
  for (const id of ids) { assert.equal(await pages(id).count(), 1); assert.equal(await card(id).locator('[data-carousel-indicators]').count(), 0); }
  count = 0; await refresh();
  for (const id of ids) { assert.equal(await pages(id).count(), 0); assert.equal(await card(id).locator('[aria-roledescription="carousel"]').count(), 0); }
  count = 8; large = true; await refresh();
  await page.setViewportSize({ width: 320, height: 900 }); await page.waitForTimeout(200);
  await page.evaluate(() => (window as any).setTestLocale('zh-CN'));
  await card('chart.status').getByTestId('upstream-status-row').first().waitFor();
  // Constrain the real card below its rendered row height to exercise native overflow.
  await card('chart.status').locator('.dashboard-card-body').evaluate(element => {
    const body = element as HTMLElement;
    body.style.height = '80px';
    body.style.flex = 'none';
  });
  await page.waitForTimeout(200);
  assert(await current('chart.status').evaluate(element => element.scrollHeight > element.clientHeight), 'oversized single status row remains vertically scrollable');
  await swipe('chart.status', 0, -90); await page.clock.runFor(200);
  assert(await current('chart.status').evaluate(element => element.scrollTop > 0), 'vertical touch scrolls an oversized status row');
  await cdp.detach();
  assert.deepEqual(errors, []); assert.equal(writes, 0);
  console.log('PASS: four actual Dashboard cards, measured grouping/resize/all-fit/empty/refresh/anchor, default 5s, manual controls, continuous bidirectional mobile swipes, native vertical scrolling, EN/ZH; 0 writes.');
} finally { try { await browser?.close(); } finally { await uiRuntime.close(); } }
}, 240_000);
