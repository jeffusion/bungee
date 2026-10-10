import { beforeAll, afterAll, afterEach, expect, test } from 'bun:test';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startUiRuntime } from '../../../../../../../tests/helpers/ui-runtime';

let runtime: Awaited<ReturnType<typeof startUiRuntime>>, browser: Browser;
beforeAll(async () => {
  runtime = await startUiRuntime(['tests/fixtures/components/body/index.html'], [
    { find: "$api/config", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/api-config.js", import.meta.url)) },
    { find: "$api/logs", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/api-logs.js", import.meta.url)) },
    { find: "$i18n", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/i18n.js", import.meta.url)) },
    { find: "$components/industrial", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/components-industrial.js", import.meta.url)) },
    { find: "./JsonBodyViewer.svelte", replacement: fileURLToPath(new URL("../../../../fixtures/components/body/JsonBodyViewer.svelte", import.meta.url)) },
  ]);
  try { browser = await chromium.launch(); } catch (error) { await runtime.close(); throw error; }
}, 120_000);
afterAll(async () => { try { await browser?.close(); } finally { await runtime?.close(); } });

const tabs = ['original', 'transformed', 'response'];
let cleanup = async () => {};
afterEach(async () => { await cleanup(); });

for (const scenario of ['config-failed', 'body-disabled', 'missing-ids'] as const) {
  for (const target of tabs) {
    test(`historical body: ${scenario}, ${target}`, async () => {
      let context: BrowserContext | undefined;
      let closing: Promise<void> | undefined;
      // Keep cleanup local: a timed-out test's finally must not close the next test.
      const close = () => closing ??= (async () => {
        await context?.close();
      })();
      cleanup = close;
      try {
        context = await browser.newContext();
        context.setDefaultTimeout(3000);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        const consoleMessages: string[] = [];
        page.on('console', message => {
          consoleMessages.push(`${message.type()}: ${message.text()}`);
          if (message.type() === 'error') errors.push(message.text());
        });
        await page.goto(`${runtime.origin}/tests/fixtures/components/body/index.html`);
        await page.waitForFunction(() => typeof (window as any).start === 'function');
        await page.evaluate((scenario) => {
          const fixture = window as any;
          fixture.scenario = scenario;
          fixture.start({
            requestId: 'test', timestamp: 0, method: 'POST', path: '/test', status: 200, duration: 1,
            ...(scenario === 'missing-ids' ? {} : {
              originalReqBodyId: 'original', reqBodyId: 'transformed', respBodyId: 'response',
            }),
            originalReqHeaderId: 'original', reqHeaderId: 'transformed', respHeaderId: 'response',
          });
        }, scenario);
        const visited = tabs.slice(0, tabs.indexOf(target) + 1);
        for (const tab of visited) {
          let phase = 'click';
          try {
            if (tab !== 'original') await page.locator(`[data-tab="${tab}"]`).click();
            phase = `header-${tab} and body`;
            await page.waitForFunction(({ tab, missing }) => {
              const root = document.querySelector('[data-testid="logs-detail-content"]');
              const body = root?.querySelector('[data-body]');
              return root?.textContent?.includes('header-' + tab)
                && (missing ? !body : body?.textContent?.includes('body-' + tab));
            }, { tab, missing: scenario === 'missing-ids' });
          } catch (error) {
            const dom = await page.locator('body').textContent().catch(() => '<unavailable>');
            throw new Error(`${scenario}, ${target}: ${tab} ${phase}\nDOM: ${dom}\nconsole: ${JSON.stringify(consoleMessages)}\npageerror: ${JSON.stringify(errors)}`, { cause: error });
          }
        }
        expect(await page.evaluate(() => (window as any).bodyCalls)).toEqual(
          scenario === 'missing-ids' ? [] : visited,
        );
        if (scenario === 'missing-ids') {
          expect(await page.locator('[data-body]').count()).toBe(0);
        } else {
          expect(await page.locator('[data-body]').textContent()).toContain('body-' + target);
        }
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 15000);
  }
}

test('all body tabs display new arrays and historical SSE text or wrappers as event/data arrays', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(3000);
  cleanup = async () => { await context.close(); };
  const expected = [{ event: 'named', data: { x: 1 } }, { event: 'message', data: '[DONE]' }];
  const cases = [
    { body: 'event: named\ndata: {"x":1}\n\ndata: [DONE]\n\n', contentType: 'text/event-stream', expected },
    { body: { kind: 'sse_messages', messages: [{ event: 'named', dataText: '{"x":1}' }, { done: true, dataText: '[DONE]' }] }, contentType: '', expected },
    { body: expected, contentType: 'text/event-stream', expected },
    { body: 'data: ordinary text\n\n', contentType: 'text/plain', expected: 'data: ordinary text\n\n' },
  ];
  for (const fixture of cases) {
    const page = await context.newPage();
    try {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${runtime.origin}/tests/fixtures/components/body/index.html`);
      await page.waitForFunction(() => typeof (window as any).start === 'function');
      await page.evaluate(({ body, contentType }) => {
        const fixture = window as any;
        fixture.contentType = contentType;
        fixture.sseBodies = { original: body, transformed: body, response: body };
        fixture.start({
          requestId: 'sse', timestamp: 0, method: 'POST', path: '/test', status: 200, duration: 1,
          originalReqBodyId: 'original', reqBodyId: 'transformed', respBodyId: 'response',
          originalReqHeaderId: 'original', reqHeaderId: 'transformed', respHeaderId: 'response',
        });
      }, fixture);
      for (const tab of tabs) {
        if (tab !== 'original') await page.locator(`[data-tab="${tab}"]`).click();
        await page.waitForFunction(({ tab, expected }) => {
          const fixture = window as any;
          return fixture.bodyCalls.includes(tab)
            && document.querySelector('[data-body]')?.textContent === JSON.stringify(expected);
        }, { tab, expected: fixture.expected });
        expect(JSON.parse((await page.locator('[data-body]').textContent())!)).toEqual(fixture.expected);
      }
      expect(await page.evaluate(() => (window as any).bodyCalls)).toEqual(tabs);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 15000);

test('historical response without Content-Type loads final Accept before display, even when opened first', async () => {
  const context = await browser.newContext();
  context.setDefaultTimeout(3000);
  cleanup = async () => { await context.close(); };
  const body = 'event: named\ndata: {"x":1}\n\ndata: [DONE]\n\n';
  for (const fixture of [
    { originalAccept: 'application/json', accept: 'text/event-stream', media: '', body, expected: [{ event: 'named', data: { x: 1 } }, { event: 'message', data: '[DONE]' }] },
    { originalAccept: 'text/event-stream', accept: 'application/json', media: '', body, expected: body },
    { originalAccept: 'text/event-stream', accept: 'text/event-stream', media: '', body: 'upstream failed', expected: 'upstream failed' },
    { originalAccept: 'text/event-stream', accept: 'text/event-stream', media: 'text/plain', body, expected: body },
    { originalAccept: 'text/event-stream', accept: null, media: '', body, expected: [{ event: 'named', data: { x: 1 } }, { event: 'message', data: '[DONE]' }] },
  ]) {
    const page = await context.newPage();
    try {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${runtime.origin}/tests/fixtures/components/body/index.html`);
      await page.waitForFunction(() => typeof (window as any).start === 'function');
      await page.evaluate(fixture => {
        const state = window as any;
        state.sseHeaders = { original: { Accept: fixture.originalAccept, 'Content-Type': 'application/json' },
          transformed: { ACCEPT: fixture.accept, 'content-type': 'application/json' },
          response: fixture.media ? { 'Content-Type': fixture.media } : {} };
        state.sseBodies = { original: { x: 1 }, transformed: { x: 1 }, response: fixture.body };
        state.start({ requestId: 'missing-type', timestamp: 0, method: 'POST', path: '/test', status: 200, duration: 1,
          originalReqHeaderId: 'original', ...(fixture.accept === null ? {} : { reqHeaderId: 'transformed' }),
          respHeaderId: 'response', respBodyId: 'response' });
      }, fixture);
      await page.locator('[data-tab="response"]').click();
      await page.waitForFunction(expected => document.querySelector('[data-body]')?.textContent === JSON.stringify(expected), fixture.expected);
      expect(JSON.parse((await page.locator('[data-body]').textContent())!)).toEqual(fixture.expected);
      expect(await page.evaluate(() => (window as any).bodyCalls)).toEqual(['response']);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }
}, 15000);
