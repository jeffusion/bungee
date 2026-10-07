import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import type { AppConfig } from '@jeffusion/bungee-types';
import { ensureDataPlaneSchema } from './helpers/data-plane-runtime';

await ensureDataPlaneSchema();
const { accessLogWriter } = await import('../src/logger/access-log-writer');
const { RequestLogger } = await import('../src/logger/request-logger');
const { BodyStorageManager } = await import('../src/logger/body-storage');
const { captureBody, flushBodyCaptures } = await import('../src/logger/body-capture');
const { handleRequest } = await import('../src/worker/request/handler');
const encoder = new TextEncoder();
const roots: string[] = [];
const requestIds: string[] = [];
const maxBytes = 5 * 1024 * 1024;

async function setup(maxSize = maxBytes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bungee-body-log-bypass-'));
  roots.push(root);
  const storage = new BodyStorageManager({ enabled: true, maxSize }, root);
  const logging = { accessLogWriter: {
    write(entry: Parameters<typeof accessLogWriter.write>[0]) {
      if (!requestIds.includes(entry.requestId)) requestIds.push(entry.requestId);
      accessLogWriter.write(entry);
    },
    updateBodyId: accessLogWriter.updateBodyId.bind(accessLogWriter),
    updateResponseBodyId: accessLogWriter.updateResponseBodyId.bind(accessLogWriter),
    updateProtocolOutcome: accessLogWriter.updateProtocolOutcome.bind(accessLogWriter),
    updateTransportOutcome: accessLogWriter.updateTransportOutcome.bind(accessLogWriter),
    appendProcessingStep: accessLogWriter.appendProcessingStep.bind(accessLogWriter),
  }, fileLogWriter: { write() {} }, bodyStorage: storage };
  const config = (target: string, route = {}): AppConfig => ({
    logging: { body: { enabled: true, max_size: maxSize, retention_days: 1 } },
    routes: [{ path: '/test', ...route, endpoints: [{ target }] }],
  });
  const rows = async () => {
    await flushBodyCaptures();
    await accessLogWriter.flush();
    return requestIds.map(id => accessLogWriter.getDatabase().query('SELECT * FROM access_logs WHERE request_id=?').get(id) as Record<string, any>);
  };
  return { storage, logging, config, rows };
}

afterEach(async () => {
  await flushBodyCaptures();
  await accessLogWriter.flush();
  for (const id of requestIds.splice(0)) accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE request_id=?').run(id);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test('models-sized opaque response is logged without a body demand', async () => {
  const { logging, storage, config, rows } = await setup();
  const text = JSON.stringify({ models: 'x'.repeat(613_950) });
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(text, { headers: { 'content-type': 'application/json' } }) });
  try {
    const response = await handleRequest(new Request('http://gateway/test/models'), config(server.url.origin), { logging });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    const [row] = await rows();
    expect(await storage.load(row.resp_body_id)).toEqual(JSON.parse(text));
    const steps = JSON.parse(row.processing_steps);
    expect(steps).toContainEqual(expect.objectContaining({ step: 'response_body_plan', detail: expect.objectContaining({ mode: 'opaque-stream', reasons: [] }) }));
    expect(steps.some((step: any) => step.step === 'body_logging_incomplete')).toBe(false);
  } finally { await server.stop(true); }
});

test('opaque request and response logging preserve compressed, malformed and binary wire bytes', async () => {
  const { logging, storage, config, rows } = await setup();
  let forwarded: Uint8Array | undefined;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    forwarded = new Uint8Array(await req.arrayBuffer());
    return new Response(forwarded, { headers: req.headers });
  } });
  try {
    const plain = '{ "model": "m" }';
    const cases = [
      { bytes: gzipSync(encoder.encode(plain)), coding: 'gzip', expected: JSON.parse(plain) },
      { bytes: zstdCompressSync(encoder.encode(plain)), coding: 'zstd', expected: JSON.parse(plain) },
      { bytes: encoder.encode('{bad'), coding: '', expected: '{bad' },
      { bytes: new Uint8Array([255, 128, 0, 1]), coding: 'unknown', expected: { encoding: 'base64', content_encoding: 'unknown', data: '/4AAAQ==' } },
    ];
    for (const { bytes, coding, expected } of cases) {
      const response = await handleRequest(new Request('http://gateway/test', { method: 'POST', body: bytes,
        headers: { 'content-type': 'application/json', ...(coding ? { 'content-encoding': coding } : {}) } }), config(server.url.origin), { logging });
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
      expect(forwarded).toEqual(new Uint8Array(bytes));
      const row = (await rows()).at(-1)!;
      for (const field of ['req_body_id', 'original_req_body_id', 'resp_body_id']) expect(await storage.load(row[field])).toEqual(expected);
    }
  } finally { await server.stop(true); }
});

