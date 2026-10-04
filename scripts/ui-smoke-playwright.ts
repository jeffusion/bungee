import { chromium, type Page } from 'playwright';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { configurationRuntimeFixture, publicationFixture } from '../packages/ui/tests/fixtures/publication';

const WORKSPACE_ROOT = path.resolve(__dirname, '../');
const EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.omo/evidence/svelte5-shadcn/task-2-playwright');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

export const SELECTORS = {
  page: (name: string) => `page-${name}`,
  input: (domain: string, field: string) => `${domain}-${field}-input`,
  select: (domain: string, field: string) => `${domain}-${field}-select`,
  button: (domain: string, action: string) => `${domain}-${action}-button`,
  message: (domain: string, state: string) => `${domain}-${state}-message`,
};

export const PAGE_TEST_IDS = {
  design: 'page-design',
  dashboard: 'page-dashboard',
  routes: 'page-routes',
  services: 'page-services',
  logs: 'page-logs',
  config: 'page-config',
  plugins: 'page-plugins',
  login: 'page-login',
  notFound: 'page-not-found',
  publicationRecovery: 'dashboard-publication-recovery',
  publicationRetry: 'publication-retry-button',
};

export async function assertPageTestId(page: Page, testId: string): Promise<void> {
  const locator = page.locator(`[data-testid="${testId}"]`);
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  const isVisible = await locator.isVisible();
  if (!isVisible) {
    throw new Error(`Page test ID ${testId} is not visible.`);
  }
}

async function assertDesignPageContent(page: Page): Promise<void> {
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (/\bNx[A-Z][A-Za-z0-9_-]*\b/.test(bodyText)) {
    throw new Error('Expected /design visible content to exclude Nx* wrapper names.');
  }

  const dividerTitles = await page.locator('h2').evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent ?? '').trim()).filter(Boolean),
  );

  const colorIndex = dividerTitles.findIndex((text) => /COLOR SYSTEM/i.test(text));
  const basicIndex = dividerTitles.findIndex((text) => /BASIC COMPONENTS/i.test(text));
  const industrialIndex = dividerTitles.findIndex((text) => /INDUSTRIAL COMPONENTS/i.test(text));

  if (colorIndex === -1 || basicIndex === -1 || industrialIndex === -1) {
    throw new Error('Expected /design to visibly include Color System, Basic Components, and Industrial Components.');
  }

  if (!(colorIndex < basicIndex && basicIndex < industrialIndex)) {
    throw new Error('Expected /design visible section order to be Color System before Basic Components before Industrial Components.');
  }
}

const baseUrlArgIndex = process.argv.indexOf('--base-url');
const baseUrl = baseUrlArgIndex !== -1 ? process.argv[baseUrlArgIndex + 1] : 'http://localhost:5185';
const strictTestIds = process.argv.includes('--strict-testids');

if (baseUrl.includes(':8088')) {
  console.error('Error: Pre-final smoke test must never contact port 8088.');
  process.exit(1);
}

try {
  const res = await fetch(baseUrl);
  if (!res.ok && res.status !== 404) {
    throw new Error(`Server returned status ${res.status}`);
  }
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: Base URL ${baseUrl} is not reachable. Please start the Vite server first. Details: ${message}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

interface PageErrorLog {
  message: string;
  stack?: string;
}

interface ConsoleErrorLog {
  text: string;
  location: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface SmokeLogContext {
  timestamp: string;
  elapsedMs: number;
  caseName?: string;
  route?: string;
  actualUrl?: string;
}

interface FailedRequestLog extends SmokeLogContext { currentCase?: string; url: string; error?: string; resourceType: string; frameUrl?: string }
interface SmokeCaseContext { name: string; route: string }

interface SmokeTimelineEntry extends SmokeLogContext { event: string; detail?: string }

interface FailureDiagnosticPaths { caseName: string; route: string; actualUrl?: string; screenshotPath?: string; domTextPath?: string; domHtmlPath?: string; errors: string[] }

const pageErrors: PageErrorLog[] = [];
const consoleErrors: ConsoleErrorLog[] = [];
const failedRequests: FailedRequestLog[] = [];
const criticalFailures: FailedRequestLog[] = [];
const timeline: SmokeTimelineEntry[] = [];
const failureDiagnosticPaths: FailureDiagnosticPaths[] = [];
const smokeStartedAt = Date.now();
let activeCase: SmokeCaseContext | undefined;
const localAccountsManifest = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, 'plugins/local-accounts/manifest.json'), 'utf8'));
let protectedAuth = false;
let pluginSession = false;
let loginRequests = 0;

