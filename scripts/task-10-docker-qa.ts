import { chromium, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE_ROOT = path.resolve(__dirname, '../');
const EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.omo/evidence/svelte5-shadcn');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 9088;
const BASE_URL = `http://localhost:${PORT}`;
const now = Date.now();
const cacheBust = `${now}`;

interface ErrorLog {
  message: string;
  stack?: string;
}

interface ConsoleLog {
  text: string;
  location: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface RequestFailureLog {
  url: string;
  errorText?: string;
}

interface PageResult {
  name: string;
  path: string;
  assertion: string;
  success: boolean;
  screenshot: string;
}

function addError(message: string, errors: ErrorLog[], stack?: string): void {
  errors.push({ message, stack });
}

function addConsoleError(text: string, location: ConsoleLog['location'], consoleErrors: ConsoleLog[]): void {
  consoleErrors.push({ text, location });
}

function addRequestFailure(url: string, errorText: string | undefined, requestFailures: RequestFailureLog[]): void {
  requestFailures.push({ url, errorText });
}

function assertPortSafety() {
  const includesForbidden = new URL(BASE_URL).port === '8088';
  if (includesForbidden) {
    throw new Error('Task 10 Docker QA must not use host port 8088');
  }
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'Unknown error';
}

function screenshotPath(label: string): string {
  return path.join(EVIDENCE_DIR, `task-10-${label}.png`);
}

async function waitForServer(url: string, timeoutMs = 120000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // keep waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for backend at ${url}`);
}

async function assertVisible(page: Page, selector: string): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 12000 });
    return true;
  } catch {
    return false;
  }
}

async function assertTextVisible(page: Page, text: string): Promise<boolean> {
  try {
    await page.getByText(text).first().waitFor({ state: 'visible', timeout: 12000 });
    return true;
  } catch {
    return false;
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

const requiredPages = [
  { name: 'design', route: '/__ui/?v=__BUST__#/design', selector: '[data-testid="page-design"]' },
  { name: 'dashboard', route: '/__ui/?v=__BUST__#/', selector: '[data-testid="page-dashboard"]' },
  { name: 'routes', route: '/__ui/?v=__BUST__#/routes', selector: '[data-testid="page-routes"]' },
  { name: 'services', route: '/__ui/?v=__BUST__#/services', selector: '[data-testid="page-services"]' },
  { name: 'logs', route: '/__ui/?v=__BUST__#/logs', selector: '[data-testid="page-logs"]' },
  { name: 'config', route: '/__ui/?v=__BUST__#/config', selector: '[data-testid="page-config"]' },
  { name: 'plugins', route: '/__ui/?v=__BUST__#/plugins', selector: '[data-testid="page-plugins"]' },
  { name: 'missing-route', route: '/__ui/?v=__BUST__#/missing-route', text: '404' },
  { name: 'login', route: '/__ui/?v=__BUST__#/login', selector: '#token-input' },
] as const;

const invalidLoginSelectors = [
  'input[type="text"]',
  'input[type="password"]',
  'button',
] as const;

async function main() {
  assertPortSafety();

  const pageErrors: ErrorLog[] = [];
  const consoleErrors: ConsoleLog[] = [];
  const requestFailures: RequestFailureLog[] = [];

  await waitForServer(`${BASE_URL}/__ui/`, 120000);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const page = await context.newPage();

  page.on('pageerror', (error) => {
    addError(error.message, pageErrors, error.stack);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      addConsoleError(msg.text(), msg.location(), consoleErrors);
    }
  });

  page.on('requestfailed', (request) => {
    addRequestFailure(request.url(), request.failure()?.errorText, requestFailures);
  });

  const results: PageResult[] = [];
  let hasFailure = false;

  try {
    for (const item of requiredPages) {
      const route = item.route.replace('__BUST__', cacheBust);
      const target = `${BASE_URL}${route}`;
      const filename = screenshotPath(item.name);

      await page.goto(target, { waitUntil: 'networkidle' });
      const assertion = 'selector' in item ? item.selector : `text:${item.text}`;
      const visible = 'selector' in item
        ? await assertVisible(page, item.selector)
        : await assertTextVisible(page, item.text);

      if (item.name === 'design' && visible) {
        await assertDesignPageContent(page);
      }

      await page.screenshot({ path: filename, fullPage: true });

      if (!visible) {
        addError(`Expected ${assertion} to be visible at ${target}`, pageErrors);
      }

      const result: PageResult = {
        name: item.name,
        path: route,
        assertion,
        success: visible,
        screenshot: `.omo/evidence/svelte5-shadcn/${path.basename(filename)}`,
      };

      if (!visible) hasFailure = true;
      results.push(result);
    }

    const loginUrl = `${BASE_URL}/__ui/${cacheBust}#/login`;
    await page.goto(loginUrl, { waitUntil: 'networkidle' });
    for (const selector of invalidLoginSelectors) {
      const first = page.locator(selector).first();
      if (await first.count()) {
        const tag = await first.evaluate((el) => el.tagName.toLowerCase());
        if (tag === 'input') {
          await first.fill('invalid');
        } else if (tag === 'button') {
          await first.click({ force: true }).catch(() => {});
        }
      }
    }

    await page.screenshot({ path: screenshotPath('failure-boundaries'), fullPage: true });

    if (pageErrors.length > 0 || consoleErrors.length > 0 || requestFailures.length > 0) {
      hasFailure = true;
    }
  } catch (err: unknown) {
    hasFailure = true;
    addError(`Fatal QA script error: ${extractErrorMessage(err)}`, pageErrors);
  } finally {
    await browser.close();
  }

  const report = {
    timestamp: now,
    baseUrl: BASE_URL,
    pageErrors,
    consoleErrors,
    requestFailures,
    pages: results,
    failureBoundaryScreenshot: '.omo/evidence/svelte5-shadcn/task-10-failure-boundaries.png',
    success: !hasFailure && pageErrors.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0,
  };

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'task-10-docker-browser.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  if (!report.success) {
    console.error('Task 10 Docker QA failed');
    process.exit(1);
  }

  console.log('Task 10 Docker QA completed successfully');
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
