import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from '@bungee/ws-client';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import type { ChainQueryResult, LogQueryResult } from '../../packages/core/src/api/logs';
import { createCodexRouterGatewayFixture, seedCodexRouterCatalog } from '../helpers/codex-router-gateway-fixture';
import {
  cleanupGatewayFixture, quarantinePortBlock, recordOwnedWorkers, releasePortBlock, requestJson,
  reservePortBlock, startTrackedGatewayMaster, stopOwnedMaster, waitForHealth, waitUntil,
  type GatewayFixture, type GatewayMasterStartupState, type OwnedMaster, type PortLease,
} from '../helpers/gateway-runtime';

let fixture: GatewayFixture;
let lease: PortLease;
let master: OwnedMaster | undefined;
let upstream: ReturnType<typeof Bun.serve<string>>;
const startup: GatewayMasterStartupState = { attempted: false, errors: [] };
const sockets = new Set<WebSocket>();
const expectedDisconnectOperationCounts = new Map<string, number>();
const management = () => `http://127.0.0.1:${lease.base}`;
const proxy = () => `http://127.0.0.1:${lease.block.ports[1]}`;
const failurePlugin = 'request-logging-candidate-gate';
const hostedStreamPlugin = 'request-logging-stream-fixture';
const jsonHeaders = { 'content-type': 'application/json' };
const largeBodyBytes = 36 * 1024 * 1024;
const largeChunk = new TextEncoder().encode('x'.repeat(64 * 1024));
const encoder = new TextEncoder();
const responseDeltas = Array.from({ length: 512 }, (_, sequence_number) => ({
  type: 'response.output_text.delta', sequence_number, delta: 'x',
}));
let finishHeldOperation: (() => void) | undefined;
let finishHeldResponse: (() => void) | undefined;
let receivedUnansweredCreate: (() => void) | undefined;
const largeWebSocketBytes = 9 * 1024 * 1024;

async function startMaster() {
  try { master = await startTrackedGatewayMaster(startup, fixture, lease); }
  catch (error) { master = startup.master; throw error; }
  await waitForHealth(master, lease.base, fixture);
}

async function snapshot() {
  const result = await requestJson(`${management()}/api/config`, {}, fixture);
  expect(result.response.status).toBe(200);
  return result.body as { revision: number; config: ConfigurationAggregate };
}

async function waitForPublication(mutation: string, revision: number) {
  await waitUntil(async () => {
    const result = await requestJson(`${management()}/api/config/operations/${mutation}`, {}, fixture);
    const operation = (result.body as { operation?: { state: string; committed_revision: number } }).operation;
    if (operation?.state === 'failed' || operation?.state === 'degraded') {
      throw new Error(`Log fixture publication did not converge: ${result.text}`);
    }
    return operation?.state === 'converged' && operation.committed_revision === revision;
  }, 'request log fixture publication did not converge', 35000);
  const runtime = await requestJson(`${management()}/api/config/runtime`, {}, fixture);
  expect(runtime.response.status).toBe(200);
  const body = runtime.body as { workers: Parameters<typeof recordOwnedWorkers>[1]; publication: { serving_revision: number } };
  await recordOwnedWorkers(master!, body.workers);
  return body.publication;
}

async function publish(revision: number, aggregate: ConfigurationAggregate) {
  const mutation = randomUUID();
  const result = await requestJson(`${management()}/api/config`, {
    method: 'PUT', headers: jsonHeaders,
    body: JSON.stringify({ expected_revision: revision, mutation_id: mutation, aggregate }),
  }, fixture);
  expect(result.response.status, result.text).toBe(202);
  return waitForPublication(mutation, revision + 1);
}

async function setCollection(action: 'enable' | 'disable', whileServing?: (revision: number) => Promise<void>) {
  const { revision } = await snapshot();
  const mutation = randomUUID();
  const result = await requestJson(`${management()}/api/plugins/request-logs/${action}`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ expected_revision: revision, mutation_id: mutation }),
  }, fixture);
  expect(result.response.status, result.text).toBe(202);
  await whileServing?.(revision + 1);
  expect(await waitForPublication(mutation, revision + 1)).toMatchObject({ serving_revision: revision + 1 });
  return revision + 1;
}

