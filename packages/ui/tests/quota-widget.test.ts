import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { loadPluginArtifactManifest } from '../../core/src/plugin-artifact-contract';
import { accountSummary, accountUsage, errorText } from '../../../plugins/chatgpt-oauth/ui/account-model.js';

const source = await Bun.file(new URL('../../../plugins/chatgpt-oauth/ui/ChatgptQuotaWidget.svelte', import.meta.url)).text();
const manifest = await Bun.file(new URL('../../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).json();
test('strict manifest registers a medium read-only native widget, preserving account settings', async () => {
  const parsed = await loadPluginArtifactManifest(new URL('../../../plugins/chatgpt-oauth', import.meta.url).pathname);
  expect(parsed.manifestContract).toBe('vnext');
  expect(parsed.contributes?.nativeWidgets).toContainEqual({ id: 'chatgpt-quota-usage', title: 'ui.widgetTitle', component: 'ChatgptQuotaWidget', size: 'medium' });
  expect(manifest.ui.components).toContainEqual({ name: 'ChatgptQuotaWidget', entry: 'ui/ChatgptQuotaWidget.svelte' });
  expect(manifest.ui.components).toContainEqual({ name: 'ChatgptAccountsPage', entry: 'ui/AccountsPage.svelte' });
});
test('widget compiles without warnings, guards i18n and has no mutating API or extra panel shell', () => {
  for (const generate of ['client', 'server'] as const) expect(compile(source, { filename: 'ChatgptQuotaWidget.svelte', generate }).warnings).toEqual([]);
  expect(source).toContain("requestPluginControl<unknown>(owner, path, 'GET', undefined, signal)");
  expect(source).not.toMatch(/['"]POST['"]|\/login|\/reset|PanelCard|CornerBrackets|animate-spin|\.creditId|\.redeemRequestId|\.title|\.description/);
  expect(source).toContain("$isLoading ? ''");
  expect(source).toContain('quota-widget flex h-full min-h-0');
  expect(source).not.toContain('calc(16rem');
  expect(source).toContain('60000'); expect(source).toContain('controller?.abort(); clearInterval(timer)');
  for (const key of [...source.matchAll(/['"](ui\.[a-zA-Z_]+)['"]/g)].map(match => match[1])) {
    for (const language of ['en', 'zh-CN']) expect(manifest.translations[language][key]).toBeTruthy();
  }
});
test('Dashboard checks generated ownership before resolution, protects host props and namespaces native keys', async () => {
  const dashboard = await Bun.file(new URL('../src/routes/Dashboard.svelte', import.meta.url)).text();
  expect(dashboard).toContain('if (getWidgetSource(widget.component) !== p.name) return;');
  expect(dashboard.indexOf('getWidgetSource(widget.component)')).toBeLessThan(dashboard.indexOf('getNativeWidget(widget.component)'));
  expect(dashboard).toContain('props: { ...widget.props, selectedRange, pluginName: p.name, onHeaderChange:');
  expect(dashboard).toContain('nativeWidgetPanels as panel (`${panel.pluginName}:${panel.id}`)');
  expect(dashboard.slice(dashboard.indexOf('<!-- ===== iframe plugin panels'))).not.toContain('getWidgetSource');
});
test('host header callback identities survive range updates but reject old updates and cleanup after replacement', async () => {
  const dashboard = await Bun.file(new URL('../src/routes/Dashboard.svelte', import.meta.url)).text();
  const helpers = [dashboard.match(/  function getHeaderReporter\([\s\S]*?\n  }/)![0], dashboard.match(/  function pruneHeaderChannels\([\s\S]*?\n  }/)![0]].join('\n');
  const host = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(`let widgetHeaders = {}; const headerChannels = new Map(); ${helpers}; return { getHeaderReporter, pruneHeaderChannels, headers: () => widgetHeaders };`))();
  const component = {}, key = 'owner:widget';
  const value = (summary: string) => ({ summary, refresh: { label: 'Refresh', busy: false, disabled: false, run() {} } });
  const old = host.getHeaderReporter(key, component);
  expect(host.getHeaderReporter(key, component)).toBe(old);
  old(value('old')); host.pruneHeaderChannels(new Set());
  expect(host.headers()[key]).toBeUndefined();
  const current = host.getHeaderReporter(key, component); current(value('current'));
  old(value('late')); old(null);
  expect(host.headers()[key].summary).toBe('current');
  current({ summary: {}, refresh: 'invalid' });
  expect(host.headers()[key].summary).toBe('current');
  current(null); expect(host.headers()[key]).toBeNull();
});

// Exercise the actual refresh function, not a second implementation of its concurrency logic.
const refreshSource = source.match(/  async function refresh\([\s\S]*?\n  }/)![0];
const create = new Function('requestPluginControl', 'accountSummary', 'accountUsage', 'errorText', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  let rows = [], busy = true, loaded = false, notice = '', generation = 0, disposed = false, controller;
  const pluginName = 'chatgpt-oauth';
  ${refreshSource}
  return { refresh, state: () => ({ rows, busy, notice, loaded }), dispose: () => { disposed = true; ++generation; controller?.abort(); } };
`));
const account = (id: string) => ({ id, label: `Account ${id}`, status: 'active', available: true });
const usage = { usage: { state: 'fresh', primary: { usedPercent: 12, windowSeconds: 18000 } }, resetCredits: { state: 'unavailable' } };
test('malformed usage is isolated; valid partial windows survive, malformed account records do not erase peers', async () => {
  const instance = create(async (_owner: string, path: string) => path === '/accounts'
    ? { accounts: [account('good'), account('bad'), { status: 'garbage' }, account('good'), account('')] }
    : path.endsWith('good') ? usage : { usage: { state: 'fresh', primary: null }, resetCredits: { state: 'fresh', availableCount: -1 } }, accountSummary, accountUsage, errorText);
  await instance.refresh();
  expect(instance.state().rows).toHaveLength(2);
  expect(instance.state().rows[0].usage.usage.value.primary.usedPercent).toBe(12);
  expect(instance.state().rows[1].error).toBe('errors.invalid_response');
  expect(instance.state().notice).toBe('ui.widgetPartialAccounts');
});
test('credit count prefers authoritative fresh credit data then fresh usage; unknown never becomes zero', () => {
  const helper = source.match(/  function creditCount\([\s\S]*?\n  }/)![0];
  const count = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(`${helper}; return creditCount;`))();
  const snapshot = (usageState: string, creditState: string) => ({ usage: accountUsage({ usage: { state: usageState, availableCount: 3 }, resetCredits: { state: creditState, availableCount: 1 } }) });
  expect(count(snapshot('fresh', 'fresh'))).toBe(1);
  expect(count(snapshot('fresh', 'stale'))).toBe(3);
  expect(count(snapshot('unavailable', 'unavailable'))).toBeUndefined();
  expect(count({})).toBeUndefined();
  expect(count({ usage: accountUsage({ usage: { state: 'fresh', availableCount: 0 }, resetCredits: { state: 'unavailable' } }) })).toBe(0);
});
test('unavailable envelopes are not last-good snapshots; failed GET becomes stale only with a real window or count', async () => {
  const helpers = [source.match(/  const validPercent =.*;/)![0], source.match(/  function creditCount\([\s\S]*?\n  }/)![0], source.match(/  function usageState\([\s\S]*?\n  }/)![0]].join('\n');
  const state = new Function(new Bun.Transpiler({ loader: 'ts' }).transformSync(`let busy = false, notice = ''; ${helpers}; return usageState;`))();
  let failed = false;
  const unavailable = { usage: { state: 'unavailable' }, resetCredits: { state: 'unavailable' } };
  const instance = create(async (_owner: string, path: string) => {
    if (path === '/accounts') return { accounts: [account('empty'), account('window'), account('count')] };
    if (failed) throw new Error('upstream_unavailable');
    if (path.endsWith('empty')) return unavailable;
    if (path.endsWith('window')) return usage;
    return { usage: { state: 'unavailable' }, resetCredits: { state: 'fresh', availableCount: 0 } };
  }, accountSummary, accountUsage, errorText);
  await instance.refresh(); expect(state(instance.state().rows[0])).toBe('unavailable');
  failed = true; await instance.refresh();
  expect(instance.state().rows.map(state)).toEqual(['unavailable', 'stale', 'stale']);
});
test('four GET workers, abort before superseding, ignored late responses and disposed instance cannot overwrite state', async () => {
  let list = 0, active = 0, maximum = 0;
  const pending: Array<{ signal: AbortSignal; finish: () => void }> = [];
  const instance = create(async (_owner: string, path: string, method: string, _body: unknown, signal: AbortSignal) => {
    expect(method).toBe('GET');
    if (path === '/accounts') return { accounts: list++ === 0 ? Array.from({ length: 10 }, (_, i) => account(String(i))) : [account('new')] };
    active++; maximum = Math.max(maximum, active);
    let counted = true;
    const done = () => { if (counted) { active--; counted = false; } };
    signal.addEventListener('abort', done, { once: true });
    return new Promise(resolve => pending.push({ signal, finish: () => { done(); resolve(usage); } }));
  }, accountSummary, accountUsage, errorText);
  const old = instance.refresh(); await Bun.sleep(0);
  expect(pending).toHaveLength(4);
  const next = instance.refresh(); await Bun.sleep(0);
  expect(pending.slice(0, 4).every(item => item.signal.aborted)).toBe(true);
  pending[4].finish(); await next;
  pending.slice(0, 4).forEach(item => item.finish()); await old;
  expect(instance.state().rows.map((row: any) => row.account.id)).toEqual(['new']);
  expect(maximum).toBe(4); expect(pending).toHaveLength(5);
  const final = instance.refresh(); await Bun.sleep(0); instance.dispose();
  const before = JSON.stringify(instance.state()); pending[5].finish(); await final;
  expect(JSON.stringify(instance.state())).toBe(before); expect(pending[5].signal.aborted).toBe(true);
});
