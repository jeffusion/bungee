import assert from 'node:assert/strict';
import type { Page, Request } from 'playwright';
import { LAYOUT_KEY } from '../../../src/components/dashboard/layout';
import { observeNetwork } from './network';
import { dashboardSample, historySample } from './stats';
import { configurationRuntimeFixture, publicationFixture } from '../publication';

export async function connectQuota(page: Page, origin: string, initiallyEnabled = true) {
 const manifest = await Bun.file(new URL('../../../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
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
  const network = observeNetwork(page, errors);
  const activeUsageRequests = new Set<Request>();
  page.on('pageerror', error => { errors.push(error.message); console.error(error); });

  let enabled = initiallyEnabled, count = 2, malformedList = false, malformedAccount = false, lists = 0, gets = 0, posts = 0;
  let peer = false;
  const failingRefs = new Map<string, number>();
  const spoofed = { ...manifest.contributes.nativeWidgets[0], props: { pluginName: 'forged-owner', selectedRange: 'forged-range', onHeaderChange: 'forged-callback', summary: 'FORGED SUMMARY' } };
  let active = 0, maxActive = 0, holdUsage = false;
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
    if (url.origin !== origin) {
      if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.fulfill({ body: '', contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'text/plain' });
      unexpected.push(`External resource: ${request.url()}`); return route.abort();
    }
    if (request.method() !== 'GET') { posts++; unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const respond = (body: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/plugins') return respond([
      { name: 'quota-impostor', enabled: true, metadata: { ui: { components: [{ name: 'ChatgptQuotaWidget', entry: 'ui/forged.svelte' }] }, contributes: { nativeWidgets: [{ ...spoofed, props: { pluginName: 'chatgpt-oauth', selectedRange: 'forged-range' } }] } } },
      { name: manifest.name, enabled, metadata: { ...manifest.metadata, contributes: { ...manifest.contributes, nativeWidgets: [spoofed] } } },
      ...(peer ? [{ name: 'token-stats', enabled: true, metadata: { contributes: { nativeWidgets: [{ ...spoofed, component: 'TokenStatsChart' }] } } }] : []),
    ]);
    if (url.pathname === '/api/plugins/schemas') return respond({ [manifest.name]: manifest });
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts') {
      lists++;
      const body = malformedList ? { accounts: null } : { accounts: [...accounts.slice(0, count), ...(malformedAccount ? [{ invalid: true }] : [])] };
      return respond(body);
    }
    if (url.pathname === '/api/plugins/chatgpt-oauth/control/accounts/usage') {
      gets++; const ref = url.searchParams.get('accountRef')!; apiRefs.push(ref);
      activeUsageRequests.add(request);
      active++; maxActive = Math.max(maxActive, active);
      let done = false;
      const finish = () => { if (!done) { active--; activeUsageRequests.delete(request); done = true; } };
      const failed = (failedRequest: any) => { if (failedRequest === request) { finish(); page.off('requestfailed', failed); } };
      page.on('requestfailed', failed);
      if (holdUsage) await new Promise<void>(resolve => usageReleases.push(resolve));

      finish(); page.off('requestfailed', failed);
      if ((failingRefs.get(ref) ?? 0) > 0) {
        failingRefs.set(ref, failingRefs.get(ref)! - 1);
        network.expectHttpError(request, 503);
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_unavailable' }) });
      }
      return respond(usages[accounts.findIndex(account => account.id === ref)]);
    }
    if (url.pathname === '/api/config/runtime') return respond(configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })));
    if (url.pathname === '/api/stats/dashboard') return respond(dashboardSample('1h', Date.now(), historySample([])));
    if (url.pathname === '/api/runtime/upstreams') return respond({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
    if (url.pathname === '/api/config') return respond({ config: { logical_configuration: { services: [], routes: [], plugins: [], auth: { enabled: false, tokens: [] } }, plugin_activations: [] }, revision: 1, content_hash: 'fixture' });
    unexpected.push(url.pathname); console.error('Unexpected fixture API:', url.pathname); return route.abort();
  });
  const base = `${origin}/tests/fixtures/quota.html`;
  const widget = page.getByTestId('chatgpt-quota-widget');
  const panel = page.locator('article').filter({ has: widget });
  const refresh = () => panel.locator('header').getByRole('button');
  const ready = () => refresh().and(page.locator('[aria-busy="false"]')).waitFor();

 await page.goto(base); await page.getByTestId('page-dashboard').waitFor();
 if (initiallyEnabled) { await widget.waitFor(); await ready(); }
 else await page.getByText('Plugin disabled', { exact: true }).first().waitFor();
 const rows = () => widget.getByTestId('quota-account');
 const assertClean = () => { network.assertSettled(); assert.equal(posts, 0); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); };
 return { base, manifest, widget, panel, refresh, ready, rows, accounts, usages, failingRefs, errors, unexpected,
 assertClean, expectUsageAborts: (action: () => Promise<unknown>) => network.expectAborts([...activeUsageRequests], action), usageReleases,
get enabled() { return enabled; }, set enabled(value: typeof enabled) { enabled = value; },
get count() { return count; }, set count(value: typeof count) { count = value; },
get malformedList() { return malformedList; }, set malformedList(value: typeof malformedList) { malformedList = value; },
get malformedAccount() { return malformedAccount; }, set malformedAccount(value: typeof malformedAccount) { malformedAccount = value; },
get lists() { return lists; }, set lists(value: typeof lists) { lists = value; },
get gets() { return gets; }, set gets(value: typeof gets) { gets = value; },
get posts() { return posts; }, set posts(value: typeof posts) { posts = value; },
get peer() { return peer; }, set peer(value: typeof peer) { peer = value; },
get active() { return active; }, set active(value: typeof active) { active = value; },
get maxActive() { return maxActive; }, set maxActive(value: typeof maxActive) { maxActive = value; },
get holdUsage() { return holdUsage; }, set holdUsage(value: typeof holdUsage) { holdUsage = value; }
 };
}
