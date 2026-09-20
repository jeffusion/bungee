/** Run: bun --cwd packages/ui tests/sandbox-bridge-browser.ts. */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import appConfig from '../vite.config';

const root = new URL('../', import.meta.url).pathname;
const server = await createServer({ ...appConfig, configFile: false, root,
  server: { host: '127.0.0.1', port: 5202, proxy: {} } });
await server.listen();
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as any).__sandboxProbes = [];
    window.addEventListener('message', event => {
      if (event.data?.type === 'sandbox-probe') (window as any).__sandboxProbes.push(event.data.generation);
    });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Content Security Policy|Refused to connect|violates the following Content Security Policy|Fetch API cannot load/.test(message.text())) errors.push(message.text()); });
  let controlCalls = 0;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/plugins/sandbox-plugin/index.html') {
      return route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'" },
        body: `<!doctype html><script>
          window.bridgeResult = new Promise(resolve => {
            window.addEventListener('message', event => {
              if (event.source !== parent || event.data?.type !== 'bungee:bridge-init' || event.ports.length !== 1) return;
              window.bridgeStarted = true; const port = event.ports[0], generation = event.data.generation, nonce = event.data.nonce;
              parent.postMessage({ type: 'sandbox-probe', generation }, '*');
              port.onmessage = message => { if (message.data?.type === 'bungee:theme') window.theme = message.data.theme; };
              port.start();
              Promise.all([
                fetch('/api/plugins/sandbox-plugin/control/allowed', { method: 'POST' }).then(() => 'unexpected').catch(() => 'blocked'),
                new Promise(done => { const id = crypto.randomUUID(); const receive = response => { if (response.data?.type === 'bungee:host-result' && response.data.id === id) { port.removeEventListener('message', receive); done(response.data); } }; port.addEventListener('message', receive); port.postMessage({ type: 'bungee:host-request', generation, nonce, id, action: 'control', path: '/allowed', method: 'POST', body: {} }); }),
                new Promise(done => { const id = crypto.randomUUID(); const receive = response => { if (response.data?.type === 'bungee:host-result' && response.data.id === id) { port.removeEventListener('message', receive); done(response.data); } }; port.addEventListener('message', receive); port.postMessage({ type: 'bungee:host-request', generation, nonce, id, action: 'open-external', url: 'https://attacker.example/' }); })
              ]).then(([fetchResult, control, policyDenied]) => resolve({ fetchResult, control, policyDenied, parentDocument: (() => { try { return parent.document; } catch { return 'blocked'; } })(), parentStorage: (() => { try { return parent.localStorage; } catch { return 'blocked'; } })(), frameElement: frameElement === null, sandboxMutation: (() => { try { if (!frameElement) throw new Error('opaque'); frameElement.setAttribute('sandbox', 'allow-same-origin'); return 'unexpected'; } catch { return 'blocked'; } })() }));
            });
          }).then(value => window.bridgeValue = value);
        </script>`,
      });
    }
    if (url.hostname === 'attacker.example') return route.fulfill({ contentType: 'text/html', body: '<script>window.bridgeStarted = false;</script>' });
    if (url.pathname === '/api/plugins/sandbox-plugin/sandbox') return route.fulfill({ json: {
      sandbox: 'allow-scripts', allowedHostActions: ['ui-context', 'copy-styles', 'control'], controlAllowlist: [{ path: '/allowed', methods: ['POST'] }],
    } });
    if (url.pathname === '/api/plugins') return route.fulfill({ json: [{ name: 'sandbox-plugin', enabled: true, metadata: { contributes: { api: [{ path: '/allowed', methods: ['POST'], handler: 'allowed', execution: 'control' }] } } }] });
    if (url.pathname === '/api/plugins/sandbox-plugin/control/allowed') { controlCalls++; return route.fulfill({ json: { ok: true } }); }
    return route.continue();
  });

  const base = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}/tests/fixtures/sandbox.html`;
  await page.goto(base);
  const frame = page.locator('iframe');
  await frame.waitFor();
  const child = page.frames().find(candidate => candidate !== page.mainFrame());
  assert(child, 'sandbox child frame was not created');
  await child!.waitForFunction(() => Boolean((window as any).bridgeValue), undefined, { timeout: 10000 });
  const result = await child!.evaluate(() => (window as any).bridgeValue);
  assert.equal(result.fetchResult, 'blocked');
  assert.deepEqual(result.control.result, { ok: true });
  assert.equal(result.policyDenied.error, '插件策略不允许此宿主操作');
  assert.equal(result.control.type, 'bungee:host-result');
  assert.equal(result.control.generation, 1);
  assert.equal(typeof result.control.nonce, 'string');
  assert.equal(typeof result.control.id, 'string');
  assert.equal(result.parentDocument, 'blocked');
  assert.equal(result.parentStorage, 'blocked');
  assert.equal(result.frameElement, true);
  assert.equal(result.sandboxMutation, 'blocked');
  assert.equal(controlCalls, 1);
  await page.evaluate(() => window.postMessage({ type: 'bungee:host-request', generation: 1, nonce: 'forged', id: 'window-forged', action: 'control', path: '/allowed', method: 'POST', body: {} }, '*'));
  await page.waitForTimeout(50);
  assert.equal(controlCalls, 1);
  assert.deepEqual(await page.evaluate(() => (window as any).__sandboxProbes), [1]);
  await frame.evaluate(element => { (element as HTMLIFrameElement).src = 'http://attacker.example/attacker.html'; });
  await page.waitForFunction(() => document.querySelector('iframe')?.src === 'http://attacker.example/attacker.html');
  await page.waitForTimeout(250);
  const reloadedChild = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url().includes('attacker.example'));
  assert.equal(await page.evaluate(() => (window as any).__sandboxProbes.length), 1);
  assert.equal(await reloadedChild!.evaluate(() => Boolean((window as any).bridgeStarted)), false);
  assert.equal(await page.getByRole('status', { name: 'Sandbox navigation blocked' }).count(), 1);
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
  assert.deepEqual(errors, []);
  console.log('PASS sandbox bridge: opaque iframe, blocked direct API, one manifest-allowed control request, no page/console errors');
} finally {
  await browser.close();
  await server.close();
}
