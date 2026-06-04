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

function baseConfig() {
  return {
    config_version: 1,
    port: 8088,
    workers: 2,
    log_level: 'info',
    body_parser_limit: '50mb',
    auth: { enabled: false, tokens: [] },
    logging: { body: { enabled: false, retention_days: 7 } },
    routes: [],
    services: [],
  };
}

const modelCatalog = {
  provider: '',
  source: 'stored',
  fetchedAt: Date.now(),
  models: [
    { value: 'gpt-4o', label: 'GPT-4o', provider: 'openai', description: 'OpenAI flagship' },
    { value: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet', provider: 'anthropic', description: 'Anthropic balanced model' },
  ],
};

const tokenStatsPlugin = {
  name: 'token-stats',
  version: '1.0.0',
  enabled: false,
  metadata: {
    name: 'Token Stats',
    description: 'Track token usage and costs',
    icon: 'analytics',
    contributes: { settings: '/settings', nativeWidgets: [{ id: 'token-stats-chart', title: 'Token Stats', size: 'medium', component: 'TokenStatsChart' }] },
  },
};

const modelMappingPlugin = {
  name: 'model-mapping',
  version: '1.0.0',
  enabled: true,
  metadata: {
    name: 'Model Mapping',
    description: 'Map model aliases through a managed catalog',
    icon: 'swap_horiz',
    contributes: { settings: '/catalog' },
  },
};

const tokenStatsSchema = {
  name: 'token-stats',
  version: '1.0.0',
  description: 'Track token usage and costs',
  metadata: tokenStatsPlugin.metadata,
  configSchema: [
    { name: 'apiKey', type: 'string', label: 'API Key', required: true, placeholder: 'Required API key' },
    { name: 'mode', type: 'select', label: 'Mode', required: false, options: [{ value: 'summary', label: 'Summary' }, { value: 'detailed', label: 'Detailed' }] },
    { name: 'mappings', type: 'model_mapping', label: 'Model mappings', required: false, catalogPlugin: 'model-mapping' },
  ],
};

let tokenStatsEnabled = false;
let pluginConfigSaveAttempts = 0;
let configSaveAttempts = 0;
let enabledSchemasRequests = 0;
let schemaRequestsBeforeEnable = 0;
let schemaRequestsAfterEnable = 0;

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

    if (pathname === '/routes') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/config') {
      if (method === 'PUT') {
        configSaveAttempts += 1;
        await fulfillJson(route, { success: true, message: 'saved' });
        return;
      }
      await fulfillJson(route, baseConfig());
      return;
    }

    if (pathname === '/plugins/schemas') {
      enabledSchemasRequests += url.searchParams.get('enabledOnly') === 'true' ? 1 : 0;
      if (url.searchParams.get('enabledOnly') === 'true') {
        if (tokenStatsEnabled) schemaRequestsAfterEnable += 1;
        else schemaRequestsBeforeEnable += 1;
        await fulfillJson(route, tokenStatsEnabled ? { 'token-stats': tokenStatsSchema } : {});
        return;
      }
      await fulfillJson(route, { 'token-stats': tokenStatsSchema });
      return;
    }

    if (pathname === '/plugins/token-stats/enable' && method === 'POST') {
      tokenStatsEnabled = true;
      await fulfillJson(route, { success: true });
      return;
    }

    if (pathname === '/plugins/token-stats/disable' && method === 'POST') {
      tokenStatsEnabled = false;
      await fulfillJson(route, { success: true });
      return;
    }

    if (pathname === '/plugins/token-stats/models') {
      await fulfillJson(route, modelCatalog);
      return;
    }

    if (pathname === '/plugins/model-mapping/models') {
      await fulfillJson(route, modelCatalog);
      return;
    }

    if (pathname === '/plugins/model-mapping/catalog') {
      await fulfillJson(route, {
        source: 'stored',
        fetchedAt: Date.now(),
        modelCount: modelCatalog.models.length,
        providerCount: 2,
        models: modelCatalog.models,
        providers: ['openai', 'anthropic'],
      });
      return;
    }

    if (pathname === '/plugins/model-mapping/catalog/refresh' && method === 'POST') {
      await fulfillJson(route, {
        source: 'stored',
        fetchedAt: Date.now(),
        modelCount: modelCatalog.models.length,
        providerCount: 2,
        models: modelCatalog.models,
        providers: ['openai', 'anthropic'],
      });
      return;
    }

    if (pathname === '/plugins') {
      await fulfillJson(route, [
        { ...tokenStatsPlugin, enabled: tokenStatsEnabled },
        modelMappingPlugin,
      ]);
      return;
    }

    if (pathname.startsWith('/plugins/') && pathname.endsWith('/sandbox')) {
      await fulfillJson(route, { sandbox: 'allow-scripts allow-same-origin' });
      return;
    }

    if (pathname === '/system/reload' || pathname === '/system/restart') {
      await fulfillJson(route, { success: true, message: 'ok' });
      return;
    }

    if (pathname.startsWith('/stats/') || pathname.startsWith('/logs')) {
      await fulfillJson(route, { data: [], total: 0, page: 1, limit: 10, totalPages: 0 });
      return;
    }

    await fulfillJson(route, {});
  });
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
  console.log('Starting Task 6 config QA...');
  await page.goto(`${baseUrl}/__ui/#/config`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="page-config"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="config-log-level-select"]').selectOption('debug');
  await page.locator('[data-testid="config-save-button"]').click();
  await page.waitForTimeout(500);
  if (configSaveAttempts !== 1) throw new Error(`Expected one config save, got ${configSaveAttempts}`);

  console.log('Starting Task 6 plugin management QA...');
  await page.goto(`${baseUrl}/__ui/#/plugins`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="page-plugins"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="plugin-search-input"]').fill('token-stats');
  const tokenCard = page.locator('[data-testid="plugin-card-token-stats"]');
  await tokenCard.waitFor({ state: 'visible', timeout: 8000 });
  if (tokenStatsEnabled) throw new Error('token-stats should start disabled in mocked plugin management state');
  const schemasBeforeEnable = await page.evaluate(async () => {
    const response = await fetch('/__ui/api/plugins/schemas?enabledOnly=true');
    return response.json();
  });
  if ('token-stats' in schemasBeforeEnable) throw new Error('token-stats schema must not be usable before plugin enablement');
  await tokenCard.locator('[data-testid="plugin-enable-toggle"]').click();
  await page.waitForTimeout(500);
  if (!tokenStatsEnabled) throw new Error('token-stats should become usable only after enable toggle');
  const schemasAfterEnable = await page.evaluate(async () => {
    const response = await fetch('/__ui/api/plugins/schemas?enabledOnly=true');
    return response.json();
  });
  if (!('token-stats' in schemasAfterEnable)) throw new Error('token-stats schema must become usable after plugin enablement');

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-6-config-plugin-happy.png'), fullPage: true });

  console.log('Starting Task 6 plugin config error QA...');
  await page.goto(`${baseUrl}/__ui/#/services/new`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="service-name-input"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('button', { hasText: /plugins|插件/i }).first().click();
  await page.locator('[data-testid="section-plugins"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="section-plugins"] button', { hasText: /add|添加/i }).first().click();
  await page.locator('#plugin-select').selectOption('token-stats');
  const requiredInput = page.locator('[data-testid="plugin-config-required-input"]').first();
  await requiredInput.waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="plugin-config-save-button"]').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('[data-testid="model-mapping-save-button"]').waitFor({ state: 'visible', timeout: 8000 });
  await requiredInput.fill('valid-token');
  await requiredInput.fill('');
  await page.locator('[data-testid="plugin-config-save-button"]').click({ force: true });
  await page.locator('[data-testid="plugin-config-validation-message"]').waitFor({ state: 'visible', timeout: 8000 });
  if (pluginConfigSaveAttempts !== 0) throw new Error(`Plugin config save should be blocked locally, got ${pluginConfigSaveAttempts} API attempts`);

  await page.screenshot({ path: path.join(EVIDENCE_DIR, 'task-6-plugin-error.png'), fullPage: true });

  if (schemaRequestsBeforeEnable < 1) throw new Error('Expected explicit enabled schema check before token-stats was enabled');
  if (schemaRequestsAfterEnable < 1) throw new Error('Expected enabled schema check after token-stats was enabled');
  if (enabledSchemasRequests < 2) throw new Error('Expected multiple enabled schema requests proving gating checks');
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
      configSaveAttempts,
      pluginConfigSaveAttempts,
      enabledSchemasRequests,
      schemaRequestsBeforeEnable,
      schemaRequestsAfterEnable,
      tokenStatsEnabled,
    },
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'task-6-browser.json'), JSON.stringify(logData, null, 2));
  console.log('QA Logs saved.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
}

console.log('Playwright verification completed successfully.');
process.exit(0);
