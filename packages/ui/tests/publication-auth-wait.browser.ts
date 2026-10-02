import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Disposable local management credential only; never an upstream/real token.
const base = process.env.PUBLICATION_UI_URL ?? 'http://127.0.0.1:28287';
const local = new URL(base);
assert.ok(['127.0.0.1', 'localhost'].includes(local.hostname));
const uiPort = Number(local.port || 80);
const proxyPort = Number(process.env.PORT ?? uiPort + 1);
const streamPort = Number(process.env.BUNGEE_MANAGEMENT_PORT ?? uiPort + 2) + 3;
const credential = 'local-publication-ui-acceptance-only';
const headers = { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
const evidence = resolve(import.meta.dir, '../../../test-results/publication/ui-auth-wait-browser');
mkdirSync(evidence, { recursive: true });
const read = async (path: string) => {
  const response = await fetch(`${base}/api${path}`, { headers });
  assert.ok(response.status === 200 || (path.startsWith('/config/operations/') && response.status === 202));
  return await response.json();
};
const proof = process.argv.find(arg => arg.startsWith('--instance-proof='))?.slice('--instance-proof='.length);
assert.ok(proof, 'real authentication writes require an explicit isolated worker artifact');
const verify = Bun.spawn([process.execPath, resolve(import.meta.dir, 'publication-draining.browser.ts'),
  '--verify-instance', `--instance-proof=${proof}`], { stdout: 'pipe', stderr: 'pipe', env: process.env });
const verified = await new Response(verify.stdout).text(), verificationError = await new Response(verify.stderr).text();
assert.equal(await verify.exited, 0, verificationError);
const ownership = JSON.parse(verified).ownership;
async function verifyOwnership() {
  const db = statSync(ownership.database);
  assert.equal(db.dev, ownership.databaseDevice); assert.equal(db.ino, ownership.databaseInode);
  const directResponse = await fetch(`http://${local.hostname}:${Number(process.env.BUNGEE_MANAGEMENT_PORT ?? uiPort + 2)}/api/config/runtime`, { headers });
  assert.equal(directResponse.status, 200);
  const direct = await directResponse.json(), ui = await read('/config/runtime');
  assert.equal(ui.revision, direct.revision); assert.equal(ui.content_hash, direct.content_hash);
  assert.ok(direct.workers.length > 0);
  for (const worker of direct.workers) {
    const marker = JSON.parse(readFileSync(resolve(ownership.state, 'runtime/workers', `${worker.worker_instance_id}.json`), 'utf8'));
    assert.equal(marker.master_generation, ownership.generation);
    for (const field of ['master_generation', 'worker_instance_id', 'boot_nonce', 'pid', 'revision', 'content_hash']) assert.equal(marker[field], worker[field]);
    assert.ok(ui.workers.some((reported: any) => reported.worker_instance_id === marker.worker_instance_id && reported.boot_nonce === marker.boot_nonce));
  }
  return direct;
}
const before = await read('/config');
assert.notEqual(before.config.logical_configuration.auth?.enabled, true);
await verifyOwnership();
const browser = await chromium.launch({ headless: true });
const encoder = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
const finishers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>();
const upstream = Bun.serve({ hostname: '127.0.0.1', port: streamPort, idleTimeout: 60, fetch() {
  let timer: ReturnType<typeof setInterval>;
  let deadline: ReturnType<typeof setTimeout>;
  let current: ReadableStreamDefaultController<Uint8Array>;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    current = controller; controllers.add(controller);
    const finish = () => { if (!controllers.has(controller)) return; clearInterval(timer); clearTimeout(deadline); controllers.delete(controller); finishers.delete(controller); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); };
    finishers.set(controller, finish);
    controller.enqueue(encoder.encode(`data: {"started_at":${Date.now()}}\n\n`));
    timer = setInterval(() => { try { controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`)); } catch { clearInterval(timer); clearTimeout(deadline); controllers.delete(controller); finishers.delete(controller); } }, 100);
    deadline = setTimeout(finish, 45000);
  }, cancel() { clearInterval(timer); clearTimeout(deadline); controllers.delete(current); finishers.delete(current); } }), { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
} });
const results: object[] = [];
const errors: string[] = [];
let dispatched = false;
let acceptedOperation: { id: string; revision: number; aggregate: unknown; expectedRevision: number } | null = null;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#/config`); await page.locator('#config-drain_timeout_ms').waitFor();
  const stream = await fetch(`http://${local.hostname}:${proxyPort}/publication-ui-drain`);
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let streamEnded = false, streamTail = '';
  const consume = (async () => { while (true) { const part = await reader.read(); if (part.done) { streamEnded = true; break; } streamTail = (streamTail + decoder.decode(part.value, { stream: true })).slice(-512); } })();
  await page.locator('#settings-access').getByRole('switch').click();
  await page.getByTestId('auth-token-input').fill(credential);
  await page.getByTestId('next-auth-token-input').fill(credential);
  await page.getByTestId('config-save-button').click();
  await page.waitForFunction(() => !(document.querySelector('[data-testid="config-confirm-publish"]') as HTMLButtonElement)?.disabled);
  const response = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/config');
  const baseline = await verifyOwnership();
  assert.equal(baseline.revision, before.revision, 'refuse a changed submission baseline');
  assert.deepEqual(baseline.config, before.config);
  await page.getByTestId('config-confirm-publish').click(); dispatched = true;
  const acceptedResponse = await response;
  const accepted = await acceptedResponse.json();
  acceptedOperation = { id: accepted.operation_id, revision: accepted.revision,
    aggregate: acceptedResponse.request().postDataJSON().aggregate,
    expectedRevision: acceptedResponse.request().postDataJSON().expected_revision };
  assert.equal(acceptedOperation.expectedRevision, before.revision);
  results.push({ stage: 'accepted', operationId: accepted.operation_id, revision: accepted.revision });
  await page.waitForFunction(() => /新配置已生效，旧进程收尾尚未完成/.test(document.querySelector('[data-testid="configuration-publication-banner"]')?.textContent ?? ''), undefined, { timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('bungee_auth_token')), null);
  assert.equal(streamEnded, false);
  await page.waitForFunction(() => /等待结果超时/.test(document.querySelector('[data-testid="config-review"]')?.textContent ?? ''), undefined, { timeout: 20000 });
  const runtime = await read('/config/runtime');
  assert.equal(streamEnded, false, 'client waiting must not truncate the authenticated publication stream');
  assert.equal(runtime.publication.operation.state, 'draining');
  assert.equal(runtime.publication.serving_revision, accepted.revision);
  assert.equal(runtime.publication.serving_complete, true);
  assert.equal(await page.evaluate(() => localStorage.getItem('bungee_auth_token')), null);
  assert.equal(page.url().endsWith('/#/config'), true, 'candidate proof reads must not force a false login failure');
  await page.screenshot({ path: resolve(evidence, 'auth-client-wait-stopped.png'), animations: 'disabled' });
  results.push({ stage: 'auth-client-wait-stopped', publication: runtime.publication, candidateNotPersisted: true, stayedInWorkspace: true });
  for (const finish of [...finishers.values()]) finish();
  await consume; assert.ok(streamTail.endsWith('data: [DONE]\n\n'));
  for (let i = 0; i < 100; i++) {
    const completed = await read('/config/runtime');
    if (completed.publication.operation.state === 'converged') break;
    await Bun.sleep(100);
  }
  assert.equal((await read('/config/runtime')).publication.operation.state, 'converged');
  await page.getByRole('button', { name: '关闭审阅', exact: true }).click();
  await page.getByTestId('config-review').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查询本次发布', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('bungee_auth_token') === 'local-publication-ui-acceptance-only');
  results.push({ stage: 'auth-converged', doneMarkerReceived: true, candidatePersistedOnlyAfterConvergence: true });
  await context.close();
} finally {
  for (const finish of [...finishers.values()]) { try { finish(); } catch {} }
  upstream.stop(true);
  await browser.close();
  if (dispatched && acceptedOperation) {
    assert.equal(acceptedOperation.expectedRevision, before.revision, 'refuse restoration from a different submission baseline');
    // Restore anonymous access using actual CAS writes, after the active operation
    // ends. Do not cancel it or mutate the database behind the service.
    let terminal;
    for (let i = 0; i < 650; i++) {
      terminal = await read('/config/runtime');
      if (['converged', 'degraded'].includes(terminal.publication.operation?.state)) break;
      await Bun.sleep(100);
    }
    assert.equal(terminal.publication.operation.operation_id, acceptedOperation.id);
    assert.ok(['converged', 'degraded'].includes(terminal.publication.operation.state));
    await verifyOwnership();
    results.push({ stage: 'auth-terminal', publication: terminal.publication });
    const snapshot = await read('/config');
    assert.equal(snapshot.revision, acceptedOperation.revision, 'refuse restoration over a concurrent write');
    assert.deepEqual(snapshot.config, acceptedOperation.aggregate);
    if (snapshot.config.logical_configuration.auth?.tokens?.includes(credential)) {
      const aggregate = before.config;
      const response = await fetch(`${base}/api/config`, { method: 'PUT', headers,
        body: JSON.stringify({ expected_revision: snapshot.revision, mutation_id: crypto.randomUUID(), aggregate }) });
      assert.equal(response.status, 202);
      const restored = await response.json();
      results.push({ stage: 'restore-anonymous-access', status: response.status, body: restored });
      let restoredState;
      for (let i = 0; i < 650; i++) {
        restoredState = await read(`/config/operations/${restored.operation_id}`);
        if (['converged', 'degraded'].includes(restoredState.operation.state)) break;
        await Bun.sleep(100);
      }
      assert.equal(restoredState.operation.state, 'converged');
      const original = await read('/config');
      assert.equal(original.revision, restored.revision); assert.deepEqual(original.config, before.config);
      results.push({ stage: 'restored-original-auth', revision: original.revision });
    }
  } else if (dispatched) {
    results.push({ stage: 'restoration-refused', reason: 'original operation was not acknowledged; retain isolated instance for inspection' });
  }
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ base, credentialScope: 'disposable local management only', results, errors }, null, 2));
}
assert.deepEqual(errors, []);
console.log(JSON.stringify({ base, results, errors, evidence }, null, 2));
