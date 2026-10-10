import { test as browserTest } from 'bun:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

browserTest('route editor target', async () => {
const dist = resolve(fileURLToPath(new URL('../../dist', import.meta.url)));
const evidence = process.env.BUNGEE_UI_EVIDENCE ?? `/tmp/bungee-route-target-${Date.now()}`;
const cases = ['new-custom', 'edit-service', 'edit-custom', 'service-first'];
const contentTypes: Record<string,string> = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

await mkdir(evidence, { recursive: true, mode: 0o700 });
type CaseResult = { name:string; status:string; requests:string[]; unhandledApi:string[]; writes:string[]; pageErrors:string[]; consoleErrors:string[]; requestFailed:string[]; screenshots:string[]; before?:string; after?:string; rendererResponsive?:number; coldNavigationStyle?:Awaited<ReturnType<typeof navigationStyle>>; returnNavigationStyle?:Awaited<ReturnType<typeof navigationStyle>>; servicePanelText?:string; styleIsolation?:{buttonDisplay:string;buttonFontSize:string;keyBorder:string}; error?:string;cleanupError?:string };
const report: {cases:CaseResult[];screenshots:string[];error?:string;cleanupError?:string} = {cases:[],screenshots:[]};
let browser: Browser | undefined;
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const file = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (req.method !== 'GET' || !file.startsWith(`${dist}/`)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});

const endpoint = (id:string, target:string) => ({ id, position: 0, target, priority: 1, weight: 100, is_disabled: false, plugins: [] });
const logical = {
  log_level: 'info', auth: { enabled: false, tokens: [] }, logging: {}, plugins: [],
  services: [{ id: 'service-fixture', position: 0, name: 'fixture-service',
    endpoints: [endpoint('service-endpoint', 'https://example.test')], plugins: [] }],
  routes: [
    { id: 'route-service', position: 0, path: '/fixture-service/', service_id: 'service-fixture', plugins: [] },
    { id: 'route-custom', position: 1, path: '/fixture-custom/', endpoints: [endpoint('custom-endpoint', 'https://example.test')], plugins: [] },
  ],
};

// Check computed styles in the split production build, where editor CSS is lazy-loaded.
const navigationStyle = async (page:Page, testId:string) => page.locator(`button[data-testid="${testId}"]`).evaluate((button:HTMLElement) => {
  const style = getComputedStyle(button);
  const keyStyle = getComputedStyle(button.closest('aside')!.querySelector('kbd')!);
  return {
    display: style.display, fullWidth: button.offsetWidth === button.parentElement!.clientWidth,
    alignItems: style.alignItems, fontSize: style.fontSize, color: style.color,
    backgroundColor: style.backgroundColor,
    keyDisplay: keyStyle.display, keyHeight: keyStyle.height, keyBorder: keyStyle.borderTopWidth,
  };
});

const assertNavigationStyle = (style:Awaited<ReturnType<typeof navigationStyle>>) => assert.deepEqual(style, {
  display: 'inline-flex', fullWidth: true, alignItems: 'center', fontSize: '11px',
  color: 'rgb(251, 146, 60)', backgroundColor: 'rgba(249, 115, 22, 0.08)',
  keyDisplay: 'flex', keyHeight: '18px', keyBorder: '1px',
});

try {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address=server.address();assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({headless:true,timeout:10_000});

  for (const name of cases) {
    const result:CaseResult = { name, status: 'running', requests: [], unhandledApi: [], writes: [],
      pageErrors: [], consoleErrors: [], requestFailed: [], screenshots: [] };
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (url.origin !== origin) {
          if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
          if (url.hostname === 'fonts.gstatic.com') return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
          result.unhandledApi.push(`${method} ${url.origin}${url.pathname}`);
          return route.abort('blockedbyclient');
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();

        const key = `${method} ${url.pathname}`;
        result.requests.push(key);
        let body;
        if (key === 'GET /api/auth/mode') body = { mode: 'anonymous', publicOrigin: origin };
        else if (key === 'GET /api/auth/verify') body = { success: true, mode: 'anonymous', subject: { id: 'anonymous', provider: 'anonymous' } };
        else if (key === 'GET /api/plugins') body = [];
        else if (key === 'GET /api/plugin-translations') body = {};
        else if (key === 'GET /api/config') body = { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: logical, plugin_activations: [] } };
        else if (key === 'GET /api/config/runtime') body = { revision: 1, content_hash: `sha256:${'a'.repeat(64)}`,
          config: { logical_configuration: logical, plugin_activations: [] }, workers: [],
          publication: { operation: null, recovery: null, retryable: false,
            serving_complete: false, serving_revision: null, target_revision: 1 } };
        else if (key === 'GET /api/runtime/upstreams') body = { workers: [], services: {}, availability: 'unknown', upstreams: [] };
        else if (key === 'POST /api/config/validate') body = { valid: true, errors: [] };
        else {
          result.unhandledApi.push(key);
          if (method !== 'GET') result.writes.push(key);
          return route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify({ error: 'unhandled_test_api' }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });

      const page = await context.newPage();
      page.setDefaultTimeout(4000);
      page.on('pageerror', error => result.pageErrors.push(error.stack ?? error.message));
      page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
      page.on('requestfailed', request => result.requestFailed.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));

      const serviceBacked = name === 'edit-service' || name === 'service-first';
      const path = name === 'new-custom' ? '/routes/new'
        : `/routes/edit/${encodeURIComponent(serviceBacked ? '/fixture-service/' : '/fixture-custom/')}`;
      const runtimeResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/runtime');
      await page.goto(`${origin}/#${name === 'service-first' ? '/services/edit/fixture-service' : path}`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      assert.equal((await runtimeResponse).status(), 200);
      if (name === 'service-first') {
        await page.locator('button[data-testid="service-nav-identity"]').waitFor({ state: 'visible' });
        assertNavigationStyle(await navigationStyle(page, 'service-nav-identity'));
        const servicePath = resolve(evidence, 'service-cold-entry.png');
        await page.screenshot({ path: servicePath });
        result.screenshots.push(servicePath);
        await page.evaluate(path => { window.location.hash = path; }, path);
      }
      const target = page.locator('button[data-testid="route-nav-target"]');
      await target.waitFor({ state: 'visible', timeout: 5000 });
      result.before = await page.locator('main').innerText({ timeout: 4000 });
      const beforePath = resolve(evidence, `${name}-before.png`);
      await page.screenshot({ path: beforePath, timeout: 5000 });
      result.screenshots.push(beforePath);

      result.coldNavigationStyle = await navigationStyle(page, 'route-nav-match');
      assert.ok((await page.locator('[data-testid="builder-nav"] kbd').allTextContents()).includes('1-8'));
      await page.keyboard.press('Control+8');
      await page.locator('[data-testid="section-review"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('button[data-testid="route-nav-review"]').getAttribute('aria-current'), 'page');
      await page.keyboard.press('Control+1');
      await page.locator('[data-testid="section-match"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => getComputedStyle(document.querySelector('button[data-testid="route-nav-match"]')!).color === 'rgb(251, 146, 60)');
      result.styleIsolation = await page.evaluate(() => {
        // Matching class names outside the component must not inherit its rules.
        const probe = document.createElement('div');
        probe.innerHTML = '<button class="nav-button is-active">Unrelated</button><kbd>Key</kbd>';
        document.body.append(probe);
        const button = getComputedStyle(probe.querySelector('button')!);
        const key = getComputedStyle(probe.querySelector('kbd')!);
        const result = { buttonDisplay: button.display, buttonFontSize: button.fontSize, keyBorder: key.borderTopWidth };
        probe.remove();
        return result;
      });
      assert.deepEqual(result.styleIsolation, { buttonDisplay: 'inline-block', buttonFontSize: '14px', keyBorder: '0px' });
      if (serviceBacked) {
        await page.evaluate(() => { window.location.hash = '/services/edit/fixture-service'; });
        await page.locator('button[data-testid="service-nav-identity"]').waitFor({ state: 'visible' });
        assertNavigationStyle(await navigationStyle(page, 'service-nav-identity'));
        assert.ok((await page.locator('[data-testid="service-builder-nav"] kbd').allTextContents()).includes('1-7'));
        await page.keyboard.press('Control+7');
        await page.locator('[data-testid="service-review-summary"]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('button[data-testid="service-nav-review"]').getAttribute('aria-current'), 'page');
        await page.evaluate(path => { window.location.hash = path; }, path);
        await target.waitFor({ state: 'visible' });
        result.returnNavigationStyle = await navigationStyle(page, 'route-nav-match');
        assert.deepEqual(result.coldNavigationStyle, result.returnNavigationStyle,
          'visiting ServiceEditor must not change RouteEditor navigation styles');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await target.waitFor({ state: 'visible' });
        assertNavigationStyle(await navigationStyle(page, 'route-nav-match'));
      }
      assertNavigationStyle(result.coldNavigationStyle);

      await target.hover();
      await page.waitForFunction(() => {
        const style = getComputedStyle(document.querySelector('button[data-testid="route-nav-target"]')!);
        return style.color === 'rgb(253, 186, 116)' && style.backgroundColor === 'rgba(249, 115, 22, 0.04)';
      });
      await target.click({ timeout: 4000, noWaitAfter: true });
      const targetPanel = page.locator('[data-testid="route-target-section"][data-testid-section="target"]');
      await targetPanel.waitFor({ state: 'visible', timeout: 4000 });
      assert.equal(await targetPanel.locator('[data-testid="mode-service"]').count(), 1);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('button[data-testid="route-nav-target"]')!).color === 'rgb(251, 146, 60)');
      assertNavigationStyle(await navigationStyle(page, 'route-nav-target'));
      await page.locator('button[data-testid="route-nav-match"]').click({ timeout: 4000 });
      await page.locator('[data-testid="section-match"]').waitFor({ state: 'visible', timeout: 4000 });
      await target.click({ timeout: 4000 });
      await targetPanel.waitFor({ state: 'visible', timeout: 4000 });

      if (serviceBacked) {
        result.servicePanelText = await targetPanel.locator('..').innerText();
        assert.ok(result.servicePanelText.toLowerCase().includes('fixture-service'));
        assert.ok((await targetPanel.innerText()).includes('https://example.test'));
        assert.match((await targetPanel.locator('[data-testid="mode-service"]').getAttribute('class'))!, /bg-nexus-500/);
      } else {
        assert.match((await targetPanel.locator('[data-testid="mode-custom"]').getAttribute('class'))!, /bg-nexus-500/);
        if (name === 'edit-custom') assert.ok((await targetPanel.innerText()).includes('https://example.test'));
      }

      if (name === 'new-custom') {
        const modeService = targetPanel.locator('[data-testid="mode-service"]');
        const modeCustom = targetPanel.locator('[data-testid="mode-custom"]');
        const confirmation = page.locator('[role="dialog"]');
        await modeService.click({ timeout: 4000 });
        await confirmation.waitFor({ state: 'visible', timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/);
        await modeService.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });
        await page.waitForTimeout(100);
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/, 'manual service selection without route.service must persist');
        await targetPanel.getByRole('button', { name: /fixture-service/ }).click({ timeout: 4000 });
        assert.ok((await targetPanel.innerText()).includes('https://example.test'));
        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-cancel"]').click({ timeout: 4000 });
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/);
        await modeCustom.click({ timeout: 4000 });
        await confirmation.locator('[data-testid="confirm-dialog-confirm"]').click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/);
        await modeService.click({ timeout: 4000 });
        assert.match((await modeService.getAttribute('class'))!, /bg-nexus-500/);
        await page.getByRole('button', { name: /使用模板/ }).click({ timeout: 4000 });
        await page.getByRole('button', { name: /Simple Proxy/ }).click({ timeout: 4000 });
        assert.match((await modeCustom.getAttribute('class'))!, /bg-nexus-500/, 'replacing route object must derive the new mode');
        assert.ok((await targetPanel.innerText()).includes('https://api.example.com'));
      }

      result.after = await targetPanel.innerText({ timeout: 4000 });
      result.rendererResponsive = await page.evaluate(() => 6 * 7);
      const afterPath = resolve(evidence, `${name}-after.png`);
      await page.screenshot({ path: afterPath, timeout: 5000 });
      result.screenshots.push(afterPath);
      assert.equal(result.rendererResponsive, 42);
      assert.ok(result.after.includes(serviceBacked ? 'https://example.test' : '自定义端点'));
      if (name === 'edit-service') {
        await page.evaluate(() => { window.location.hash = '/design'; });
        await page.locator('[data-testid="design-form-text-roles"]').waitFor({ state: 'visible' });
        const designPath = resolve(evidence, 'design-after-editors.png');
        await page.screenshot({ path: designPath });
        result.screenshots.push(designPath);
      }
      assert.equal(await page.locator('[data-testid="configuration-publication-banner"]').count(), 0);
      assert.deepEqual(result.unhandledApi, []);
      assert.deepEqual(result.writes, []);
      assert.deepEqual(result.pageErrors, []);
      assert.deepEqual(result.consoleErrors, []);
      assert.deepEqual(result.requestFailed, []);
      result.status = 'pass';
    } catch (error) {
      result.status = 'fail';
      result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    } finally {
      if (context) {
        try { await context.close(); }
        catch (error) {
          result.status = 'fail';
          result.cleanupError = error instanceof Error ? error.message : String(error);
        }
      }
      report.cases.push(result);
      console.log(JSON.stringify({ name, status: result.status, error: result.error, cleanupError: result.cleanupError,
        pageErrors: result.pageErrors.length, firstPageError: result.pageErrors[0], consoleErrors: result.consoleErrors.length,
        requestFailed: result.requestFailed.length, unhandledApi: result.unhandledApi, writes: result.writes, screenshots: result.screenshots }));
    }
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
} finally {
  try { await browser?.close(); } catch(error) { report.cleanupError=String(error); }
  if (server.listening) {
    try {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    } catch (error) {
      report.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const reportPath = resolve(evidence, 'report.json');
  try {
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`Evidence: ${reportPath}`);
  } catch (error) {
    report.cleanupError ??= error instanceof Error ? error.message : String(error);
  }
}

if (report.error || report.cleanupError || report.cases.length !== cases.length || report.cases.some(result => result.status !== 'pass')) {
  throw new Error('Route editor browser scenarios or cleanup failed; see captured report');
}
}, 240_000);