function currentPageUrl(): string | undefined {
  try {
    const url = page.url();
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

function recordTimeline(event: string, caseContext = activeCase, detail?: string): void {
  const actualUrl = currentPageUrl();
  timeline.push({
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - smokeStartedAt,
    event,
    ...(caseContext === undefined ? {} : { caseName: caseContext.name, route: caseContext.route }),
    ...(actualUrl === undefined ? {} : { actualUrl }),
    ...(detail === undefined ? {} : { detail }),
  });
}

async function assertVisibleTestId(testId: string, caseContext: SmokeCaseContext): Promise<void> {
  recordTimeline('visible_testid_assertion_start', caseContext, testId);
  try {
    await assertPageTestId(page, testId);
    recordTimeline('visible_testid_assertion_success', caseContext, testId);
  } catch (error) {
    recordTimeline('visible_testid_assertion_failure', caseContext, testId);
    throw error;
  }
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

async function captureFailureDiagnostics(caseContext: SmokeCaseContext): Promise<void> {
  const slug = safeSlug(caseContext.name);
  const actualUrl = currentPageUrl();
  const paths: FailureDiagnosticPaths = {
    caseName: caseContext.name,
    route: caseContext.route,
    ...(actualUrl === undefined ? {} : { actualUrl }),
    errors: [],
  };
  failureDiagnosticPaths.push(paths);

  const screenshotPath = path.join(EVIDENCE_DIR, `${slug}-failure.png`);
  try {
    await page.screenshot({ path: screenshotPath });
    paths.screenshotPath = path.relative(WORKSPACE_ROOT, screenshotPath);
  } catch (error) {
    paths.errors.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`);
  }

  const domTextPath = path.join(EVIDENCE_DIR, `${slug}-failure.txt`);
  try {
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    fs.writeFileSync(domTextPath, text, 'utf8');
    paths.domTextPath = path.relative(WORKSPACE_ROOT, domTextPath);
  } catch (error) {
    paths.errors.push(`dom_text: ${error instanceof Error ? error.message : String(error)}`);
  }

  const domHtmlPath = path.join(EVIDENCE_DIR, `${slug}-failure.html`);
  try {
    const html = await page.content();
    fs.writeFileSync(domHtmlPath, html, 'utf8');
    paths.domHtmlPath = path.relative(WORKSPACE_ROOT, domHtmlPath);
  } catch (error) {
    paths.errors.push(`dom_html: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isCriticalRequest(url: string): boolean {
  if (/\.(png|ico|svg|css|js|woff2|json)$/i.test(url)) {
    return false;
  }
  return true;
}

page.on('pageerror', (err) => {
  pageErrors.push({ message: err.message, stack: err.stack });
});

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push({ text: msg.text(), location: msg.location() });
  }
});

page.on('requestfailed', (req) => {
  const url = req.url();
  const error = req.failure()?.errorText;
  let frameUrl: string | undefined;
  try { frameUrl = req.frame().url(); } catch { /* Navigation failures can lack an available frame. */ }
  const actualUrl = currentPageUrl();
  const log: FailedRequestLog = {
    url,
    error,
    timestamp: new Date().toISOString(),
    elapsedMs: Date.now() - smokeStartedAt,
    ...(activeCase === undefined ? {} : { currentCase: activeCase.name, route: activeCase.route }),
    ...(actualUrl === undefined ? {} : { actualUrl }),
    resourceType: req.resourceType(),
    ...(frameUrl === undefined ? {} : { frameUrl }),
  };
  failedRequests.push(log);
  if (isCriticalRequest(url)) {
    criticalFailures.push(log);
  }
});

await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async (route) => {
  const url = route.request().url();
  const pathname = new URL(url).pathname;
  if (pathname === '/api/auth/mode') {
    await route.fulfill({ json: { mode: protectedAuth ? 'plugin' : 'anonymous', publicOrigin: new URL(url).origin,
      ...(protectedAuth ? { provider: { name: 'local-accounts', loginComponent: localAccountsManifest.management.loginComponent } } : {}) } });
  } else if (pathname === '/api/auth/verify') {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(protectedAuth
        ? { success: pluginSession, mode: 'plugin', ...(pluginSession ? { subject: { id: 'smoke-admin', provider: 'local-accounts' }, csrfToken: 'smoke-csrf' } : {}) }
        : { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } }),
    });
  } else if (pathname === '/api/auth/login') {
    assert.equal(route.request().method(), 'POST');
    assert.deepEqual(route.request().postDataJSON(), { username: 'smoke-admin', password: 'smoke-password', transport: 'cookie' });
    loginRequests++;
    pluginSession = true;
    await route.fulfill({ json: { success: true, mode: 'plugin', csrfToken: 'smoke-csrf' } });
  } else if (pathname === '/api/plugin-translations') {
    await route.fulfill({ json: Object.fromEntries(Object.entries(localAccountsManifest.translations)
      .map(([language, messages]) => [language, { plugins: { 'local-accounts': messages } }])) });
  } else if (new URL(url).pathname === '/api/config/runtime') {
    await route.fulfill({ json: configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
      retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 })) });
  } else if (new URL(url).pathname === '/api/runtime/upstreams') {
    await route.fulfill({ json: { schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
      availability: 'complete', reason: null, admission: { revision: 1 },
      workers: { observed: [], missing: [] }, upstreams: [] } });
  } else if (url.includes('/config')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        revision: 1,
        content_hash: 'smoke',
        config: {
          logical_configuration: {
            auth: { enabled: false, tokens: [] },
            routes: [],
            services: [],
            plugins: [],
          },
          plugin_activations: [],
        },
      }),
    });
  } else if (new URL(url).pathname === '/api/stats/dashboard') {
    const endTime = Date.now();
    await route.fulfill({ json: {
      startTime: endTime - 3_600_000, endTime, range: '1h',
      units: { history: 'request_chain', upstreams: 'upstream_attempt' },
      history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [] },
      upstreams: [],
    } });
  } else if (url.includes('/stats/history/v2')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [], errors: [], responseTime: [], timestamps: [] }),
    });
  } else if (url.includes('/stats/upstream-distribution')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0 }),
    });
  } else if (url.includes('/stats/upstream-failures')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  } else if (url.includes('/stats/upstream-status-codes')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  } else if (url.includes('/stats/upstream-stats')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], type: 'all' }),
    });
  } else if (url.includes('/logs/cleanup/config')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, retentionDays: 7, scheduleIntervalHours: 24, isActive: false }),
    });
  } else if (url.includes('/logs')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 }),
    });
  } else if (url.includes('/routes')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  } else if (url.includes('/services')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  } else if (url.includes('/plugins')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  } else {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  }
});

