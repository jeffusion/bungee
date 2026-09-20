// Built UI + isolated loopback mock. Every business API (including authentication) is mocked.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const evidence = process.env.BUNGEE_UI_EVIDENCE ?? `/tmp/opencode/settings-review-${Date.now()}`;
await mkdir(evidence, { recursive: true, mode: 0o700 });
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, `.${new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname}`);
    if (req.method !== 'GET' || !path.startsWith(dist + '/')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(path)] ?? 'application/octet-stream' });
    res.end(await readFile(path));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const report = { origin, cases: [], screenshots: [], fonts: [], expectedHTTP: [], expectedNetwork: [], pageErrors: [], consoleErrors: [], requestFailed: [], unexpectedHTTP: [], failures: [] };
const fontCache = new Map();
const fontCacheDir = '/tmp/opencode/bungee-project-font-cache';
await mkdir(fontCacheDir, { recursive: true, mode: 0o700 });
const TOKEN = 'qa-current-secret', NEXT = 'qa-next-secret', KEY = 'bungee:settings-publication';
const hash = `sha256:${'a'.repeat(64)}`;
const initialAggregate = () => ({ logical_configuration: { log_level: 'info', auth: { enabled: true, tokens: [TOKEN] }, logging: { body: { enabled: true, max_size: 51200, retention_days: 1 } }, routes: [], services: [], plugins: [] }, plugin_activations: [] });
const operation = (id, revision, state = 'converged') => ({ mutation_id: id, expected_revision: revision - 1, committed_revision: revision, state, result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null, error_code: state === 'degraded' ? 'old_worker_drain_failed' : null, error_detail: state === 'degraded' ? '0:timeout, 1:exit_unconfirmed' : null, target_worker_count: 2 });
const envelope = aggregate => ({ format: 'bungee-config-snapshot', format_version: 1, schema_version: 2, exported_at: 1, source_revision: 6, content_hash: hash, envelope_hash: hash, aggregate });
const upload = (page, value) => page.getByTestId('config-import-input').setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
// Keep the matrix's value/disabled assertions while exercising the headless list.
const logLevel = page => ({
  selectOption: async value => {
    await page.locator('#config-log-level').click();
    await page.getByRole('option', { name: new RegExp(`${{ debug: 'Debug', info: 'Info', warn: 'Warning', error: 'Error' }[value]}$`) }).click();
  },
  inputValue: async () => {
    const trigger = page.locator('#config-log-level');
    const value = await trigger.getAttribute('data-value');
    const english = await page.evaluate(() => localStorage.getItem('locale') === 'en');
    const labels = english
      ? { '': 'Default (Info)', debug: 'Debug', info: 'Info', warn: 'Warning', error: 'Error' }
      : { '': '默认（Info）', debug: '调试 · Debug', info: '信息 · Info', warn: '警告 · Warning', error: '错误 · Error' };
    assert.equal((await trigger.innerText()).trim(), labels[value], `visible log-level label for ${value}`);
    return value;
  },
  isDisabled: () => page.locator('#config-log-level').isDisabled(),
});
let lastPage;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function scenario(name, { mobile = false, english = false, outcome = 'success', storageSet = false, storageRemove = false, saved = null, authEnabled = true, rejection = null } = {}) {
  const model = { aggregate: initialAggregate(), revision: 42, op: operation('10000000-0000-4000-8000-000000000001', 42), release: false, polls: 0, serving: false, recovery: null,
    failRuntime: false, hangRuntime: false, invalid: false, rejectStatus: null, queryStatus: null, cleanup: 'success', cleanupExecuted: 0, cleanupAttempts: 0, cleanupRefreshFail: false, nativeDecision: 'accept',
    writes: [], acceptedWrites: 0, validations: [], logins: [], reads: [], expected: new Set(), consoleStart: report.consoleErrors.length,
    preflightEntered: deferred(), releasePreflight: deferred(), preflightFinished: deferred(), queued: deferred(), queryGate: null, networkQuery: false, networkRuntime: false };
  model.aggregate.logical_configuration.auth.enabled = authEnabled;
  let mutationQueue = Promise.resolve();
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, locale: english ? 'en' : 'zh-CN', serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'bungee_auth_token', value: TOKEN }, { name: 'locale', value: english ? 'en' : 'zh-CN' }] }] } });
  if (storageSet || storageRemove) await ctx.addInitScript(({ storageSet, storageRemove, key }) => {
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(k, v) { if (this === sessionStorage && k === key && storageSet && !window.allowStorage) throw new Error('test storage set denied'); return set.call(this, k, v); };
    Storage.prototype.removeItem = function(k) { if (this === sessionStorage && k === key && storageRemove) throw new Error('test storage remove denied'); return remove.call(this, k); };
  }, { storageSet, storageRemove, key: KEY });
  if (name === 'import-lan-http') await ctx.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  if (saved !== null) await ctx.addInitScript(({ key, saved }) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem(key, saved); sessionStorage.setItem('seeded', '1'); } }, { key: KEY, saved });
  if (outcome === 'preflight') await ctx.addInitScript(() => {
    const original = window.fetch; let first = true;
    window.fetch = (input, init) => {
      const request = original(input, init);
      if (init?.method === 'PUT' && first) {
        first = false;
        // Transport loses the response; the request on the server remains behind its preflight barrier.
        return Promise.race([request, new Promise((_, reject) => { window.loseFirstResponse = () => reject(new TypeError('response lost')); })]);
      }
      return request;
    };
  });
  const page = lastPage = await ctx.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.pageErrors.push({ name, error: e.message }));
  page.on('console', m => { if (m.type() === 'error') report.consoleErrors.push({ name, text: m.text(), url: m.location().url }); });
  page.on('requestfailed', r => report.requestFailed.push({ name, method: r.method(), url: r.url(), error: r.failure()?.errorText }));
  page.on('dialog', d => {
    if (d.type() !== 'beforeunload') report.failures.push(`Unexpected native ${d.type()} in ${name}`);
    void (model.nativeDecision === 'dismiss' ? d.dismiss() : d.accept());
  });
  const expected = (method, path, status) => model.expected.add(`${method} ${path} ${status}`);
  const snapshot = () => ({ revision: model.revision, content_hash: hash, config: model.aggregate });
  const workers = () => [0, 1].map(slot => ({ worker_slot: slot, slot, attempt_no: 1, revision: model.revision, applied_revision: model.revision, target_revision: model.revision, content_hash: hash, state: 'converged', last_error: null }));
  const opState = () => ({ operation: model.op, workers: workers() });
  const publication = () => ({ operation: { operation_id: model.op.mutation_id, committed_revision: model.op.committed_revision, state: model.op.state, result_status: model.op.result_status, error_code: model.op.error_code }, recovery: model.recovery, retryable: false, serving_complete: model.serving, serving_revision: model.serving ? model.revision : null, target_revision: model.revision });
  await ctx.route('**/*', async route => {
    const req = route.request(), u = new URL(req.url()), method = req.method(), path = u.pathname;
    if (u.origin !== origin) {
      assert.ok(method === 'GET' && ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(u.hostname), `non-mock destination ${req.url()}`);
      if (!fontCache.has(req.url())) {
        const cacheFile = `${fontCacheDir}/${createHash('sha256').update(req.url()).digest('hex')}.json`;
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
          assert.equal(cached.url, req.url());
          fontCache.set(req.url(), { status: 200, contentType: cached.contentType, headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(cached.body, 'base64') });
        } catch {
          try {
            const response = await route.fetch({ timeout: 15000 }); assert.equal(response.status(), 200);
            const body = await response.body(), contentType = response.headers()['content-type'];
            fontCache.set(req.url(), { status: 200, contentType, headers: { 'access-control-allow-origin': '*' }, body });
            await writeFile(cacheFile, JSON.stringify({ url: req.url(), contentType, body: body.toString('base64') }), { mode: 0o600 });
          } catch (error) {
            report.failures.push(`Project font unavailable: ${req.url()} (${error.message})`);
            await route.abort('failed').catch(() => {}); return;
          }
        }
      }
      return route.fulfill(fontCache.get(req.url())).catch(() => {});
    }
    if (!path.startsWith('/api/')) return route.continue();
    const json = async (data, status = 200) => {
      if (status >= 400) {
        const entry = { name, method, url: req.url(), status };
        (model.expected.has(`${method} ${path} ${status}`) ? report.expectedHTTP : report.unexpectedHTTP).push(entry);
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    };
    const body = method === 'GET' ? null : req.postDataJSON();
    const isWrite = path === '/api/config' && method === 'PUT' || path === '/api/config/import' && method === 'POST';
    if (isWrite) model.writes.push({ method, path, body });
    if (isWrite && rejection) {
      if (rejection === 'network') {
        report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_CONNECTION_RESET' });
        return route.abort('connectionreset');
      }
      const status = ['500', '401', '409', '422'].includes(rejection) ? Number(rejection) : 503;
      expected(method, path, status);
      if (rejection === 'nonJSON') {
        report.expectedHTTP.push({ name, method, url: req.url(), status });
        return route.fulfill({ status, contentType: 'text/plain', body: 'SECRET-BODY' });
      }
      return json({ error: rejection, ...(rejection === 'control_recovering' ? { reason: 'lease_margin' } : {}), message: 'SECRET-BODY', stack: 'SECRET-BODY', aggregate: { token: NEXT } }, status);
    }
    if (isWrite && outcome === 'undelivered' && model.writes.length === 1) {
      expected('GET', `/api/config/operations/${body.mutation_id}`, 404);
      report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_CONNECTION_RESET' });
      return route.abort('connectionreset'); // Before auth, CAS or any DB mutation.
    }
    const attempt = model.writes.length;
    let releaseMutation = () => {};
    if (isWrite) {
      const previous = mutationQueue, completion = deferred();
      mutationQueue = completion.promise; releaseMutation = completion.resolve;
      if (attempt > 1) model.queued.resolve();
      await previous; // Mutations are serial; operation/snapshot/runtime reads bypass this queue.
    }
    try {
    if (path === '/api/logs/cleanup' && method === 'POST') model.cleanupAttempts++;
    const auth = model.aggregate.logical_configuration.auth;
    const authorized = !auth?.enabled || auth.tokens.includes((req.headers().authorization ?? '').replace(/^Bearer /, ''));
    if (path === '/api/auth/verify') return json({ success: authorized }, !authorized && req.headers().authorization ? 401 : 200);
    if (path === '/api/auth/login' && method === 'POST') {
      model.logins.push({ success: !auth.enabled || auth.tokens.includes(body.token) });
      return json({ success: model.logins.at(-1).success }, model.logins.at(-1).success ? 200 : 401);
    }
    if (!authorized) return json({ error: 'unauthorized' }, 401);
    if (method === 'GET') {
      model.reads.push(path);
      if (path === '/api/config') return json(snapshot());
      if (path === '/api/config/export') return json(envelope(model.aggregate));
      if (path === '/api/plugins') return json([]);
      if (path === '/api/plugin-translations') return json({});
      if (path === '/api/config/runtime') {
        if (model.networkRuntime) {
          report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_CONNECTION_RESET' });
          return route.abort('connectionreset');
        }
        if (model.hangRuntime) {
          report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_ABORTED' });
          await new Promise(resolve => setTimeout(resolve, 10000));
          try { await json({ ...snapshot(), workers: workers(), publication: publication() }); } catch { /* expected client deadline abort */ }
          return;
        }
        return model.failRuntime ? json({ error: 'runtime_unavailable' }, 503) : json({ ...snapshot(), workers: workers(), publication: publication() });
      }
      if (path.startsWith('/api/config/operations/')) {
        if (outcome === 'committed503' && model.writes.length > 0) {
          assert.equal(path, `/api/config/operations/${model.writes[0].body.mutation_id}`);
          assert.equal(req.headers().authorization, `Bearer ${NEXT}`);
        }
        if (model.queryGate) {
          const gate = model.queryGate; model.queryGate = null; gate.entered.resolve(); await gate.release.promise;
          await json({ error: 'operation_not_found' }, 404); gate.finished.resolve(); return;
        }
        if (model.networkQuery) {
          report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_CONNECTION_RESET' });
          return route.abort('connectionreset');
        }
        if (model.queryStatus) return json({ error: name.endsWith('-accepted503') ? 'control_recovering' : 'test_lookup_error' }, model.queryStatus);
        if (path.split('/').at(-1) !== model.op.mutation_id) return json({ error: 'operation_not_found' }, 404);
        if (!['converged', 'degraded'].includes(model.op.state)) {
          model.polls++;
          const state = outcome === 'degraded' && model.polls > 1 ? 'degraded' : model.release ? 'converged' : model.polls < 2 ? 'publishing' : 'draining';
          model.op = operation(model.op.mutation_id, model.revision, state);
          if (['converged', 'degraded'].includes(state)) model.serving = true;
        }
        return json(opState(), model.op.state === 'converged' ? 200 : 202);
      }
      if (path === '/api/logs') return json({ data: [], total: 0, page: 1, limit: 50, totalPages: 0 });
      if (path === '/api/logs/cleanup/config') return model.cleanupRefreshFail ? json({ error: 'refresh_failed' }, 503) : json({ enabled: true, retentionDays: 1, scheduleIntervalHours: 1, isActive: true });
      if (path === '/api/runtime/upstreams') return json({ workers: [], services: {}, availability: 'unknown', upstreams: [] });
      if (path === '/api/stats/history/v2') return json({ timestamps: [], requests: [], errors: [], responseTime: [], successRate: [] });
      if (path.startsWith('/api/stats/')) return json({ data: [] });
      return json({ error: 'unmocked_endpoint' }, 404);
    }
    if (path === '/api/logs/cleanup' && method === 'POST') {
      model.cleanupExecuted++;
      if (model.cleanup === 'refresh-failure') model.cleanupRefreshFail = true;
      return json({ deletedSqliteRecords: 1, deletedFileLogFiles: 0, deletedBodyDirs: 0, deletedBodyFiles: 0, durationMs: 1 });
    }
    if (path === '/api/config/validate' && method === 'POST') { model.validations.push(body); return json({ valid: !model.invalid, errors: model.invalid ? [{ path: 'private.marker', message: NEXT }] : [] }); }
    assert.ok(isWrite, `unapproved mock write ${method} ${path}`);
    assert.match(body.mutation_id, /^[a-f0-9-]{36}$/);
    if (path.endsWith('/import')) assert.deepEqual(Object.keys(body).sort(), ['envelope', 'expected_revision', 'mutation_id']);
    if (outcome === 'preflight' && attempt === 1) {
      expected('GET', `/api/config/operations/${body.mutation_id}`, 404);
      model.preflightEntered.resolve(); await model.releasePreflight.promise;
    }
    if (body.expected_revision !== model.revision || outcome === 'conflict') return json({ error: 'stale_revision' }, 409);
    if (model.rejectStatus) return json({ error: 'invalid_configuration', errors: [] }, model.rejectStatus);
    const candidate = body.aggregate ?? body.envelope.aggregate;
    if (JSON.stringify(candidate.logical_configuration.auth) !== JSON.stringify(auth) && candidate.logical_configuration.auth?.enabled) {
      const proof = (req.headers()['x-bungee-next-authorization'] ?? '').replace(/^Bearer /, '');
      if (!candidate.logical_configuration.auth.tokens.includes(proof)) return json({ error: 'invalid_next_authorization' }, 403);
    }
    model.aggregate = structuredClone(candidate); model.revision++; model.acceptedWrites++;
    model.op = operation(body.mutation_id, model.revision, 'committed');
    if (outcome === 'committed503') {
      expected(method, path, 503);
      return json({ error: 'repository_unavailable', message: 'SECRET-BODY' }, 503);
    }
    if (outcome === 'preflight') {
      if (model.release) { model.op = operation(body.mutation_id, model.revision, 'converged'); model.serving = true; }
      model.preflightFinished.resolve('committed');
    }
    if (outcome === 'lost') {
      report.expectedNetwork.push({ name, method, url: req.url(), error: 'net::ERR_CONNECTION_RESET' }); return route.abort('connectionreset');
    }
    if (outcome === 'unknown') return json({ error: 'outcome_unknown' }, 503);
    return await json({ ...opState(), operation_id: body.mutation_id, revision: model.revision }, 202);
    } finally { releaseMutation(); }
  });
  const ready = async () => {
    await page.getByTestId('logging-max-size').waitFor();
    await page.getByTestId('settings-serving-state').getByText(english ? 'Current serving not confirmed' : '当前接流尚未确认', { exact: true }).waitFor();
  };
  await page.goto(`${origin}/?fixture=${name}#/config`); await ready();
  const fonts = await page.evaluate(async () => {
    const specs = ['400 14px Inter', '400 12px "DM Mono"', '500 16px Orbitron'];
    const loaded = await Promise.all(specs.map(spec => document.fonts.load(spec, 'AB123'))); await document.fonts.ready;
    return loaded.map((faces, i) => ({ spec: specs[i], count: faces.length, loaded: faces.length > 0 && faces.every(f => f.status === 'loaded') }));
  });
  assert.ok(fonts.every(f => f.loaded), 'project fonts must actually load'); report.fonts.push({ name, fonts });
  const shot = async label => {
    assert.ok(!(await page.locator('body').innerText()).includes(TOKEN)); assert.ok(!(await page.locator('body').innerText()).includes(NEXT));
    const path = `${evidence}/${name}-${label}.png`; await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path);
  };
  const review = async () => { await page.getByTestId('config-save-button').click(); await page.getByTestId('config-review').getByText(english ? /Validation passed/ : /校验通过/).waitFor(); };
  const close = async () => {
    const before = await logLevel(page).inputValue();
    assert.equal(await page.getByRole('dialog').locator('footer').getByRole('button').count(), 1);
    await page.getByRole('dialog').getByRole('button', { name: english ? 'Close review' : '关闭审阅', exact: true }).click();
    await page.getByTestId('config-review').waitFor({ state: 'hidden' });
    assert.equal(await logLevel(page).inputValue(), before);
  };
  const confirm = async accept => { await page.getByTestId('confirmation-accept').waitFor(); await page.getByTestId(accept ? 'confirmation-accept' : 'confirmation-cancel').click(); await page.getByTestId('confirmation-accept').waitFor({ state: 'hidden' }); };
  const publish = async () => { await review(); await page.getByTestId('config-confirm-publish').click(); };
  const relogin = async () => {
    expected('GET', '/api/auth/verify', 401);
    await page.reload(); await page.getByTestId('page-login').waitFor();
    await page.locator('#token-input').fill(NEXT); await page.locator('[data-testid="page-login"] button.nx-btn-primary').click();
    await page.getByTestId('page-dashboard').waitFor(); await page.waitForLoadState('networkidle');
    await page.goto(`${origin}/#/config`); await page.getByTestId('logging-max-size').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('bungee_auth_token')), NEXT);
  };
  const finish = async () => {
    await page.waitForLoadState('networkidle');
    if (await page.locator('#config-log-level').count()) await logLevel(page).inputValue();
    const stored = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    for (const secret of [TOKEN, NEXT, 'logical_configuration', 'envelope_hash']) assert.ok(!stored.includes(secret));
    const text = await page.locator('body').innerText(); for (const secret of [TOKEN, NEXT]) assert.ok(!text.includes(secret));
    await ctx.close(); report.cases.push({ name, attemptedWrites: model.writes.length, acceptedWrites: model.acceptedWrites, revision: model.revision,
      expectedRevisions: model.writes.map(w => w.body.expected_revision), operationIds: model.writes.map(w => w.body.mutation_id),
      validations: model.validations.length, cleanupAttempts: model.cleanupAttempts, cleanupExecuted: model.cleanupExecuted, logins: model.logins.length, passed: true });
  };
  return { page, ctx, model, shot, review, close, confirm, publish, expected, relogin, finish };
}