function sse(payload: unknown): Response {
  return new Response(`data: ${JSON.stringify(payload)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

async function queryLogs(path: string, groupBy?: 'chain') {
  const query = new URLSearchParams({ path, limit: '50', ...(groupBy ? { groupBy } : {}) });
  const result = await requestJson(`${management()}/api/logs?${query}`, {}, fixture);
  expect(result.response.status).toBe(200);
  return (result.body as LogQueryResult | ChainQueryResult).data;
}

function storedRequestKinds(path: string): Array<string | null> {
  const db = new Database(fixture.accessDbPath, { readonly: true });
  try {
    return db.query<{ record_kind: string | null }, [string]>(
      'SELECT record_kind FROM access_logs WHERE path = ?',
    ).all(path).map(row => row.record_kind);
  } finally { db.close(); }
}

async function loadBody(bodyId: string | undefined) {
  expect(bodyId).toBeString();
  const result = await requestJson(`${management()}/api/logs/body/${bodyId}`, {}, fixture);
  expect(result.response.status, result.text).toBe(200);
  expect(result.body).toMatchObject({ bodyId });
  return (result.body as { content: unknown }).content;
}

async function echoHttp(name: string, type = 'text/plain', body = '日志正文') {
  const path = `/plain/body/${name}`;
  const response = await fetch(`${proxy()}${path}`, { method: 'POST', headers: { 'content-type': type }, body });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe(type);
  expect(await response.text()).toBe(body);
  return path;
}

async function waitForHttpRecords(path: string, withBody = true) {
  let rows: LogQueryResult['data'] = [];
  await waitUntil(async () => {
    rows = await queryLogs(path);
    return rows.some(row => row.recordKind === 'access' && row.transportOutcome === 'completed')
      && rows.some(row => row.recordKind === 'attempt' && (!withBody || (row.reqBodyId && row.respBodyId)));
  }, `finished request log records missing for ${path}`, 12000);
  return rows;
}

async function connect(path: string) {
  const socket = new WebSocket(`${proxy().replace('http:', 'ws:')}${path}`);
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket handshake deadline')); }, 5000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  return socket;
}

async function close(socket: WebSocket) {
  socket.close(1000);
  await waitUntil(() => socket.readyState === WebSocket.CLOSED, 'client did not close', 5000);
}

beforeAll(async () => {
  fixture = await createCodexRouterGatewayFixture();
  const gatePath = join(fixture.pluginsPath, failurePlugin);
  await mkdir(gatePath);
  await writeFile(join(gatePath, 'manifest.json'), JSON.stringify({
    name: failurePlugin, version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], runtimeScope: 'global', main: 'index.js',
    uiExtensionMode: 'none', engines: { bungee: '^6.0.0' },
  }));
  await writeFile(join(gatePath, 'index.js'), `export default class {
    static name = '${failurePlugin}'; static version = '1.0.0';
    bodyRequirements() { return { request: 'none' }; }
    init() { throw new Error('candidate gate rejected worker initialization'); }
    register() {}
  }`);
  const streamPluginPath = join(fixture.pluginsPath, hostedStreamPlugin);
  await mkdir(streamPluginPath);
  await writeFile(join(streamPluginPath, 'manifest.json'), JSON.stringify({
    name: hostedStreamPlugin, version: '1.0.0', schemaVersion: 3, artifactKind: 'runtime-plugin',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], runtimeScope: 'scoped', main: 'index.js',
    uiExtensionMode: 'none', engines: { bungee: '^6.0.0' },
  }));
  await writeFile(join(streamPluginPath, 'index.js'), `export default class {
    static name = '${hostedStreamPlugin}'; static version = '1.0.0';
    bodyRequirements(context) { return { request: ['/chatgpt/stream-check/responses', '/chatgpt/disconnect/responses'].includes(context.url.pathname) ? 'json-read' : 'none' }; }
    register(hooks) {
      hooks.onInterceptRequest.tapPromise('${hostedStreamPlugin}', async context => {
        if (context.originalUrl.pathname === '/chatgpt/disconnect/responses') {
          const response = { id: crypto.randomUUID(), object: 'response', status: 'completed', model: context.body.model, output: [] };
          const stream = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'response.completed', response }) + '\\n\\n'));
          } });
          return { action: 'respond', response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) };
        }
        if (context.originalUrl.pathname !== '/chatgpt/stream-check/responses') return;
        const { input } = context.body;
        if (!['stream-terminal', 'stream-eof', 'stream-invalid-tail'].includes(input)) throw new Error('Unexpected stream fixture input');
        const response = { id: crypto.randomUUID(), object: 'response', status: 'in_progress', model: context.body.model, output: [] };
        const messages = [
          { type: 'response.created', response },
          { type: 'error', code: 'server_error', message: 'fixture intermediate error', param: null, sequence_number: 1 },
        ];
        if (input === 'stream-terminal') messages.push({ type: 'response.failed', response: { ...response, status: 'failed' } });
        if (input === 'stream-invalid-tail') messages.push(
          { type: 'response.completed', response: { ...response, status: 'completed' } },
          { type: 'response.output_text.delta', delta: 'late' },
        );
        const stream = messages.map(event => 'data: ' + JSON.stringify(event) + '\\n\\n').join('');
        return { action: 'respond', response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) };
      });
    }
  }`);
  lease = await reservePortBlock();
  upstream = Bun.serve<string>({
    hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (request.headers.get('upgrade') === 'websocket' && [
        '/responses', '/drain/responses', '/body-check/responses', '/body-disabled/responses', '/replay-check/responses', '/echo', '/live',
        '/disconnect/responses', '/disconnect-before-terminal/responses', '/upstream-close/responses',
      ].includes(path)) {
        if (server.upgrade(request, { data: path })) return;
      }
      if (path === '/events' && request.method === 'GET') return sse({ type: 'response.failed', custom: true });
      if (path === '/plain-payload/responses') {
        return new Response('data: {"type":"response.failed","custom":true}\n\nevent: error\ndata: {"error":{"message":"socket disconnected","code":"BROKER_UNAVAILABLE"}}\n\ndata: {"type":"error","message":"queue interrupted","sequence_number":2}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (path === '/stream-error') return sse({ type: 'error', code: 'server_error', message: 'fixture', param: null, sequence_number: 0 });
      if (path.startsWith('/sse-disconnect/')) {
        const status = path.endsWith('/success') ? 'completed' : path.endsWith('/failure') ? 'failed' : 'in_progress';
        const type = status === 'in_progress' ? 'response.created' : `response.${status}`;
        const payload = path.endsWith('/plain') ? { message: 'plain event' }
          : { type, response: { id: randomUUID(), object: 'response', status } };
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/hold') {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: before\n\n'));
          finishHeldResponse = () => { controller.enqueue(encoder.encode('data: after\n\n')); controller.close(); };
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path.startsWith('/body/') && request.method === 'POST') {
        return new Response(request.body, { headers: { 'content-type': request.headers.get('content-type')! } });
      }
      if (path === '/large-json' || path === '/large-over-limit') {
        let sent = 0;
        let opened = false;
        const bytes = path === '/large-json' ? largeBodyBytes : largeBodyBytes + largeChunk.byteLength;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!opened) { opened = true; controller.enqueue(encoder.encode('{"data":"')); return; }
            if (sent === bytes) { controller.enqueue(encoder.encode('"}')); controller.close(); return; }
            sent += largeChunk.byteLength;
            controller.enqueue(largeChunk);
          },
        }, { highWaterMark: 0 }), { headers: jsonHeaders });
      }
      if (path === '/generate') {
        return Response.json({ modelVersion: 'gemini-fixture', candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model' } }] });
      }
      if (path === '/stream') {
        return sse({ modelVersion: 'gemini-fixture', candidates: [{ index: 0, finishReason: 'SAFETY' }] });
      }
      if (['/responses', '/aliased'].includes(path) && request.method === 'POST') {
        const body = await request.json() as { model: string };
        if (body.model === 'org/native') {
          return Response.json({ error: { code: 'codex_router_generation_cancelled', message: 'Upstream fixture rejection' } }, { status: 422 });
        }
        const failed = body.model === 'fail';
        const status = failed ? 'failed' : 'completed';
        const response = { type: `response.${status}`, response: { id: randomUUID(), object: 'response', status, model: body.model, output: [] } };
        if (failed) {
          const opening = { type: 'response.created', response: { ...response.response, status: 'in_progress' } };
          const unrelated = { type: 'response.completed', response: { ...response.response, id: randomUUID(), status: 'completed' } };
          return new Response(Bun.gzipSync([opening, unrelated, response].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), {
            headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' },
          });
        }
        return sse(response);
      }
      return new Response('Unexpected upstream route', { status: 404 });
    },
    websocket: { message(socket, raw) {
      if (socket.data === '/echo') { socket.send(raw); return; }
      const body = JSON.parse(String(raw));
      if (socket.data === '/live') {
        const send = (message: object) => socket.send(new TextEncoder().encode(JSON.stringify(message)));
        if (body.setup) send({ setupComplete: {} });
        if (body.clientContent?.turnComplete) {
          send({ serverContent: { modelTurn: { role: 'model', parts: [{ text: 'fixture' }] } } });
          send({ serverContent: { turnComplete: true } });
        }
        if (body.realtimeInput) {
          send({ serverContent: { interrupted: true } });
          send({ serverContent: { turnComplete: true } });
        }
        return;
      }
      if (body.model === 'unbound-rejection' || body.model === 'default-rejection') {
        const code = body.model === 'default-rejection' ? 'previous_response_not_found' : 'invalid_request';
        socket.send(JSON.stringify({ type: 'error', stream_id: body.stream_id, error: { code } }));
        return;
      }
      if (body.model === 'replay-a') {
        socket.send(JSON.stringify({ type: 'error', stream_id: body.stream_id, error: { code: 'previous_response_not_found' } }));
        return;
      }
      if (body.model === 'replay-b') {
        const late = { id: randomUUID(), object: 'response', model: 'replay-a', output: [] };
        socket.send(JSON.stringify({ type: 'response.created', stream_id: body.stream_id, response: { ...late, status: 'in_progress' } }));
        socket.send(JSON.stringify({ type: 'response.completed', stream_id: body.stream_id, response: { ...late, status: 'completed' } }));
      }
      if (body.model === 'no-opening') {
        receivedUnansweredCreate?.();
        return;
      }
      const response = { id: randomUUID(), object: 'response', model: body.model, output: [],
        ...(body.model === 'large-lifecycle' ? { payload: body.input } : {}),
      };
      socket.send(JSON.stringify({ type: 'response.created', stream_id: body.stream_id, response: { ...response, status: 'in_progress' } }));
      if (body.model === 'unfinished') return;
      const terminal = JSON.stringify({ type: 'response.completed', stream_id: body.stream_id, response: { ...response, status: 'completed' } });
      if (socket.data === '/upstream-close/responses') {
        socket.send(terminal);
        socket.close(1011, 'fixture upstream failure');
        return;
      }
      if (body.model === 'held-operation') { finishHeldOperation = () => socket.send(terminal); return; }
      if (body.model === 'parallel' || body.model === 'success') {
        for (const delta of responseDeltas) socket.send(JSON.stringify(delta));
      }
      if (body.model === 'large-ws') {
        socket.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(65536) }));
      }
      if (body.model === 'overlap-ws') socket.send(JSON.stringify(responseDeltas[0]));
      socket.send(terminal);
      socket.send(terminal);
    } },
  });
  await startMaster();
  await seedCodexRouterCatalog(fixture);
  const initial = await snapshot();
  expect(initial.config.plugin_activations).toContainEqual({ plugin_name: 'request-logs' });
  const errorTarget = randomUUID();
  const binding = (name: string, position: number, options?: object) => ({ id: randomUUID(), name, position, enabled: true, ...(options && { options }) });
  const routes = ['/codex/', '/chatgpt/', '/plain/', '/http-target/', '/gemini/'].map((path, position) => ({
    id: position === 3 ? errorTarget : randomUUID(), position, path, websocket: { enabled: position !== 3 },
    path_rewrite: { [`^${path.slice(0, -1)}`]: '' },
    endpoints: [{ id: randomUUID(), position: 1, target: `http://127.0.0.1:${upstream.port}`, weight: 100, priority: 1, is_disabled: false, plugins: [] }],
    plugins: position === 1 ? [binding('codex-router', 1, { models: [{
      provider: 'lab', source: 'upstream-error', model: 'org/native',
      target: { type: 'route', id: errorTarget, protocol: 'responses' },
    }] }), binding(hostedStreamPlugin, 2)] : [],
  }));
  await publish(initial.revision, {
    plugin_activations: [...initial.config.plugin_activations, ...['models-dev', 'llm-protocol-adapter', 'codex-router', hostedStreamPlugin].map(plugin_name => ({ plugin_name }))],
    logical_configuration: { routes, plugins: [], services: [], logging: { body: { enabled: true, max_size: 65536, retention_days: 1 } } },
  });
}, 90000);

