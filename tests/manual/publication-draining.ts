import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { DEFAULT_PUBLICATION_POLICY } from '@jeffusion/bungee-types';

// Real local HTTP stream through actual Ingress and workers. No intercepted
// management responses, no external upstream or production credentials.
const base = process.env.PUBLICATION_UI_URL ?? 'http://127.0.0.1:28287';
const local = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(local.hostname), 'only disposable local services are permitted');
const uiPort = Number(local.port || 80);
const managementPort = Number(process.env.BUNGEE_MANAGEMENT_PORT ?? uiPort + 2);
const proxyPort = Number(process.env.PORT ?? uiPort + 1);
const streamPort = managementPort + 3;
const api = `http://${local.hostname}:${managementPort}/api`;
const proxy = `http://${local.hostname}:${proxyPort}/publication-ui-drain`;
const upstreamTarget = `http://127.0.0.1:${streamPort}`;
const produceDegraded = process.argv.includes('--degraded');
const repo = realpathSync(resolve(import.meta.dir, '../..'));
const artifactRoot = `${process.env.PUBLICATION_EVIDENCE_ROOT ?? "/tmp/bungee-publication"}/`;
const proofOption = process.argv.find(arg => arg.startsWith('--instance-proof='))?.slice('--instance-proof='.length);
const restoreOption = process.argv.find(arg => arg.startsWith('--restore='))?.slice('--restore='.length);
const deferRestore = process.argv.includes('--defer-restore');
const verifyOnly = process.argv.includes('--verify-instance');
const fixtureOnly = process.env.PUBLICATION_FIXTURE_ONLY === '1';
const drainSeconds = produceDegraded ? 20 : 30;
const evidence = resolve(process.env.PUBLICATION_EVIDENCE_ROOT ?? "/tmp/bungee-publication", 'ui-draining-browser');
mkdirSync(evidence, { recursive: true });
const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const timers = new Map<ReadableStreamDefaultController<Uint8Array>, { heartbeat: ReturnType<typeof setInterval>; deadline: ReturnType<typeof setTimeout> }>();
const encoder = new TextEncoder();
const maximumStreamMs = fixtureOnly ? 250 : 40000;
function ownedArtifact(path: string): string {
  assert.ok(isAbsolute(path), 'an explicit absolute isolated artifact path is required');
  const actual = realpathSync(path);
  assert.ok(actual.startsWith(artifactRoot), 'artifacts must be inside this checkout test-results/publication');
  return actual;
}
type Ownership = { state: string; database: string; databaseDevice: number; databaseInode: number; generation: string };
let ownership: Ownership;
const readRuntime = async (origin: string) => {
  const response = await fetch(`${origin}/api/config/runtime`); assert.equal(response.status, 200);
  return await response.json();
};
async function verifyOwnership() {
  const direct = await readRuntime(`http://${local.hostname}:${managementPort}`);
  const ui = await readRuntime(base);
  assert.equal(ui.revision, direct.revision); assert.equal(ui.content_hash, direct.content_hash);
  const db = statSync(ownedArtifact(ownership.database));
  assert.ok(db.isFile(), 'the dedicated helper database must be a real file');
  assert.equal(db.dev, ownership.databaseDevice); assert.equal(db.ino, ownership.databaseInode);
  assert.ok(direct.workers.length > 0, 'the owned helper must have real serving worker descriptors');
  for (const worker of direct.workers) {
    const path = ownedArtifact(resolve(ownership.state, 'runtime/workers', `${worker.worker_instance_id}.json`));
    const marker = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(marker.schema, 'bungee-worker-descriptor-v1'); assert.equal(marker.role, 'worker');
    assert.equal(marker.phase, 'serving'); assert.equal(marker.evidence?.kind, 'ready');
    assert.equal(marker.master_generation, ownership.generation);
    assert.match(marker.descriptor_mac, /^hmac-sha256:[0-9a-f]{64}$/);
    for (const field of ['master_generation', 'worker_instance_id', 'boot_nonce', 'pid', 'revision', 'content_hash']) assert.equal(marker[field], worker[field]);
    assert.ok(ui.workers.some((reported: any) => reported.worker_instance_id === marker.worker_instance_id && reported.boot_nonce === marker.boot_nonce && reported.master_generation === ownership.generation));
  }
  return direct;
}
if (!fixtureOnly) {
  if (restoreOption) {
    const receipt = JSON.parse(readFileSync(ownedArtifact(restoreOption), 'utf8'));
    assert.equal(receipt.schema, 'publication-owned-restore-v1'); ownership = receipt.ownership;
  } else {
    assert.ok(proofOption, 'fail closed: supply --instance-proof=<owned local-server runtime/workers/*.json> before any real write');
    const proof = ownedArtifact(proofOption!);
    const marker = JSON.parse(readFileSync(proof, 'utf8'));
    assert.equal(marker.schema, 'bungee-worker-descriptor-v1'); assert.equal(marker.role, 'worker');
    assert.equal(marker.phase, 'serving'); assert.equal(marker.evidence?.kind, 'ready');
    assert.equal(basename(proof), `${marker.worker_instance_id}.json`);
    const state = dirname(dirname(dirname(proof)));
    assert.equal(proof, resolve(state, 'runtime/workers', `${marker.worker_instance_id}.json`));
    const database = ownedArtifact(resolve(state, 'bungee.db')), db = statSync(database);
    ownership = { state, database, databaseDevice: db.dev, databaseInode: db.ino, generation: marker.master_generation };
  }
  await verifyOwnership();
  if (verifyOnly) { console.log(JSON.stringify({ owned: true, ownership })); process.exit(0); }
}
async function restoreOwned(receiptPath: string) {
  const receipt = JSON.parse(readFileSync(ownedArtifact(receiptPath), 'utf8'));
  ownership = receipt.ownership; const runtime = await verifyOwnership();
  assert.equal(runtime.revision, receipt.expectedRevision, 'refuse restoration over concurrent configuration changes');
  assert.equal(runtime.publication.operation.operation_id, receipt.operationId);
  assert.ok(['converged', 'degraded'].includes(runtime.publication.operation.state), 'never restore across a nonterminal operation');
  assert.deepEqual(runtime.config, receipt.expectedConfig);
  const response = await fetch(`${api}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: receipt.expectedRevision, mutation_id: crypto.randomUUID(), aggregate: receipt.originalConfig }) });
  assert.equal(response.status, 202); const accepted = await response.json();
  for (let i = 0; i < 3500; i++) {
    const result = await fetch(`${api}/config/operations/${accepted.operation_id}`);
    assert.ok([200, 202].includes(result.status));
    const state = await result.json();
    if (['converged', 'degraded'].includes(state.operation.state)) {
      assert.equal(state.operation.state, 'converged'); const final = await verifyOwnership();
      assert.equal(final.revision, accepted.revision); assert.deepEqual(final.config, receipt.originalConfig);
      return { accepted, finalRevision: final.revision, restored: true };
    }
    await Bun.sleep(100);
  }
  throw new Error('restoration did not converge');
}
if (restoreOption) {
  const restored = await restoreOwned(restoreOption);
  writeFileSync(resolve(evidence, 'restoration.json'), JSON.stringify(restored, null, 2)); process.exit(0);
}
function clearStream(controller: ReadableStreamDefaultController<Uint8Array>) {
  const active = timers.get(controller);
  if (active) { clearInterval(active.heartbeat); clearTimeout(active.deadline); }
  timers.delete(controller); controllers.delete(controller);
}
function finishStream(controller: ReadableStreamDefaultController<Uint8Array>) {
  if (!controllers.has(controller)) return;
  clearStream(controller);
  controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
}
let received = 0;
const upstream = Bun.serve({ hostname: '127.0.0.1', port: streamPort, idleTimeout: 60,
  fetch() {
    received++;
    let current: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        current = controller; controllers.add(controller);
        controller.enqueue(encoder.encode(`data: {"started_at":${Date.now()}}\n\n`));
        const heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`)); } catch { clearStream(controller); } }, 100);
        // A finite stream, even if the integration exits before manual release.
        const deadline = setTimeout(() => finishStream(controller), maximumStreamMs);
        timers.set(controller, { heartbeat, deadline });
      },
      cancel() { clearStream(current); },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  },
});
if (fixtureOnly) {
  try {
    const started = performance.now();
    const response = await fetch(`${upstreamTarget}/fixture-protocol`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const body = await response.text();
    const elapsedMs = performance.now() - started;
    const frames = body.split('\n\n').filter(Boolean);
    assert.equal(frames.at(-1), 'data: [DONE]');
    assert.ok(frames.some(frame => frame.startsWith(': heartbeat ')));
    const first = JSON.parse(frames[0].slice('data: '.length));
    assert.deepEqual(Object.keys(first), ['started_at']);
    assert.equal(typeof first.started_at, 'number');
    assert.ok(body.endsWith('data: [DONE]\n\n'));
    assert.ok(elapsedMs < 3000);
    assert.equal(controllers.size, 0); assert.equal(timers.size, 0);
    const report = { scope: 'fixture protocol only, not proxy or publication acceptance', url: response.url, contentType: response.headers.get('content-type'), finite: true, frameCount: frames.length, elapsedMs, doneMarkerReceived: true, requests: received, billingUsageGenerated: false };
    writeFileSync(resolve(evidence, 'fixture-protocol.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { upstream.stop(true); }
  process.exit(0);
}
const json = async (path: string, init?: RequestInit) => {
  if (init?.method && init.method !== 'GET') await verifyOwnership();
  const response = await fetch(`${api}${path}`, init);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return await response.json();
};
const waitTerminal = async (id: string) => {
  for (let count = 0; count < 3500; count++) {
    const state = await json(`/config/operations/${id}`);
    if (['converged', 'degraded'].includes(state.operation.state)) return state;
    await Bun.sleep(100);
  }
  throw new Error('Real publication did not reach a terminal record');
};
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
const results: object[] = [];
let receiptPath: string | null = null;
let caseCompleted = false;
try {
  const snapshot = await json('/config');
  const aggregate = structuredClone(snapshot.config);
  const existingRoute = aggregate.logical_configuration.routes.find((route: { path: string }) => route.path === '/publication-ui-drain');
  assert.equal(existingRoute, undefined, 'use a fresh owned test instance; never reuse or replace an unrelated route');
  let setup;
  if (existingRoute) {
    const bound = aggregate.logical_configuration.services.find((service: { id: string }) => service.id === existingRoute.service_id);
    assert.ok(bound?.endpoints.some((endpoint: { target: string }) => endpoint.target === upstreamTarget), 'existing probe must bind the intended local service');
    const current = await json('/config/runtime');
    setup = { operation_id: current.publication.operation.operation_id };
  } else {
    aggregate.logical_configuration.publication = { ...(aggregate.logical_configuration.publication ?? DEFAULT_PUBLICATION_POLICY), drain_timeout_ms: drainSeconds * 1000 };
    const serviceId = crypto.randomUUID();
    aggregate.logical_configuration.services.push({ id: serviceId, position: aggregate.logical_configuration.services.length, name: 'Local browser drain acceptance', plugins: [],
    endpoints: [{ id: crypto.randomUUID(), position: 0, target: upstreamTarget, weight: 100, priority: 1, is_disabled: false, plugins: [] }] });
    aggregate.logical_configuration.routes.push({ id: crypto.randomUUID(), position: aggregate.logical_configuration.routes.length, path: '/publication-ui-drain', service_id: serviceId, plugins: [] });
    setup = await json('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: snapshot.revision, mutation_id: crypto.randomUUID(), aggregate }) });
  }
  receiptPath = resolve(evidence, 'restore-receipt.json');
  const receipt = { schema: 'publication-owned-restore-v1', ownership, originalConfig: snapshot.config, expectedConfig: aggregate,
    expectedRevision: setup.revision, operationId: setup.operation_id };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const setupTerminal = await waitTerminal(setup.operation_id);
  const setupRuntime = await json('/config/runtime');
  results.push({ stage: 'setup', terminal: setupTerminal, publication: setupRuntime.publication });
  // A historical drain exception is recorded, never relabelled successful.
  // Continue UI-only acceptance if the actual new target is confirmed serving.
  assert.equal(setupRuntime.publication.serving_complete, true);
  assert.equal(setupRuntime.publication.serving_revision, setupRuntime.publication.target_revision);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#/config`); await page.locator('#config-drain_timeout_ms').waitFor();
  const request = await fetch(proxy);
  if (request.status !== 200) {
    const body = (await request.text()).slice(0, 2048);
    results.push({ stage: 'proxy-rejected', status: request.status, body, upstreamRequestsReceived: received });
    assert.equal(request.status, 200, body);
  }
  assert.equal(received, 1);
  const reader = request.body!.getReader();
  const first = await reader.read(); assert.equal(first.done, false);
  const headersConfirmedAt = performance.now();
  let bytes = first.value!.byteLength;
  const decoder = new TextDecoder();
  let streamTail = decoder.decode(first.value, { stream: true }).slice(-512);
  let streamEnded = false;
  let streamReadError: string | null = null;
  const consume = (async () => { try { while (true) { const part = await reader.read(); if (part.done) { streamEnded = true; break; } bytes += part.value!.byteLength; streamTail = (streamTail + decoder.decode(part.value, { stream: true })).slice(-512); } } catch (error) { streamEnded = true; streamReadError = String(error); } })();
  await page.locator('#config-drain_timeout_ms').fill(String(drainSeconds));
  // If setup already used D=30s, an independent C edit still starts a real publication.
  const currentC = Number(await page.locator('#config-drain_start_timeout_ms').inputValue());
  await page.locator('#config-drain_start_timeout_ms').fill(String(currentC + 1));
  await page.getByTestId('config-save-button').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config');
  await verifyOwnership();
  const rollingStartedAt = performance.now();
  assert.ok(rollingStartedAt - headersConfirmedAt < 5000, 'setup must leave >D remaining in the finite SSE');
  await page.getByTestId('config-confirm-publish').click();
  const accepted = await (await responsePromise).json();
  receipt.expectedConfig = { ...aggregate, logical_configuration: { ...aggregate.logical_configuration,
    publication: { ...aggregate.logical_configuration.publication, drain_start_timeout_ms: (currentC + 1) * 1000, drain_timeout_ms: drainSeconds * 1000 } } };
  receipt.expectedRevision = accepted.revision; receipt.operationId = accepted.operation_id;
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  results.push({ stage: 'rolling-start', responseHeadersConfirmedBeforeRolling: true, drainSeconds, maximumStreamMs, accepted, ownership });
  const banner = page.getByTestId('configuration-publication-banner');
  await page.waitForFunction(() => /新配置已生效，旧进程收尾尚未完成/.test(document.querySelector('[data-testid="configuration-publication-banner"]')?.textContent ?? ''), undefined, { timeout: 10000 });
  const active = await json('/config/runtime');
  assert.equal(active.publication.operation.state, 'draining');
  assert.equal(active.publication.serving_revision, accepted.revision);
  assert.equal(active.publication.serving_complete, true);
  assert.equal(streamEnded, false);
  results.push({ stage: 'active-draining', accepted, publication: active.publication });
  await page.screenshot({ path: resolve(evidence, 'desktop-real-draining.png'), animations: 'disabled' });
  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 1000 });
  await mobile.goto(`${base}/#/config`); await mobile.locator('#config-drain_timeout_ms').waitFor();
  await mobile.getByTestId('configuration-publication-banner').getByText(/新配置已生效，旧进程收尾尚未完成/).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.screenshot({ path: resolve(evidence, 'mobile-real-draining.png'), animations: 'disabled' });
  await page.waitForFunction(() => /等待结果超时/.test(document.querySelector('[data-testid="config-review"]')?.textContent ?? ''), undefined, { timeout: 20000 });
  assert.equal(streamEnded, false, '15 second client wait must not end the actual stream');
  const waitingStopped = await json('/config/runtime');
  assert.equal(waitingStopped.publication.operation.state, 'draining');
  assert.equal(waitingStopped.publication.serving_complete, true);
  assert.equal(waitingStopped.publication.serving_revision, accepted.revision);
  assert.match(await page.getByTestId('config-review').innerText(), /不代表未提交/);
  assert.equal(await page.getByTestId('config-confirm-publish').isDisabled(), true);
  assert.ok(bytes > first.value!.byteLength);
  assert.match(await banner.innerText(), /新配置已生效，旧进程收尾尚未完成/);
  results.push({ stage: 'client-wait-stopped', accepted, before: setupRuntime.publication, publication: waitingStopped.publication,
    review: await page.getByTestId('config-review').innerText(), repeatPublishDisabled: true, streamBytes: bytes, streamEnded });
  await page.screenshot({ path: resolve(evidence, 'desktop-client-wait-stopped.png'), animations: 'disabled' });
  // Normal flow explicitly finishes before D; deadline flow deliberately does
  // not finish upstream. Only the Runtime's authorised D cutoff may cancel it.
  if (!produceDegraded) for (const controller of [...controllers]) finishStream(controller);
  await consume; assert.equal(streamEnded, true);
  if (!produceDegraded) { assert.equal(streamReadError, null); assert.ok(streamTail.endsWith('data: [DONE]\n\n')); }
  else {
    assert.ok(performance.now() - rollingStartedAt >= drainSeconds * 1000, 'cancellation must not precede the explicit D');
    assert.equal(streamTail.endsWith('data: [DONE]\n\n'), false, 'D cancellation is not successful SSE completion');
  }
  const terminal = await waitTerminal(accepted.operation_id);
  assert.equal(terminal.operation.mutation_id, accepted.operation_id);
  results.push({ stage: 'final-terminal', terminal, streamBytes: bytes, streamEnded, streamReadError,
    doneMarkerReceived: streamTail.endsWith('data: [DONE]\n\n'), producedDegraded: produceDegraded });
  assert.equal(terminal.operation.state, produceDegraded ? 'degraded' : 'converged');
  if (produceDegraded) assert.equal(terminal.operation.error_code, 'old_worker_drain_failed');
  const finalRuntime = await verifyOwnership();
  assert.equal(finalRuntime.revision, accepted.revision);
  assert.equal(finalRuntime.publication.operation.operation_id, accepted.operation_id);
  assert.equal(finalRuntime.publication.serving_complete, true);
  assert.equal(finalRuntime.publication.serving_revision, accepted.revision);
  await page.getByRole('button', { name: '关闭审阅', exact: true }).click();
  await page.getByTestId('config-review').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查询本次发布', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="page-config"]')?.getAttribute('data-submission-phase') === 'terminal');
  assert.equal(await page.getByTestId('publication-retry-button').count(), 0);
  await page.screenshot({ path: resolve(evidence, 'desktop-stream-completed-converged.png'), animations: 'disabled' });
  results.push({ accepted, active: active.publication, waitingStopped: waitingStopped.publication, streamBytes: bytes, streamCompleted: streamEnded, terminal });
  results.push({ stage: 'restore-ready', receiptPath, ownershipProof: resolve(ownership.state, 'runtime/workers', `${finalRuntime.workers[0].worker_instance_id}.json`) });
  await context.close();
  caseCompleted = true;
} finally {
  for (const controller of [...controllers]) { try { finishStream(controller); } catch { clearStream(controller); } }
  upstream.stop(true); await browser.close();
  if (receiptPath && (!deferRestore || !caseCompleted)) {
    try { results.push({ stage: 'restored', result: await restoreOwned(receiptPath) }); }
    catch (error) { errors.push(`Restoration refused or failed; receipt retained: ${String(error)}`); }
  }
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ base, api, proxy, management: 'real', upstream: 'real-local-http-stream', results, errors }, null, 2));
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ base, results, errors, evidence }, null, 2));