test('body modifications log the final request and response while retaining the original request', async () => {
  const { logging, storage, config, rows } = await setup();
  const original = '{ "x": 1 }';
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) { return new Response(await req.text(), { headers: { 'content-type': 'application/json' } }); } });
  try {
    const response = await handleRequest(new Request('http://gateway/test', { method: 'POST', body: original, headers: { 'content-type': 'application/json' } }),
      config(server.url.origin, { request: { body: { add: { x: 2 } } }, response: { body: { add: { x: 3, flag: false } } } }), { logging });
    expect(await response.json()).toEqual({ x: 3, flag: false });
    const [row] = await rows();
    expect(await storage.load(row.original_req_body_id)).toEqual({ x: 1 });
    expect(await storage.load(row.req_body_id)).toEqual({ x: 2 });
    expect(await storage.load(row.resp_body_id)).toEqual({ x: 3, flag: false });
  } finally { await server.stop(true); }
});

test('local responses and rejected requests also retain response bodies and failure codes', async () => {
  const { logging, storage, config, rows } = await setup();
  const cfg = config('http://127.0.0.1:1', { response_rules: [{ path: '/test', match_type: 'exact', enabled: true, type: 'response', status: 201, body: 'local' }] });
  expect(await (await handleRequest(new Request('http://gateway/test'), cfg, { logging })).text()).toBe('local');
  const missing = await handleRequest(new Request('http://gateway/missing'), cfg, { logging });
  expect(missing.status).toBe(404);
  const missingBody = await missing.text();
  const rejected = await handleRequest(new Request('http://gateway/test', { method: 'POST', body: 'x', headers: { 'content-length': '2048' } }),
    { ...config('http://127.0.0.1:1'), body_parser_limit: '1kb' }, { logging });
  expect(rejected.status).toBe(413);
  const rejectedBody = await rejected.json();
  const [local, notFound, failure] = await rows();
  expect(await storage.load(local.resp_body_id)).toBe('local');
  expect(await storage.load(notFound.resp_body_id)).toEqual(JSON.parse(missingBody));
  expect(await storage.load(failure.resp_body_id)).toEqual(rejectedBody);
  expect(failure.protocol_outcome).toBe('failed');
  expect(failure.protocol_code).toBe('request_body_too_large');
});

test('logging never reads ahead, waits for persistence, or turns storage failure into a transfer failure', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  let resolveSave!: () => void;
  const saveGate = new Promise<void>(resolve => { resolveSave = resolve; });
  const saved: unknown[] = [];
  const capture = captureBody(new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { pulls++; } }, { highWaterMark: 0 }), 1024, '',
    async value => { saved.push(value); await saveGate; }, () => {});
  expect(pulls).toBe(0);
  const reader = capture.body.getReader();
  controller.enqueue(encoder.encode('first'));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  expect(saved).toEqual([]);
  controller.enqueue(encoder.encode('last')); controller.close();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('last');
  expect(await Promise.race([reader.read(), Bun.sleep(100).then(() => 'blocked')])).toEqual({ done: true, value: undefined });
  resolveSave(); await capture.completion;
  expect(saved).toEqual(['firstlast']);

  const { logging, config, rows } = await setup();
  const response = await handleRequest(new Request('http://gateway/test'), config('http://127.0.0.1:1', {
    response_rules: [{ path: '/test', match_type: 'exact', enabled: true, type: 'response', body: 'ok' }],
  }), { logging: { ...logging, bodyStorage: { async save() { throw new Error('disk unavailable'); } } } });
  expect(await response.text()).toBe('ok');
  const [row] = await rows();
  expect(row.status).toBe(200); expect(row.success).toBe(1); expect(row.resp_body_id).toBeNull();
  expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({ step: 'body_logging_incomplete' }));
});

