import { chromium, type Page, type Route } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const WORKSPACE_ROOT = path.resolve(__dirname, '../');
const EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.omo/evidence/svelte5-shadcn');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 5185;
const baseUrl = `http://localhost:${PORT}`;
const now = Date.now();

interface BrowserLogLocation {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

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

const configResponse = {
  config_version: 1,
  port: 8088,
  workers: 2,
  log_level: 'info',
  auth: { enabled: false, tokens: [] },
  logging: { body: { enabled: true, retention_days: 7 } },
  routes: [
    {
      path: '/api/task-8',
      methods: ['GET', 'POST'],
      service: 'task-8-service',
      auth: { enabled: true },
      failover: { enabled: true, retry_on: [500, 502, 503] },
      path_rewrite: { '^/api/task-8': '/v1/task-8' },
    },
  ],
  services: [
    {
      name: 'task-8-service',
      endpoints: [
        { target: 'https://edge-a.example.test', status: 'HEALTHY', weight: 80, priority: 1, description: 'primary' },
        { target: 'https://edge-b.example.test', status: 'HALF_OPEN', weight: 20, priority: 2, description: 'recovery' },
      ],
    },
  ],
};

const routesResponse = [
  {
    path: '/api/task-8',
    methods: ['GET', 'POST'],
    service: 'task-8-service',
    auth: { enabled: true },
    failover: { enabled: true, retry_on: [500, 502, 503] },
    path_rewrite: { '^/api/task-8': '/v1/task-8' },
    plugins: [],
  },
  {
    path: '/api/custom-task-8',
    methods: ['POST'],
    endpoints: [
      { target: 'https://custom-a.example.test', status: 'HEALTHY', weight: 100, priority: 1 },
      { target: 'https://custom-b.example.test', status: 'UNHEALTHY', weight: 50, priority: 2 },
      { target: 'https://custom-c.example.test', status: 'HALF_OPEN', weight: 25, priority: 3 },
      { target: 'https://custom-d.example.test', status: 'HEALTHY', weight: 10, priority: 4 },
      { target: 'https://custom-e.example.test', status: 'HEALTHY', weight: 5, priority: 5 },
      { target: 'https://custom-f.example.test', status: 'HEALTHY', weight: 1, priority: 6 },
    ],
    transformer: 'openai-to-gemini',
    plugins: [],
  },
];

const servicesResponse = [
  {
    name: 'task-8-service',
    endpoints: [
      { target: 'https://edge-a.example.test', status: 'HEALTHY', weight: 80, priority: 1, description: 'primary' },
      { target: 'https://edge-b.example.test', status: 'HALF_OPEN', weight: 20, priority: 2, description: 'recovery' },
    ],
    health_check: { enabled: true, path: '/health', interval_ms: 30000 },
  },
];

const logEntries = [
  {
    id: 1,
    requestId: 'req-task-8-001',
    timestamp: now - 10000,
    method: 'GET',
    path: '/api/task-8',
    status: 200,
    duration: 72,
    routePath: '/api/task-8',
    upstream: 'https://edge-a.example.test',
    success: true,
    requestType: 'final',
    authSuccess: true,
    authLevel: 'none',
    reqHeaderId: 'req-h-8',
    respHeaderId: 'res-h-8',
    processingSteps: [{ step: 'route_match', timestamp: now - 10000, duration: 5 }],
  },
];

const dashboardHistory = {
  timestamps: [now - 240000, now - 180000, now - 120000, now - 60000, now],
  requests: [8, 13, 21, 34, 55],
  errors: [0, 0, 1, 0, 1],
  responseTime: [70, 76, 82, 78, 74],
  successRate: [100, 100, 95.2, 100, 98.1],
};

let configRequests = 0;
let routeRequests = 0;
let serviceRequests = 0;
let logRequests = 0;

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

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installApiMocks(page: Page): Promise<void> {
  await page.route('**/__ui/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace('/__ui/api', '');
    const method = request.method();

    if (pathname === '/config/validate' && method === 'POST') {
      await fulfillJson(route, { valid: true });
      return;
    }

    if (pathname === '/config') {
      configRequests += 1;
      if (method === 'PUT') {
        await fulfillJson(route, { success: true, message: 'saved' });
        return;
      }
      await fulfillJson(route, configResponse);
      return;
    }

    if (pathname === '/routes') {
      routeRequests += 1;
      await fulfillJson(route, routesResponse);
      return;
    }

    if (pathname === '/services') {
      serviceRequests += 1;
      await fulfillJson(route, servicesResponse);
      return;
    }

    if (pathname === '/plugins') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/plugins/schemas') {
      await fulfillJson(route, {});
      return;
    }

    if (pathname.startsWith('/logs/headers/')) {
      await fulfillJson(route, { accept: 'application/json', 'x-task': '8' });
      return;
    }

    if (pathname.startsWith('/logs')) {
      logRequests += 1;
      await fulfillJson(route, { data: logEntries, total: logEntries.length, page: 1, limit: 50, totalPages: 1 });
      return;
    }

    if (pathname === '/stats/history/v2') {
      await fulfillJson(route, dashboardHistory);
      return;
    }

    if (pathname === '/stats/upstream-stats') {
      await fulfillJson(route, { data: [{ upstream: 'https://edge-a.example.test', count: 42, percentage: 100, failedRequests: 0 }], type: 'all' });
      return;
    }

    if (pathname === '/stats/upstream-status-codes') {
      await fulfillJson(route, { data: [{ upstream: 'https://edge-a.example.test', status2xx: 40, status3xx: 1, status4xx: 1, status5xx: 0 }] });
      return;
    }

    if (pathname === '/logs/cleanup/config') {
      await fulfillJson(route, { enabled: false, retentionDays: 7, scheduleIntervalHours: 24, isActive: false });
      return;
    }

    await fulfillJson(route, {});
  });
}

