import { afterAll, beforeAll } from 'bun:test';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { startUiRuntime } from '../../../../../tests/helpers/ui-runtime';

/** A test file owns its service/browser; each call owns a fresh context. */
export function dashboardRuntime(options: Parameters<typeof startUiRuntime>[0] = { mode: 'built-page' }) {
  let runtime: Awaited<ReturnType<typeof startUiRuntime>>;
  let browser: Browser;
  beforeAll(async () => {
    runtime = await startUiRuntime(options);
    try { browser = await chromium.launch({ headless: true }); }
    catch (error) { await runtime.close(); throw error; }
  }, 120_000);
  afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });
  return {
    get origin() { return runtime.origin; },
    async run<T>(body: (page: Page) => Promise<T>, options: BrowserContextOptions = {}) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ...options });
      try { return await body(await context.newPage()); }
      finally { await context.close(); }
    },
  };
}
