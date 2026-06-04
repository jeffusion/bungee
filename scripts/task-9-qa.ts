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
  return 'Unknown error';
}

async function assertDesignPageContentOrder(page: Page): Promise<void> {
  const bodyText = await page.evaluate(() => document.body.innerText);
  const nxVisibleWrapperPattern = /\bNx[A-Z][A-Za-z0-9_-]*\b/;
  if (nxVisibleWrapperPattern.test(bodyText)) {
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installApiMocks(page: Page): Promise<void> {
  await page.route('**/__ui/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname.replace('/__ui/api', '');

    if (pathname === '/plugins') {
      await fulfillJson(route, []);
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
    await sleep(3000);
  }

const browser = await chromium.launch({ headless: true });
const pageErrors: PageErrorLog[] = [];
const consoleErrors: ConsoleErrorLog[] = [];
const requestFailures: RequestFailureLog[] = [];
let hasFailure = false;

try {
  console.log('Starting Task 9 browser QA...');

  // 1. Desktop Viewport
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const desktopPage = await desktopContext.newPage();

  desktopPage.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
    console.error(`[DESKTOP BROWSER ERROR] ${err.message}`);
    hasFailure = true;
  });

  desktopPage.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
      console.error(`[DESKTOP BROWSER CONSOLE ERROR] ${msg.text()}`);
      hasFailure = true;
    }
  });

  desktopPage.on('requestfailed', (req) => {
    requestFailures.push({ url: req.url(), errorText: req.failure()?.errorText });
    console.error(`[DESKTOP REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText}`);
    hasFailure = true;
  });

  await installApiMocks(desktopPage);
  await desktopPage.goto(`${baseUrl}/__ui/#/design`, { waitUntil: 'networkidle' });

  await assertVisible(desktopPage, 'page-design', 20000);
  await assertVisible(desktopPage, 'design-section-ui-shadcn');
  await assertVisible(desktopPage, 'design-section-industrial-b');

  await assertDesignPageContentOrder(desktopPage);

  await desktopPage.screenshot({ path: path.join(EVIDENCE_DIR, 'task-9-design-desktop.png'), fullPage: true });
  await desktopContext.close();

  // 2. Mobile Viewport
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileContext.newPage();

  mobilePage.on('pageerror', (err) => {
    pageErrors.push({ message: err.message, stack: err.stack });
    console.error(`[MOBILE BROWSER ERROR] ${err.message}`);
    hasFailure = true;
  });

  mobilePage.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), location: msg.location() });
      console.error(`[MOBILE BROWSER CONSOLE ERROR] ${msg.text()}`);
      hasFailure = true;
    }
  });

  mobilePage.on('requestfailed', (req) => {
    requestFailures.push({ url: req.url(), errorText: req.failure()?.errorText });
    console.error(`[MOBILE REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText}`);
    hasFailure = true;
  });

  await installApiMocks(mobilePage);
  await mobilePage.goto(`${baseUrl}/__ui/#/design`, { waitUntil: 'networkidle' });

  await assertVisible(mobilePage, 'page-design', 20000);
  await assertVisible(mobilePage, 'design-section-ui-shadcn');
  await assertVisible(mobilePage, 'design-section-industrial-b');

  await assertDesignPageContentOrder(mobilePage);

  await mobilePage.screenshot({ path: path.join(EVIDENCE_DIR, 'task-9-design-mobile.png'), fullPage: true });
  await mobileContext.close();

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
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'task-9-browser.json'), JSON.stringify(logData, null, 2));
  console.log('QA Logs saved.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
}

console.log('Playwright verification completed successfully.');
process.exit(0);