test('late body IDs are applied before enqueue, while queued and after persistence', async () => {
  for (const phase of ['before', 'queued', 'persisted']) {
    const id = crypto.randomUUID(); requestIds.push(id);
    const write = () => accessLogWriter.write({ requestId: id, timestamp: Date.now(), method: 'POST', path: '/test', status: 200, duration: 1 });
    if (phase !== 'before') write();
    if (phase === 'persisted') await accessLogWriter.flush();
    accessLogWriter.updateBodyId(id, 'request', 'req');
    accessLogWriter.updateBodyId(id, 'response', 'resp');
    accessLogWriter.updateBodyId(id, 'original-request', 'original');
    if (phase === 'before') write();
    await accessLogWriter.flush();
    expect(accessLogWriter.getDatabase().query('SELECT req_body_id,resp_body_id,original_req_body_id FROM access_logs WHERE request_id=?').get(id))
      .toEqual({ req_body_id: 'req', resp_body_id: 'resp', original_req_body_id: 'original' });
  }
});

test('oversized logs are skipped without truncating the wire and capacity is released', async () => {
  const { logging, config, storage, rows } = await setup(64);
  const text = 'x'.repeat(1024);
  const cfg = config('http://127.0.0.1:1', { response_rules: [{ path: '/test', match_type: 'exact', enabled: true, type: 'response', body: text }] });
  expect(await (await handleRequest(new Request('http://gateway/test'), cfg, { logging })).text()).toBe(text);
  const [row] = await rows();
  expect(row.resp_body_id).toBeNull();
  expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({ step: 'body_logging_incomplete', detail: expect.objectContaining({ reason: 'size_limit' }) }));
  const small = new RequestLogger(new Request('http://gateway/test'), undefined, logging);
  const body = small.observeBody('ok', 'response', new Headers(), cfg.logging!.body);
  expect(await new Response(body).text()).toBe('ok');
  await small.bodyLoggingCompletion(); await small.complete(200);
  expect(await storage.load((await rows()).at(-1)!.resp_body_id)).toBe('ok');
});

test('route retries record the final response rather than the discarded first response', async () => {
  const { logging, storage, config, rows } = await setup();
  let attempts = 0;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    await req.arrayBuffer();
    return new Response(++attempts === 1 ? 'discarded' : 'final', { status: attempts === 1 ? 503 : 200 });
  } });
  try {
    const response = await handleRequest(new Request('http://gateway/test', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } }),
      config(server.url.origin, { retry: { enabled: true, retry_on: [503], max_retries: 1 } }), { logging });
    expect(await response.text()).toBe('final'); expect(attempts).toBe(2);
    const [row] = await rows();
    expect(await storage.load(row.resp_body_id)).toBe('final');
    expect(await storage.load(row.req_body_id)).toBe('{bad');
  } finally { await server.stop(true); }
});

test('SSE logging preserves the final event envelope with and without modification', async () => {
  const { logging, storage, config, rows } = await setup();
  const text = ': hello\nevent: named\nid: 7\nretry: 12\ndata: {"x":1}\n\ndata: [DONE]\n\n';
  let finish!: () => void;
  let gate: Promise<void>;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    return new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, -14)));
      await gate;
      controller.enqueue(encoder.encode(text.slice(-14))); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    for (const modify of [false, true]) {
      gate = new Promise<void>(resolve => { finish = resolve; });
      const response = await handleRequest(new Request('http://gateway/test'), config(server.url.origin,
        modify ? { response: { body: { add: { x: 2 } } } } : {}), { logging });
      const reader = response.body!.getReader();
      const first = await Promise.race([reader.read(), Bun.sleep(100).then(() => 'blocked' as const)]);
      expect(first).not.toBe('blocked');
      finish();
      let wire = new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value);
      while (true) { const next = await reader.read(); if (next.done) break; wire += new TextDecoder().decode(next.value); }
      expect(wire).toBe(modify ? text.replace('"x":1', '"x":2') : text);
      expect(await storage.load((await rows()).at(-1)!.resp_body_id)).toEqual([
        { event: 'named', data: { x: modify ? 2 : 1 } },
        { event: 'message', data: '[DONE]' },
      ]);
    }
  } finally { finish?.(); await server.stop(true); }
});