try {
  if (process.env.SETTINGS_FIELD_PIXELS) {
    for (const mobile of [false, true]) for (const english of [false, true]) {
      const name = `fields-${mobile ? 'mobile' : 'desktop'}-${english ? 'en' : 'zh'}`;
      const s = await scenario(name, { mobile, english });
      for (const section of ['general', 'logging']) {
        const filename = `${name}-${section}.png`, path = `${evidence}/${filename}`;
        const image = await s.page.locator(`#settings-${section}`).screenshot({ path, animations: 'disabled' });
        report.screenshots.push(path);
        if (process.env.SETTINGS_COMPARE_PIXELS) assert.deepEqual(image, await readFile(`${process.env.SETTINGS_COMPARE_PIXELS}/${filename}`), `${filename}: identical rendered pixels`);
      }
      await s.finish();
    }
  } else if (process.env.SETTINGS_BASELINE) {
    const s = await scenario('baseline');
    await s.shot('settings');
    await s.page.goto(`${origin}/#/design`);
    await s.page.getByTestId('page-design').waitFor();
    await s.page.locator('#design-select-trigger').scrollIntoViewIfNeeded();
    await s.shot('design');
    await s.page.getByTestId('design-industrial-toggle').scrollIntoViewIfNeeded();
    await s.shot('design-toggle');
    await s.finish();
  } else if (process.env.SETTINGS_VISUAL) {
    for (const mobile of [false, true]) for (const english of [false, true]) {
      const s = await scenario(`visual-${mobile ? 'mobile' : 'desktop'}-${english ? 'en' : 'zh'}`, { mobile, english });
      const p = s.page, trigger = p.locator('#config-log-level');
      const overflow = async () => assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const snapshot = async label => { await overflow(); await s.shot(label); };
      await snapshot('initial');
      const menu = p.getByRole('button', { name: english ? 'Snapshot actions' : '快照操作' });
      await menu.focus(); await p.keyboard.press('Enter');
      await p.getByRole('menuitem', { name: english ? 'Export snapshot' : '导出快照' }).waitFor();
      await snapshot('snapshot-menu');
      assert.equal(await p.getByRole('menuitem', { name: english ? 'Import snapshot' : '导入快照' }).isDisabled(), false);
      await p.keyboard.press('Escape');
      assert.equal(await menu.evaluate(el => el === document.activeElement), true);
      assert.equal(await menu.isDisabled(), false);
      await menu.click();
      await p.getByRole('menuitem', { name: english ? 'Export snapshot' : '导出快照' }).click();
      await s.confirm(false);
      assert.equal(s.model.reads.includes('/api/config/export'), false, 'cancelled export never downloads');
      await menu.click();
      const chooser = p.waitForEvent('filechooser');
      await p.getByRole('menuitem', { name: english ? 'Import snapshot' : '导入快照' }).click();
      await (await chooser).setFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope(initialAggregate()))) });
      await p.getByTestId('import-preview').waitFor();
      await p.getByRole('button', { name: english ? 'Cancel import' : '取消导入', exact: true }).click();
      const details = p.getByRole('button', { name: english ? 'Publication details' : '查看发布详情' });
      assert.equal(await details.getAttribute('aria-expanded'), 'false');
      await details.click(); await p.getByTestId('publication-details').waitFor();
      assert.equal(await details.getAttribute('aria-expanded'), 'true');
      await snapshot('details');
      await details.click(); await p.getByTestId('publication-details').waitFor({ state: 'hidden' });
      const nav = p.getByRole('navigation', { name: english ? 'Settings sections' : '设置分区' });
      assert.equal(await nav.evaluate(el => getComputedStyle(el).borderBottomWidth), '0px');
      const sections = [english ? 'General' : '一般设置', english ? 'Access' : '访问认证', english ? 'Logging' : '日志采集'];
      const links = nav.getByRole('button');
      assert.equal(await links.count(), 3);
      assert.ok((await links.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))).every(height => height >= (mobile ? 44 : 40)));
      assert.ok(await links.first().evaluate(el => {
        const number = el.querySelector('.nx-display');
        return number?.textContent === '01' && getComputedStyle(number).fontFamily.includes('Orbitron')
          && getComputedStyle(el).transitionProperty === 'color' && !el.textContent.includes('↘');
      }));
      await links.first().hover();
      assert.equal(await links.first().evaluate(el => getComputedStyle(el).textDecorationLine), 'none');
      await p.waitForFunction(() => getComputedStyle(document.querySelector('[aria-label="设置分区"] button .nx-display, [aria-label="Settings sections"] button .nx-display')).color === 'rgb(251, 146, 60)');
      await snapshot('nav-hover');
      await links.first().focus(); await p.keyboard.press('Tab');
      await p.mouse.move(0, 0);
      await snapshot('nav-focus');
      for (const [index, section] of sections.entries()) {
        const link = nav.getByRole('button', { name: section, exact: true });
        if (index === 0) await link.click();
        else { await link.focus(); await p.keyboard.press(index === 1 ? 'Enter' : 'Space'); }
        assert.equal(await p.evaluate(() => document.activeElement?.id), `settings-${['general', 'access', 'logging'][index]}`);
        assert.ok(await p.locator(`#settings-${['general', 'access', 'logging'][index]}`).evaluate(el => el.getBoundingClientRect().top < innerHeight));
      }
      await p.evaluate(() => scrollTo(0, 0));
      const messages = JSON.parse(await readFile(new URL(`../src/i18n/locales/${english ? 'en' : 'zh-CN'}.json`, import.meta.url), 'utf8'));
      const namedFields = [
        p.getByRole('textbox', { name: messages.configuration.bodyParserLimit, exact: true }),
        p.getByRole('spinbutton', { name: `${messages.settings.diff.bodyMax} · KiB`, exact: true }),
        p.getByRole('spinbutton', { name: messages.settings.diff.retention, exact: true }),
      ];
      const fieldIds = [];
      for (const field of namedFields) {
        await field.waitFor();
        fieldIds.push(await field.getAttribute('id'));
        assert.ok(await field.evaluate(el => {
          const label = document.getElementById(el.getAttribute('aria-labelledby'));
          const help = document.getElementById(el.getAttribute('aria-describedby'));
          return label?.tagName === 'LABEL' && label.htmlFor === el.id && !!help?.textContent.trim()
            && [...document.querySelectorAll('[id]')].filter(node => node.id === el.id).length === 1;
        }), 'visible label and help resolve to this input');
      }
      (report.fieldNames ??= []).push({ name: `visual-${mobile ? 'mobile' : 'desktop'}-${english ? 'en' : 'zh'}`, snapshots: await Promise.all(namedFields.map(field => field.ariaSnapshot())) });
      assert.equal(await p.getByTestId('settings-change-bar').count(), 0);
      assert.equal(await logLevel(p).inputValue(), 'info');
      if (mobile) assert.ok(await trigger.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'first field visible on mobile');
      assert.equal(await p.locator('#settings-general select').count(), 0, 'no native log-level select');
      await trigger.focus(); await p.keyboard.press('Tab');
      await p.waitForFunction(() => {
        const field = document.activeElement.getBoundingClientRect();
        return field.bottom <= (document.querySelector('[data-testid="settings-change-bar"]')?.getBoundingClientRect().top ?? innerHeight);
      });
      await p.keyboard.press('Shift+Tab');
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      await p.waitForFunction(() => getComputedStyle(document.querySelector('#config-log-level')).borderColor === 'rgb(249, 115, 22)');
      await snapshot('focus');
      await p.keyboard.press('Enter'); await p.getByRole('listbox').waitFor();
      assert.equal(await p.locator('fieldset .settings-select-list').count(), 0, 'list is not clipped by the form body');
      await snapshot('select-open');
      await p.keyboard.press('End'); await p.keyboard.press('Enter');
      assert.equal(await logLevel(p).inputValue(), 'error');
      assert.equal(await p.getByTestId('config-save-button').isDisabled(), false);
      await trigger.click(); await p.keyboard.press('Escape');
      await p.getByRole('listbox').waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
      await snapshot('dirty');
      assert.equal(await p.getByTestId('settings-draft-state').locator('p').last().innerText(), english ? 'Editing baseline r42 · 1 change' : '编辑基线 r42 · 1 项更改');
      await p.getByTestId('logging-retention-days').fill('2');
      assert.deepEqual(await Promise.all(namedFields.map(field => field.getAttribute('id'))), fieldIds, 'field IDs survive rerenders');
      assert.equal(await p.getByTestId('settings-change-bar').locator('p').innerText(), english ? '2 changes · r42' : '2 项更改 · r42');
      await p.getByTestId('logging-retention-days').fill('1');
      await s.review(); assert.equal(await trigger.isDisabled(), true); await snapshot('review');
      assert.equal(await p.getByRole('dialog').locator('footer').getByRole('button').count(), 1);
      assert.equal(await p.getByTestId('config-review').locator('p').first().innerText(), english ? 'Editing baseline r42 · 1 change' : '编辑基线 r42 · 1 项更改');
      const dialogControls = await p.getByRole('dialog').getByRole('button').evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
      assert.ok(dialogControls.every(height => height >= (mobile ? 44 : 40)));
      for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
        await p.keyboard.press(key);
        assert.ok(await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
      }
      await p.keyboard.press('Escape'); await p.getByTestId('config-review').waitFor({ state: 'hidden' });
      await trigger.click(); await p.getByRole('option').first().click();
      assert.equal(await logLevel(p).inputValue(), '');
      await snapshot('default-label');
      await s.review(); assert.equal(Object.hasOwn(s.model.validations.at(-1).aggregate.logical_configuration, 'log_level'), false); await s.close();
      await p.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'config-save-button');
      await logLevel(p).selectOption('error');
      const auth = p.getByRole('switch', { name: english ? 'Enable Authentication' : '启用认证', exact: true });
      const token = p.getByTestId('auth-token-input');
      assert.equal(await token.getAttribute('type'), 'password');
      await p.getByRole('button', { name: english ? 'Show tokens' : '显示令牌', exact: true }).click();
      assert.equal(await token.getAttribute('type'), 'text');
      await p.getByRole('button', { name: english ? 'Hide tokens' : '隐藏令牌', exact: true }).click();
      assert.equal(await token.getAttribute('type'), 'password');
      await auth.scrollIntoViewIfNeeded(); await snapshot('auth-enabled');
      await auth.focus(); await p.keyboard.press('Space'); assert.equal(await auth.getAttribute('aria-checked'), 'false');
      assert.equal(await token.inputValue(), TOKEN); await snapshot('auth-disabled');
      await p.keyboard.press('Enter'); assert.equal(await auth.getAttribute('aria-checked'), 'true');
      const next = initialAggregate(); next.logical_configuration.log_level = 'debug';
      next.logical_configuration.routes = Array.from({ length: 65 }, (_, i) => ({ id: `route-${i}`, path: `/v1/long-path-${i}-${'x'.repeat(120)}`, plugins: [] }));
      await upload(p, envelope(next)); await p.getByTestId('import-preview').waitFor();
      assert.equal(await trigger.isDisabled(), true);
      assert.equal(await auth.isDisabled(), true);
      await p.getByTestId('import-preview').evaluate(el => window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 120)); await snapshot('import-preview');
      assert.ok((await p.getByTestId('import-preview').innerText()).includes(english ? 'Routes 65 · Services 0' : '路由 65 · 服务 0'));
      await s.review(); await snapshot('long-review');
      await p.getByTestId('config-review').evaluate(el => el.parentElement.scrollTo(0, el.parentElement.scrollHeight));
      await snapshot('long-review-bottom'); await s.close();
      await p.getByRole('button', { name: english ? 'Cancel import' : '取消导入', exact: true }).click();
      await p.getByTestId('logging-retention-days').scrollIntoViewIfNeeded(); await snapshot('logging');
      assert.ok((await p.locator('#settings-logging').innerText()).includes(english ? 'default: 5 KiB' : '默认 5 KiB'));
      const controls = await p.getByTestId('page-config').locator('button:visible, a:visible, input:visible').evaluateAll(els => els.map(el => ({ tag: el.tagName, text: el.textContent, height: el.getBoundingClientRect().height })));
      assert.ok(controls.every(control => control.height >= (mobile ? 44 : 40)), JSON.stringify(controls.filter(control => control.height < (mobile ? 44 : 40))));
      assert.equal(s.model.writes.length, 0); await s.finish();
    }
  } else {
  if (process.env.SETTINGS_ONLY_REJECTION) {
    for (const mobile of [false, true]) for (const imported of [false, true]) {
      for (const failure of ['control_recovering', 'control_readiness_failed', 'repository_unavailable', 'committed503', '500', 'nonJSON', 'network', 'accepted503', '409', '422', '401']) {
        const english = !mobile;
        const s = await scenario(`rejection-${mobile ? 'mobile' : 'desktop'}-${imported ? 'import' : 'put'}-${failure}`, { mobile, english, outcome: failure === 'committed503' ? failure : 'success', rejection: ['accepted503', 'committed503'].includes(failure) ? null : failure });
        if (failure === 'accepted503') {
          s.model.queryStatus = 503;
          await s.page.route('**/api/config/operations/*', async route => { s.expected('GET', new URL(route.request().url()).pathname, 503); await route.fallback(); });
        }
        if (imported) {
          const next = initialAggregate(); next.logical_configuration.log_level = 'error'; next.logical_configuration.auth.tokens = [NEXT];
          await upload(s.page, envelope(next)); await s.page.getByTestId('import-preview').waitFor();
        } else {
          await logLevel(s.page).selectOption('error'); await s.page.getByTestId('auth-token-input').fill(NEXT);
        }
        await s.page.getByTestId('next-auth-token-input').fill(NEXT);
        const reads = s.model.reads.filter(path => path === '/api/config').length;
        await s.publish();
        if (failure === '401') {
          await s.page.getByTestId('page-login').waitFor();
          assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
        } else {
          const known = ['control_recovering', 'control_readiness_failed'].includes(failure);
          const phase = known || ['409', '422'].includes(failure) ? 'rejected' : failure === 'accepted503' ? 'active' : 'unknown';
          await s.page.waitForFunction(phase => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === phase && !!document.querySelector('[data-testid="settings-notice"]'), phase);
          await s.close();
          assert.equal(s.model.reads.filter(path => path === '/api/config').length, reads);
          assert.equal(await s.page.getByTestId('next-auth-token-input').inputValue(), NEXT);
          if (imported) assert.equal(await s.page.getByTestId('import-preview').count(), 1);
          else { assert.equal(await logLevel(s.page).inputValue(), 'error'); assert.equal(await s.page.getByTestId('auth-token-input').inputValue(), NEXT); }
          assert.equal(await logLevel(s.page).isDisabled(), imported || phase === 'unknown' || phase === 'active');
          const text = await s.page.locator('body').innerText(); assert.ok(!text.includes('SECRET-BODY'));
          if (known) {
            assert.ok(text.includes(`HTTP 503 · ${failure}${failure === 'control_recovering' ? ' · lease_margin' : ''}`));
            assert.ok(text.includes(english ? 'Configuration was not committed; your draft is retained' : '配置未提交，草稿已保留'));
            assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
          } else assert.ok(!text.includes('HTTP 503 ·'));
          assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
          await s.page.evaluate(() => window.scrollTo(0, 0)); await s.shot('retained');
          if (known) {
            await s.review(); assert.ok(!(await s.page.locator('body').innerText()).includes('HTTP 503 ·'));
            assert.equal(await s.page.getByTestId('config-confirm-publish').isDisabled(), false); await s.close();
          }
          if (failure === 'committed503') {
            const id = s.model.writes[0].body.mutation_id;
            assert.equal(s.model.revision, 43); assert.equal(s.model.acceptedWrites, 1);
            assert.equal(s.model.op.mutation_id, id); assert.equal(s.model.op.state, 'committed');
            assert.equal(s.model.polls, 0);
            assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), true);
            assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null, 'unconfirmed identity stays in memory, not accepted storage');
            assert.equal(await s.page.evaluate(() => localStorage.getItem('bungee_auth_token')), TOKEN);
            assert.ok(!(await s.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(NEXT));
            const check = s.page.getByRole('button', { name: english ? 'Check this publication' : '查询本次发布', exact: true });
            const readsBeforeQuery = s.model.reads.length;
            await check.click();
            await s.page.waitForFunction(() => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === 'active');
            assert.deepEqual(await s.page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), KEY), { version: 1, mutationId: id, accepted: true });
            assert.deepEqual(s.model.reads.slice(readsBeforeQuery).filter(path => path.startsWith('/api/config/operations/')), [`/api/config/operations/${id}`]);
            assert.equal(await s.page.getByTestId('next-auth-token-input').inputValue(), NEXT);
            assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), true);
            await s.shot('tracking');
            s.model.release = true; await check.click();
            await s.page.waitForFunction(() => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === 'terminal' && !document.querySelector('[data-testid="next-auth-token-input"]'));
            assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
            assert.equal(await s.page.evaluate(() => localStorage.getItem('bungee_auth_token')), NEXT);
            assert.equal(await logLevel(s.page).inputValue(), 'error');
            assert.equal(await logLevel(s.page).isDisabled(), false);
            await s.shot('converged');
          }
        }
        assert.equal(s.model.writes.length, 1); await s.finish();
      }
    }
  }
  if (!process.env.SETTINGS_ONLY_REJECTION) {
  if (!process.env.SETTINGS_ONLY_CLEANUP) {
    {
      const s = await scenario('auth-enable-preflight', { outcome: 'preflight', authEnabled: false });
      await s.page.getByRole('switch', { name: '启用认证', exact: true }).click();
      await s.page.getByTestId('auth-token-input').fill(NEXT); await s.page.getByTestId('next-auth-token-input').fill(NEXT);
      await s.publish(); await s.model.preflightEntered.promise;
      await s.page.evaluate(() => window.loseFirstResponse());
      await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
      // Auth is still off, so the candidate can query before the queued enable request commits.
      const beforeReads = s.model.reads.filter(path => path === '/api/config').length;
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/请求未撤销，鉴权结果未确认，请继续查询；不要重新提交/).waitFor();
      assert.equal(s.model.reads.filter(path => path === '/api/config').length, beforeReads);
      assert.equal(await s.page.getByTestId('next-auth-token-input').inputValue(), NEXT);
      assert.equal(await s.page.getByTestId('auth-token-input').inputValue(), NEXT);
      assert.equal(await logLevel(s.page).isDisabled(), true);
      assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), true);
      assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
      assert.ok(!(await s.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).includes(NEXT));
      assert.equal(s.model.acceptedWrites, 0); await s.page.evaluate(() => window.scrollTo(0, 0)); await s.shot('locked');
      s.model.release = true; s.model.releasePreflight.resolve(); assert.equal(await s.model.preflightFinished.promise, 'committed');
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/发布记录已收敛/).waitFor();
      assert.equal(await s.page.evaluate(() => localStorage.getItem('bungee_auth_token')), NEXT);
      assert.equal(s.model.writes.length, 1); assert.equal(s.model.acceptedWrites, 1); assert.equal(s.model.revision, 43);
      assert.equal(await s.page.getByTestId('next-auth-token-input').count(), 0); await s.finish();
    }
    for (const failure of ['503', 'network']) {
      const s = await scenario(`missing-runtime-${failure}`, { outcome: 'undelivered', mobile: failure === 'network' });
      await logLevel(s.page).selectOption('error'); await s.publish();
      await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
      if (failure === '503') { s.expected('GET', '/api/config/runtime', 503); s.model.failRuntime = true; }
      else s.model.networkRuntime = true;
      const beforeReads = s.model.reads.filter(path => path === '/api/config').length;
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/当前配置已读取，但接流状态无法确认/).waitFor();
      assert.ok(s.model.reads.filter(path => path === '/api/config').length > beforeReads);
      assert.equal(await logLevel(s.page).inputValue(), 'error');
      assert.equal(await logLevel(s.page).isDisabled(), true);
      assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), true);
      assert.equal(await s.page.getByTestId('page-config').getAttribute('data-submission-phase'), 'unknown');
      assert.equal(s.model.revision, 42); assert.equal(s.model.acceptedWrites, 0);
      await s.page.evaluate(() => window.scrollTo(0, 0)); await s.shot('locked');
      s.model.failRuntime = false; s.model.networkRuntime = false;
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/未发现已提交记录/).waitFor();
      assert.equal(await logLevel(s.page).inputValue(), 'info');
      assert.equal(await logLevel(s.page).isDisabled(), false);
      assert.equal(s.model.writes.length, 1); await s.finish();
    }
    {
      const s = await scenario('preflight-cas', { outcome: 'preflight' });
      const select = logLevel(s.page);
      await select.selectOption('error'); await s.publish(); await s.model.preflightEntered.promise;
      await s.page.evaluate(() => window.loseFirstResponse());
      await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/未发现已提交记录/).waitFor();
      assert.equal(await select.inputValue(), 'info'); assert.equal(s.model.acceptedWrites, 0);
      s.expected('PUT', '/api/config', 409);
      s.model.release = true; await select.selectOption('error'); await s.publish(); await s.model.queued.promise;
      assert.equal(s.model.acceptedWrites, 0); assert.equal(s.model.revision, 42);
      s.model.releasePreflight.resolve(); assert.equal(await s.model.preflightFinished.promise, 'committed');
      await s.page.getByTestId('settings-notice').getByText(/版本已变化/).waitFor(); await s.close();
      await s.page.getByTestId('settings-notice').locator('..').getByRole('button').click(); await s.confirm(true);
      await s.page.waitForFunction(() => document.querySelector('[data-testid="settings-draft-state"]')?.textContent.includes('r43'));
      assert.equal(await select.inputValue(), 'error');
      assert.deepEqual(s.model.writes.map(w => w.body.expected_revision), [42, 42]);
      assert.notEqual(s.model.writes[0].body.mutation_id, s.model.writes[1].body.mutation_id);
      assert.equal(s.model.revision, 43); assert.equal(s.model.acceptedWrites, 1);
      assert.equal(s.model.op.mutation_id, s.model.writes[0].body.mutation_id); await s.shot('first-commit-second-stale'); await s.finish();
    }
    for (const mobile of [false, true]) {
      const s = await scenario(`undelivered-${mobile ? 'mobile' : 'desktop'}`, { outcome: 'undelivered', mobile });
      const select = logLevel(s.page);
      await select.selectOption('error'); await s.publish();
      await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
      assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      await s.page.getByTestId('settings-notice').getByText(/未发现已提交记录，已重新加载当前配置，可以重新修改并提交/).waitFor();
      assert.equal(await select.isDisabled(), false); assert.equal(await select.inputValue(), 'info');
      assert.equal(s.model.aggregate.logical_configuration.log_level, 'info'); assert.equal(s.model.acceptedWrites, 0);
      await s.page.evaluate(() => window.scrollTo(0, 0)); await s.shot('unlocked');
      await select.selectOption('error'); s.model.release = true; await s.publish();
      await s.page.getByTestId('config-review').waitFor({ state: 'hidden' });
      assert.equal(s.model.writes.length, 2); assert.equal(s.model.acceptedWrites, 1);
      assert.equal(s.model.aggregate.logical_configuration.log_level, 'error'); await s.finish();
    }
    for (const accepted of [false, true]) {
      for (const failure of [401, 'network', ...(accepted ? [404] : [])]) {
        const s = await scenario(`${accepted ? 'accepted' : 'unaccepted'}-${failure}`, { outcome: accepted ? 'success' : 'undelivered' });
        s.model.queryStatus = typeof failure === 'number' ? failure : null; s.model.networkQuery = failure === 'network';
        // Register generated IDs before the first operation poll.
        await s.page.route('**/api/config/operations/*', async route => {
          if (typeof failure === 'number') s.expected('GET', new URL(route.request().url()).pathname, failure);
          await route.fallback();
        });
        await logLevel(s.page).selectOption('error'); await s.publish();
        await s.page.getByTestId('settings-notice').getByText(accepted ? failure === 401 ? /无权查询/ : failure === 404 ? /暂未查到/ : /查询暂不可用/ : /请求已发出/).waitFor();
        await s.close();
        await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
        await s.page.getByTestId('settings-notice').getByText(failure === 401 ? /无权查询/ : failure === 404 ? /暂未查到/ : /查询暂不可用/).waitFor();
        assert.equal(await logLevel(s.page).isDisabled(), true);
        const saved = await s.page.evaluate(key => JSON.parse(sessionStorage.getItem(key) ?? 'null'), KEY);
        assert.equal(saved?.accepted ?? false, accepted); assert.equal(s.model.writes.length, 1);
        if (accepted && failure === 404) {
          await s.page.reload(); await s.page.getByTestId('settings-notice').getByText(/暂未查到/).waitFor();
          assert.equal(await logLevel(s.page).isDisabled(), true);
        }
        await s.finish();
      }
    }
    for (const exists of [false, true]) {
      const id = '10000000-0000-4000-8000-000000000099';
      const s = await scenario(`legacy-${exists ? 'found' : 'missing'}`);
      if (exists) s.model.op = operation(id, s.model.revision, 'publishing');
      else s.expected('GET', `/api/config/operations/${id}`, 404);
      await s.page.evaluate(({ key, id }) => sessionStorage.setItem(key, id), { key: KEY, id });
      await s.page.reload();
      if (exists) {
        await s.page.waitForFunction(key => { const value = sessionStorage.getItem(key); return value?.startsWith('{') && JSON.parse(value).accepted === true; }, KEY);
        assert.equal(await logLevel(s.page).isDisabled(), true);
      } else {
        await s.page.getByTestId('settings-notice').getByText(/未发现已提交记录/).waitFor();
        assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
        assert.equal(await logLevel(s.page).isDisabled(), false);
        assert.equal(await logLevel(s.page).inputValue(), 'info');
      }
      assert.equal(s.model.writes.length, 0); await s.finish();
    }
    {
      const s = await scenario('corrupt-metadata', { saved: '{broken' });
      await s.page.getByTestId('settings-notice').getByText(/本地.*读取失败|本地.*无法|无法.*本地/).waitFor();
      assert.equal(s.model.writes.length, 0); assert.equal(await logLevel(s.page).isDisabled(), true); await s.finish();
    }
    for (const leave of [false, true]) {
      const s = await scenario(leave ? 'destroy-query' : 'old-404-new-pending', { outcome: 'undelivered' });
      await logLevel(s.page).selectOption('error'); await s.publish();
      await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
      const gate = { entered: deferred(), release: deferred(), finished: deferred() }; s.model.queryGate = gate;
      await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click(); await gate.entered.promise;
      if (leave) {
        await s.page.evaluate(() => { location.hash = '#/logs'; }); await s.confirm(true); await s.page.getByTestId('page-logs').waitFor();
      } else {
        await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
        await s.page.getByTestId('settings-notice').getByText(/未发现已提交记录/).waitFor();
        s.model.networkQuery = true;
        await logLevel(s.page).selectOption('error'); await s.publish();
        await s.page.getByTestId('settings-notice').getByText(/查询暂不可用/).waitFor(); await s.close();
      }
      const saved = await s.page.evaluate(key => sessionStorage.getItem(key), KEY);
      const reads = s.model.reads.filter(path => path === '/api/config').length;
      const response = s.page.waitForResponse(r => r.url().endsWith(s.model.writes[0].body.mutation_id) && r.status() === 404);
      gate.release.resolve(); await gate.finished.promise; await response;
      await s.page.waitForLoadState('networkidle');
      assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), saved);
      assert.equal(s.model.reads.filter(path => path === '/api/config').length, reads);
      if (!leave) { assert.equal(await logLevel(s.page).isDisabled(), true); assert.equal(s.model.writes.length, 2); }
      else assert.equal(await s.page.getByTestId('page-logs').count(), 1);
      await s.finish();
    }
    for (const outcome of ['success', 'lost']) {
      const s = await scenario(outcome === 'success' ? 'import-lan-http' : 'import-lost-response', { outcome });
      const next = initialAggregate(); next.logical_configuration.log_level = 'error';
      await upload(s.page, envelope(next)); await s.page.getByTestId('import-preview').waitFor(); await s.publish();
      if (outcome === 'lost') {
        await s.page.getByTestId('settings-notice').getByText(/请求已发出/).waitFor(); await s.close();
        assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
        await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
        await s.page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.accepted === true, KEY);
        assert.equal(await logLevel(s.page).isDisabled(), true);
        s.model.release = true; await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
      } else s.model.release = true;
      await s.page.waitForFunction(() => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === 'terminal');
      assert.equal(s.model.writes.length, 1); assert.equal(s.model.acceptedWrites, 1); assert.equal(s.model.writes[0].method, 'POST'); await s.finish();
    }
  }
  if (!process.env.SETTINGS_ONLY_ACCEPTANCE) {
  if (!process.env.SETTINGS_ONLY_CLEANUP) {
  {
    const s = await scenario('basic'); const { page, model } = s;
    assert.equal(await page.getByTestId('logging-max-size').inputValue(), '50'); await s.shot('desktop');
    await page.getByTestId('logging-max-size').fill('52'); await s.review();
    assert.match(await page.getByTestId('config-diff').innerText(), /单条正文存储上限.*50 KiB.*52 KiB/s); await s.shot('safe-review'); await s.close();
    await page.getByRole('button', { name: '放弃更改', exact: true }).click(); await s.confirm(false);
    assert.equal(await page.getByTestId('logging-max-size').inputValue(), '52');
    await page.getByRole('button', { name: '放弃更改', exact: true }).click(); await s.confirm(true);
    await page.waitForFunction(() => document.activeElement?.id === 'config-log-level');
    await page.getByTestId('logging-max-size').fill(''); await s.review();
    assert.equal(Object.hasOwn(model.validations.at(-1).aggregate.logical_configuration.logging.body, 'max_size'), false);
    assert.ok(!(await page.getByTestId('logging-max-size').getAttribute('placeholder')).includes('undefined')); await s.close();
    await page.getByTestId('logging-max-size').fill('52'); await s.publish();
    await page.getByTestId('settings-publication-state').getByText('正在等待旧请求结束').waitFor();
    const publicationDetails = page.getByRole('button', { name: '查看发布详情' });
    assert.equal(await publicationDetails.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.getByTestId('publication-details').isVisible(), true, 'automatic publication details remain visible');
    assert.match(await page.getByTestId('runtime-uncertain').innerText(), /不是读取失败/); model.release = true;
    await page.getByTestId('config-review').waitFor({ state: 'hidden' }); assert.equal(model.writes.length, 1);
    s.expected('GET', '/api/config/runtime', 503); model.failRuntime = true; await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByTestId('settings-serving-state').getByText('接流状态未知 / 过期').waitFor(); await s.shot('stale');
    model.failRuntime = false; await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.getByTestId('settings-serving-state').getByText(/接流已确认/).waitFor();
    model.hangRuntime = true; await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.getByTestId('settings-serving-state').getByText('接流状态未知 / 过期').waitFor({ timeout: 11000 }); model.hangRuntime = false;
    await page.getByRole('button', { name: '刷新状态', exact: true }).click(); await page.getByTestId('settings-serving-state').getByText(/接流已确认/).waitFor();
    await page.getByRole('button', { name: '快照操作' }).click(); await page.getByRole('menuitem', { name: '导出快照' }).click(); await s.confirm(false);
    assert.equal(model.reads.filter(path => path === '/api/config/export').length, 0);
    await page.getByRole('button', { name: '快照操作' }).click(); await page.getByRole('menuitem', { name: '导出快照' }).click(); const download = page.waitForEvent('download'); await s.confirm(true); await download;
    assert.equal(model.reads.filter(path => path === '/api/config/export').length, 1);
    await s.finish();
  }
  for (const kind of ['set', 'remove']) {
    const s = await scenario(`storage-${kind}`, { storageSet: kind === 'set', storageRemove: kind === 'remove' });
    await s.page.getByTestId('logging-max-size').fill('52'); s.model.release = true; await s.publish();
    if (kind === 'set') await s.page.getByText(/无法保存追踪标识/).waitFor();
    await s.page.getByTestId('config-review').waitFor({ state: 'hidden' });
    assert.equal(await s.page.getByTestId('page-config').getAttribute('data-submission-phase'), 'terminal');
    if (kind === 'remove') await s.page.getByText(/本地标识清理失败/).waitFor();
    await s.page.getByTestId('logging-max-size').fill('53'); assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), false);
    assert.equal(s.model.writes.length, 1);
    if (kind === 'remove') { await s.page.reload(); await s.page.waitForFunction(() => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === 'terminal'); assert.equal(await s.page.getByTestId('logging-max-size').isDisabled(), false); }
    await s.finish();
  }
  for (const outcome of ['success', 'lost', 'timeout', 'degraded']) {
    const s = await scenario(`auth-${outcome}`, { outcome });
    await s.page.getByTestId('auth-token-input').fill(NEXT); await s.page.getByTestId('next-auth-token-input').fill(NEXT);
    if (outcome === 'success') s.model.release = true;
    await s.publish();
    if (outcome === 'success') {
      await s.page.getByTestId('config-review').waitFor({ state: 'hidden' }); assert.equal(await s.page.evaluate(() => localStorage.getItem('bungee_auth_token')), NEXT);
    } else if (outcome === 'degraded') {
      await s.page.getByTestId('config-review').waitFor({ state: 'hidden' }); await s.page.getByTestId('settings-notice').getByText(/未完成状态结束/).waitFor();
      assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
      assert.equal(await s.page.getByTestId('logging-max-size').isDisabled(), false);
      assert.match(await s.page.getByTestId('publication-details').innerText(), /旧工作进程排空结果/); await s.shot('terminal');
      await s.relogin(); await s.page.getByRole('button', { name: '查看发布详情', exact: true }).click();
      await s.page.getByTestId('logging-max-size').fill('53'); await s.review(); assert.equal(await s.page.getByTestId('config-confirm-publish').isDisabled(), false); await s.close();
    } else {
      await s.page.getByTestId('settings-notice').getByText(outcome === 'timeout' ? /等待结果超时/ : /请求已发出/).waitFor({ timeout: 23000 }); await s.shot('pending'); await s.close();
      assert.equal(!!(await s.page.evaluate(key => sessionStorage.getItem(key), KEY)), outcome !== 'lost');
      if (outcome === 'lost') {
        for (const status of [401, 503]) {
          s.model.queryStatus = status === 401 ? null : status; s.expected('GET', `/api/config/operations/${s.model.op.mutation_id}`, status);
          if (status === 401) s.model.aggregate.logical_configuration.auth.tokens = ['third-party-rotation'];
          await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
          await s.page.getByTestId('settings-notice').getByText(status === 404 ? /暂未查到/ : status === 401 ? /无权查询/ : /查询暂不可用/).waitFor();
          assert.equal(s.model.writes.length, 1);
          if (status === 401) s.model.aggregate.logical_configuration.auth.tokens = [NEXT];
        }
        s.model.queryStatus = null;
        await s.page.getByRole('button', { name: '查询本次发布', exact: true }).click();
        await s.page.waitForFunction(key => JSON.parse(sessionStorage.getItem(key) ?? 'null')?.accepted === true, KEY);
        assert.equal(await s.page.getByTestId('logging-max-size').isDisabled(), true);
      }
      s.model.release = true; await s.relogin();
      await s.page.getByTestId('settings-publication-state').getByText('最近发布已收敛').waitFor();
      await s.page.waitForFunction(() => document.querySelector('[data-testid="logging-max-size"]')?.disabled === false);
      assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
    }
    assert.equal(s.model.writes.length, 1); assert.equal(s.model.acceptedWrites, 1); await s.finish();
  }
  {
    const s = await scenario('write-401'); await s.page.getByTestId('logging-max-size').fill('52'); await s.review();
    s.model.aggregate.logical_configuration.auth.tokens = [NEXT]; s.model.revision++; s.expected('PUT', '/api/config', 401);
    await s.page.getByTestId('config-confirm-publish').click(); await s.page.getByTestId('page-login').waitFor();
    await s.page.waitForFunction(key => sessionStorage.getItem(key) === null, KEY);
    assert.equal(s.model.writes.length, 1); assert.equal(s.model.acceptedWrites, 0); await s.finish();
  }
  for (const status of [409, 422]) {
    const s = await scenario(`rejected-${status}`, { outcome: status === 409 ? 'conflict' : 'success' });
    if (status === 409) { const next = initialAggregate(); next.logical_configuration.logging.body.retention_days = 2; await upload(s.page, envelope(next)); await s.page.getByTestId('import-preview').waitFor(); s.expected('POST', '/api/config/import', 409); }
    else { await s.page.getByTestId('logging-max-size').fill('52'); s.model.rejectStatus = 422; s.expected('PUT', '/api/config', 422); }
    await s.publish(); await s.page.getByTestId('settings-notice').waitFor();
    assert.equal(await s.page.getByTestId('page-config').getAttribute('data-submission-phase'), 'rejected');
    assert.equal(await s.page.evaluate(key => sessionStorage.getItem(key), KEY), null);
    assert.equal(s.model.acceptedWrites, 0); await s.close();
    assert.equal(s.model.writes.length, 1); await s.finish();
  }
  {
    const s = await scenario('recovery');
     s.model.op = operation(s.model.op.mutation_id, 42, 'degraded'); s.model.serving = true;
     s.model.recovery = { recovery_id: 'recovery', target_revision: 42, state: 'running', attempt_count: 1, max_attempts: 3 };
    await s.page.getByRole('button', { name: '刷新状态', exact: true }).click(); await s.page.waitForFunction(() => document.querySelector('[data-testid="logging-max-size"]')?.disabled === true);
    s.model.recovery.state = 'succeeded'; await s.page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await s.page.waitForFunction(() => document.querySelector('[data-testid="logging-max-size"]')?.disabled === false); await s.page.getByTestId('logging-max-size').fill('52');
    assert.equal(await s.page.getByTestId('config-save-button').isDisabled(), false); assert.equal(await s.page.getByTestId('publication-retry-button').count(), 0); await s.finish();
  }
  for (const english of [false, true]) {
    const s = await scenario(english ? 'english-long' : 'chinese-long', { mobile: true, english });
    const next = initialAggregate(); next.logical_configuration.routes = Array.from({ length: 65 }, (_, i) => ({ id: `route-${i}`, path: `/v1/item-${i}`, plugins: [{ name: 'example', options: { 'secret-key-marker': 8675309 } }] }));
    next.logical_configuration.auth['tokens.enabled'] = 987654321;
    await upload(s.page, envelope(next)); await s.page.getByTestId('import-preview').waitFor();
    for (const marker of ['secret-key-marker', '8675309', '987654321', 'tokens.enabled']) assert.ok(!(await s.page.locator('body').innerText()).includes(marker));
    assert.equal(s.model.validations.length, 0); assert.equal(s.model.writes.length, 0); await s.review(); await s.shot('safe-summary');
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab', 'Tab', 'Shift+Tab']) { await s.page.keyboard.press(key); assert.ok(await s.page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))); }
    await s.page.keyboard.press('Escape'); await s.page.getByTestId('config-review').waitFor({ state: 'hidden' });
    await s.page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'config-save-button');
    await s.page.getByRole('button', { name: english ? 'Cancel import' : '取消导入', exact: true }).click(); assert.equal(s.model.writes.length, 0);
    await upload(s.page, 'x'.repeat(2_000_000)); await s.page.getByTestId('settings-notice').waitFor(); assert.equal(await s.page.getByTestId('import-preview').count(), 0);
    await s.shot('bounded'); await s.finish();
  }
  {
    const s = await scenario('leave-guard'); const p = s.page;
    await p.goto(`${origin}/#/logs`); await p.getByTestId('page-logs').waitFor(); await p.goto(`${origin}/#/config`); await p.getByTestId('logging-max-size').waitFor();
    await p.getByTestId('logging-max-size').fill('52');
    await p.locator('nav a[href="/#/routes"]').first().click(); await s.confirm(false); await p.waitForURL('**/#/config'); assert.equal(await p.getByTestId('logging-max-size').inputValue(), '52');
    await p.evaluate(() => { location.hash = '#/services'; }); await s.confirm(false); await p.waitForURL('**/#/config');
    await p.goBack({ waitUntil: 'domcontentloaded' }); await s.confirm(false); await p.waitForURL('**/#/config');
    s.model.nativeDecision = 'dismiss'; await p.reload().catch(() => {}); assert.equal(await p.getByTestId('logging-max-size').inputValue(), '52');
    s.model.nativeDecision = 'accept'; await p.evaluate(() => { location.hash = '#/logs'; }); await s.confirm(true); await p.getByTestId('page-logs').waitFor();
    assert.equal(s.model.writes.length, 0); await s.finish();
  }
  {
    const s = await scenario('leave-guard-refresh'); const p = s.page;
    await p.evaluate(() => { location.hash = '#/logs'; }); await p.getByTestId('page-logs').waitFor();
    await p.evaluate(() => { location.hash = '#/config'; }); await p.getByTestId('logging-max-size').waitFor();
    await p.reload(); await p.getByTestId('logging-max-size').waitFor();
    await p.getByTestId('logging-max-size').fill('52');
    await p.goBack({ waitUntil: 'domcontentloaded' }); await s.confirm(false);
    await p.waitForFunction(() => location.hash === '#/config'); assert.equal(await p.getByTestId('logging-max-size').inputValue(), '52');
    await p.goBack({ waitUntil: 'domcontentloaded' }); await s.confirm(true);
    await p.getByTestId('page-logs').waitFor(); assert.equal(s.model.writes.length, 0); await s.finish();
  }
  }
  for (const cleanup of ['success', 'refresh-failure', '401']) {
    const s = await scenario(`cleanup-${cleanup}`); const p = s.page;
    await p.goto(`${origin}/#/logs`); await p.getByTestId('logs-maintenance').locator('summary').click();
    await p.getByTestId('cleanup-start').click(); await s.confirm(false); assert.equal(s.model.cleanupAttempts, 0);
    await p.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'cleanup-start');
    s.model.cleanup = cleanup;
    if (cleanup === 'refresh-failure') s.expected('GET', '/api/logs/cleanup/config', 503);
    await p.getByTestId('cleanup-start').click();
    if (cleanup === '401') { s.model.aggregate.logical_configuration.auth.tokens = [NEXT]; s.expected('POST', '/api/logs/cleanup', 401); }
    await s.confirm(true);
    if (cleanup === '401') { await p.getByTestId('page-login').waitFor(); assert.equal(s.model.cleanupExecuted, 0); }
    else {
      await p.getByTestId('cleanup-outcome').getByText(cleanup === 'success' ? '清理已执行。' : /清理已执行，状态刷新失败/).waitFor();
      assert.equal(await p.getByTestId('cleanup-start').isDisabled(), true); assert.equal(s.model.cleanupExecuted, 1); await s.shot('result');
    }
    assert.equal(s.model.cleanupAttempts, 1); await s.finish();
  }
  }
  }
  }
  assert.deepEqual(report.unexpectedHTTP, []); assert.deepEqual(report.pageErrors, []);
  const same = (a, b) => a.name === b.name && a.method === b.method && a.url === b.url && a.error === b.error;
  assert.deepEqual(report.requestFailed.filter(r => !report.expectedNetwork.some(e => same(r, e))), []);
  const consumedHTTP = new Set(), consumedNetwork = new Set();
  for (const c of report.consoleErrors) {
    const status = /^Failed to load resource: the server responded with a status of (\d{3}) \(.+\)$/.exec(c.text)?.[1];
    const network = /^Failed to load resource: (net::ERR_[A-Z_]+)$/.exec(c.text)?.[1];
    const entries = status ? report.expectedHTTP : report.expectedNetwork, consumed = status ? consumedHTTP : consumedNetwork;
    const index = entries.findIndex((e, i) => !consumed.has(i) && e.name === c.name && e.url === c.url && (status ? e.status === Number(status) : network && e.error === network));
    assert.ok(index >= 0, `unexpected console: ${JSON.stringify(c)}`); consumed.add(index);
  }
} catch (error) {
  report.failures.push(error.stack ?? String(error)); process.exitCode = 1;
  if (lastPage && !lastPage.isClosed()) {
    await lastPage.screenshot({ path: `${evidence}/failure.png`, animations: 'disabled', mask: [lastPage.locator('input')] }).catch(() => {});
    report.failureNavigation = await lastPage.evaluate(() => ({ url: location.href, state: history.state, length: history.length })).catch(() => null);
    report.failureText = (await lastPage.locator('body').innerText().catch(() => '')).replaceAll(TOKEN, '********').replaceAll(NEXT, '********');
    report.failureFocus = await lastPage.evaluate(() => ({ tag: document.activeElement?.tagName, testId: document.activeElement?.getAttribute('data-testid'), text: document.activeElement?.textContent?.slice(0, 80) })).catch(() => null);
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  report.fontSources = [...fontCache.keys()];
  await writeFile(`${evidence}/summary.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
