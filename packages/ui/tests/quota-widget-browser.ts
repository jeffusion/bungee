/** Run: bun --cwd packages/ui tests/quota-widget-browser.ts. Real Dashboard, fake GET APIs only. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import appConfig from '../vite.config';
import { LAYOUT_KEY } from '../src/components/dashboard/layout';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';
const manifest = await Bun.file(new URL('../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ ...appConfig, configFile: false, root,
  optimizeDeps: { entries: ['tests/fixtures/quota.html'], exclude: ['svelte-spa-router'] },
  server: { host: '127.0.0.1', port: 5201, proxy: {} } });
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.clock.install({ time: new Date('2026-09-10T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-10T12:00:00Z'));
  await page.addInitScript(({ key }) => {
    localStorage.setItem('locale', 'en');
    const ids = ['plugin:native:chatgpt-oauth:chatgpt-quota-usage', 'plugin:native:token-stats:chatgpt-quota-usage'];
    localStorage.setItem(key, JSON.stringify({ version: 5,
      cards: ids.map((id, i) => ({ id, x: i * 15, y: 0, w: 15, h: 6 })),
      mobile: ids.map(id => ({ id, height: 'tall' })),
    }));
  }, { key: LAYOUT_KEY });
  const errors: string[] = [], unexpected: string[] = [];
  const expectedFailures = new Set<string>();
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (expectedFailures.has(message.location().url) && /status of 503/.test(message.text())) return;
    errors.push(message.text());
  });
  let enabled = false, count = 2, malformedList = false, malformedAccount = false, lists = 0, gets = 0, posts = 0;
  let peer = false;
  const failingRefs = new Set<string>();
  const spoofed = { ...manifest.contributes.nativeWidgets[0], props: { pluginName: 'forged-owner', selectedRange: 'forged-range', onHeaderChange: 'forged-callback', summary: 'FORGED SUMMARY' } };
  let active = 0, maxActive = 0, holdList = false, releaseList = () => {}, holdUsage = false;
  let holdLocale = false;
  const localeReleases: Array<() => void> = [];
  const usageReleases: Array<() => void> = [];
  const apiRefs: string[] = [];
  const names = ['Personal', 'long.account.name@production.workspace.example.test', 'Stale snapshot', 'No windows', 'Unavailable quota', 'Disabled account', 'Reauth account', 'Malformed quota', 'Unknown percent', 'Usage count fallback'];
  const accounts = names.map((label, index) => ({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`, label,
    status: index === 5 ? 'disabled' : index === 6 ? 'reauth_required' : 'active', available: index !== 5 && index !== 6,
    identity: { email: index === 0 ? 'personal@example.test' : index === 1 ? label : undefined, planType: index < 2 ? index === 0 ? 'Plus' : 'Free' : undefined } }));
  const primary = { usedPercent: 25, windowSeconds: 18000, resetAt: Date.UTC(2026, 8, 10, 17) };
  const baseUsage = { usage: { state: 'fresh', primary, secondary: { usedPercent: 60, windowSeconds: 604800, resetAt: Date.UTC(2026, 8, 17) } },
    resetCredits: { state: 'fresh', availableCount: 2, credits: [{ id: '22222222-2222-4222-8222-222222222222', status: 'available', title: 'UPSTREAM PRIVATE TITLE', description: 'UPSTREAM PRIVATE DESCRIPTION' }] } };
  const usages: any[] = [baseUsage,
    { usage: { state: 'fresh', primary: { usedPercent: 0, windowSeconds: 2592000, resetAt: Date.UTC(2026, 9, 10) }, secondary: null }, resetCredits: { state: 'fresh', availableCount: 0, credits: [] } },
    { ...baseUsage, usage: { ...baseUsage.usage, state: 'stale' } },
    { usage: { state: 'fresh' }, resetCredits: { state: 'fresh', availableCount: 1 } },
    { usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } }, null, null,
    { usage: { state: 'invalid' }, resetCredits: { state: 'fresh', availableCount: -1 } },
    { usage: { state: 'fresh', primary: { windowSeconds: 7200 } }, resetCredits: { state: 'unavailable' } },
    { usage: { state: 'fresh', availableCount: 3, primary }, resetCredits: { state: 'unavailable' } }];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') { unexpected.push(url.origin); return route.abort(); }
    if (request.method() !== 'GET') { posts++; unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (holdLocale && /\/i18n\/locales\/(en|zh-CN)\.json$/.test(url.pathname)) await new Promise<void>(resolve => localeReleases.push(resolve));
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/plugins') return respond([
      { name: 'quota-impostor', enabled: true, metadata: { ui: { components: [{ name: 'ChatgptQuotaWidget', entry: 'ui/forged.svelte' }] }, contributes: { nativeWidgets: [{ ...spoofed, props: { pluginName: 'chatgpt-oauth', selectedRange: 'forged-range' } }] } } },
      { name: manifest.name, enabled, metadata: { ...manifest.metadata, contributes: { ...manifest.contributes, nativeWidgets: [spoofed] } } },
      ...(peer ? [{ name: 'token-stats', enabled: true, metadata: { contributes: { nativeWidgets: [{ ...spoofed, component: 'TokenStatsChart' }] } } }] : []),
    ]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: manifest });
    if (url.pathname.endsWith('/control/accounts')) {
      lists++;
      const body = malformedList ? { accounts: null } : { accounts: [...accounts.slice(0, count), ...(malformedAccount ? [{ invalid: true }] : [])] };
      if (holdList) { holdList = false; await new Promise<void>(resolve => releaseList = resolve); }
      return respond(body);
    }
    if (url.pathname.endsWith('/control/accounts/usage')) {
      gets++; const ref = url.searchParams.get('accountRef')!; apiRefs.push(ref);
      active++; maxActive = Math.max(maxActive, active);
      let done = false;
      const finish = () => { if (!done) { active--; done = true; } };
      const failed = (failedRequest: any) => { if (failedRequest === request) { finish(); page.off('requestfailed', failed); } };
      page.on('requestfailed', failed);
      if (holdUsage) await new Promise<void>(resolve => usageReleases.push(resolve));
      else await Bun.sleep(15);
      finish(); page.off('requestfailed', failed);
      if (failingRefs.has(ref)) {
        expectedFailures.add(request.url());
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_unavailable' }) });
      }
      return respond(usages[accounts.findIndex(account => account.id === ref)]);
    }
    if (url.pathname === '/api/config/runtime') return respond(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
    if (url.pathname === '/api/stats/dashboard') return respond({ startTime: Date.now() - 3600000, endTime: Date.now(), range: '1h', units: { history: 'request_chain', upstreams: 'upstream_attempt' }, history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [] }, upstreams: [] });
    if (url.pathname === '/api/runtime/upstreams') return respond({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
    if (url.pathname.startsWith('/api/config')) return respond({ config: { logical_configuration: { services: [], routes: [], plugins: [], auth: { enabled: false, tokens: [] } }, plugin_activations: [] }, revision: 1, content_hash: 'fixture' });
    if (url.pathname.startsWith('/api/stats/history/v2')) return respond({ timestamps: [], requests: [], errors: [], responseTime: [] });
    if (url.pathname.startsWith('/api/stats/upstream-')) return respond({ data: [] });
    unexpected.push(url.pathname); console.error('Unexpected fixture API:', url.pathname); return route.abort();
  });
  const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/tests/fixtures/quota.html`;
  const widget = page.getByTestId('chatgpt-quota-widget');
  const panel = page.locator('article').filter({ has: widget });
  const refresh = () => panel.locator('header').getByRole('button');
  const ready = () => refresh().and(page.locator('[aria-busy="false"]')).waitFor();
  await page.goto(base); await page.getByTestId('page-dashboard').waitFor();
  await page.waitForFunction(() => typeof (window as any).refreshTestPlugins === 'function');
  assert.equal(await widget.count(), 0); assert.equal(lists, 0); assert.equal(gets, 0);
  assert.equal(await page.getByTestId('native-widget-summary').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).quotaMounts ?? 0), 0, 'impostor ui.components declaration cannot instantiate the registered component');
  await page.screenshot({ path: '/tmp/bungee-quota-owner-rejected.png', fullPage: true });
  enabled = true; holdList = true; await page.evaluate(() => (window as any).refreshTestPlugins());
  await widget.waitFor(); await refresh().locator('.nx-load-xs').waitFor();
  assert(await refresh().isDisabled());
  await panel.screenshot({ path: '/tmp/bungee-quota-initial-loading.png' });
  releaseList(); await ready();
  assert.equal(lists, 1); assert.equal(gets, 2);
  assert.deepEqual(await page.evaluate(() => (window as any).quotaHostProps), { pluginName: 'chatgpt-oauth', selectedRange: '1h', headerReporterType: 'function' });
  assert.equal(await page.evaluate(() => (window as any).quotaMounts), 1);
  const identityCounts = { lists, gets };
  peer = true; await page.evaluate(() => (window as any).refreshTestPlugins());
  await page.getByTestId('quota-peer').waitFor();
  assert.equal(await page.getByTestId('quota-peer').innerText(), 'token-stats');
  const peerPanel = page.locator('article').filter({ has: page.getByTestId('quota-peer') });
  assert.equal(await peerPanel.getByText('TOKEN-STATS', { exact: true }).count(), 1, 'no-header widgets keep their original plugin tag');
  assert.equal(await peerPanel.getByTestId('native-widget-summary').count(), 0);
  assert.equal(await widget.count(), 1); assert.equal(await page.evaluate(() => (window as any).quotaMounts), 1);
  peer = false; await page.evaluate(() => (window as any).refreshTestPlugins()); await page.getByTestId('quota-peer').waitFor({ state: 'detached' });
  assert.deepEqual({ lists, gets }, identityCounts, 'same widget id across owners does not remount existing quota');
  const initialRequests = { lists, gets };
  const activeAccount = () => widget.locator('[data-carousel-slide][aria-hidden="false"]');
  await page.mouse.move(0, 0);
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '0');
  await page.clock.runFor(2999);
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '0');
  await page.clock.runFor(1);
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '1');
  await page.clock.runFor(3000);
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '0');
  assert.deepEqual({ lists, gets }, initialRequests, 'rotation does not refetch quota');
  const slideMotion = await activeAccount().evaluate(element => ({ property: getComputedStyle(element).transitionProperty, duration: getComputedStyle(element).transitionDuration }));
  assert.deepEqual(slideMotion, { property: 'transform', duration: '0.18s' });
  assert.equal(await widget.locator('.carousel-next').evaluate(element => getComputedStyle(element).opacity), '0', 'arrows are hidden at rest');
  await widget.hover();
  await widget.getByRole('button', { name: 'Next account page', exact: true }).click();
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '1');
  await widget.getByRole('button', { name: 'Previous account page', exact: true }).click();
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '0');
  await widget.getByRole('button', { name: 'Pause account rotation', exact: true }).click();
  await refresh().focus(); await page.mouse.move(0, 0);
  await page.clock.runFor(6000);
  assert.equal(await activeAccount().getAttribute('data-carousel-slide'), '0');
  console.log('CAROUSEL: 3-second horizontal rotation, wraparound, manual navigation and pause passed; no extra quota requests');
  await widget.hover();
  await widget.getByRole('button', { name: 'Start account rotation', exact: true }).click();
  const snapshot = async (language: string, width: number, state: string) => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    await ready();
    await page.evaluate(language => (window as any).setTestLocale(language), language);
    await panel.locator('header').getByRole('button', { name: language === 'en' ? 'Refresh quota usage' : '刷新额度用量' }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    await panel.locator('header').getByRole('button').focus();
    await page.mouse.move(0, 0);
    assert.equal(await panel.locator('header').count(), 1);
    assert.equal(await panel.getByText(language === 'en' ? 'ChatGPT quota' : 'ChatGPT 额度', { exact: true }).count(), 1);
    assert.equal(await widget.locator('article, .nx-corner, h1, h2, h3').count(), 0);
    assert.equal(await widget.getByRole('button').count(), await widget.getByTestId('quota-page').count() > 1 ? Math.min(5, await widget.getByTestId('quota-page').count()) + 3 : 0, 'bounded subtle indicators plus contextual controls');
    if (await widget.getByTestId('quota-page').count() > 1) {
      const indicators = widget.locator('[data-carousel-indicators]');
      assert.equal((await indicators.boundingBox())!.height, 24);
      assert.equal(await indicators.locator('span').first().evaluate(element => element.getBoundingClientRect().height), 3);
      assert.equal(await indicators.innerText(), '', 'no numbered buttons or counter');
    }
    assert.equal(await panel.getByText('CHATGPT-OAUTH', { exact: true }).count(), 0);
    const summary = panel.getByTestId('native-widget-summary');
    assert.equal(await summary.getAttribute('title'), await summary.textContent(), 'truncated summary retains full accessible text');
    assert(await panel.locator('header').evaluate(element => {
      const summary = element.querySelector('[data-testid="native-widget-summary"]')!, title = element.querySelector('.nx-panel-head-title')!, button = element.querySelector('button')!;
      const a = title.getBoundingClientRect(), b = summary.getBoundingClientRect(), c = button.getBoundingClientRect(), header = element.getBoundingClientRect();
      return a.right <= b.left && b.right <= c.left && c.right <= header.right && a.top < c.bottom && b.top < c.bottom
        && element.scrollWidth <= element.clientWidth && Number(getComputedStyle(summary).fontWeight) < Number(getComputedStyle(title).fontWeight);
    }), 'title → secondary summary → icon are inline, non-overlapping and inside header');
    const icon = (await refresh().boundingBox())!;
    assert.equal(icon.height, 21); assert.equal(icon.width, 21); assert.equal((await refresh().innerText()).trim(), '');
    const geometry = await widget.evaluate(element => {
      const root = element.getBoundingClientRect(), host = element.closest('article')!, outer = host.getBoundingClientRect();
      const holder = element.parentElement!, holderStyle = getComputedStyle(holder);
      const list = element.querySelector('[data-carousel-slide][aria-hidden="false"]');
      const grid = list?.querySelector('.quota-account');
      return { hostHeight: outer.height, height: root.height, available: holder.clientHeight - parseFloat(holderStyle.paddingTop) - parseFloat(holderStyle.paddingBottom), bottom: root.bottom, hostBottom: outer.bottom,
        expectedColumns: element.clientWidth >= 32 * parseFloat(getComputedStyle(document.documentElement).fontSize) ? 2 : 1, span: getComputedStyle(host).gridColumnEnd, columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        overflow: list ? getComputedStyle(list).overflowY : null, scroll: list ? list.scrollHeight > list.clientHeight : false, listHeight: list?.clientHeight ?? 0, listTop: list ? list.getBoundingClientRect().top - root.top : 0,
        contained: element.scrollWidth <= element.clientWidth && (!list || list.scrollWidth <= list.clientWidth) };
    });
    assert(geometry.hostHeight >= 200); assert(geometry.height > 0 && Math.abs(geometry.height - geometry.available) <= 1, 'root naturally fills the host content box');
    assert(geometry.bottom <= geometry.hostBottom && geometry.contained);
    if (count) {
      assert.equal(geometry.overflow, 'auto');
      assert(geometry.listHeight >= 90 && Math.abs(geometry.listTop) <= 2, 'slide fills space above subtle indicators');
    }
    if (count) assert.equal(geometry.columns, geometry.expectedColumns);
    if (width >= 768) assert.equal(await panel.locator('..').locator('..').getAttribute('gs-w'), '15');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const dom = await panel.evaluate(element => element.outerHTML);
    assert(!/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i.test(dom));
    assert(!dom.includes('UPSTREAM PRIVATE'));
    assert(!dom.includes('FORGED SUMMARY'));
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-${state}.png` });
    if (state === 'populated') await panel.locator('header').screenshot({ path: `/tmp/bungee-quota-header-${language}-${width}-normal.png` });
    if (language === 'zh-CN' && state === 'populated' && width === 1440) await page.screenshot({ path: '/tmp/bungee-quota-dashboard-zh-CN-1440.png', fullPage: true });
    console.log(`DASHBOARD ${language} ${width} ${state}`, JSON.stringify(geometry));
  };
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) await snapshot(language, width, 'populated');
  await page.evaluate(() => (window as any).setTestLocale('en'));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => (window as any).setLongSummary(true));
  await panel.getByTestId('native-widget-summary').filter({ hasText: 'deliberately long' }).waitFor();
  assert(await panel.getByTestId('native-widget-summary').evaluate(element => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflow === 'hidden'));
  await panel.locator('header').screenshot({ path: '/tmp/bungee-quota-header-long-summary.png' });
  await page.evaluate(() => (window as any).setLongSummary(false));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(100); await ready();
  const rows = () => widget.getByTestId('quota-account');
  assert.equal(await rows().first().locator('[role="meter"]').count(), 2);
  assert.equal(await rows().nth(1).locator('[role="meter"]').count(), 1);
  assert.match(await rows().nth(1).innerText(), /30-day limit/i);
  assert(!/5-hour|weekly/i.test(await rows().nth(1).innerText()));
  assert.equal((await rows().nth(1).innerText()).split(names[1]).length, 2);
  const rangeBefore = { lists, gets };
  const rangeMounts = await page.evaluate(() => (window as any).quotaMounts);
  await page.getByRole('radiogroup').getByRole('radio').last().click();
  await page.waitForTimeout(50); assert.deepEqual({ lists, gets }, rangeBefore, 'historical selectedRange does not refetch current quota');
  assert.deepEqual(await page.evaluate(() => (window as any).quotaHostProps), { pluginName: 'chatgpt-oauth', selectedRange: '24h', headerReporterType: 'function' });
  assert.equal(await page.evaluate(() => (window as any).quotaMounts), rangeMounts, 'range changes preserve component instance');
  console.log('OWNER BOUNDARY: enabled impostor blocked with 0 mount/API; host owner/range override forged props; cross-owner same id and range changes preserve mount');
  // Manual refresh is a full quota snapshot, not a configuration mutation or range query.
  const before = { lists, gets }; const buttonWidth = (await refresh().boundingBox())!.width;
  holdList = true; await refresh().click(); await refresh().locator('.nx-load-xs').waitFor();
  assert(await refresh().isDisabled()); assert.equal((await refresh().boundingBox())!.width, buttonWidth);
  assert.equal(await refresh().locator('svg, .animate-spin').count(), 0);
  for (const language of ['en', 'zh-CN']) for (const width of [900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(100);
    await page.evaluate(language => (window as any).setTestLocale(language), language);
    await panel.locator('header').getByRole('button', { name: language === 'en' ? 'Refresh quota usage' : '刷新额度用量' }).waitFor();
    assert.equal((await refresh().boundingBox())!.height, 21); assert.equal((await refresh().boundingBox())!.width, 21);
    assert.equal(await panel.getByTestId('native-widget-summary').textContent(), language === 'en' ? '2 available / 2 accounts' : '2 可用 / 2 个账号');
    await panel.locator('header').screenshot({ path: `/tmp/bungee-quota-header-${language}-${width}-busy.png` });
  }
  await page.evaluate(() => (window as any).setTestLocale('en'));
  await panel.screenshot({ path: '/tmp/bungee-quota-refresh-busy.png' });
  releaseList(); await ready(); assert.equal(lists, before.lists + 1); assert.equal(gets, before.gets + 2);
  count = 10; await refresh().click(); await ready();
  assert.equal(await rows().count(), 10); assert(maxActive <= 4);
  assert(!apiRefs.includes(accounts[5].id) && !apiRefs.includes(accounts[6].id));
  for (const index of [4, 5, 6, 7, 8]) assert.equal(await rows().nth(index).getByTestId('quota-count').innerText(), '—');
  assert.equal(await rows().nth(9).getByTestId('quota-count').innerText(), '3');
  assert.match(await rows().nth(2).innerText(), /Stale/i); assert.match(await rows().nth(7).innerText(), /Invalid server response/i);
  assert.match(await rows().nth(3).innerText(), /No limit windows/i); assert.match(await rows().nth(8).innerText(), /Usage unknown/);
  assert.equal(await rows().nth(4).getByTestId('quota-state').innerText(), 'Unavailable');
  // Resize the actual GridStack card: grouping follows available space, not
  // a fixed account count or an assumed row height.
  const resizeQuota = async (height: number, width = 15) => {
    await widget.evaluate((element, size) => {
      const card = element.closest('.grid-stack-item') as any;
      const grid = (card.closest('.grid-stack') as any).gridstack;
      const animate = grid.opts.animate;
      grid.setAnimation(false); grid.update(card, { h: size.height, w: size.width });
      void card.offsetHeight; grid.setAnimation(animate);
    }, { height, width });
    await page.waitForTimeout(150);
  };
  const visiblePage = () => widget.locator('[data-carousel-slide][aria-hidden="false"]');
  const pageCount = () => widget.getByTestId('quota-page').count();
  const pageAccounts = () => visiblePage().getByTestId('quota-account');
  const layoutRequests = { lists, gets };
  const smallPages = await pageCount();
  await widget.locator('[id$="-viewport"]').focus();
  await widget.locator('[id$="-viewport"]').press('End');
  const anchor = await pageAccounts().first().locator('div > div > span').first().innerText();
  await resizeQuota(14);
  assert(await pageCount() < smallPages, 'taller card packs more accounts per page');
  assert(await pageAccounts().filter({ hasText: anchor }).count() > 0, 'resizing keeps the previously visible account in view');
  await widget.locator('[id$="-viewport"]').press('Home');
  assert(await pageAccounts().count() > 1, 'one screen has multiple vertically stacked accounts');
  assert(await visiblePage().evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'complete rows fit without vertical scrolling');
  assert(await widget.locator('[data-carousel-slide]').evaluateAll(elements => elements.every(element =>
    element.querySelectorAll('[data-testid="quota-account"]').length < 2 || element.scrollHeight <= element.clientHeight + 1)), 'every page containing multiple accounts fits completely');
  const widePages = await pageCount();
  await resizeQuota(14, 8);
  assert(await pageCount() >= widePages, 'narrower card recalculates wrapped account heights');
  await panel.screenshot({ path: '/tmp/bungee-quota-pages-narrow-tall.png' });
  await resizeQuota(14);
  await widget.locator('[id$="-viewport"]').press('Home');
  await page.clock.runFor(200);
  const positions = await pageAccounts().evaluateAll(elements => elements.map(element => element.getBoundingClientRect().top));
  assert(positions.every((position, index) => !index || position > positions[index - 1]), 'accounts stack vertically');
  await panel.locator('header').getByRole('button').focus(); await page.mouse.move(0, 0);
  await page.clock.runFor(200);
  await panel.screenshot({ path: '/tmp/bungee-quota-pages-tall.png' });
  // Restart a full interval after settling the CSS transition for the image.
  await widget.hover(); await page.mouse.move(0, 0);
  const visibleLabels = await pageAccounts().allTextContents();
  await page.clock.runFor(2999); assert.deepEqual(await pageAccounts().allTextContents(), visibleLabels);
  await page.clock.runFor(1); assert.notDeepEqual(await pageAccounts().allTextContents(), visibleLabels, '3s rotates the entire page');
  await resizeQuota(40);
  assert.equal(await pageCount(), 1, 'all fitting accounts share one page');
  assert.equal(await pageAccounts().count(), 10);
  assert.equal(await widget.getByRole('button').count(), 0, 'no carousel controls when all accounts fit');
  const onePageLabels = await pageAccounts().allTextContents();
  await page.clock.runFor(5000); assert.deepEqual(await pageAccounts().allTextContents(), onePageLabels);
  await panel.screenshot({ path: '/tmp/bungee-quota-pages-all-fit.png' });
  await resizeQuota(6);
  assert.equal(await pageCount(), smallPages, 'shrinking restores pagination without missing accounts');
  assert.equal(await rows().count(), 10);
  assert.deepEqual({ lists, gets }, layoutRequests, 'resizing and page rotation do not fetch quota again');
  console.log('HEIGHT PAGINATION: actual card grow/shrink, stacked rows, complete-page 3s rotation, anchor retention and all-fit control removal passed');
  for (const index of [0, 3, 4]) failingRefs.add(accounts[index].id);
  await refresh().click(); await ready();
  assert.equal(await rows().nth(4).getByTestId('quota-state').innerText(), 'Unavailable', 'failed GET after unavailable envelope is still unavailable');
  assert.equal(await rows().nth(4).getByTestId('quota-count').innerText(), '—');
  assert.equal(await rows().nth(0).getByTestId('quota-state').innerText(), 'Stale', 'window snapshot survives GET failure as stale');
  assert.equal(await rows().nth(3).getByTestId('quota-state').innerText(), 'Stale', 'authoritative count survives GET failure as stale');
  assert.equal(await rows().nth(3).getByTestId('quota-count').innerText(), '1');
  await widget.locator('[id$="-viewport"]').focus();
  await widget.locator('[id$="-viewport"]').press('Home');
  for (let step = 0; step < 4; step++) await widget.locator('[id$="-viewport"]').press('ArrowRight');
  await panel.screenshot({ path: '/tmp/bungee-quota-no-snapshot-after-failure.png' });
  failingRefs.clear(); await refresh().click(); await ready();
  console.log('SNAPSHOT STATE: unavailable → failed GET remains unavailable/—; prior window or count → failed GET is stale');
  await panel.scrollIntoViewIfNeeded();
  await refresh().focus(); await page.keyboard.press('Tab');
  const viewport = widget.locator('[id$="-viewport"]');
  const activeSlide = () => widget.locator('[data-carousel-slide][aria-hidden="false"]');
  assert(await widget.getByRole('button', { name: 'Pause account rotation', exact: true }).evaluate(element => document.activeElement === element), 'playback is the first keyboard entry');
  await page.keyboard.press('Tab');
  assert(await viewport.evaluate(element => document.activeElement === element));
  await page.keyboard.press('End');
  assert.equal(await activeSlide().getAttribute('data-carousel-slide'), String((await widget.getByTestId('quota-page').count()) - 1), 'End selects the final page');
  await page.keyboard.press('Home');
  assert.equal(await activeSlide().getAttribute('data-carousel-slide'), '0');
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) {
    await snapshot(language, width, 'partial');
    await viewport.focus(); await viewport.press('Home');
    await viewport.press('ArrowRight'); await viewport.press('ArrowRight');
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-partial-stale.png` });
    await viewport.press('Home');
    await activeSlide().focus(); await page.keyboard.press('End');
    await page.waitForTimeout(350);
    if (width === 390) assert(await activeSlide().evaluate(element => element.scrollTop > 0), 'long account details remain keyboard scrollable');
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-partial-bottom.png` });
    await activeSlide().evaluate(element => element.scrollTop = 0);
  }
  const tickBefore = lists; await page.clock.fastForward(60000); await ready(); assert.equal(lists, tickBefore + 1);
  // Timer supersedes a stalled earlier list request; releasing it cannot restore old accounts.
  count = 10; holdList = true; await refresh().click(); await refresh().locator('.nx-load-xs').waitFor();
  count = 1; await page.clock.fastForward(60000); await ready(); assert.equal(await rows().count(), 1);
  releaseList(); await page.waitForTimeout(50); assert.equal(await rows().count(), 1);
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) await snapshot(language, width, 'single');
  malformedList = true; await refresh().click(); await ready();
  assert.equal(await rows().count(), 1); assert.equal(await widget.getByRole('alert').count(), 1);
  malformedList = false; malformedAccount = true; await refresh().click(); await ready();
  assert.equal(await rows().count(), 1); assert.equal(await widget.getByRole('alert').count(), 1);
  malformedAccount = false; count = 0; await refresh().click(); await ready();
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) await snapshot(language, width, 'empty');
  // Disable unmounts the real Dashboard contribution and cancels its live requests/timer.
  const mountsBeforeDisable = await page.evaluate(() => (window as any).quotaMounts);
  count = 10; holdUsage = true; await refresh().click();
  await page.waitForTimeout(80); assert.equal(active, 4);
  await page.evaluate(() => (window as any).disableTestPlugin()); await widget.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('native-widget-summary').count(), 0, 'disable removes the header channel');
  await page.waitForTimeout(50); assert.equal(active, 0);
  const disabledCounts = { lists, gets }; holdUsage = false; usageReleases.splice(0).forEach(release => release());
  await page.clock.fastForward(120000); assert.deepEqual({ lists, gets }, disabledCounts);
  count = 1; await page.evaluate(() => (window as any).refreshTestPlugins()); await ready();
  assert.equal(await page.evaluate(() => (window as any).quotaMounts), mountsBeforeDisable + 1);
  // The current dashboard retains disabled definitions for saved layouts.
  // Header ownership is retired when the contribution is actually withdrawn.
  await page.evaluate(() => (window as any).withdrawTestPlugin());
  await widget.waitFor({ state: 'detached' });
  await page.evaluate(() => (window as any).refreshTestPlugins()); await ready();
  const currentSummary = await panel.getByTestId('native-widget-summary').textContent();
  await page.evaluate(() => {
    const old = (window as any).quotaHeaderCallbacks[0];
    old({ summary: 'LATE OLD INSTANCE', refresh: { label: 'OLD', busy: true, disabled: true, run() {} } });
    old(null);
  });
  assert.equal(await panel.getByTestId('native-widget-summary').textContent(), currentSummary);
  assert.equal(await refresh().getAttribute('aria-busy'), 'false');
  console.log('HEADER OWNERSHIP: reserved callback, no-header tag, stable range, disable/re-enable and withdrawn contribution late update/cleanup all passed');
  // Mount the component before locale loading finishes; Dashboard itself retains its existing locale gate.
  holdLocale = true; await page.goto(`${base}?race`, { waitUntil: 'domcontentloaded' }); await widget.waitFor();
  await page.waitForFunction(() => (window as any).raceHeader?.refresh.busy === false);
  assert(localeReleases.length > 0, 'locale resources really are held while widget is mounted');
  assert.equal(await page.evaluate(() => (window as any).raceHeader.refresh.label), '');
  assert.equal(errors.length, 0, 'rendering before locale is ready must not throw');
  holdLocale = false; localeReleases.splice(0).forEach(release => release());
  await page.waitForFunction(() => (window as any).raceHeader?.refresh.label === 'Refresh quota usage');
  await page.evaluate(() => (window as any).unmountDashboard());
  assert.equal(await page.evaluate(() => (window as any).raceHeader), null, 'widget cleanup reports clear to its original host callback');
  const unmounted = { lists, gets }; await page.clock.fastForward(120000); assert.deepEqual({ lists, gets }, unmounted);
  assert.equal(posts, 0); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  console.log('PASS quota widget: actual Dashboard saved layout, carousel, owners, 0/1/2/10 accounts, EN/ZH, dynamic windows, malformed/partial, timer/latest-wins/cleanup, max concurrency', maxActive, 'API GET counts', { lists, gets }, 'POST/consume', posts);
} finally { await browser.close(); await server.close(); }