test('all SSE body directions use the same array format while preserving compressed wire bytes', async () => {
  const { logging, storage, config, rows } = await setup();
  const text = 'event: named\r\ndata: {"x":1}\r\n\r\ndata: hello\r\ndata: world\r\n\r\ndata: [DONE]\r\n\r\n';
  const expected = [{ event: 'named', data: { x: 1 } }, { event: 'message', data: 'hello\nworld' }, { event: 'message', data: '[DONE]' }];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
    return new Response(await req.arrayBuffer(), { headers: req.headers });
  } });
  try {
    for (const coding of ['', 'gzip', 'zstd']) {
      const bytes = coding === 'gzip' ? gzipSync(encoder.encode(text)) : coding === 'zstd' ? zstdCompressSync(encoder.encode(text)) : encoder.encode(text);
      const response = await handleRequest(new Request('http://gateway/test', { method: 'POST', body: bytes,
        headers: { 'content-type': 'text/event-stream; charset=utf-8', ...(coding ? { 'content-encoding': coding } : {}) } }), config(server.url.origin), { logging });
      expect(response.headers.get('content-encoding') ?? '').toBe(coding);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
      const row = (await rows()).at(-1)!;
      for (const field of ['original_req_body_id', 'req_body_id', 'resp_body_id']) expect(await storage.load(row[field])).toEqual(expected);
    }
  } finally { await server.stop(true); }
});

test('SSE array expansion obeys the log size limit without affecting the response', async () => {
  const { logging, config, rows } = await setup(64);
  const text = 'data:\n\n'.repeat(4);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const response = await handleRequest(new Request('http://gateway/test'), config(server.url.origin), { logging });
    expect(response.status).toBe(200); expect(await response.text()).toBe(text);
    const [row] = await rows();
    expect(row.resp_body_id).toBeNull();
    expect(JSON.parse(row.processing_steps)).toContainEqual(expect.objectContaining({ step: 'body_logging_incomplete', detail: expect.objectContaining({ reason: 'size_limit' }) }));
  } finally { await server.stop(true); }
});

test('SSE parsing capacity exhaustion remains isolated and releases its reservations', async () => {
  const text = 'data:0\n\n'.repeat(200_000);
  const reasons: string[] = []; const saved: unknown[] = [];
  const capture = captureBody(new Response(text).body!, maxBytes, '', async value => { saved.push(value); }, reason => reasons.push(reason), undefined, 'text/event-stream');
  expect(await new Response(capture.body).text()).toBe(text); await capture.completion;
  expect(saved).toEqual([]); expect(reasons).toEqual(['buffer_capacity']);
  const after = captureBody(new Response('data: ok\n\n').body!, 1024, '', async value => { saved.push(value); }, reason => reasons.push(reason), undefined, 'text/event-stream');
  expect(await new Response(after.body).text()).toBe('data: ok\n\n'); await after.completion;
  expect(saved).toEqual([[{ event: 'message', data: 'ok' }]]); expect(reasons).toEqual(['buffer_capacity']);
});

test('concurrent logging saturation skips copies and releases all capacity without losing wire bytes', async () => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const reasons: string[] = [];
  const chunk = new Uint8Array(5 * 1024 * 1024);
  const captures = Array.from({ length: 8 }, () => captureBody(new ReadableStream<Uint8Array>({ start(c) { controllers.push(c); } }, { highWaterMark: 0 }),
    chunk.length, '', async () => {}, reason => reasons.push(reason)));
  const readers = captures.map(capture => capture.body.getReader());
  try {
    for (let i = 0; i < captures.length; i++) {
      controllers[i]!.enqueue(chunk);
      expect((await readers[i]!.read()).value).toEqual(chunk);
    }
    expect(reasons).toContain('buffer_capacity');
    controllers.forEach(controller => controller.close());
    await Promise.all(readers.map(reader => reader.read()));
    await Promise.all(captures.map(capture => capture.completion));
    let saved: unknown;
    const after = captureBody(new Response('after').body!, 64, '', async value => { saved = value; }, reason => { throw new Error(reason); });
    expect(await new Response(after.body).text()).toBe('after'); await after.completion;
    expect(saved).toBe('after');
  } finally { await Promise.all(readers.map(reader => reader.cancel())); }
});

test('Buffer views retain an independent log copy when the source buffer is reused', async () => {
  const chunk = Buffer.alloc(16 * 1024 * 1024).subarray(0, 5);
  chunk.set(encoder.encode('first'));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let saved: unknown;
  const capture = captureBody(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }, { highWaterMark: 0 }),
    64, '', async value => { saved = value; }, reason => { throw new Error(reason); });
  const reader = capture.body.getReader();
  controller.enqueue(chunk);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
  chunk.fill(120); controller.close();
  expect((await reader.read()).done).toBe(true);
  await capture.completion;
  expect(saved).toBe('first');
});

