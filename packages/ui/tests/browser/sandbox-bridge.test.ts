import { test as browserTest } from 'bun:test';
import assert from 'node:assert/strict';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';
import { chromium, expect, type Request } from 'playwright/test';

browserTest('sandbox bridge', async () => {
const uiRuntime = await startUiRuntime({ mode: 'component-fixture', entries: ['tests/fixtures/sandbox.html'] });
let releasePending = () => {};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    (window as any).__sandboxProbes = [];
    window.addEventListener('message', event => {
      if (event.data?.type === 'sandbox-probe') (window as any).__sandboxProbes.push(event.data.generation);
    });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const cspMessages = new Set<string>();
  let directFetchFailure = false;
  let expectedRevocation: Request | undefined;
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const category = text.includes('Fetch API cannot load') ? 'fetch' : text.includes('connect-src') ? 'connect' : '';
    if (category && text.includes('/api/plugins/sandbox-plugin/control/allowed') && /Content Security Policy|Refused to connect/.test(text) && !cspMessages.has(category)) { cspMessages.add(category); return; }
    errors.push(`${message.location().url}: ${text}`);
  });
  page.on('requestfailed', request => {
    if (request === expectedRevocation && request.failure()?.errorText === 'net::ERR_ABORTED') return;
    if (!directFetchFailure && request.frame() !== page.mainFrame() && request.method() === 'POST' && request.url().endsWith('/api/plugins/sandbox-plugin/control/allowed') && request.failure()?.errorText === 'net::ERR_FAILED') { directFetchFailure = true; return; }
    errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  let controlCalls = 0;
  const pendingControl = new Promise<void>(resolve => { releasePending = resolve; });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/plugins/sandbox-plugin/index.html') {
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
              window.startPendingControl = () => port.postMessage({type:'bungee:host-request',generation,nonce,id:'pending-navigation',action:'control',path:'/allowed',method:'POST',body:{pending:true}});
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
    if (request.method() === 'GET' && url.hostname === 'attacker.example' && url.pathname === '/attacker.html') return route.fulfill({contentType: 'text/html', body: `<!doctype html><script>
      window.receivedBridges = []; window.receivedResults = [];
      window.addEventListener('message', event => {
        if(event.data?.type !== 'bungee:bridge-init') return;
        window.receivedBridges.push(event.data.generation);
        for(const port of event.ports) {
          port.onmessage = response => window.receivedResults.push(response.data);
          port.start();
          port.postMessage({type:'bungee:host-request',generation:event.data.generation,nonce:event.data.nonce,id:'attacker-control',action:'control',path:'/allowed',method:'POST',body:{}});
        }
      });
      window.probeReady = true;
    </script>`});
    if (request.method() === 'GET' && url.pathname === '/api/plugins/sandbox-plugin/sandbox') return route.fulfill({ json: {
      sandbox: 'allow-scripts', allowedHostActions: ['ui-context', 'copy-styles', 'control'], controlAllowlist: [{ path: '/allowed', methods: ['POST'] }],
    } });
    if (request.method() === 'GET' && url.pathname === '/api/plugins') return route.fulfill({ json: [{ name: 'sandbox-plugin', enabled: true, metadata: { contributes: { api: [{ path: '/allowed', methods: ['POST'], handler: 'allowed', execution: 'control' }] } } }] });
    if (request.method() === 'POST' && url.pathname === '/api/plugins/sandbox-plugin/control/allowed') {
      controlCalls++;
      if (request.postDataJSON().pending) await pendingControl;
      return route.fulfill({json: {ok: true}});
    }
    if (url.pathname.startsWith('/api/')) { errors.push(`Unexpected API ${request.method()} ${url.pathname}`); return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}}); }
    return route.continue();
  });

  const base = `${uiRuntime.origin}/tests/fixtures/sandbox.html`;
  await page.goto(base);
  const frame = page.locator('iframe');
  await frame.waitFor();
  const child = page.frames().find(candidate => candidate !== page.mainFrame());
  assert(child, 'sandbox child frame was not created');
  await child!.waitForFunction(() => Boolean((window as any).bridgeValue), undefined, { timeout: 10000 });
  const result = await child!.evaluate(() => (window as any).bridgeValue);
  for (const [theme, semantic] of [['industrial', 'dark'], ['dark', 'dark'], ['light', 'light'], [null, 'light']]) {
    await page.evaluate(theme => theme === null ? document.documentElement.removeAttribute('data-theme') : document.documentElement.setAttribute('data-theme', theme), theme);
    await child!.waitForFunction(expected => (window as any).theme === expected, semantic);
  }
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
  // Observe a valid bridge round-trip after the forged window message.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await child!.waitForFunction(() => (window as any).theme === 'dark');
  assert.equal(controlCalls, 1);
  assert.deepEqual(await page.evaluate(() => (window as any).__sandboxProbes), [1]);
  const pendingRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/control/allowed') && request.postDataJSON()?.pending === true);
  await child!.evaluate(() => (window as any).startPendingControl());
  const inFlight = await pendingRequest; expectedRevocation = inFlight;
  const revoked = page.waitForEvent('requestfailed', request => request === inFlight && request.failure()?.errorText === 'net::ERR_ABORTED');
  await frame.evaluate(element => { (element as HTMLIFrameElement).src = 'http://attacker.example/attacker.html'; });
  await page.waitForFunction(() => document.querySelector('iframe')?.src === 'http://attacker.example/attacker.html');
  await revoked; releasePending();
  await expect(page.getByRole('status', {name:'Sandbox navigation blocked'})).toBeVisible();
  const reloadedChild = page.frames().find(candidate => candidate !== page.mainFrame() && candidate.url().includes('attacker.example'));
  assert.equal(await page.evaluate(() => (window as any).__sandboxProbes.length), 1);
  assert(reloadedChild, 'external navigation did not load the receiving probe');
  await reloadedChild!.waitForFunction(() => (window as any).probeReady === true);
  // Host's load handler has visibly revoked the bridge. Process a browser rendering turn
  // after that checkpoint so a mistakenly transferred init message reaches this listener.
  await reloadedChild!.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.deepEqual(await reloadedChild!.evaluate(() => (window as any).receivedBridges), []);
  assert.deepEqual(await reloadedChild!.evaluate(() => (window as any).receivedResults), []);
  assert.equal(controlCalls, 2, 'external document must not acquire a third control request');
  assert.equal(await page.getByRole('status', { name: 'Sandbox navigation blocked' }).count(), 1);
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
  assert.deepEqual(errors, []);
  console.log('PASS sandbox bridge: opaque iframe, allowed bridge control, revoked in-flight control and no bridge granted after navigation');
} finally {
  releasePending();
  try { await browser?.close(); } finally { await uiRuntime.close(); }
}
}, 240_000);
