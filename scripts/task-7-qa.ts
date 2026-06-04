import { chromium, type Page, type Route } from 'playwright';
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

type LogMode = 'normal' | 'empty';

let logMode: LogMode = 'normal';
let dashboardVisits = 0;
let logsRequests = 0;
let tokenStatsRequests = 0;

const now = Date.now();

const dashboardHistory = {
  timestamps: [now - 240000, now - 180000, now - 120000, now - 60000, now],
  requests: [18, 24, 31, 42, 55],
  errors: [0, 1, 0, 2, 1],
  responseTime: [82, 91, 76, 88, 95],
  successRate: [100, 95.8, 100, 95.2, 98.1],
};

const configResponse = {
  config_version: 1,
  port: 8080,
  workers: 2,
  log_level: 'info',
  auth: { enabled: false, tokens: [] },
  logging: { body: { enabled: true, retention_days: 7 } },
  routes: [
    { path: '/api/chat', methods: ['GET', 'POST'], service: 'llm-edge' },
  ],
  services: [
    {
      name: 'llm-edge',
      endpoints: [
        { target: 'https://edge-a.example.test', status: 'HEALTHY', weight: 80, priority: 1 },
        { target: 'https://edge-b.example.test', status: 'HALF_OPEN', weight: 20, priority: 2 },
      ],
    },
  ],
};

const routesResponse = [
  { path: '/api/chat', methods: ['GET', 'POST'], service: 'llm-edge', plugins: [] },
];

const pluginsResponse = [
  {
    name: 'token-stats',
    version: '2.0.0',
    enabled: true,
    metadata: {
      name: 'Token Statistics',
      description: 'Track token usage by route and upstream',
      icon: 'bar_chart',
      contributes: {
        nativeWidgets: [
          { id: 'token-stats-chart', title: 'widgets.chart.title', size: 'medium', component: 'TokenStatsChart', props: {} },
        ],
      },
    },
  },
];

const logEntries = [
  {
    id: 1,
    requestId: 'req-task7-001',
    timestamp: now - 10000,
    method: 'GET',
    path: '/api/chat',
    query: 'trace=1',
    status: 200,
    duration: 87,
    routePath: '/api/chat',
    upstream: 'https://edge-a.example.test',
    transformer: 'openai-to-gemini',
    processingSteps: [
      { step: 'route_match', timestamp: now - 10000, duration: 8 },
      { step: 'upstream_selected', timestamp: now - 9992, duration: 12, detail: { target: 'edge-a', plugins: ['token-stats'] } },
      { step: 'response_complete', timestamp: now - 9980, duration: 67 },
    ],
    authSuccess: true,
    authLevel: 'none',
    success: true,
    requestType: 'final',
    reqHeaderId: 'req-h-1',
    respHeaderId: 'res-h-1',
  },
  {
    id: 2,
    requestId: 'req-task7-002',
    timestamp: now - 25000,
    method: 'POST',
    path: '/api/chat',
    status: 503,
    duration: 142,
    routePath: '/api/chat',
    upstream: 'https://edge-b.example.test',
    processingSteps: [{ step: 'retry_recovery', timestamp: now - 25000, duration: 142, detail: { level: 'warn' } }],
    authSuccess: true,
    success: false,
    requestType: 'retry',
    errorMessage: 'upstream temporarily unavailable',
  },
];

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

function filteredLogs(url: URL) {
  if (logMode === 'empty') {
    return { data: [], total: 0, page: 1, limit: 50, totalPages: 0 };
  }

  const method = url.searchParams.get('method');
  const searchTerm = url.searchParams.get('searchTerm')?.toLowerCase() ?? '';
  const data = logEntries.filter((entry) => {
    if (method && entry.method !== method) return false;
    if (searchTerm && !entry.path.toLowerCase().includes(searchTerm)) return false;
    return true;
  });

  return { data, total: data.length, page: 1, limit: 50, totalPages: data.length > 0 ? 1 : 0 };
}

