import type { Page } from 'playwright';
import { expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../publication';
import { menuSnapshot, fulfillMenuIcons } from '../menus';
import { LAYOUT_KEY } from '../../../src/components/dashboard/layout';
import { tokenStatsWindow } from '../../../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../../../core/src/plugin.types';
import { observeNetwork } from './network';
import { dashboardSample, historySample, upstreamSample } from './stats';
import type { TimeRange } from '../../../src/types';

export async function navigateDashboard(page: Page, navigate: () => Promise<unknown>) {
  // Cards may render before the independent configuration read completes.
  // Finish it before another navigation can abort the request.
  const config = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config');
  await navigate();
  await (await config).finished();
}

export function tokenMenuSnapshot() {
 const snapshot = menuSnapshot();
 const page = { id: 'plugin:token-stats:%2Fstatistics', label: 'page.title', href: '/#/extensions/token-stats/statistics', source: 'plugin' as const, pluginName: 'token-stats', defaultIcon: 'lucide:chart-no-axes-column', available: true };
 return { ...snapshot, catalog: [...snapshot.catalog, page], layout: [...snapshot.layout, { kind: 'page' as const, pageId: page.id, visible: true }] };
}

export async function connectDashboard(page: Page, native = false) {
const pageErrors: string[] = [];
page.on('pageerror', error => pageErrors.push(error.message));
const tokenManifest = await Bun.file(new URL('../../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const modelsDevManifest = await Bun.file(new URL('../../../../../plugins/models-dev/manifest.json', import.meta.url)).json();
await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
let historyCalls = 0, historyFailure = false, disabledPlugin = false, nativeFailure = false;
let nativeInput = 1200, nativeOutput = 600, nativeCost = 0.078;
let nativeLargeNumbers = false;
let nativeLimitedModels = false;
let historyFailuresRemaining = 0, nativeFailuresRemaining = 0;

const network = observeNetwork(page, pageErrors);
const nativeRequests: string[] = [];

const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = config.config.logical_configuration as any;
logical.services = ['openai-pool', 'anthropic-pool', 'gemini-pool', 'billing-api'].map((name, i) => ({ id: `service-${i}`, position: i, name,
  endpoints: Array.from({ length: i === 0 ? 3 : 2 }, (_, j) => ({ id: `ep-${i}-${j}`, position: j, target: `https://${name}.example.com`, weight: 1, priority: 0, is_disabled: false, plugins: [] })), plugins: [] }));
logical.routes = ['/v1/chat/completions', '/v1/messages', '/v1beta/models', '/api/billing'].map((path, i) => ({ id: `route-${i}`, position: i, path, service_id: `service-${i}`, plugins: [] }));
const requests = [30,31,32,33,34,35,36,35,34,33,31,25];
const failed = [0,0,0,1,1,0,0,1,1,1,0,1];
const responseTimes = [85,88,84,90,94,87,83,79,84,82,85,90];
// 389 chains produce 390 attempts after one recovered HTTP 503. Six other
// attempts fail mid-stream after HTTP 2xx, so HTTP and joint outcomes differ.
const upstreams = [upstreamSample('https://chatgpt.com', {
  requestCounts: { success: 383, failed: 7 },
  httpStatusCounts: { status2xx: 389, status3xx: 0, status4xx: 0, status5xx: 1, statusOther: 0 },
  transportCounts: { completed: 384, failed: 6, cancelled: 0, pending: 0, unknown: 0 },
  successRequests: 383, failedRequests: 7,
}, 6)];
let statusFixtures = false;
let cancellationFixture = false;
let trendScenario: 'default' | 'growth' | 'new' | 'idle' | 'stopped' = 'default';
const snapshotTime = Date.UTC(2026, 8, 30, 4, 38, 30);
function dashboardHistory(range: TimeRange) {
  const intervalMs = range === '1h' ? 60_000 : range === '12h' ? 1_800_000 : 3_600_000;
  const currentStart = Math.floor(snapshotTime / intervalMs) * intervalMs;
  const counts = [...requests], failures = [...failed], latencies = [...responseTimes];
  const previous = counts.length - 3, current = counts.length - 2;
  if (trendScenario === 'growth') {
    counts[previous] = 515; counts[current] = 542; counts[current + 1] = 220;
    failures[previous] = 3; failures[current] = 2;
    latencies[previous] = 29044; latencies[current] = 23610;
  } else if (trendScenario !== 'default') {
    counts[previous] = trendScenario === 'stopped' ? 9 : 0;
    counts[current] = trendScenario === 'new' ? 9 : 0;
    failures[previous] = failures[current] = 0;
    latencies[previous] = counts[previous] ? 100 : 0;
    latencies[current] = counts[current] ? 100 : 0;
  }
  return historySample(counts.map((count, i) => ({
    timestamp: currentStart - (counts.length - 1 - i) * intervalMs, responseTime: latencies[i],
    requestCounts: { success: count - failures[i], failed: failures[i] },
    httpStatusCounts: { status2xx: count, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 },
    transportCounts: { completed: count - failures[i], failed: failures[i], cancelled: 0, pending: 0, unknown: 0 },
    successRequests: count - failures[i], failedRequests: failures[i],
  })));
}
const statusUpstreams = [
  // Completed 3xx can be protocol successes while their joint request result is failed.
  upstreamSample('https://api.openai.com', {
    requestCounts: { success: 1000, failed: 20 },
    httpStatusCounts: { status2xx: 1000, status3xx: 5, status4xx: 10, status5xx: 5, statusOther: 0 },
    transportCounts: { completed: 1020, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
    successRequests: 1005, failedRequests: 15,
  }),
  upstreamSample('https://client-errors.example.com', {
    requestCounts: { success: 0, failed: 13 },
    httpStatusCounts: { status2xx: 0, status3xx: 0, status4xx: 13, status5xx: 0, statusOther: 0 },
    transportCounts: { completed: 13, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
    successRequests: 0, failedRequests: 13,
  }),
  upstreamSample('https://idle.example.com', {
    requestCounts: { success: 0, failed: 0 },
    httpStatusCounts: { status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 },
    transportCounts: { completed: 0, failed: 0, cancelled: 0, pending: 0, unknown: 0 },
    successRequests: 0, failedRequests: 0,
  }),
  upstreamSample('https://no-http-response.example.com', {
    requestCounts: { success: 0, failed: 3 },
    httpStatusCounts: { status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 3 },
    transportCounts: { completed: 0, failed: 3, cancelled: 0, pending: 0, unknown: 0 },
    successRequests: 0, failedRequests: 3,
  }),
];
const cancelledSample = {
  requestCounts: { success: 2, failed: 2 },
  httpStatusCounts: { status2xx: 7, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 },
  transportCounts: { completed: 2, failed: 2, cancelled: 3, pending: 0, unknown: 0 },
  successRequests: 2, failedRequests: 5,
};
await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
  const url = new URL(route.request().url());
  if (route.request().method() !== 'GET') { pageErrors.push(`Unexpected method: ${route.request().method()} ${url.pathname}`); return route.fulfill({ status: 405, body: '' }); }
  if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'anonymous', publicOrigin: url.origin } });
  if (url.pathname === '/api/auth/verify') return route.fulfill({ json: { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
  if (url.pathname === '/api/resources/api-key') return route.fulfill({ json: { keys: [] } });
  if (url.pathname === '/api/plugin-translations') return route.fulfill({ json: Object.fromEntries(
    Object.entries(tokenManifest.translations).map(([language, messages]) => [language, { plugins: { 'token-stats': messages, 'models-dev': modelsDevManifest.translations[language] } }])) });
  if (url.pathname === '/api/config/runtime') return route.fulfill({ json: config });
  if (url.pathname === '/api/config') return route.fulfill({ json: { revision: 1, content_hash: config.content_hash, config: config.config } });
  if (url.pathname === '/api/runtime/upstreams') return route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(), availability: 'complete', reason: null,
    admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: logical.services.flatMap((service: any) => service.endpoints.map((endpoint: any, j: number) => ({
      state_key: service.name, upstream_id: endpoint.id, circuit_state: service.name === 'gemini-pool' && j === 1 ? 'HALF_OPEN' : 'HEALTHY',
      active_request_count: 0, last_used_time: null, last_used_complete: true, last_failure_time: null, last_failure_complete: true, workers: [],
    }))) } });
  if (url.pathname === '/api/stats/dashboard') {
    historyCalls++;
    const range = (url.searchParams.get('range') ?? '1h') as TimeRange;
    const history = cancellationFixture ? historySample([{ ...cancelledSample, timestamp: snapshotTime - 60_000, responseTime: 80 }]) : dashboardHistory(range);
    const data = cancellationFixture ? [upstreamSample('https://chatgpt.com', cancelledSample, 5)] : statusFixtures ? statusUpstreams : upstreams;
    const fail = historyFailure && historyFailuresRemaining-- > 0;
    if (fail) network.expectHttpError(route.request(), 503);
    return fail ? route.fulfill({ status: 503, json: { error: 'unavailable' } }) : route.fulfill({ json: dashboardSample(range, snapshotTime, history, data) });
  }
  if (url.pathname === '/api/plugins/demo/sandbox') return route.fulfill({ json: { sandbox: 'allow-scripts', allowedHostActions: [], controlAllowlist: [] } });
  if (url.pathname === '/api/plugins/token-stats/control/stats') {
    nativeRequests.push(url.search);
    if (nativeFailure && nativeFailuresRemaining-- > 0) { network.expectHttpError(route.request(), 503); return route.fulfill({ status: 503, json: { error: 'unavailable' } }); }
    const asOfMs = Date.parse('2026-10-31T06:00:30Z');
    const { bucketMs, bucketStarts, bucketEndMs } = tokenStatsWindow((url.searchParams.get('range') ?? '1h') as TokenStatsRange, asOfMs, url.searchParams.get('timeZone') ?? 'UTC');
    return route.fulfill({ json: { groupBy: url.searchParams.get('groupBy'), asOfMs, bucketMs, bucketStarts, bucketEndMs, logicalRequests: 12, upstreamAttempts: 12,
      totalInputTokens: nativeInput, totalOutputTokens: nativeOutput, estimatedCostUsd: nativeCost,
      ...(nativeLargeNumbers ? { cacheReadTokens: 1_000_000, cacheWriteTokens: 1024 } : {}),
      authorityBreakdown: { input: { official: 12 }, output: { official: 12 } },
      data: Array.from({ length: 12 }, (_, i) => ({ dimension: i === 10 ? 'unknown' : `model-${i}`, logicalRequests: 1, upstreamAttempts: 1,
        bucketStartMs: bucketStarts ? bucketStarts[Math.max(0, bucketStarts.findLastIndex(start => start < asOfMs) - i % 5)] : Math.floor(asOfMs / bucketMs) * bucketMs - (i % 5) * bucketMs,
        officialInputTokens: url.searchParams.get('groupBy') === 'model' && i < 2 ? (i === 0 ? 200 : 0) : 100,
        officialOutputTokens: 50, estimatedCostUsd: 0.001 * (i + 1),
        authorityBreakdown: { input: { official: 1 }, output: { official: 1 } },
        ...(nativeLargeNumbers ? { officialInputTokens: 1_000_000_000_000, officialOutputTokens: 1_000_000_000,
          cacheReadTokens: 1_000_000, cacheWriteTokens: 1024, estimatedCostUsd: 1234.56 } : {}) }))
        .slice(0, nativeLimitedModels && url.searchParams.get('groupBy') === 'time' ? 1 : undefined),
    } });
  }
  if (url.pathname === '/api/plugins/token-stats/control/pricing') return route.fulfill({ json: {
    state: 'empty', version: null, fetchedAt: null, error: null, modelCount: 0, providerCount: 0,
  } });
  if (url.pathname === '/api/plugins/token-stats/control/pricing/mappings') return route.fulfill({ json: { mappings: [] } });
  if (url.pathname === '/api/plugins/models-dev/control/catalog/providers') return route.fulfill({ json: { providers: [] } });
  if (url.pathname === '/api/plugins/models-dev/control/catalog/status') return route.fulfill({ json: {
    state: 'empty', version: null, settings: { autoRefresh: true, intervalHours: 24, timeoutSeconds: 15 },
    refreshing: false, lastAttemptAt: null, lastSuccessAt: null, nextRefreshAt: null, lastError: null,
    modelCount: 0, providerCount: 0,
  } });
  if (url.pathname === '/api/plugins') return route.fulfill({ json: native ? [{ name: 'token-stats', version: tokenManifest.version, enabled: true, metadata: { ...tokenManifest.metadata, contributes: { ...tokenManifest.contributes,
        nativeWidgets: tokenManifest.contributes.nativeWidgets.map((widget: any) => ({ ...widget, props: { pluginName: 'intruder', selectedRange: '24h' } })),
      } } },
      { name: 'intruder', enabled: true, metadata: { contributes: { nativeWidgets: tokenManifest.contributes.nativeWidgets } } },
      { name: 'models-dev', version: modelsDevManifest.version, enabled: true, metadata: { ...modelsDevManifest.metadata, contributes: modelsDevManifest.contributes } }]
    : [{ name: 'demo', enabled: !disabledPlugin, metadata: { name: 'demo', version: '1.0.0', contributes: { widgets: [{ id: 'demo', title: '测试插件', path: 'widget.html', size: 'medium' }] } } }] });
  if (url.pathname === '/api/ui/menus') return route.fulfill({ json: native ? tokenMenuSnapshot() : menuSnapshot() });
  if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
  pageErrors.push(`Unexpected API: ${route.request().method()} ${url.pathname}`);
  return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
});
await page.route('**/plugins/demo/index.html*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="color:#aaa;background:#15171c">Test plugin widget</body></html>' }));
const card = (id: string) => page.locator(`.grid-stack-item[data-card-id="${id}"]`);
const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), LAYOUT_KEY);
async function edit() { await page.getByTestId('dashboard-customize').click(); await expect(page.getByTestId('dashboard-save-layout')).toBeVisible(); }
async function cancel() { await page.getByTestId('dashboard-cancel-layout').click(); const discard = page.getByRole('button', { name: '放弃更改', exact: true }); if (await discard.isVisible()) await discard.click(); await expect(page.getByTestId('dashboard-customize')).toBeVisible(); }
async function library() { await page.getByTestId('dashboard-add-card').click(); await expect(page.getByRole('dialog')).toBeVisible(); }
async function closeLibrary() { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); }

