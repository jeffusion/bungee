import { chromium, expect } from 'playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';
import { defaultLayout, LAYOUT_KEY, type CardDefinition } from '../src/components/dashboard/layout';

// Delay real UI requests with fixtures so each intermediate layout is observable.
const base = process.env.DASHBOARD_BASE_URL ?? 'http://127.0.0.1:5185';
const evidence = process.env.DASHBOARD_EVIDENCE_DIR ?? '/tmp/bungee-dashboard-loading';
const manifest = await Bun.file(new URL('../../../plugins/token-stats/manifest.json', import.meta.url)).json();
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const results: object[] = [];
const narrowLayout = defaultLayout(['overview', 'time'].map(id => ({
  id: `plugin:native:token-stats:token-stats-${id}`, title: `plugins.token-stats.widgets.${id}.title`,
  description: '', group: 'plugin', tag: 'TOKEN', pluginName: 'token-stats', w: 12, h: 4,
  ...(id === 'overview' ? { presentation: 'kpi' } : {}),
}) as CardDefinition[]));
narrowLayout.cards.find(card => card.id.endsWith('token-stats-overview'))!.w = 6;

try {
  for (const language of ['zh-CN', 'en']) {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      for (const custom of width === 1440 ? [false, true] : [false]) {
        const context = await browser.newContext({ viewport: { width, height: 1080 }, locale: language });
        await context.addInitScript(({ language, layout, key }) => {
          localStorage.setItem('locale', language);
          if (layout) localStorage.setItem(key, JSON.stringify(layout));
        }, { language, layout: custom ? narrowLayout : null, key: LAYOUT_KEY });
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        let response: 'success' | 'empty' | 'error' = 'success';
        let input = 1200;
        let requests = 0;
        let release!: () => void;
        let gate = new Promise<void>(resolve => { release = resolve; });
        const delayNext = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
        await page.route('**/api/**', async route => {
          const url = new URL(route.request().url());
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
          if (url.pathname === '/api/stats/dashboard') return json({ range: url.searchParams.get('range'),
            startTime: Date.now() - 3_600_000, endTime: Date.now(), units: { history: 'request_chain', upstreams: 'upstream_attempt' },
            history: { timestamps: [], requests: [], errors: [], responseTime: [], requestCounts: { success: [], failed: [] } },
            upstreams: [], requestCounts: { success: 0, failed: 0 } });
          if (url.pathname === '/api/plugins/token-stats/control/stats') {
            requests++;
            await gate;
            if (response === 'error') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
            const empty = response === 'empty';
            return json({ groupBy: 'time', asOfMs: Date.now(), bucketMs: 300_000, data: [],
              logicalRequests: empty ? 0 : 1, upstreamAttempts: empty ? 0 : 1,
              totalInputTokens: empty ? 0 : input, totalOutputTokens: empty ? 0 : 600,
              estimatedCostUsd: empty ? 0 : 0.078,
              authorityBreakdown: { input: { official: 1 }, output: { official: 1 } } });
          }
          return json({});
        });
        const overview = page.getByTestId('token-stats-overview');
        const overviewCard = page.locator('[data-card-id="plugin:native:token-stats:token-stats-overview"]');
        const settle = () => page.evaluate(async () => {
          await document.fonts.ready;
          for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        });
        const measure = () => page.evaluate(() => ({
          rowHeight: document.querySelector<HTMLElement>('.dashboard-grid')?.style.getPropertyValue('--dashboard-row-height') ?? null,
          cards: [...document.querySelectorAll<HTMLElement>('.grid-stack-item, .dashboard-mobile-card')].map(card => ({
            id: card.dataset.cardId, height: card.getBoundingClientRect().height, y: card.getBoundingClientRect().y,
          })),
          overflow: [...document.querySelectorAll<HTMLElement>('.dashboard-kpi-card')].flatMap(card => {
            const metric = card.querySelector('.kpi-metric-row')?.getBoundingClientRect();
            const body = card.querySelector('.kpi-body')?.getBoundingClientRect();
            return metric && body && (metric.top < body.top - 1 || metric.bottom > body.bottom + 1) ? [card.textContent] : [];
          }),
        }));
        await page.goto(`${base}/#/`);
        // Initial GridStack registration, fonts and unrelated requests settle independently
        // of the held Token request. Do not sample an intermediate mount geometry.
        await expect(overview).toHaveAttribute('aria-busy', 'true');
        await settle();
        let previousGeometry = '', stableSamples = 0;
        await expect.poll(async () => {
          const geometry = JSON.stringify(await measure());
          stableSamples = geometry === previousGeometry ? stableSamples + 1 : 0;
          previousGeometry = geometry;
          return stableSamples;
        }, { intervals: [100], message: `${language}/${width}/${custom}: initial layout settles with Token request pending` })
          .toBeGreaterThanOrEqual(3);
        for (const [index, outcome] of ['success', 'empty', 'error'].entries()) {
          response = outcome as typeof response;
          if (index) {
            delayNext();
            await page.getByRole('radio', { name: index === 1 ? '12h' : '24h', exact: true }).click();
          }
          await expect(overview).toHaveAttribute('aria-busy', 'true');
          await expect(overview.getByRole('status')).toContainText(manifest.translations[language]['ui.loading']);
          await settle();
          const loading = await measure();
          expect(loading.overflow).toEqual([]);
          if (language === 'zh-CN' && !custom && outcome === 'success' && [390, 1440].includes(width)) {
            await page.screenshot({ path: `${evidence}/loading-${width}.png`, animations: 'disabled',
              clip: { x: 0, y: 0, width, height: width === 1440 ? 560 : 1000 } });
          }
          release();
          await expect(overview).toHaveAttribute('aria-busy', 'false');
          if (outcome === 'success') await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.2K');
          if (outcome === 'empty') await expect(overviewCard.getByTestId('token-stats-empty')).toBeVisible();
          if (outcome === 'error') await expect(overviewCard.getByRole('alert')).toBeVisible();
          await settle();
          const loaded = await measure();
          expect(loaded, `${language}/${width}/${custom}/${outcome}: loading and loaded geometry match`).toEqual(loading);
          results.push({ language, width, custom, outcome, rowHeight: loaded.rowHeight });
          if (language === 'zh-CN' && !custom && outcome === 'success' && [390, 1440].includes(width)) {
            await page.screenshot({ path: `${evidence}/loaded-${width}.png`, animations: 'disabled',
              clip: { x: 0, y: 0, width, height: width === 1440 ? 560 : 1000 } });
          }
        }
        // Retry after failure, then refresh cached data without replacing it with placeholders.
        const refresh = overviewCard.locator('header').getByRole('button', { name: manifest.translations[language]['ui.refresh'], exact: true });
        response = 'success'; delayNext();
        await refresh.click(); await expect(overview).toHaveAttribute('aria-busy', 'true');
        const retrying = await measure(); release();
        await expect(overview).toHaveAttribute('aria-busy', 'false');
        await expect(overviewCard.getByRole('alert')).toHaveCount(0);
        await settle(); expect(await measure()).toEqual(retrying);
        input = 1_900_000; delayNext();
        const cached = await page.getByTestId('token-stats-metric-input').textContent();
        await refresh.click(); await expect(overview).toHaveAttribute('aria-busy', 'true');
        expect(await page.getByTestId('token-stats-metric-input').textContent()).toBe(cached);
        const refreshing = await measure(); release();
        await expect(overview).toHaveAttribute('aria-busy', 'false');
        await expect(page.getByTestId('token-stats-metric-input')).toContainText('1.9M');
        await settle(); expect(await measure()).toEqual(refreshing);
        expect(requests).toBe(5); // Overview and trend share each request.
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        await context.close();
      }
    }
  }
  expect(errors).toEqual([]);
  writeFileSync(`${evidence}/report.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ cases: results.length, errors, evidence }));
} finally { await browser.close(); }