const routesToTest = [
  { path: '/#/design', name: 'design', testId: PAGE_TEST_IDS.design },
  { path: '/#/', name: 'dashboard', testId: PAGE_TEST_IDS.dashboard },
  { path: '/#/routes', name: 'routes', testId: PAGE_TEST_IDS.routes },
  { path: '/#/services', name: 'services', testId: PAGE_TEST_IDS.services },
  { path: '/#/logs', name: 'logs', testId: PAGE_TEST_IDS.logs },
  { path: '/#/config', name: 'config', testId: PAGE_TEST_IDS.config },
  { path: '/#/plugins', name: 'plugins', testId: PAGE_TEST_IDS.plugins },
  { path: '/#/login', name: 'anonymous-login', testId: PAGE_TEST_IDS.dashboard },
  { path: '/#/login', name: 'login', testId: PAGE_TEST_IDS.login },
  { path: '/#/unknown-route', name: 'not-found', testId: PAGE_TEST_IDS.notFound },
];

let hasFailure = false;
const missingTestIds: string[] = [];

for (const [caseIndex, r] of routesToTest.entries()) {
  const modeChanged = protectedAuth !== (r.name === 'login');
  protectedAuth = r.name === 'login';
  pluginSession = false;
  const targetUrl = `${baseUrl}${r.path}`;
  const caseContext: SmokeCaseContext = { name: r.name, route: r.path };
  if (caseIndex > 0) recordTimeline('next_case', caseContext);
  activeCase = caseContext;
  recordTimeline('case_begin');
  console.log(`Visiting: ${targetUrl}`);
  let caseFailed = false;
  
  try {
    recordTimeline('goto_begin', caseContext, targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    recordTimeline('goto_completed');
    // Hash navigation preserves App's auth store; reload when the fixture changes mode.
    if (modeChanged) {
      recordTimeline('reload_begin');
      await page.reload({ waitUntil: 'networkidle' });
      recordTimeline('reload_completed');
    }
    await page.waitForTimeout(1000);

    if (r.name === 'design') {
      await assertDesignPageContent(page);
    }
    
    if (strictTestIds) {
      await assertVisibleTestId(r.testId, caseContext);
      if (r.name === 'dashboard' && await page.getByTestId(PAGE_TEST_IDS.publicationRecovery).count() !== 0) {
        throw new Error('Healthy publication must not add a recovery alert.');
      }
    } else {
      const locator = page.locator(`[data-testid="${r.testId}"]`);
      recordTimeline('visible_testid_assertion_start', caseContext, r.testId);
      let isVisible: boolean;
      try {
        isVisible = await locator.isVisible();
      } catch (error) {
        recordTimeline('visible_testid_assertion_failure', caseContext, r.testId);
        throw error;
      }
      if (!isVisible) {
        console.warn(`Warning: Page test ID ${r.testId} is missing on ${r.name} (staging-safe mode).`);
        missingTestIds.push(r.testId);
      }
      recordTimeline(isVisible ? 'visible_testid_assertion_success' : 'visible_testid_assertion_failure', caseContext,
        isVisible ? r.testId : `${r.testId} missing (staging-safe warning)`);
    }
    
    const screenshotPath = path.join(EVIDENCE_DIR, `${r.name}.png`);
    await page.screenshot({ path: screenshotPath });
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (!bodyText || bodyText.trim().length === 0) {
      console.error(`Error: Page ${r.name} rendered empty body.`);
      hasFailure = true;
      caseFailed = true;
      recordTimeline('empty_body_validation_failure');
      recordTimeline('failure_diagnostics_begin');
      await captureFailureDiagnostics(caseContext);
      recordTimeline('failure_diagnostics_end');
    }
    if (r.name === 'login') {
      const form = page.getByTestId(PAGE_TEST_IDS.login).locator('form');
      await form.locator('input[autocomplete="username"]').fill('smoke-admin');
      await form.locator('input[autocomplete="current-password"]').fill('smoke-password');
      await form.getByRole('button').click();
      await assertVisibleTestId(PAGE_TEST_IDS.dashboard, caseContext);
      assert.equal(loginRequests, 1, 'The local-accounts login form must submit exactly once.');
      assert.equal(new URL(page.url()).hash, '#/', 'Successful provider login must return to the dashboard.');
    }
    recordTimeline('case_end', caseContext, caseFailed ? 'failure' : 'success');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error visiting ${r.name}: ${message}`);
    hasFailure = true;
    caseFailed = true;
    recordTimeline('case_failure', caseContext, message);
    recordTimeline('failure_diagnostics_begin');
    await captureFailureDiagnostics(caseContext);
    recordTimeline('failure_diagnostics_end');
    recordTimeline('case_end', caseContext, 'failure');
  }
}

recordTimeline('browser_close_begin');
await browser.close();
recordTimeline('browser_close_end');

const logData = {
  strictMode: strictTestIds,
  missingTestIds,
  pageErrors,
  consoleErrors,
  failedRequests,
  criticalFailures,
  timeline,
  failureDiagnosticPaths,
};

fs.writeFileSync(
  path.join(EVIDENCE_DIR, 'smoke-results.json'),
  JSON.stringify(logData, null, 2)
);

if (pageErrors.length > 0 || consoleErrors.length > 0 || criticalFailures.length > 0 || hasFailure) {
  for (const error of pageErrors) console.error(`Browser page error: ${error.stack ?? error.message}`);
  console.error('Smoke test failed with errors.');
  process.exit(1);
} else {
  console.log('Smoke test completed successfully.');
  process.exit(0);
}