async function checkKpiRegions(count = 5) {
  const cards = page.locator('.dashboard-kpi-card').filter({ hasNot: page.getByTestId('token-stats-overview') });
  await expect(cards).toHaveCount(count);
  await expect.poll(() => cards.evaluateAll(nodes => {
    const heights = nodes.map(node => ['.kpi-header', '.kpi-body', '.kpi-footer'].map(selector => node.querySelector(selector)!.getBoundingClientRect().height));
    return Math.max(...[0, 1, 2].map(region => Math.max(...heights.map(card => card[region])) - Math.min(...heights.map(card => card[region]))));
  })).toBeLessThan(1);
  const clipped = await cards.evaluateAll(nodes => nodes.flatMap(node => {
    const body = node.querySelector('.kpi-body')!.getBoundingClientRect();
    const metric = node.querySelector('.kpi-metric-row')!.getBoundingClientRect();
    const footer = node.querySelector('.kpi-footer')!.getBoundingClientRect();
    const bounds = node.getBoundingClientRect();
    return metric.top < body.top || metric.bottom > body.bottom || Math.abs(footer.bottom - bounds.bottom) > 2 ? [node.textContent] : [];
  }));
  expect(clipped).toEqual([]);
}


return { network, pageErrors, nativeRequests, tokenManifest, modelsDevManifest, card, stored, edit, cancel, library, closeLibrary, checkKpiRegions,
get historyCalls() { return historyCalls; }, set historyCalls(value: typeof historyCalls) { historyCalls = value; },
get historyFailure() { return historyFailure; }, set historyFailure(value: typeof historyFailure) { historyFailure = value; historyFailuresRemaining = value ? 1 : 0; },
get disabledPlugin() { return disabledPlugin; }, set disabledPlugin(value: typeof disabledPlugin) { disabledPlugin = value; },
get nativeFailure() { return nativeFailure; }, set nativeFailure(value: typeof nativeFailure) { nativeFailure = value; nativeFailuresRemaining = value ? 2 : 0; },
get nativeInput() { return nativeInput; }, set nativeInput(value: typeof nativeInput) { nativeInput = value; },
get nativeOutput() { return nativeOutput; }, set nativeOutput(value: typeof nativeOutput) { nativeOutput = value; },
get nativeCost() { return nativeCost; }, set nativeCost(value: typeof nativeCost) { nativeCost = value; },
get nativeLargeNumbers() { return nativeLargeNumbers; }, set nativeLargeNumbers(value: typeof nativeLargeNumbers) { nativeLargeNumbers = value; },
get nativeLimitedModels() { return nativeLimitedModels; }, set nativeLimitedModels(value: typeof nativeLimitedModels) { nativeLimitedModels = value; },
get statusFixtures() { return statusFixtures; }, set statusFixtures(value: typeof statusFixtures) { statusFixtures = value; },
get cancellationFixture() { return cancellationFixture; }, set cancellationFixture(value: typeof cancellationFixture) { cancellationFixture = value; },
get trendScenario() { return trendScenario; }, set trendScenario(value: typeof trendScenario) { trendScenario = value; } };
}
