import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const WORKSPACE_ROOT = path.resolve(__dirname, '../');
const EVIDENCE_DIR = path.join(WORKSPACE_ROOT, '.omo/evidence/svelte5-shadcn');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 5185;
const baseUrl = `http://localhost:${PORT}`;

console.log('Starting Vite dev server on port', PORT);
const viteProcess = exec(`bun run dev --port ${PORT}`, { cwd: path.join(WORKSPACE_ROOT, 'packages/ui') });

await new Promise((resolve) => setTimeout(resolve, 3000));

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

const pageErrors: PageErrorLog[] = [];
const consoleErrors: ConsoleErrorLog[] = [];
let hasFailure = false;

function isIgnorableHmrConsoleError(text: string): boolean {
  return /WebSocket/i.test(text) && /ERR_CONNECTION_REFUSED/i.test(text);
}

page.on('pageerror', (err) => {
  pageErrors.push({ message: err.message, stack: err.stack });
  hasFailure = true;
});

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    if (isIgnorableHmrConsoleError(msg.text())) {
      return;
    }

    consoleErrors.push({
      text: msg.text(),
      location: {
        url: msg.location().url,
        lineNumber: msg.location().lineNumber,
        columnNumber: msg.location().columnNumber,
      },
    });
    hasFailure = true;
  }
});

try {
  const targetUrl = `${baseUrl}/__ui/#/design`;
  console.log(`Visiting: ${targetUrl}`);

  await page.route('**/__ui/api/**', async (route) => {
    const url = route.request().url();
    let body = '{}';
    if (url.includes('/plugins') || url.includes('/routes') || url.includes('/services')) {
      body = '[]';
    } else if (url.includes('/config')) {
      body = JSON.stringify({ routes: [], services: [] });
    } else if (url.includes('/logs')) {
      body = JSON.stringify({ data: [], total: 0, page: 1, limit: 10, totalPages: 0 });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body,
    });
  });

  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  const pageDesign = page.locator('[data-testid="page-design"]');
  await pageDesign.waitFor({ state: 'visible', timeout: 5000 });

  const primaryBtn = page.locator('[data-testid="design-button-primary"]');
  await primaryBtn.click();

  const basicInput = page.locator('[data-testid="design-input-basic"]');
  await basicInput.fill('Test Input Value');

  const selectTrigger = page.locator('[data-testid="design-select-trigger"]');
  await selectTrigger.click();
  await page.waitForTimeout(500);

  const option50 = page.locator('[data-testid="design-select-option-50"]');
  await option50.click();
  await page.waitForTimeout(500);

  const dialogTrigger = page.locator('[data-testid="design-dialog-trigger"]');
  await dialogTrigger.click();
  await page.waitForTimeout(500);

  const cancelBtn = page.locator('button:has-text("Cancel")');
  await cancelBtn.click();
  await page.waitForTimeout(500);

  const dropdownTrigger = page.locator('[data-testid="design-dropdown-trigger"]');
  await dropdownTrigger.click();
  await page.waitForTimeout(500);

  const screenshotPath = path.join(EVIDENCE_DIR, 'task-4-design-primitives.png');
  await page.screenshot({ path: screenshotPath });
  console.log('Screenshot captured at:', screenshotPath);

  const logData = {
    pageErrors,
    consoleErrors,
    success: pageErrors.length === 0 && consoleErrors.length === 0 && !hasFailure,
  };
  const jsonPath = path.join(EVIDENCE_DIR, 'task-4-design-primitives.json');
  fs.writeFileSync(jsonPath, JSON.stringify(logData, null, 2));
  console.log('JSON log saved at:', jsonPath);

} catch (err) {
  console.error('Error during Playwright execution:', err);
  hasFailure = true;
} finally {
  await browser.close();
  viteProcess.kill();
  console.log('Vite dev server stopped.');
}

if (hasFailure || pageErrors.length > 0 || consoleErrors.length > 0) {
  console.error('Playwright verification failed.');
  process.exit(1);
} else {
  console.log('Playwright verification completed successfully.');
  process.exit(0);
}