afterAll(async () => {
  for (const socket of sockets) socket.terminate();
  const errors: unknown[] = [...startup.errors];
  let stopped = false;
  let released = !startup.attempted;
  try { if (master) { await stopOwnedMaster(master); stopped = true; } } catch (error) { errors.push(error); }
  if (stopped) {
    // The logs API can hide extra rows, so inspect storage after its writers have exited.
    for (const [path, count] of expectedDisconnectOperationCounts) {
      try { expect(storedRequestKinds(path), path).toEqual(Array(count).fill('operation')); }
      catch (error) { errors.push(error); }
    }
  }
  try { await upstream?.stop(true); } catch (error) { errors.push(error); }
  try { if (lease) { await releasePortBlock(lease); released = true; } } catch (error) { quarantinePortBlock(lease); errors.push(error); }
  if (fixture) {
    try {
      if (!await cleanupGatewayFixture(fixture, { startupAttempted: startup.attempted, master, shutdownVerified: stopped, portsVerifiedClosed: released })) {
        errors.push(new Error('Fixture cleanup could not verify process ownership'));
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'request logging storage verification or fixture cleanup failed');
}, 45000);

test('ordinary HTTP records only supported bodies and ordinary WebSocket stays outside request logs', async () => {
  const plainWs = await connect('/plain/echo');
  const echo = new Promise<string>(resolve => plainWs.once('message', data => resolve(String(data))));
  plainWs.send('{"type":"response.create","model":"plain"}');
  expect(await echo).toContain('"type":"response.create"');
  await close(plainWs);
  const plainSse = await fetch(`${proxy()}/plain/events`);
  expect(plainSse.status).toBe(200);
  expect(await plainSse.text()).toContain('"type":"response.failed"');
  const representations = [
    ['json', 'application/json', '{ "value": 1 }', { value: 1 }],
    ['vendor-json', 'application/vnd.fixture+json; charset=utf-8', '{ "value": 2 }', { value: 2 }],
    ['text', 'text/plain; charset=utf-8', '日志正文', '日志正文'],
    ['invalid-json', 'application/json', '{invalid', undefined],
    ['unknown-type', 'application/octet-stream', 'opaque body', undefined],
  ] as const;
  await Promise.all(representations.map(async ([name, type, body, content]) => {
    const path = await echoHttp(name, type, body);
    const rows = await waitForHttpRecords(path, content !== undefined);
    const attempt = rows.find(row => row.recordKind === 'attempt')!;
    expect(rows.filter(row => row.recordKind === 'operation')).toEqual([]);
    if (content === undefined) {
      expect(rows.every(row => !row.originalReqBodyId && !row.reqBodyId && !row.respBodyId)).toBe(true);
    } else {
      for (const bodyId of [attempt.reqBodyId, attempt.respBodyId]) {
        expect(await loadBody(bodyId)).toEqual(content);
      }
    }
  }));
  const plain = await waitForHttpRecords('/plain/events', false);
  expect(plain.find(row => row.recordKind === 'access')).toMatchObject({ status: 200, transportType: 'http', transportOutcome: 'completed' });
  expect(plain.every(row => row.recordKind !== 'operation' && !row.respBodyId && row.protocolOutcome === undefined)).toBe(true);
  const plainResponsesPath = '/codex/plain-payload/responses';
  const plainResponses = await fetch(`${proxy()}${plainResponsesPath}`, { method: 'POST' });
  expect(await plainResponses.text()).toContain('"custom":true');
  expect((await waitForHttpRecords(plainResponsesPath, false)).every(row => row.recordKind !== 'operation' && !row.respBodyId)).toBe(true);
  expect(await queryLogs('/plain/echo')).toEqual([]);
  expect(storedRequestKinds('/plain/echo')).toEqual([]);
}, 45000);

test('HTTP SSE records its access and both WebSocket paths record one row per confirmed client request', async () => {
  const failed = await fetch(`${proxy()}/codex/aliased`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fail', input: 'test', stream: true }),
  });
  expect(failed.status).toBe(200);
  expect(await failed.text()).toContain('response.failed');

  const errorPath = '/codex/stream-error';
  const error = await fetch(`${proxy()}${errorPath}`, { method: 'POST' });
  expect(await error.text()).toContain('server_error');
  const native = await connect('/codex/responses');
  const nativeEvents: Array<{ type: string }> = [];
  native.on('message', raw => nativeEvents.push(JSON.parse(String(raw))));
  const nativeRequest = { type: 'response.create', model: 'parallel', stream_id: 'parallel', input: [] };
  native.send(JSON.stringify(nativeRequest));
  await waitUntil(() => nativeEvents.filter(event => event.type === 'response.completed').length === 2, 'named stream did not finish', 5000);
  expect(nativeEvents.filter(event => event.type === 'response.output_text.delta')).toEqual(responseDeltas);
  for (const model of ['first', 'second', 'unfinished']) {
    const openings = nativeEvents.filter(event => event.type === 'response.created').length;
    native.send(JSON.stringify({ type: 'response.create', model, input: [] }));
    await waitUntil(() => nativeEvents.filter(event => event.type === 'response.created').length > openings,
      'request did not open before sending the next request on the same stream', 5000);
  }
  await waitUntil(() => nativeEvents.filter(event => event.type === 'response.created').length === 4,
    'known requests did not open', 5000);
  for (const model of ['default-rejection', 'unbound-rejection', 'ambiguous']) {
    native.send(JSON.stringify({ type: 'response.create', model, input: [] }));
  }
  await waitUntil(() => nativeEvents.filter(event => event.type === 'response.completed').length === 8
    && nativeEvents.filter(event => event.type === 'response.created').length === 5, 'raw frames did not reach the client', 5000);
  native.send(JSON.stringify({ type: 'response.create', model: 'unbound-rejection', stream_id: 'isolated', input: [] }));
  await waitUntil(() => nativeEvents.filter(event => event.type === 'error').length === 3, 'scoped error did not arrive', 5000);
  native.send(JSON.stringify({ type: 'response.create', model: 'recovered', stream_id: 'isolated', input: [] }));
  await waitUntil(() => nativeEvents.filter(event => event.type === 'response.completed').length === 10, 'scoped requests did not recover', 5000);
  await close(native);

  const managed = await connect('/chatgpt/responses');
  const managedEvents: Array<{ type: string }> = [];
  managed.on('message', raw => managedEvents.push(JSON.parse(String(raw))));
  const managedRequest = { type: 'response.create', model: 'success', input: [], client_metadata: { trace: 'client' } };
  managed.send(JSON.stringify(managedRequest));
  await waitUntil(() => managedEvents.some(event => event.type === 'response.completed'), 'managed generation did not complete', 5000);
  const managedDeltas = managedEvents.filter(event => event.type === 'response.output_text.delta');
  expect(managedDeltas.length).toBe(responseDeltas.length);
  expect(managedDeltas).toEqual(responseDeltas);
  managed.send(JSON.stringify({ type: 'response.create', input: [] }));
  await waitUntil(() => managedEvents.some(event => event.type === 'error'), 'managed local rejection did not arrive', 5000);
  managed.send(JSON.stringify({ type: 'response.create', model: 'upstream-error', input: [] }));
  await waitUntil(() => managedEvents.filter(event => event.type === 'error').length === 2, 'managed upstream rejection did not arrive', 5000);
  await close(managed);

  await waitUntil(async () => {
    const codex = await queryLogs('/codex/responses');
    const aliased = await queryLogs('/codex/aliased');
    const chatgpt = await queryLogs('/chatgpt/responses');
    expect(codex.filter(row => row.recordKind === 'operation' && row.observationOutcome)).toHaveLength(4);
    expect(codex.some(row => row.recordKind === 'operation' && row.originalReqBodyId && row.respBodyId)).toBe(true);
    expect((await queryLogs(errorPath)).some(row => row.recordKind === 'operation' && row.protocolOutcome === 'failed')).toBe(true);
    expect(aliased.some(row => row.recordKind === 'operation' && row.protocolOutcome === 'failed')).toBe(true);
    expect(aliased.some(row => row.recordKind === 'attempt' && row.respBodyId)).toBe(true);
    expect(aliased.some(row => row.recordKind === 'access' && row.transportOutcome === 'completed')).toBe(true);
    expect(chatgpt.filter(row => row.recordKind === 'operation' && row.observationOutcome)).toHaveLength(3);
    expect(chatgpt.filter(row => row.recordKind === 'operation').every(row => row.originalReqBodyId && row.respBodyId)).toBe(true);
    return true;
  }, 'HTTP access or finished WebSocket operations were not flushed', 12000);

  const codex = await queryLogs('/codex/responses');
  const aliased = await queryLogs('/codex/aliased');
  const http = aliased.find(row => row.recordKind === 'access' && row.transportType === 'http')!;
  expect(http).toMatchObject({ status: 200, transportOutcome: 'completed' });
  expect(aliased.filter(row => row.accessId === http.accessId && row.recordKind === 'operation')).toEqual([
    expect.objectContaining({ protocol: 'responses', operation: 'response.create', protocolOutcome: 'failed', status: 200 }),
  ]);
  const httpAttempt = aliased.find(row => row.accessId === http.accessId && row.recordKind === 'attempt');
  expect(await loadBody(httpAttempt?.respBodyId)).toEqual([
    { event: 'message', data: { type: 'response.created', response: { id: expect.any(String), object: 'response', status: 'in_progress', model: 'fail', output: [] } } },
    { event: 'message', data: { type: 'response.failed', response: { id: expect.any(String), object: 'response', status: 'failed', model: 'fail', output: [] } } },
  ]);
  const nativeOperations = codex;
  const nativeAccessId = nativeOperations[0]?.accessId;
  expect(nativeAccessId).toBeString();
  expect(nativeOperations.every(row => row.recordKind === 'operation' && row.accessId === nativeAccessId)).toBe(true);
  expect(storedRequestKinds('/codex/responses')).toEqual(['operation', 'operation', 'operation', 'operation']);
  expect(new Set(nativeOperations.map(row => row.operationId)).size).toBe(4);
  expect(nativeOperations.filter(row => row.protocolOutcome === 'completed')).toEqual(Array.from({ length: 3 }, () =>
    expect.objectContaining({ transportOutcome: 'completed', observationOutcome: 'complete' })));
  const unfinished = nativeOperations.filter(row => row.observationOutcome === 'incomplete');
  expect(unfinished).toHaveLength(1);
  expect(unfinished.every(row => row.protocolOutcome === undefined && row.transportOutcome === 'unknown')).toBe(true);
  expect(unfinished[0]?.respBodyId).toBeUndefined();
  const nativeResponses = nativeEvents.slice(0, 2 + responseDeltas.length);
  const nativeBodies = await Promise.all(nativeOperations.filter(row => row.originalReqBodyId).map(async row => ({
    row, request: await loadBody(row.originalReqBodyId),
  })));
  const burst = nativeBodies.find(({ request }) => (request as { model?: string }).model === 'parallel');
  expect(burst?.request).toEqual(nativeRequest);
  expect(await loadBody(burst?.row.respBodyId)).toEqual(nativeResponses);
  const codexChains = await queryLogs('/codex/responses', 'chain');
  expect(codexChains).toHaveLength(4);
  expect(codexChains.filter(row => row.recordKind === 'operation' && row.protocolOutcome === 'completed')).toEqual(
    Array.from({ length: 3 }, () => expect.objectContaining({ method: 'GET', chainStatus: 101, chainTransportOutcome: 'completed' })),
  );
  expect((await queryLogs('/codex/aliased', 'chain')).find(row => row.requestId === http.requestId)).toMatchObject({
    status: 200, transportOutcome: 'completed', protocol: 'responses', protocolOutcome: 'failed',
  });

  const managedOperations = await queryLogs('/chatgpt/responses');
  const managedAccessId = managedOperations[0]?.accessId;
  expect(managedAccessId).toBeString();
  expect(storedRequestKinds('/chatgpt/responses')).toEqual(['operation', 'operation', 'operation']);
  expect(managedOperations.map(row => row.protocolOutcome).sort()).toEqual(['completed', 'failed', 'failed']);
  expect(managedOperations.every(row => row.transportOutcome === 'completed' && row.observationOutcome === 'complete')).toBe(true);
  expect(managedOperations.every(row => row.recordKind === 'operation' && row.accessId === managedAccessId
    && row.method === 'GET' && row.status === 101 && row.operation === 'response.create')).toBe(true);
  const completed = managedOperations.find(row => row.protocolOutcome === 'completed');
  expect(await loadBody(completed?.originalReqBodyId)).toEqual(managedRequest);
  expect(await loadBody(completed?.respBodyId)).toEqual(managedEvents.filter(event => event.type !== 'error'));
  for (const failed of managedOperations.filter(row => row.protocolOutcome === 'failed')) {
    const request = await loadBody(failed.originalReqBodyId) as { model?: string };
    const errorIndex = request.model === 'upstream-error' ? 1 : 0;
    expect(await loadBody(failed.respBodyId)).toEqual([managedEvents.filter(event => event.type === 'error')[errorIndex]]);
  }
  expect(await queryLogs('/chatgpt/responses', 'chain')).toHaveLength(3);
  const exported = await requestJson(`${management()}/api/logs/export?format=json&groupBy=chain&accessId=${managedAccessId}`, {}, fixture);
  expect(exported.response.status).toBe(200);
  expect((exported.body as LogQueryResult['data']).map(row => row.recordKind)).toEqual(['operation', 'operation', 'operation']);
}, 45000);

test('Responses SSE success survives client disconnect', async () => {
  for (const [name, expected, protocol] of [
    ['success', 'completed', 'completed'],
    ['failure', 'cancelled', 'failed'],
    ['unfinished', 'cancelled', undefined],
    ['plain', 'cancelled', undefined],
  ] as const) {
    const path = `/codex/sse-disconnect/${name}`;
    const abort = new AbortController();
    const response = await fetch(`${proxy()}${path}`, { method: 'POST', signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let received = '';
    const decoder = new TextDecoder();
    while (!received.includes('\n\n')) {
      const part = await reader.read();
      expect(part.done).toBe(false);
      received += decoder.decode(part.value, { stream: true });
    }
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitUntil(async () => {
      const rows = await queryLogs(path, 'chain');
      const access = rows.find(row => row.recordKind === 'access');
      return access?.transportOutcome === expected && access.transportCode === 'client_cancelled'
        && access.success === (expected === 'completed') && access.protocolOutcome === protocol
        && (name !== 'unfinished' || access.observationOutcome === 'incomplete');
    }, `wrong result after client stopped SSE ${name}`, 12000);
  }
}, 45000);

test('Responses WS success survives client disconnect only after confirmed completion', async () => {
  for (const [path, type, model, code] of [
    ['/codex/disconnect/responses', 'response.completed', 'fixture', 1006],
    ['/chatgpt/disconnect/responses', 'response.completed', 'fixture', 1006],
    ['/codex/disconnect-before-terminal/responses', 'response.created', 'unfinished', 1006],
    ['/codex/upstream-close/responses', 'response.completed', 'fixture', 1011],
  ] as const) {
    const socket = await connect(path);
    const closed = new Promise<number>(resolve => socket.once('close', resolve));
    const terminal = new Promise<void>(resolve => {
      socket.on('message', raw => {
        if (JSON.parse(String(raw)).type !== type) return;
        if (code === 1006) socket.terminate();
        resolve();
      });
    });
    socket.send(JSON.stringify({ type: 'response.create', model, input: [] }));
    await waitUntil(() => socket.readyState === WebSocket.CLOSED, `WS fixture did not close ${path}`, 5000);
    await terminal;
    expect(await closed).toBe(code);
    const completed = model !== 'unfinished';
    await waitUntil(async () => {
      const rows = await queryLogs(path);
      const operation = rows[0];
      return rows.length === 1 && operation?.recordKind === 'operation' && operation.success === completed
        && operation.observationOutcome === (completed ? 'complete' : 'incomplete')
        && operation.protocolOutcome === (completed ? 'completed' : undefined)
        && operation.transportOutcome === (completed ? 'completed' : 'unknown');
    }, `wrong result after WS close ${path}`, 12000);
    expectedDisconnectOperationCounts.set(path, 1);
  }
  const path = '/codex/disconnect-before-terminal/responses';
  const socket = await connect(path);
  const firstTerminal = new Promise<void>(resolve => {
    socket.on('message', raw => {
      if (JSON.parse(String(raw)).type === 'response.completed') resolve();
    });
  });
  socket.send(JSON.stringify({ type: 'response.create', model: 'fixture', input: [] }));
  await firstTerminal;
  const unanswered = Promise.withResolvers<void>();
  receivedUnansweredCreate = unanswered.resolve;
  socket.send(JSON.stringify({ type: 'response.create', model: 'no-opening', input: [] }));
  await unanswered.promise;
  socket.terminate();
  await waitUntil(() => socket.readyState === WebSocket.CLOSED, 'client did not close after unanswered request', 5000);
  await waitUntil(async () => {
    const rows = await queryLogs(path);
    return rows.length === 2 && rows.some(row => row.protocolOutcome === 'completed' && row.transportOutcome === 'completed');
  }, 'the confirmed WebSocket operation lost its terminal result', 12000);
  expectedDisconnectOperationCounts.set(path, 2);
}, 45000);

test('WebSocket body limits and ambiguous frames leave operation outcomes intact', async () => {
  const path = '/codex/body-check/responses';
  const socket = await connect(path);
  const received: Array<{ type: string; response?: { model: string } }> = [];
  socket.on('message', raw => received.push(JSON.parse(String(raw))));
  const create = (model: string, stream_id: string) => socket.send(JSON.stringify({
    type: 'response.create', model, stream_id, input: [],
    client_metadata: { authorization: 'fixture-private', trace: `bng_data_${'A'.repeat(43)} API_KEY="fixture private"` },
  }));
  const terminal = (model: string) => received.some(event => event.type === 'response.completed' && event.response?.model === model);
  create('large-ws', 'large');
  await waitUntil(() => terminal('large-ws'), 'large generation did not complete on the wire', 5000);
  socket.send(JSON.stringify({ type: 'response.create', model: 'large-lifecycle', stream_id: 'large-lifecycle',
    input: 'x'.repeat(largeWebSocketBytes) }));
  await waitUntil(() => terminal('large-lifecycle'), 'large lifecycle frame did not reach the client', 10000);
  expect(received.filter(event => event.response?.model === 'large-lifecycle').every(
    event => (event.response as { payload?: string }).payload?.length === largeWebSocketBytes,
  )).toBe(true);
  create('held-operation', 'held');
  await waitUntil(() => received.some(event => event.type === 'response.created' && event.response?.model === 'held-operation'),
    'first overlapping generation did not open', 5000);
  create('overlap-ws', 'other');
  await waitUntil(() => terminal('overlap-ws'), 'second overlapping generation did not complete on the wire', 5000);
  finishHeldOperation!();
  await waitUntil(() => terminal('held-operation'), 'first overlapping generation did not complete on the wire', 5000);
  create('unfinished', 'disconnect');
  await waitUntil(() => received.some(event => event.type === 'response.created' && event.response?.model === 'unfinished'),
    'disconnected generation did not open', 5000);
  await close(socket);

  await waitUntil(async () => {
    const operations = (await queryLogs(path)).filter(row => row.recordKind === 'operation');
    return operations.length === 5 && operations.every(row => row.processingSteps?.some(
      step => step.step === 'body_logging_incomplete' && step.detail?.direction === 'response',
    ));
  }, 'WebSocket capture failures were not recorded', 12000);
  for (const row of (await queryLogs(path)).filter(row => row.recordKind === 'operation')) {
    if (!row.originalReqBodyId) {
      expect(row).toMatchObject({ protocolOutcome: 'completed', observationOutcome: 'complete' });
      expect(row.respBodyId).toBeUndefined();
      expect(row.processingSteps?.map(step => step.detail)).toEqual(['original-request', 'response'].map(direction => ({
        direction, reason: 'size_limit', observer_incomplete: true,
      })));
      continue;
    }
    const request = await loadBody(row.originalReqBodyId) as { model: string };
    expect(request).toMatchObject({ client_metadata: { authorization: '[REDACTED]', trace: '[REDACTED] API_KEY=[REDACTED]' } });
    const disconnected = request.model === 'unfinished';
    expect(row.protocolOutcome).toBe(disconnected ? undefined : 'completed');
    expect(row.observationOutcome).toBe(disconnected ? 'incomplete' : 'complete');
    expect(row.respBodyId).toBeUndefined();
    const reason = disconnected ? 'stream_failed' : request.model === 'large-ws' ? 'size_limit' : 'ambiguous';
    expect(row.processingSteps).toEqual([expect.objectContaining({ step: 'body_logging_incomplete', detail: {
      direction: 'response', reason, observer_incomplete: true,
    } })]);
  }
  expect((await readdir(join(fixture.root, 'logs', 'bodies'), { recursive: true })).some(name => name.endsWith('.part'))).toBe(false);
}, 30000);

test('an uncorrelated error cannot bind a later request to a late opening on the same stream', async () => {
  const path = '/codex/replay-check/responses';
  const socket = await connect(path);
  const events: Array<{ type: string; response?: { model: string } }> = [];
  socket.on('message', raw => events.push(JSON.parse(String(raw))));
  const create = (model: string, stream_id: string) => socket.send(JSON.stringify({ type: 'response.create', model, stream_id, input: [] }));
  create('replay-a', 'reused');
  await waitUntil(() => events.some(event => event.type === 'error'), 'uncorrelated error did not reach the client', 5000);
  create('replay-b', 'reused');
  await waitUntil(() => ['replay-a', 'replay-b'].every(model => events.some(
    event => event.type === 'response.completed' && event.response?.model === model,
  )), 'both terminal messages did not reach the client', 5000);
  create('unambiguous', 'fresh');
  await waitUntil(() => events.some(event => event.type === 'response.completed' && event.response?.model === 'unambiguous'),
    'independent stream did not complete', 5000);
  await close(socket);
  await waitUntil(async () => {
    const rows = await queryLogs(path);
    return rows.length === 1 && rows[0]?.recordKind === 'operation' && rows[0].protocolOutcome === 'completed';
  }, 'confirmed operation did not appear in logs', 12000);
  const operations = await queryLogs(path);
  expect(await loadBody(operations[0]?.originalReqBodyId)).toMatchObject({ model: 'unambiguous' });
  expect(await loadBody(operations[0]?.respBodyId)).toEqual(events.filter(event => event.response?.model === 'unambiguous').slice(0, 2));
}, 30000);

test('hosted 200 SSE errors preserve all client messages through the final send', async () => {
  const path = '/chatgpt/stream-check/responses';
  const socket = await connect(path);
  const events: Array<{ type: string; error?: { code: string } }> = [];
  socket.on('message', raw => events.push(JSON.parse(String(raw))));
  const expected = [];
  try {
    for (const [input, tail] of [
      ['stream-terminal', ['response.failed']], ['stream-eof', ['error']], ['stream-invalid-tail', ['response.completed', 'error']],
    ] as const) {
      const start = events.length;
      const request = { type: 'response.create', model: 'stream-fixture', input };
      socket.send(JSON.stringify(request));
      await waitUntil(() => events.length >= start + 2 + tail.length, 'hosted stream did not send its last event', 5000);
      const frames = events.slice(start);
      expect(frames.map(frame => frame.type)).toEqual(['response.created', 'error', ...tail]);
      if (input !== 'stream-terminal') expect(frames.at(-1)?.error?.code).toBe('codex_router_generation_failed');
      expected.push({ request, frames });
    }
  } finally { await close(socket); }
  await waitUntil(async () => {
    const rows = (await queryLogs(path)).filter(row => row.recordKind === 'operation');
    return rows.length === 3 && rows.every(row => row.originalReqBodyId && row.respBodyId && row.protocolOutcome === 'failed');
  }, 'hosted SSE response arrays were not stored', 12000);
  const actual = await Promise.all((await queryLogs(path)).filter(row => row.recordKind === 'operation').map(async row => ({
    request: await loadBody(row.originalReqBodyId), frames: await loadBody(row.respBodyId),
  })));
  expect(actual).toEqual(expect.arrayContaining(expected));
}, 30000);

test('disabling body capture keeps WebSocket operation results', async () => {
  const initial = await snapshot();
  const logging = { body: { enabled: false, max_size: 65536, retention_days: 1 } };
  await publish(initial.revision, {
    ...initial.config, logical_configuration: { ...initial.config.logical_configuration, logging },
  });
  try {
    const path = '/codex/body-disabled/responses';
    const socket = await connect(path);
    const events: Array<{ type: string }> = [];
    socket.on('message', raw => events.push(JSON.parse(String(raw))));
    socket.send(JSON.stringify({ type: 'response.create', model: 'body-disabled', input: [] }));
    await waitUntil(() => events.some(event => event.type === 'response.completed'), 'disabled capture affected the wire', 5000);
    await close(socket);
    await waitUntil(async () => {
      const rows = await queryLogs(path);
      return rows.length === 1 && rows[0]?.recordKind === 'operation' && rows[0].protocolOutcome === 'completed';
    }, 'operation result was missing when body capture was disabled', 12000);
    expect((await queryLogs(path)).every(row => !row.originalReqBodyId && !row.reqBodyId && !row.respBodyId)).toBe(true);
  } finally {
    const current = await snapshot();
    await publish(current.revision, initial.config);
  }
}, 90000);

test('Gemini JSON, SSE and binary Live frames produce protocol outcomes without route bindings', async () => {
  for (const [path, operation, outcome] of [
    ['/gemini/generate', 'generateContent', 'completed'], ['/gemini/stream', 'streamGenerateContent', 'failed'],
  ] as const) {
    const response = await fetch(`${proxy()}${path}`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('gemini-fixture');
    await waitUntil(async () => {
      const rows = await queryLogs(path);
      return rows.some(row => row.recordKind === 'operation' && row.protocolOutcome)
        && rows.some(row => row.recordKind === 'attempt' && row.respBodyId)
        && rows.some(row => row.recordKind === 'access' && row.transportOutcome === 'completed');
    }, `Gemini HTTP operation or body was not stored for ${path}`, 12000);
    const rows = await queryLogs(path);
    expect(rows.find(row => row.recordKind === 'access')).toMatchObject({ status: 200, transportOutcome: 'completed' });
    expect(rows.find(row => row.recordKind === 'operation')).toMatchObject({ protocol: 'gemini', operation, protocolOutcome: outcome });
    if (outcome === 'failed') {
      expect(await loadBody(rows.find(row => row.recordKind === 'attempt')?.respBodyId)).toEqual([
        { event: 'message', data: { modelVersion: 'gemini-fixture', candidates: [{ index: 0, finishReason: 'SAFETY' }] } },
      ]);
    }
  }
  const path = '/gemini/live';
  const live = await connect(path);
  const messages: Array<{ setupComplete?: object; serverContent?: { turnComplete?: boolean } }> = [];
  live.on('message', raw => messages.push(JSON.parse(String(raw))));
  live.send(JSON.stringify({ setup: { model: 'models/gemini-fixture' } }));
  await waitUntil(() => messages.some(message => message.setupComplete), 'Gemini Live setup was not acknowledged', 5000);
  for (const [index, message] of [
    { clientContent: { turns: [{ role: 'user', parts: [{ text: 'hello' }] }], turnComplete: true } },
    { realtimeInput: { text: 'interrupt' } },
  ].entries()) {
    live.send(JSON.stringify(message));
    await waitUntil(() => messages.filter(message => message.serverContent?.turnComplete).length === index + 1,
      'Gemini Live turn did not finish', 5000);
  }
  await close(live);
  await waitUntil(async () => {
    const rows = await queryLogs(path);
    return rows.length === 2 && rows.every(row => row.recordKind === 'operation' && row.observationOutcome);
  }, 'Gemini Live operations were not stored', 12000);
  const rows = await queryLogs(path);
  const accessId = rows[0]?.accessId;
  expect(accessId).toBeString();
  expect(rows).toEqual(expect.arrayContaining(
    ['completed', 'cancelled'].map(protocolOutcome => expect.objectContaining({
      accessId, protocol: 'gemini', operation: 'bidiGenerateContent', protocolOutcome,
    })),
  ));
}, 45000);

test('stores and serves JSON larger than the worker logging budget without changing the wire', async () => {
  const initial = await snapshot();
  const logging = { body: { enabled: true, max_size: largeBodyBytes + 11, retention_days: 1 } };
  await publish(initial.revision, {
    ...initial.config, logical_configuration: { ...initial.config.logical_configuration, logging },
  });
  try {
    async function expectBody(response: Response, prefix: string, bytes: number, suffix: string) {
      expect(response.status).toBe(200);
      const expected = createHash('sha256').update(prefix);
      for (let written = 0; written < bytes; written += largeChunk.byteLength) expected.update(largeChunk);
      expected.update(suffix);
      const actual = createHash('sha256');
      for await (const chunk of response.body!) actual.update(chunk);
      expect(actual.digest('hex')).toBe(expected.digest('hex'));
    }
    const path = '/plain/large-json';
    await expectBody(await fetch(`${proxy()}${path}`), '{"data":"', largeBodyBytes, '"}');
    let bodyId: string | undefined;
    await waitUntil(async () => {
      bodyId = (await queryLogs(path)).find(row => row.recordKind === 'attempt')?.respBodyId;
      return !!bodyId;
    }, 'large response was not stored', 12000);
    expect(bodyId).toEndWith('.stream');
    await expectBody(await fetch(`${management()}/api/logs/body/${bodyId}`),
      `{"bodyId":${JSON.stringify(bodyId)},"content":{"data":"`, largeBodyBytes, '"}}');

    const overPath = '/plain/large-over-limit';
    await expectBody(await fetch(`${proxy()}${overPath}`), '{"data":"', largeBodyBytes + largeChunk.byteLength, '"}');
    await waitUntil(async () => {
      const rows = await queryLogs(overPath);
      return rows.some(row => row.recordKind === 'attempt' && row.processingSteps?.some(
        step => step.step === 'body_logging_incomplete' && step.detail?.reason === 'size_limit',
      ));
    }, 'over-limit response was not marked incomplete', 12000);
    expect((await queryLogs(overPath)).every(row => !row.respBodyId)).toBe(true);
    const bodyFiles = await readdir(join(fixture.root, 'logs', 'bodies'), { recursive: true });
    expect(bodyFiles.some(name => name.endsWith('.part'))).toBe(false);
  } finally {
    const current = await snapshot();
    await publish(current.revision, initial.config);
  }
}, 90000);

test('collection follows the serving revision and historical query and export survive disable and restart', async () => {
  const historicalPath = await echoHttp('historical');
  const historicalRows = await waitForHttpRecords(historicalPath);
  const drainPath = '/codex/drain/responses';
  const drainingSocket = await connect(drainPath);
  const drainEvents: Array<{ type: string; response?: { model: string } }> = [];
  drainingSocket.on('message', raw => drainEvents.push(JSON.parse(String(raw))));
  drainingSocket.send(JSON.stringify({ type: 'response.create', model: 'held-operation', input: [] }));
  const heldHttp = await fetch(`${proxy()}/plain/hold`, { signal: AbortSignal.timeout(25000) });
  expect(heldHttp.status).toBe(200);
  const heldReader = heldHttp.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await heldReader.read()).value)).toContain('before');
  let disabledRevision: number;
  try {
    await waitUntil(async () => (await queryLogs(drainPath)).some(row => row.recordKind === 'operation'),
      'old connection did not register its operation', 10000);
    disabledRevision = await setCollection('disable', async revision => {
      await waitUntil(async () => {
        const result = await requestJson(`${management()}/api/config/runtime`, {}, fixture);
        return (result.body as { publication?: { serving_revision?: number } }).publication?.serving_revision === revision;
      }, 'disabled revision did not become active while requests were held', 12000);
      finishHeldOperation!();
      drainingSocket.send(JSON.stringify({ type: 'response.create', model: 'after-cutover', input: [] }));
      await waitUntil(() => ['held-operation', 'after-cutover'].every(model =>
        drainEvents.some(event => event.type === 'response.completed' && event.response?.model === model)),
      'old connection did not receive its terminal frames after cutover', 3000);
      finishHeldResponse!();
      expect(decoder.decode((await heldReader.read()).value)).toContain('after');
      expect((await heldReader.read()).done).toBe(true);
      await close(drainingSocket);
    });
  } finally {
    if (drainingSocket.readyState === WebSocket.OPEN) drainingSocket.terminate();
    await heldReader.cancel();
  }
  const drainedRows = await queryLogs(drainPath);
  expect(drainedRows.filter(row => row.recordKind === 'operation')).toEqual([
    expect.objectContaining({ protocolOutcome: 'completed' }),
  ]);
  expect((await waitForHttpRecords('/plain/hold', false)).find(row => row.recordKind === 'access'))
    .toMatchObject({ transportOutcome: 'completed' });
  const disabledPath = await echoHttp('disabled');
  const codexBefore = await queryLogs('/codex/responses');
  const disabledSse = await fetch(`${proxy()}/codex/responses`, {
    method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model: 'disabled', input: 'test', stream: true }),
  });
  expect(disabledSse.status).toBe(200);
  expect(await disabledSse.text()).toContain('response.completed');
  await stopOwnedMaster(master!);
  const dailyLog = join(fixture.root, 'logs', `access-${new Date().toISOString().slice(0, 10)}.log`);
  await rename(dailyLog, `${dailyLog}.saved`);
  await mkdir(dailyLog);
  await startMaster();
  const restarted = await snapshot();
  expect(restarted.revision).toBe(disabledRevision);
  expect(restarted.config.plugin_activations).not.toContainEqual({ plugin_name: 'request-logs' });
  const restartedPath = await echoHttp('restarted');
  expect(await queryLogs(historicalPath)).toEqual(historicalRows);
  expect(await loadBody(historicalRows.find(row => row.recordKind === 'attempt')?.respBodyId)).toBe('日志正文');
  expect(await queryLogs('/codex/responses')).toEqual(codexBefore);
  const exported = await requestJson(`${management()}/api/logs/export?format=csv&path=${historicalPath}`, {}, fixture);
  expect(exported.response.status).toBe(200);
  expect(exported.response.headers.get('content-type')).toContain('text/csv');
  for (const row of historicalRows) expect(exported.text).toContain(row.requestId);

  await setCollection('enable');
  await waitForHttpRecords(await echoHttp('resumed'));
  expect(await queryLogs(disabledPath)).toEqual([]);
  expect(await queryLogs(restartedPath)).toEqual([]);

  const enabled = await snapshot();
  const mutation = randomUUID();
  const aggregate: ConfigurationAggregate = {
    plugin_activations: [...enabled.config.plugin_activations.filter(({ plugin_name }) => plugin_name !== 'request-logs'), { plugin_name: failurePlugin }],
    logical_configuration: { ...enabled.config.logical_configuration, plugins: [
      { id: randomUUID(), position: 1, name: failurePlugin, enabled: true },
    ] },
  };
  const rejected = await fetch(`${management()}/api/config`, {
    method: 'PUT', headers: jsonHeaders, signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ expected_revision: enabled.revision, mutation_id: mutation, aggregate }),
  });
  expect(rejected.status).toBe(503);
  expect(await rejected.json()).toEqual({ error: 'control_readiness_failed' });
  const operation = await requestJson(`${management()}/api/config/operations/${mutation}`, {}, fixture);
  expect(operation.response.status, operation.text).toBe(404);
  expect(await snapshot()).toEqual(enabled);
  const runtime = await requestJson(`${management()}/api/config/runtime`, {}, fixture);
  expect(runtime.response.status, runtime.text).toBe(200);
  expect(runtime.body).toMatchObject({ publication: { serving_revision: enabled.revision, serving_complete: true } });
  await waitForHttpRecords(await echoHttp('after-failed-publication'));
}, 120000);
