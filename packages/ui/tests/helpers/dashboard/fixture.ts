import { systemUpdateStatusFixture } from '../system-updates';
import { serviceReference } from '../service-references';
import type { Page } from 'playwright';
import { configurationRuntimeFixture, publicationFixture } from '../publication';
import { menuSnapshot, fulfillMenuIcons } from '../menus';
import { tokenStatsWindow } from '../../../../core/src/token-stats-window';
import type { TokenStatsRange } from '../../../../core/src/plugin.types';
import { observeNetwork } from './network';
import { dashboardSample, historySample, upstreamSample } from './stats';
import type { TimeRange } from '../../../src/types';

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
let nativeFailure = false, nativeFailuresRemaining = 0;

const network = observeNetwork(page, pageErrors);
const nativeRequests: string[] = [];

const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
const logical = config.config.logical_configuration as any;
logical.services = ['openai-pool', 'anthropic-pool', 'gemini-pool', 'billing-api'].map((name, i) => ({ id: `service-${i}`, position: i, name,
  endpoints: Array.from({ length: i === 0 ? 3 : 2 }, (_, j) => ({ id: `ep-${i}-${j}`, position: j, target: `https://${name}.example.com`, weight: 1, priority: 0, is_disabled: false, plugins: [] })), plugins: [] }));
logical.routes = ['/v1/chat/completions', '/v1/messages', '/v1beta/models', '/api/billing'].map((path, i) => ({ id: `route-${i}`, position: i, path, service_references: [serviceReference(`service-${i}`)], plugins: [] }));
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
const snapshotTime = Date.UTC(2026, 8, 30, 4, 38, 30);
function dashboardHistory(range: TimeRange) {
  const intervalMs = range === '1h' ? 60_000 : range === '12h' ? 1_800_000 : 3_600_000;
  const currentStart = Math.floor(snapshotTime / intervalMs) * intervalMs;
  const counts = [...requests], failures = [...failed], latencies = [...responseTimes];
  return historySample(counts.map((count, i) => ({
    timestamp: currentStart - (counts.length - 1 - i) * intervalMs, responseTime: latencies[i],
    requestCounts: { success: count - failures[i], failed: failures[i] },
    httpStatusCounts: { status2xx: count, status3xx: 0, status4xx: 0, status5xx: 0, statusOther: 0 },
    transportCounts: { completed: count - failures[i], failed: failures[i], cancelled: 0, pending: 0, unknown: 0 },
    successRequests: count - failures[i], failedRequests: failures[i],
  })));
}
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
    const range = (url.searchParams.get('range') ?? '1h') as TimeRange;
    return route.fulfill({ json: dashboardSample(range, snapshotTime, dashboardHistory(range), upstreams) });
  }
  if (url.pathname === '/api/plugins/demo/sandbox') return route.fulfill({ json: { sandbox: 'allow-scripts', allowedHostActions: [], controlAllowlist: [] } });
  if (url.pathname === '/api/plugins/token-stats/control/stats') {
    nativeRequests.push(url.search);
    if (nativeFailure && nativeFailuresRemaining-- > 0) { network.expectHttpError(route.request(), 503); return route.fulfill({ status: 503, json: { error: 'unavailable' } }); }
    const asOfMs = Date.parse('2026-10-31T06:00:30Z');
    const { bucketMs, bucketStarts, bucketEndMs } = tokenStatsWindow((url.searchParams.get('range') ?? '1h') as TokenStatsRange, asOfMs, url.searchParams.get('timeZone') ?? 'UTC');
    return route.fulfill({ json: { groupBy: url.searchParams.get('groupBy'), asOfMs, bucketMs, bucketStarts, bucketEndMs, logicalRequests: 12, upstreamAttempts: 12,
      totalInputTokens: 1200, totalOutputTokens: 600, estimatedCostUsd: 0.078,
      authorityBreakdown: { input: { official: 12 }, output: { official: 12 } },
      data: Array.from({ length: 12 }, (_, i) => ({ dimension: i === 10 ? 'unknown' : `model-${i}`, logicalRequests: 1, upstreamAttempts: 1,
        bucketStartMs: bucketStarts ? bucketStarts[Math.max(0, bucketStarts.findLastIndex(start => start < asOfMs) - i % 5)] : Math.floor(asOfMs / bucketMs) * bucketMs - (i % 5) * bucketMs,
        officialInputTokens: url.searchParams.get('groupBy') === 'model' && i < 2 ? (i === 0 ? 200 : 0) : 100,
        officialOutputTokens: 50, estimatedCostUsd: 0.001 * (i + 1),
        authorityBreakdown: { input: { official: 1 }, output: { official: 1 } },
      })),

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
    : [{ name: 'demo', enabled: true, metadata: { name: 'demo', version: '1.0.0', contributes: { widgets: [{ id: 'demo', title: '测试插件', path: 'widget.html', size: 'medium' }] } } }] });
  if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
  if (url.pathname === '/api/ui/menus') return route.fulfill({ json: native ? tokenMenuSnapshot() : menuSnapshot() });
  if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
  pageErrors.push(`Unexpected API: ${route.request().method()} ${url.pathname}`);
  return route.fulfill({ status: 404, json: { error: 'unexpected_fixture_request' } });
});
await page.route('**/plugins/demo/index.html*', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="color:#aaa;background:#15171c">Test plugin widget</body></html>' }));
return { network, pageErrors, nativeRequests, tokenManifest, modelsDevManifest,
get nativeFailure() { return nativeFailure; }, set nativeFailure(value: typeof nativeFailure) { nativeFailure = value; nativeFailuresRemaining = value ? 2 : 0; } };
}
