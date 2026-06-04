import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const WORKSPACE_ROOT = path.resolve(__dirname, '../');
const EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.omo/evidence/svelte5-shadcn');

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 5185;
const baseUrl = `http://localhost:${PORT}`;

interface BrowserLogLocation {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Unknown error';
}

async function isPortReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Vite at ${url}`);
}

let viteProcess: ReturnType<typeof exec> | null = null;
let startedVite = false;

if (await isPortReachable(baseUrl)) {
  console.log('Reusing existing Vite dev server on port', PORT);
} else {
  console.log('Starting Vite dev server on port', PORT);
  viteProcess = exec(`bun run dev --port ${PORT}`, { cwd: path.join(WORKSPACE_ROOT, 'packages/ui') });
  startedVite = true;
  await waitForServer(`${baseUrl}/__ui/`, 30000);
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
  location: BrowserLogLocation;
}

interface RequestFailureLog {
  url: string;
  errorText?: string;
}

const pageErrors: PageErrorLog[] = [];
const consoleErrors: ConsoleErrorLog[] = [];
const requestFailures: RequestFailureLog[] = [];
let hasFailure = false;

page.on('pageerror', (err) => {
  pageErrors.push({ message: err.message, stack: err.stack });
  console.error(`[BROWSER ERROR] ${err.message}`);
  hasFailure = true;
});

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push({
      text: msg.text(),
      location: {
        url: msg.location().url,
        lineNumber: msg.location().lineNumber,
        columnNumber: msg.location().columnNumber,
      },
    });
    console.error(`[BROWSER CONSOLE ERROR] ${msg.text()}`);
    hasFailure = true;
  }
});

page.on('requestfailed', (req) => {
  const url = req.url();
  const errorText = req.failure()?.errorText;
  requestFailures.push({ url, errorText });
  console.error(`[REQUEST FAILED] ${url} - ${errorText}`);
  hasFailure = true;
});

// Mock API endpoints
await page.route('**/__ui/api/**', async (route) => {
  const url = route.request().url();
  const method = route.request().method();
  
  if (url.includes('/config')) {
    if (method === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          routes: [],
          services: [
            {
              name: 'test-service',
              endpoints: [
                { target: 'http://localhost:8081', weight: 100, priority: 1 }
              ]
            }
          ]
        }),
      });
    }
  } else if (url.includes('/routes')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          path: '/health',
          service: 'test-service',
          methods: ['GET'],
          endpoints: [],
        },
      ]),
    });
  } else if (url.includes('/services')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          name: 'test-service',
          endpoints: [
            { target: 'http://localhost:8081', weight: 100, priority: 1 },
          ],
        },
      ]),
    });
  } else if (url.includes('/plugins')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
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
  } else {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  }
});

try {
  console.log('Starting Happy Path Route QA...');
  await page.goto(`${baseUrl}/__ui/#/routes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Assert page-routes and route-new-button
  const pageRoutes = page.locator('[data-testid="page-routes"]');
  await pageRoutes.waitFor({ state: 'visible', timeout: 5000 });
  
  const routeNewBtn = page.locator('[data-testid="route-new-button"]').first();
  await routeNewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await routeNewBtn.click();
  await page.waitForTimeout(1000);

  // Assert route-path-input
  const routePathInput = page.locator('[data-testid="route-path-input"]');
  await routePathInput.waitFor({ state: 'visible', timeout: 5000 });
  await routePathInput.fill('/s5-smoke');

  const routeNavTarget = page.locator('[data-testid="route-nav-target"]');
  await routeNavTarget.waitFor({ state: 'visible', timeout: 5000 });
  await routeNavTarget.click();
  await page.waitForTimeout(500);

  const modeServiceBtn = page.locator('[data-testid="mode-service"]');
  await modeServiceBtn.waitFor({ state: 'visible', timeout: 5000 });
  await modeServiceBtn.click();
  await page.waitForTimeout(500);

  const confirmBtn = page.locator('[data-testid="confirm-dialog-confirm"]');
  await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(500);

  // Assert route-service-select
  const routeServiceSelect = page.locator('[data-testid="route-service-select"]');
  await routeServiceSelect.waitFor({ state: 'visible', timeout: 5000 });
  await routeServiceSelect.selectOption('test-service');
  await page.waitForTimeout(500);

  const modeCustomBtn = page.locator('[data-testid="mode-custom"]');
  await modeCustomBtn.waitFor({ state: 'visible', timeout: 5000 });
  await modeCustomBtn.click();
  await page.waitForTimeout(500);

  await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
  await confirmBtn.click();
  await page.waitForTimeout(500);

  // Assert route-upstream-add-button
  const routeUpstreamAddBtn = page.locator('[data-testid="route-upstream-add-button"]');
  await routeUpstreamAddBtn.waitFor({ state: 'visible', timeout: 5000 });
  await routeUpstreamAddBtn.click();
  await page.waitForTimeout(500);

  // Assert route-upstream-url-input
  const routeUpstreamUrlInput = page.locator('[data-testid="route-upstream-url-input"]');
  await routeUpstreamUrlInput.waitFor({ state: 'visible', timeout: 5000 });
  await routeUpstreamUrlInput.fill('https://example.com');

  // Assert route-upstream-weight-input
  const routeUpstreamWeightInput = page.locator('[data-testid="route-upstream-weight-input"]');
  await routeUpstreamWeightInput.waitFor({ state: 'visible', timeout: 5000 });
  await routeUpstreamWeightInput.fill('10');

  // Assert route-upstream-priority-input
  const routeUpstreamPriorityInput = page.locator('[data-testid="route-upstream-priority-input"]');
  await routeUpstreamPriorityInput.waitFor({ state: 'visible', timeout: 5000 });
  await routeUpstreamPriorityInput.fill('1');

  const upstreamModalSaveBtn = page.locator('[data-testid="upstream-modal-save"]');
  await upstreamModalSaveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await upstreamModalSaveBtn.click();
  await page.waitForTimeout(500);

  // Click save
  const routeSaveBtn = page.locator('[data-testid="route-save-button"]');
  await routeSaveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await routeSaveBtn.click();
  await page.waitForTimeout(1000);

  // Take happy path screenshot
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-5-route-happy.png') });
  console.log('Happy Path Route QA completed.');

  console.log('Starting Error Path Route QA...');
  await page.goto(`${baseUrl}/__ui/#/routes/new`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Leave path empty and click save to trigger validation
  await routeSaveBtn.click({ force: true });
  await page.waitForTimeout(1000);

  // Click validation toggle to show details
  const routeValidationToggle = page.locator('[data-testid="route-validation-toggle"]');
  await routeValidationToggle.waitFor({ state: 'visible', timeout: 5000 });
  await routeValidationToggle.click();
  await page.waitForTimeout(500);

  // Assert route-validation-message
  const routeValidationMsg = page.locator('[data-testid="route-validation-message"]');
  await routeValidationMsg.waitFor({ state: 'visible', timeout: 5000 });

  // Take error path screenshot
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-5-route-error.png') });
  console.log('Error Path Route QA completed.');

  console.log('Starting Happy Path Service QA...');
  await page.goto(`${baseUrl}/__ui/#/services`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Assert page-services and service-new-button
  const pageServices = page.locator('[data-testid="page-services"]');
  await pageServices.waitFor({ state: 'visible', timeout: 5000 });

  const serviceNewBtn = page.locator('[data-testid="service-new-button"]').first();
  await serviceNewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await serviceNewBtn.click();
  await page.waitForTimeout(1000);

  // Assert service-name-input
  const serviceNameInput = page.locator('[data-testid="service-name-input"]');
  await serviceNameInput.waitFor({ state: 'visible', timeout: 5000 });
  await serviceNameInput.fill('test-service');

  const serviceNavEndpoints = page.locator('[data-testid="service-nav-endpoints"]');
  await serviceNavEndpoints.waitFor({ state: 'visible', timeout: 5000 });
  await serviceNavEndpoints.click();
  await page.waitForTimeout(500);

  // Click add upstream
  await routeUpstreamAddBtn.click();
  await page.waitForTimeout(500);

  // Assert service-endpoint-url-input
  const serviceEndpointUrlInput = page.locator('[data-testid="service-endpoint-url-input"]');
  await serviceEndpointUrlInput.waitFor({ state: 'visible', timeout: 5000 });
  await serviceEndpointUrlInput.fill('https://example.com');

  await upstreamModalSaveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await upstreamModalSaveBtn.click();
  await page.waitForTimeout(500);

  // Click save
  const serviceSaveBtn = page.locator('[data-testid="service-save-button"]');
  await serviceSaveBtn.waitFor({ state: 'visible', timeout: 5000 });
  await serviceSaveBtn.click();
  await page.waitForTimeout(1000);

  // Take service happy path screenshot
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-5-service-happy.png') });
  console.log('Happy Path Service QA completed.');

} catch (err: unknown) {
  console.error('QA Script Error:', extractErrorMessage(err));
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  hasFailure = true;
} finally {
  await browser.close();
  if (startedVite && viteProcess) {
    viteProcess.kill();
    console.log('Vite dev server stopped.');
  } else {
    console.log('Reused Vite dev server left running.');
  }
  
  // Save logs
  const logData = {
    pageErrors,
    consoleErrors,
    requestFailures,
    success: pageErrors.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0 && !hasFailure,
  };
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'task-5-browser.json'),
    JSON.stringify(logData, null, 2)
  );
  console.log('QA Logs saved.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
} else {
  console.log('Playwright verification completed successfully.');
  process.exit(0);
}