async function assertVisible(page: Page, testId: string, timeout = 10000): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout });
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();
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
    consoleErrors.push({ text: msg.text(), location: msg.location() });
    console.error(`[BROWSER CONSOLE ERROR] ${msg.text()}`);
    hasFailure = true;
  }
});

page.on('requestfailed', (req) => {
  requestFailures.push({ url: req.url(), errorText: req.failure()?.errorText });
  console.error(`[REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText}`);
  hasFailure = true;
});

await installApiMocks(page);

try {
  console.log('Starting Task 8 browser QA...');

  await page.goto(`${baseUrl}/__ui/#/design`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-design');

  await page.goto(`${baseUrl}/__ui/#/routes`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-routes');
  await page.locator('[data-testid="route-rules-table"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.getByText('/api/custom-task-8').first().waitFor({ state: 'visible', timeout: 10000 });

  await page.goto(`${baseUrl}/__ui/#/services`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-services');
  await page.locator('[data-testid="service-card"]').first().waitFor({ state: 'visible', timeout: 10000 });

  await page.goto(`${baseUrl}/__ui/#/logs`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-logs');
  await assertVisible(page, 'logs-row-first');

  await page.goto(`${baseUrl}/__ui/#/config`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-config');
  await assertVisible(page, 'config-save-button');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-8-visual-regression.png'), fullPage: true });

  if (configRequests < 1) throw new Error('Expected config API request');
  if (routeRequests < 1) throw new Error('Expected routes API request');
  if (logRequests < 1) throw new Error('Expected logs API request');
} catch (err: unknown) {
  console.error('QA Script Error:', extractErrorMessage(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  hasFailure = true;
} finally {
  await browser.close();
  if (startedVite && viteProcess) {
    viteProcess.kill();
    console.log('Vite dev server stopped.');
  } else {
    console.log('Reused Vite dev server left running.');
  }

  const logData = {
    pageErrors,
    consoleErrors,
    requestFailures,
    success: pageErrors.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0 && !hasFailure,
    counters: {
      configRequests,
      routeRequests,
      serviceRequests,
      logRequests,
    },
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'task-8-browser.json'), JSON.stringify(logData, null, 2));
  console.log('QA Logs saved.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
}

console.log('Playwright verification completed successfully.');
process.exit(0);