async function installApiMocks(page: Page): Promise<void> {
  await page.route('**/__ui/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace('/__ui/api', '');

    if (pathname === '/config') {
      await fulfillJson(route, configResponse);
      return;
    }

    if (pathname === '/routes') {
      await fulfillJson(route, routesResponse);
      return;
    }

    if (pathname === '/plugins') {
      await fulfillJson(route, pluginsResponse);
      return;
    }

    if (pathname.startsWith('/plugins/') && pathname.endsWith('/sandbox')) {
      await fulfillJson(route, { sandbox: 'allow-scripts allow-same-origin' });
      return;
    }

    if (pathname === '/plugins/token-stats/stats') {
      tokenStatsRequests += 1;
      await fulfillJson(route, {
        groupBy: url.searchParams.get('groupBy') || 'route',
        totalInputTokens: 12840,
        totalOutputTokens: 9560,
        logicalRequests: 32,
        upstreamAttempts: 35,
        authorityBreakdown: {
          input: { official: 9800, local: 3040, heuristic: 0, partial: 0, none: 0 },
          output: { official: 7220, local: 2340, heuristic: 0, partial: 0, none: 0 },
        },
        data: [
          {
            dimension: '/api/chat',
            inputTokens: 7200,
            outputTokens: 5300,
            officialInputTokens: 6200,
            officialOutputTokens: 4800,
            partialOutputs: 0,
            logicalRequests: 18,
            upstreamAttempts: 20,
            authorityBreakdown: { input: { official: 6200, local: 1000, heuristic: 0, partial: 0, none: 0 }, output: { official: 4800, local: 500, heuristic: 0, partial: 0, none: 0 } },
          },
          {
            dimension: '/v1/messages',
            inputTokens: 5640,
            outputTokens: 4260,
            officialInputTokens: 3600,
            officialOutputTokens: 2420,
            partialOutputs: 1,
            logicalRequests: 14,
            upstreamAttempts: 15,
            authorityBreakdown: { input: { official: 3600, local: 2040, heuristic: 0, partial: 0, none: 0 }, output: { official: 2420, local: 1840, heuristic: 0, partial: 0, none: 0 } },
          },
        ],
      });
      return;
    }

    if (pathname === '/stats/history/v2') {
      await fulfillJson(route, dashboardHistory);
      return;
    }

    if (pathname === '/stats/upstream-stats') {
      await fulfillJson(route, {
        data: [
          { upstream: 'https://edge-a.example.test', count: 80, percentage: 72, failedRequests: 2 },
          { upstream: 'https://edge-b.example.test', count: 31, percentage: 28, failedRequests: 5 },
        ],
        type: url.searchParams.get('type') || 'all',
      });
      return;
    }

    if (pathname === '/stats/upstream-status-codes') {
      await fulfillJson(route, {
        data: [
          { upstream: 'https://edge-a.example.test', status2xx: 75, status3xx: 3, status4xx: 1, status5xx: 1 },
          { upstream: 'https://edge-b.example.test', status2xx: 24, status3xx: 1, status4xx: 1, status5xx: 5 },
        ],
      });
      return;
    }

    if (pathname === '/logs/headers/req-h-1') {
      await fulfillJson(route, { accept: 'application/json', 'x-request-id': 'req-task7-001' });
      return;
    }

    if (pathname === '/logs/headers/res-h-1') {
      await fulfillJson(route, { 'content-type': 'application/json' });
      return;
    }

    if (pathname.startsWith('/logs')) {
      logsRequests += 1;
      await fulfillJson(route, filteredLogs(url));
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
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
  console.log('Starting Task 7 dashboard/widget QA...');
  dashboardVisits += 1;
  await page.goto(`${baseUrl}/__ui/#/`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-dashboard');
  await assertVisible(page, 'dashboard-kpi-total-requests');
  await assertVisible(page, 'dashboard-chart-traffic');
  await assertVisible(page, 'plugin-widget-token-stats');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-7-dashboard-logs.png'), fullPage: true });

  console.log('Starting Task 7 logs happy QA...');
  logMode = 'normal';
  await page.goto(`${baseUrl}/__ui/#/logs`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'page-logs');
  await assertVisible(page, 'logs-filter-path-input');
  await page.locator('[data-testid="logs-filter-path-input"]').fill('/api/chat');
  await page.locator('[data-testid="logs-filter-method-select"]').click();
  await page.getByRole('menuitem', { name: 'GET' }).click();
  await assertVisible(page, 'logs-row-first');
  await page.locator('[data-testid="logs-row-first"] button').click();
  await assertVisible(page, 'logs-detail-modal');
  await page.locator('[data-testid="logs-detail-modal"] button[aria-label]').click();
  await page.locator('[data-testid="logs-detail-modal"]').waitFor({ state: 'detached', timeout: 8000 });

  console.log('Starting Task 7 empty/widget QA...');
  logMode = 'empty';
  await page.locator('[data-testid="logs-filter-path-input"]').fill('/no-match-task-7');
  await assertVisible(page, 'logs-empty-state');
  await page.goto(`${baseUrl}/__ui/#/`, { waitUntil: 'networkidle' });
  await assertVisible(page, 'plugin-widget-token-stats');
  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-7-empty-widget.png'), fullPage: true });

  if (tokenStatsRequests < 1) throw new Error('Expected token-stats native widget API request');
  if (logsRequests < 2) throw new Error('Expected logs API requests for normal and empty paths');
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
      dashboardVisits,
      logsRequests,
      tokenStatsRequests,
    },
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'task-7-browser.json'), JSON.stringify(logData, null, 2));
  console.log('QA Logs saved.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
}

console.log('Playwright verification completed successfully.');
process.exit(0);
