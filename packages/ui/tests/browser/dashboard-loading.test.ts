import { systemUpdateStatusFixture } from '../helpers/system-updates';
import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardSample, historySample } from '../helpers/dashboard/stats';
import type { TimeRange } from '../../src/types';
import { observeNetwork } from '../helpers/dashboard/network';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../helpers/menus';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
const uiRuntime = dashboardRuntime();
const manifest = await Bun.file(new URL('../../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));

const language = 'en', width = 1440;
test('Token loading shares requests and retries failures', () => uiRuntime.run(async page => {
 const base = uiRuntime.origin;
 const errors: string[] = [];
  const network = observeNetwork(page, errors);
        await page.addInitScript(language => localStorage.setItem('locale', language), language);
        page.on('pageerror', error => errors.push(error.message));
        let response: 'success' | 'empty' | 'error' = 'success';
        const input = 1200;
        let requests = 0;
        let release!: () => void;
        let gate = new Promise<void>(resolve => { release = resolve; });
        const delayNext = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        await page.route('https://fonts.gstatic.com/**', route => route.fulfill({ body: '' }));
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const url = new URL(route.request().url());
          if (route.request().method() !== 'GET') throw new Error(`Unexpected method: ${route.request().method()} ${url.pathname}`);
          const json = (value: unknown) => route.fulfill({ json: value });
          if (url.pathname === '/api/auth/mode') return json({ mode: 'anonymous', publicOrigin: url.origin });
          if (url.pathname === '/api/auth/verify') return json({ success: true, mode: 'anonymous' });
          if (url.pathname === '/api/config/runtime') return json(runtime);
          if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
          if (url.pathname === '/api/plugins') return json([{ name: 'token-stats', enabled: true,
            metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
          if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
            .map(([code, messages]) => [code, { plugins: { 'token-stats': messages } }])));
          if (url.pathname === '/api/resources/api-key') return json({ keys: [] });
          if (url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1',
            generated_at: Date.now(), availability: 'complete', reason: null, admission: { revision: 1 },
            workers: { observed: [], missing: [] }, upstreams: [] });
          if (url.pathname === '/api/stats/dashboard') return json(dashboardSample((url.searchParams.get('range') ?? '1h') as TimeRange, Date.now(), historySample([])));
          if (url.pathname === '/api/plugins/token-stats/control/stats') {
            requests++;
            await gate;
            if (response === 'error') { network.expectHttpError(route.request(), 503); return route.fulfill({ status: 503, json: { error: 'unavailable' } }); }
            const empty = response === 'empty';
            return json({ groupBy: 'time', asOfMs: Date.now(), bucketMs: 300_000, data: [],
              logicalRequests: empty ? 0 : 1, upstreamAttempts: empty ? 0 : 1,
              totalInputTokens: empty ? 0 : input, totalOutputTokens: empty ? 0 : 600,
              estimatedCostUsd: empty ? 0 : 0.078,
              authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } });
          }
          if (route.request().method() === 'GET' && new URL(route.request().url()).pathname === '/api/system/updates') return route.fulfill({ json: systemUpdateStatusFixture });
          if (url.pathname === '/api/ui/menus') return json(menuSnapshot());
          if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
          throw new Error(`Unexpected API: ${route.request().method()} ${url.pathname}`);
        });
        const overview = page.getByTestId('token-stats-overview');
        const overviewCard = page.locator('[data-card-id="plugin:native:token-stats:token-stats-overview"]');
        await page.goto(`${base}/#/`);
        for (const [index, outcome] of ['success', 'empty', 'error'].entries()) {
          response = outcome as typeof response;
          if (index) {
            delayNext();
            await page.getByRole('radio', { name: index === 1 ? '12h' : '24h', exact: true }).click();
          }
          await expect(overview).toHaveAttribute('aria-busy', 'true');
          await expect(overview.getByRole('status')).toBeVisible();

          release();
          await expect(overview).toHaveAttribute('aria-busy', 'false');
          if (outcome === 'empty') await expect(overviewCard.getByTestId('token-stats-empty')).toBeVisible();
          if (outcome === 'error') await expect(overviewCard.getByRole('alert')).toBeVisible();

        }
        // Retry after failure, then verify another refresh shares one request.
        const refresh = overviewCard.locator('header').getByRole('button', { name: manifest.translations[language]['ui.refresh'], exact: true });
        response = 'success'; delayNext();
        await refresh.click(); await expect(overview).toHaveAttribute('aria-busy', 'true');
        release();
        await expect(overview).toHaveAttribute('aria-busy', 'false');
        await expect(overviewCard.getByRole('alert')).toHaveCount(0);
        delayNext();
        await refresh.click(); await expect(overview).toHaveAttribute('aria-busy', 'true');
        release();
        await expect(overview).toHaveAttribute('aria-busy', 'false');
        expect(requests).toBe(5); // Overview and trend share each request.

 network.assertSettled(); expect(errors).toEqual([]);
}, { viewport: { width, height: 1080 }, locale: language }), 120_000);
