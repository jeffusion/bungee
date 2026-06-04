import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

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

interface FailedRequestLog {
  url: string;
  error?: string;
}

const pageErrors: PageErrorLog[] = [];
const consoleErrors: ConsoleErrorLog[] = [];
const failedRequests: FailedRequestLog[] = [];
const criticalFailures: FailedRequestLog[] = [];

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
  const log = { url, error };
  failedRequests.push(log);
  if (isCriticalRequest(url)) {
    criticalFailures.push(log);
  }
});

await page.route('**/__ui/api/**', async (route) => {
  const url = route.request().url();
  if (url.includes('/config')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ routes: [], services: [] }),
    });
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
  { path: '/#/login', name: 'login', testId: PAGE_TEST_IDS.login },
  { path: '/#/unknown-route', name: 'not-found', testId: PAGE_TEST_IDS.notFound },
];

let hasFailure = false;
const missingTestIds: string[] = [];

for (const r of routesToTest) {
  const targetUrl = `${baseUrl}/__ui${r.path}`;
  console.log(`Visiting: ${targetUrl}`);
  
  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    if (r.name === 'design') {
      await assertDesignPageContent(page);
    }
    
    if (strictTestIds) {
      await assertPageTestId(page, r.testId);
    } else {
      const locator = page.locator(`[data-testid="${r.testId}"]`);
      const isVisible = await locator.isVisible();
      if (!isVisible) {
        console.warn(`Warning: Page test ID ${r.testId} is missing on ${r.name} (staging-safe mode).`);
        missingTestIds.push(r.testId);
      }
    }
    
    const screenshotPath = path.join(EVIDENCE_DIR, `${r.name}.png`);
    await page.screenshot({ path: screenshotPath });
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (!bodyText || bodyText.trim().length === 0) {
      console.error(`Error: Page ${r.name} rendered empty body.`);
      hasFailure = true;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error visiting ${r.name}: ${message}`);
    hasFailure = true;
  }
}

await browser.close();

const logData = {
  strictMode: strictTestIds,
  missingTestIds,
  pageErrors,
  consoleErrors,
  failedRequests,
  criticalFailures,
};

fs.writeFileSync(
  path.join(EVIDENCE_DIR, 'smoke-results.json'),
  JSON.stringify(logData, null, 2)
);

if (pageErrors.length > 0 || consoleErrors.length > 0 || criticalFailures.length > 0 || hasFailure) {
  console.error('Smoke test failed with errors.');
  process.exit(1);
} else {
  console.log('Smoke test completed successfully.');
  process.exit(0);
}