test('file logs retain all late body references even when flushed before body storage finishes', async () => {
  const { logging, storage, rows } = await setup();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bungee-body-log-files-')); roots.push(root);
  const { FileLogWriter } = await import('../src/logger/file-log-writer');
  const files = new FileLogWriter(root);
  let finishSave!: () => void;
  const gate = new Promise<void>(resolve => { finishSave = resolve; });
  const dependencies = { ...logging, fileLogWriter: files, bodyStorage: {
    async save(...args: Parameters<typeof storage.save>) { await gate; return storage.save(...args); },
  } };
  const original = new RequestLogger(new Request('http://gateway/test'), undefined, dependencies);
  const attempt = new RequestLogger(new Request('http://gateway/test'), undefined, dependencies);
  const cfg = { enabled: true, max_size: 1024 };
  try {
    const input = original.observeBody('original', 'original-request', new Headers(), cfg);
    attempt.inheritOriginalBody(original);
    expect(await new Response(input).text()).toBe('original');
    expect(await new Response(attempt.observeBody('sent', 'request', new Headers(), cfg)).text()).toBe('sent');
    expect(await new Response(attempt.observeBody('received', 'response', new Headers(), cfg)).text()).toBe('received');
    expect(await Promise.race([attempt.complete(200).then(() => 'completed'), Bun.sleep(100).then(() => 'blocked')])).toBe('completed');
    await files.flush();
    const file = path.join(root, `access-${new Date().toISOString().slice(0, 10)}.log`);
    expect(await fs.readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    })).toBe('');
    finishSave(); await flushBodyCaptures(); await files.flush();
    const [row] = await rows();
    const entry = JSON.parse((await fs.readFile(file, 'utf8')).trim());
    expect(entry).toMatchObject({ reqBodyId: row.req_body_id, respBodyId: row.resp_body_id, originalReqBodyId: row.original_req_body_id });
    expect(await storage.load(entry.reqBodyId)).toBe('sent');
    expect(await storage.load(entry.respBodyId)).toBe('received');
    expect(await storage.load(entry.originalReqBodyId)).toBe('original');
  } finally { finishSave(); await flushBodyCaptures(); await files.close(); }
});

test('locally generated upstream timeouts capture bodies before immutable file log completion', async () => {
  const { logging, storage, config, rows } = await setup();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bungee-body-log-timeout-')); roots.push(root);
  const { FileLogWriter } = await import('../src/logger/file-log-writer');
  const { initializeRuntimeState, runtimeState } = await import('../src/worker/state/runtime-state');
  const files = new FileLogWriter(root);
  let release!: () => void;
  let gate: Promise<void>;
  const dependencies = { ...logging, fileLogWriter: files, bodyStorage: {
    async save(...args: Parameters<typeof storage.save>) { await gate; return storage.save(...args); },
  } };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() { await Bun.sleep(100); return new Response('late'); } });
  try {
    for (const mode of ['static', 'failover', 'blocked-backup']) {
      const failover = mode !== 'static';
      gate = new Promise<void>(resolve => { release = resolve; });
      const cfg = config(server.url.origin, { timeouts: { first_response_ms: 10, request_ms: 500 } });
      if (mode === 'blocked-backup') cfg.routes[0]!.endpoints!.push({ id: 'backup', target: 'http://127.0.0.1:1', priority: 1 });
      if (failover) {
        cfg.services = [{ name: 'timeout-service', failover: { enabled: true }, endpoints: cfg.routes[0]!.endpoints! }];
        cfg.routes[0]!.service = 'timeout-service'; delete cfg.routes[0]!.endpoints;
        initializeRuntimeState(cfg);
      }
      if (mode === 'blocked-backup') {
        const backup = runtimeState.get('timeout-service')!.upstreams.find(upstream => upstream.upstream_id === 'backup')!;
        backup.status = 'UNHEALTHY'; backup.last_failure_time = Date.now();
      }
      const response = await handleRequest(new Request('http://gateway/test'), cfg, { logging: dependencies });
      expect(response.status).toBe(504);
      await files.flush();
      const file = path.join(root, `access-${new Date().toISOString().slice(0, 10)}.log`);
      const before = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      expect(before).not.toContain(requestIds.at(-1)!);
      expect(await response.json()).toEqual({ error: 'Gateway Timeout' });
      release(); await flushBodyCaptures(); await files.flush();
      const row = (await rows()).at(-1)!;
      const entry = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.requestId === row.request_id);
      expect(row.resp_body_id).toBeString();
      expect(entry.respBodyId).toBe(row.resp_body_id);
      expect(await storage.load(entry.respBodyId)).toEqual({ error: 'Gateway Timeout' });
    }
  } finally { release?.(); runtimeState.clear(); await server.stop(true); await flushBodyCaptures(); await files.close(); }
});
