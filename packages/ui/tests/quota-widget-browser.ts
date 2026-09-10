/** Run: bun --cwd packages/ui tests/quota-widget-browser.ts. Real Dashboard, fake GET APIs only. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import appConfig from '../vite.config';
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
  await page.addInitScript(() => localStorage.setItem('locale', 'en'));
  const errors: string[] = [], unexpected: string[] = [];
  const expectedFailures = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (expectedFailures.has(message.location().url) && /status of 503/.test(message.text())) return;
    errors.push(message.text());
  });
  let enabled = false, count = 2, malformedList = false, malformedAccount = false, lists = 0, gets = 0, posts = 0;
  let peer = false;
  const failingRefs = new Set<string>();
  const spoofed = { ...manifest.contributes.nativeWidgets[0], props: { pluginName: 'forged-owner', selectedRange: 'forged-range' } };
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
    if (!url.pathname.startsWith('/__ui/api/') && !url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/__ui/api/plugins') return respond([
      { name: 'quota-impostor', enabled: true, metadata: { ui: { components: [{ name: 'ChatgptQuotaWidget', entry: 'ui/forged.svelte' }] }, contributes: { nativeWidgets: [{ ...spoofed, props: { pluginName: 'chatgpt-oauth', selectedRange: 'forged-range' } }] } } },
      { name: manifest.name, enabled, metadata: { ...manifest.metadata, contributes: { ...manifest.contributes, nativeWidgets: [spoofed] } } },
      ...(peer ? [{ name: 'token-stats', enabled: true, metadata: { contributes: { nativeWidgets: [{ ...spoofed, component: 'TokenStatsChart' }] } } }] : []),
    ]);
    if (url.pathname === '/__ui/api/plugins/schemas') return respond({ [manifest.name]: manifest });
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
    if (url.pathname.startsWith('/__ui/api/config')) return respond({ config: { logical_configuration: { services: [], routes: [], plugins: [], auth: { enabled: false, tokens: [] } }, plugin_activations: [] }, revision: 1, content_hash: 'fixture' });
    if (url.pathname.startsWith('/__ui/api/stats/history/v2')) return respond({ timestamps: [], requests: [], errors: [], responseTime: [] });
    if (url.pathname.startsWith('/__ui/api/stats/upstream-')) return respond({ data: [] });
    unexpected.push(url.pathname); return route.abort();
  });
  const address = server.httpServer!.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/__ui/tests/fixtures/quota.html`;
  const widget = page.getByTestId('chatgpt-quota-widget');
  const panel = page.locator('article').filter({ has: widget });
  const refresh = () => widget.getByRole('button');
  const ready = () => refresh().and(page.locator('[aria-busy="false"]')).waitFor();
  await page.goto(base); await page.getByTestId('page-dashboard').waitFor();
  await page.waitForFunction(() => typeof (window as any).refreshTestPlugins === 'function');
  assert.equal(await widget.count(), 0); assert.equal(lists, 0); assert.equal(gets, 0);
  assert.equal(await page.evaluate(() => (window as any).quotaMounts ?? 0), 0, 'impostor ui.components declaration cannot instantiate the registered component');
  await page.screenshot({ path: '/tmp/bungee-quota-owner-rejected.png', fullPage: true });
  enabled = true; holdList = true; await page.evaluate(() => (window as any).refreshTestPlugins());
  await widget.waitFor(); await refresh().locator('.nx-load-xs').waitFor();
  assert(await refresh().isDisabled());
  await panel.screenshot({ path: '/tmp/bungee-quota-initial-loading.png' });
  releaseList(); await ready();
  assert.equal(lists, 1); assert.equal(gets, 2);
  assert.deepEqual(await page.evaluate(() => (window as any).quotaHostProps), { pluginName: 'chatgpt-oauth', selectedRange: '1h' });
  assert.equal(await page.evaluate(() => (window as any).quotaMounts), 1);
  const identityCounts = { lists, gets };
  peer = true; await page.evaluate(() => (window as any).refreshTestPlugins());
  await page.getByTestId('quota-peer').waitFor();
  assert.equal(await page.getByTestId('quota-peer').innerText(), 'token-stats');
  assert.equal(await widget.count(), 1); assert.equal(await page.evaluate(() => (window as any).quotaMounts), 1);
  peer = false; await page.evaluate(() => (window as any).refreshTestPlugins()); await page.getByTestId('quota-peer').waitFor({ state: 'detached' });
  assert.deepEqual({ lists, gets }, identityCounts, 'same widget id across owners does not remount existing quota');
  const snapshot = async (language: string, width: number, state: string) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(language => (window as any).setTestLocale(language), language);
    await widget.getByRole('button', { name: language === 'en' ? 'Refresh quota usage' : '刷新额度用量' }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    assert.equal(await panel.locator('header').count(), 1);
    assert.equal(await panel.getByText(language === 'en' ? 'ChatGPT quota' : 'ChatGPT 额度', { exact: true }).count(), 1);
    assert.equal(await widget.locator('article, .nx-corner, h1, h2, h3').count(), 0);
    const geometry = await widget.evaluate(element => {
      const root = element.getBoundingClientRect(), host = element.closest('article')!, outer = host.getBoundingClientRect();
      const holder = element.parentElement!, holderStyle = getComputedStyle(holder);
      const list = element.querySelector('[data-testid="quota-list"]')!;
      const grid = element.querySelector('.quota-grid');
      return { hostHeight: outer.height, height: root.height, available: holder.clientHeight - parseFloat(holderStyle.paddingTop) - parseFloat(holderStyle.paddingBottom), bottom: root.bottom, hostBottom: outer.bottom,
        span: getComputedStyle(host).gridColumnEnd, columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
        overflow: getComputedStyle(list).overflowY, scroll: list.scrollHeight > list.clientHeight,
        contained: element.scrollWidth <= element.clientWidth && list.scrollWidth <= list.clientWidth };
    });
    assert.equal(geometry.hostHeight, 224); assert(geometry.height > 0 && Math.abs(geometry.height - geometry.available) <= 1, 'root naturally fills the host content box');
    assert(geometry.bottom <= geometry.hostBottom && geometry.contained);
    assert.equal(geometry.overflow, 'auto');
    if (count) assert.equal(geometry.columns, width === 390 ? 1 : 2);
    if (width >= 768) assert.equal(geometry.span, 'span 2');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const dom = await widget.evaluate(element => element.outerHTML);
    assert(!/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i.test(dom));
    assert(!dom.includes('UPSTREAM PRIVATE'));
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-${state}.png` });
    if (language === 'zh-CN' && state === 'populated' && width === 1440) await page.screenshot({ path: '/tmp/bungee-quota-dashboard-zh-CN-1440.png', fullPage: true });
    console.log(`DASHBOARD ${language} ${width} ${state}`, JSON.stringify(geometry));
  };
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) await snapshot(language, width, 'populated');
  await page.evaluate(() => (window as any).setTestLocale('en'));
  const rows = () => widget.getByTestId('quota-account');
  assert.equal(await rows().first().locator('[role="meter"]').count(), 2);
  assert.equal(await rows().nth(1).locator('[role="meter"]').count(), 1);
  assert.match(await rows().nth(1).innerText(), /30-day limit/i);
  assert(!/5-hour|weekly/i.test(await rows().nth(1).innerText()));
  assert.equal((await rows().nth(1).innerText()).split(names[1]).length, 2);
  const rangeBefore = { lists, gets };
  await page.getByRole('radiogroup').getByRole('radio').last().click();
  await page.waitForTimeout(50); assert.deepEqual({ lists, gets }, rangeBefore, 'historical selectedRange does not refetch current quota');
  assert.deepEqual(await page.evaluate(() => (window as any).quotaHostProps), { pluginName: 'chatgpt-oauth', selectedRange: '24h' });
  assert.equal(await page.evaluate(() => (window as any).quotaMounts), 1, 'range changes preserve component instance');
  console.log('OWNER BOUNDARY: enabled impostor blocked with 0 mount/API; host owner/range override forged props; cross-owner same id and range changes preserve mount');
  // Manual refresh is a full quota snapshot, not a configuration mutation or range query.
  const before = { lists, gets }; const buttonWidth = (await refresh().boundingBox())!.width;
  holdList = true; await refresh().click(); await refresh().locator('.nx-load-xs').waitFor();
  assert(await refresh().isDisabled()); assert.equal((await refresh().boundingBox())!.width, buttonWidth);
  assert.equal(await refresh().locator('svg, .animate-spin').count(), 0);
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
  for (const index of [0, 3, 4]) failingRefs.add(accounts[index].id);
  await refresh().click(); await ready();
  assert.equal(await rows().nth(4).getByTestId('quota-state').innerText(), 'Unavailable', 'failed GET after unavailable envelope is still unavailable');
  assert.equal(await rows().nth(4).getByTestId('quota-count').innerText(), '—');
  assert.equal(await rows().nth(0).getByTestId('quota-state').innerText(), 'Stale', 'window snapshot survives GET failure as stale');
  assert.equal(await rows().nth(3).getByTestId('quota-state').innerText(), 'Stale', 'authoritative count survives GET failure as stale');
  assert.equal(await rows().nth(3).getByTestId('quota-count').innerText(), '1');
  await rows().nth(4).evaluate(element => element.scrollIntoView({ block: 'start' }));
  await panel.screenshot({ path: '/tmp/bungee-quota-no-snapshot-after-failure.png' });
  failingRefs.clear(); await refresh().click(); await ready();
  console.log('SNAPSHOT STATE: unavailable → failed GET remains unavailable/—; prior window or count → failed GET is stale');
  await panel.scrollIntoViewIfNeeded();
  await refresh().focus(); await page.keyboard.press('Tab');
  assert(await widget.getByTestId('quota-list').evaluate(element => document.activeElement === element));
  await page.keyboard.press('End');
  // Native compositor scrolling is not driven by Playwright's mocked JS timer clock.
  await page.waitForTimeout(350);
  assert(await widget.getByTestId('quota-list').evaluate(element => element.scrollTop > 0), 'account list supports native keyboard scrolling');
  await widget.getByTestId('quota-list').evaluate(element => element.scrollTop = 0);
  for (const language of ['en', 'zh-CN']) for (const width of [390, 900, 1440]) {
    await snapshot(language, width, 'partial');
    await rows().nth(2).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-partial-stale.png` });
    await widget.getByTestId('quota-list').evaluate(element => element.scrollTop = element.scrollHeight);
    await panel.screenshot({ path: `/tmp/bungee-quota-${language}-${width}-partial-bottom.png` });
    await widget.getByTestId('quota-list').evaluate(element => element.scrollTop = 0);
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
  count = 10; holdUsage = true; await refresh().click();
  await page.waitForTimeout(80); assert.equal(active, 4);
  await page.evaluate(() => (window as any).disableTestPlugin()); await widget.waitFor({ state: 'detached' });
  await page.waitForTimeout(50); assert.equal(active, 0);
  const disabledCounts = { lists, gets }; holdUsage = false; usageReleases.splice(0).forEach(release => release());
  await page.clock.fastForward(120000); assert.deepEqual({ lists, gets }, disabledCounts);
  // Mount the component before locale loading finishes; Dashboard itself retains its existing locale gate.
  holdLocale = true; await page.goto(`${base}?race`, { waitUntil: 'domcontentloaded' }); await ready();
  assert(localeReleases.length > 0, 'locale resources really are held while widget is mounted');
  assert.equal(await refresh().getAttribute('aria-label'), '');
  assert.equal(errors.length, 0, 'rendering before locale is ready must not throw');
  holdLocale = false; localeReleases.splice(0).forEach(release => release());
  await widget.getByRole('button', { name: 'Refresh quota usage', exact: true }).waitFor();
  await page.evaluate(() => (window as any).unmountDashboard());
  const unmounted = { lists, gets }; await page.clock.fastForward(120000); assert.deepEqual({ lists, gets }, unmounted);
  assert.equal(posts, 0); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  console.log('PASS quota widget: actual Dashboard medium/h-64, owners, 0/1/2/10 accounts, EN/ZH, dynamic windows, malformed/partial, timer/latest-wins/cleanup, max concurrency', maxActive, 'API GET counts', { lists, gets }, 'POST/consume', posts);
} finally { await browser.close(); await server.close(); }
