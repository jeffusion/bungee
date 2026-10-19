import { afterAll, beforeAll, test } from 'bun:test';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { expect } from 'playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startUiRuntime } from '../helpers/ui-runtime';
import { configurationRuntimeFixture, publicationFixture } from '../../packages/ui/tests/helpers/publication';
import { menuSnapshot, fulfillMenuIcons } from '../../packages/ui/tests/helpers/menus';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>;
let browser: Browser;
const manifest = JSON.parse(await readFile(new URL('../../plugins/user-auth/manifest.json', import.meta.url), 'utf8'));
const configuration = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));

beforeAll(async () => {
  runtime = await startUiRuntime({ mode: 'built-page' });
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { await runtime.close(); throw error; }
});
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

async function withPage(name: string, hash: string, run: (page: Page, loginCount: () => number) => Promise<void>, protectedAuth = false) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: Request[] = [];
  let session = false;
  let loginRequests = 0;
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  page.on('requestfailed', request => errors.push(`Failed ${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request); });
  try {
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request();
      const url = new URL(request.url());
      const key = `${request.method()} ${url.pathname}`;
      switch (key) {
        case 'GET /api/auth/mode':
          return route.fulfill({ json: { mode: protectedAuth ? 'plugin' : 'anonymous', initialized: true, publicOrigin: url.origin,
            ...(protectedAuth ? { provider: { name: 'user-auth', loginComponent: manifest.management.loginComponent } } : {}) } });
        case 'GET /api/auth/verify':
          return route.fulfill({ json: protectedAuth
            ? { success: session, mode: 'plugin', ...(session ? { subject: { id: 'smoke-admin', provider: 'user-auth' }, csrfToken: 'smoke-csrf' } : {}) }
            : { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } } });
        case 'GET /api/auth/login/options':
          return route.fulfill({ json: { local: { enabled: true, turnstile: { enabled: false } }, methods: [] } });
        case 'POST /api/auth/login':
          assert.equal(protectedAuth, true);
          assert.deepEqual(request.postDataJSON(), { username: 'smoke-admin', password: 'smoke-password', transport: 'cookie' });
          session = true; loginRequests++;
          return route.fulfill({ json: { success: true, mode: 'plugin', csrfToken: 'smoke-csrf' } });
        case 'GET /api/ui/menus': return route.fulfill({ json: menuSnapshot() });
        case 'GET /api/ui/icons/data': return fulfillMenuIcons(route);
        case 'GET /api/plugin-translations':
          return route.fulfill({ json: Object.fromEntries(Object.entries(manifest.translations)
            .map(([language, messages]) => [language, { plugins: { 'user-auth': messages } }])) });
        case 'GET /api/config/runtime': return route.fulfill({ json: configuration });
        case 'GET /api/config': return route.fulfill({ json: { revision: configuration.revision, content_hash: configuration.content_hash, config: configuration.config } });
        case 'GET /api/runtime/upstreams': return route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
          availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] } });
        case 'GET /api/stats/dashboard': {
          const endTime = Date.now();
          return route.fulfill({ json: { startTime: endTime - 3_600_000, endTime, range: '1h', units: { history: 'request_chain', upstreams: 'upstream_attempt' },
            history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [] }, upstreams: [] } });
        }
        case 'GET /api/plugins': return route.fulfill({ json: [] });
        case 'GET /api/plugins/schemas': return route.fulfill({ json: {} });
        case 'GET /api/resources/api-key': return route.fulfill({ json: { keys: [] } });
        case 'GET /api/logs': return route.fulfill({ json: { data: [], total: 0, page: 1, limit: 50, totalPages: 0 } });
        case 'GET /api/logs/cleanup/config': return route.fulfill({ json: { enabled: false, retentionDays: 7, scheduleIntervalHours: 24, isActive: false } });
        default:
          errors.push(`Unexpected API: ${key}`);
          return route.fulfill({ status: 501, json: { error: 'unexpected_fixture_request' } });
      }
    });
    await page.goto(`${runtime.origin}/#${hash}`);
    await run(page, () => loginRequests);
    if (name === 'anonymous-login') await expect(page.getByTestId('app-header')).toHaveCount(0);
    else await page.waitForFunction(() => {
      const icons = [...document.querySelectorAll('[data-testid="app-header"] [data-menu-icon]')];
      return icons.length > 0 && icons.every(icon => icon.getAttribute('data-icon-state') === 'ready');
    });
    // Drain every observed request, including earlier icon revisions, before closing this context.
    for (let index = 0; index < requests.length; index++) {
      const response = await requests[index]!.response();
      assert.ok(response, `No response: ${requests[index]!.url()}`);
      assert.equal(await response.finished(), null, `Incomplete response: ${response.url()}`);
    }
    await page.evaluate(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.deepEqual(errors, []);
    if (name === 'dashboard' || name === 'login') {
      await page.screenshot({ path: join(runtime.evidence, `${name}.png`) });
      console.log(`UI smoke screenshots: ${runtime.evidence}`);
    }
  } catch (error) {
    await Promise.allSettled([
      page.screenshot({ path: join(runtime.evidence, `${name}-failure.png`) }),
      page.content().then(html => writeFile(join(runtime.evidence, `${name}-failure.html`), html)),
      writeFile(join(runtime.evidence, `${name}-errors.json`), JSON.stringify(errors, null, 2)),
    ]);
    console.error(`UI smoke diagnostics: ${runtime.evidence}`);
    throw error;
  } finally { await context.close(); }
}

const routes = [
  ['design', '/design', 'page-design'], ['dashboard', '/', 'page-dashboard'],
  ['routes', '/routes', 'page-routes'], ['services', '/services', 'page-services'],
  ['logs', '/logs', 'page-logs'], ['config', '/config', 'page-config'],
  ['plugins', '/plugins', 'page-plugins'], ['anonymous-login', '/login', 'page-dashboard'],
  ['not-found', '/unknown-route', 'page-not-found'],
] as const;
for (const [name, hash, testId] of routes) {
  test(`built route: ${name}`, async () => withPage(name, hash, async page => {
    await expect(page.getByTestId(testId)).toBeVisible();
    if (name === 'dashboard') await expect(page.getByTestId('dashboard-publication-recovery')).toHaveCount(0);
    if (name === 'design') {
      expect(await page.locator('body').innerText()).not.toMatch(/\bNx[A-Z][A-Za-z0-9_-]*\b/);
      const titles = await page.locator('h2').allTextContents();
      const indexes = [/COLOR SYSTEM/i, /BASIC COMPONENTS/i, /INDUSTRIAL COMPONENTS/i].map(pattern => titles.findIndex(title => pattern.test(title)));
      assert.ok(indexes[0]! >= 0 && indexes[0]! < indexes[1]! && indexes[1]! < indexes[2]!);
    }
  }), 60_000);
}

test('provider login hands a Cookie session to the built dashboard', async () => withPage('login', '/login', async (page, loginCount) => {
  const form = page.getByTestId('page-login').locator('form');
  await form.locator('input[autocomplete="username"]').fill('smoke-admin');
  await form.locator('input[autocomplete="current-password"]').fill('smoke-password');
  const verification = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/verify'
    && loginCount() === 1);
  await form.locator('button:not([type="button"])').click();
  const request = await verification;
  assert.equal(request.headers().authorization, undefined, 'Browser handoff must verify using its Cookie, without Bearer credentials.');
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/');
  expect(loginCount()).toBe(1);
}, true), 60_000);
