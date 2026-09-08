import { describe, expect, test } from 'bun:test';
import {
  CodexModelCache,
  CodexModelsError,
  buildCodexModelsRequest,
  createCodexModelSource,
  parseCodexModelsBody,
} from '../server/codex-models';

const identity = (accountId = 'acct-a', generation = 1) => ({ accountId, generation, clientVersion: '1.2.3' });

function response(value: unknown, status = 200, headers: HeadersInit = { 'content-type': 'application/json' }): Response {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers });
}

const fixture = { models: [
  { slug: 'visible-model', visibility: 'list', supported_in_api: true, display_name: 'Visible' },
  { slug: 'hidden-model', visibility: 'hide', supported_in_api: true },
  { slug: 'not-api-model', visibility: 'list', supported_in_api: false },
] };

describe('Codex model source', () => {
  test('builder has no credential wire interface and cache identity is separate', () => {
    const request = buildCodexModelsRequest('1.2.3', { etag: '"etag-1"' });
    expect(request.url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=1.2.3');
    expect(request.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    const headers = new Headers(request.init.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('ChatGPT-Account-ID')).toBeNull();
    expect(headers.get('Originator')).toBe('codex_cli_rs');
    expect(headers.get('Accept')).toBe('application/json');
  });

  test('filters only visible API models and keeps native metadata', () => {
    const models = parseCodexModelsBody(JSON.stringify(fixture));
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'visible-model', displayName: 'Visible', source: 'upstream' });
    expect(models[0].metadata).toEqual(fixture.models[0]);
  });

  test('treats an official empty list as a successful empty result', async () => {
    const source = createCodexModelSource({ identity: identity(), execute: async () => response({ models: [] }) });
    await expect(source.loadSnapshot()).resolves.toMatchObject({ models: [], source: 'upstream', stale: false });
  });

  test('isolates accounts and refreshes after TTL or explicit invalidation', async () => {
    let now = 1000;
    let calls = 0;
    const cache = new CodexModelCache();
    const execute = async () => {
      calls += 1;
      return response({ models: [{ slug: `model-${calls}`, visibility: 'list', supported_in_api: true }] }, 200, { 'content-type': 'application/json', etag: `"${calls}"` });
    };
    const first = createCodexModelSource({ identity: identity('acct-a'), cache, execute, now: () => now, ttlMs: 10 });
    const second = createCodexModelSource({ identity: identity('acct-b'), cache, execute, now: () => now, ttlMs: 10 });
    await first.load();
    await first.load();
    await second.load();
    expect(calls).toBe(2);
    now += 11;
    await first.load();
    expect(calls).toBe(3);
    first.invalidate('"3"');
    await first.load();
    expect(calls).toBe(4);
  });

  test('shared cache epochs block a late write after another source invalidates the same key', async () => {
    const cache = new CodexModelCache();
    let calls = 0;
    let resolveFirst!: (value: Response) => void;
    const execute = async () => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
      return response({ models: [{ slug: 'fresh', visibility: 'list', supported_in_api: true }] });
    };
    const first = createCodexModelSource({ identity: identity(), cache, execute });
    const second = createCodexModelSource({ identity: identity(), cache, execute });
    const pending = first.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    second.invalidate();
    resolveFirst(response({ models: [{ slug: 'late', visibility: 'list', supported_in_api: true }] }));
    await pending;
    await expect(second.load()).resolves.toMatchObject({ 0: { id: 'fresh' } });
    expect(calls).toBe(2);
  });

  test('expired cache failure is explicit and never falls back to stale models', async () => {
    let now = 2;
    let fail = false;
    const source = createCodexModelSource({
      identity: identity(), ttlMs: 1, now: () => now,
      execute: async () => fail ? Promise.reject(new Error('token=secret')) : response(fixture),
    });
    await source.load();
    fail = true;
    now = 365 * 24 * 60 * 60 * 1000;
    await expect(source.load()).rejects.toMatchObject({ kind: 'network' });
    await expect(source.load()).rejects.not.toThrow('secret');
  });

  test('401 and 403 clear cache, while 429 remains an explicit error', async () => {
    let status = 200;
    let now = 2;
    let calls = 0;
    const source = createCodexModelSource({
      identity: identity('acct-status'), ttlMs: 1, now: () => now,
      execute: async () => { calls += 1; return status === 200 ? response(fixture) : response({}, status); },
    });
    await source.load();
    status = 401;
    now = 4;
    await expect(source.load()).rejects.toMatchObject({ kind: 'network', status: 401 });
    status = 200;
    await source.load();
    expect(calls).toBe(3);
    status = 403;
    now = 6;
    await expect(source.load()).rejects.toMatchObject({ kind: 'network', status: 403 });
    status = 429;
    await expect(source.load()).rejects.toMatchObject({ kind: 'http', status: 429 });
  });

  test('invalidate prevents an in-flight success from repopulating cache', async () => {
    let resolve!: (value: Response) => void;
    let calls = 0;
    const source = createCodexModelSource({
      identity: identity('acct-flight'),
      execute: () => {
        calls += 1;
        if (calls === 1) return new Promise<Response>((r) => { resolve = r; });
        return Promise.resolve(response(fixture));
      },
    });
    const pending = source.load();
    await new Promise((r) => setTimeout(r, 0));
    source.invalidate();
    resolve(response(fixture));
    await pending;
    await source.load();
    expect(calls).toBe(2);
  });

  test('304 refreshes a real cache entry but is rejected without one', async () => {
    const empty = createCodexModelSource({ identity: identity('acct-304-empty'), execute: async () => response({}, 304) });
    await expect(empty.load()).rejects.toMatchObject({ kind: 'http', status: 304 });

    let now = 1;
    let calls = 0;
    const source = createCodexModelSource({
      identity: identity('acct-304'), ttlMs: 1, now: () => now,
      execute: async () => {
        calls += 1;
        return calls === 1
          ? response(fixture, 200, { 'content-type': 'application/json', etag: '"etag"' })
          : response({}, 304);
      },
    });
    await source.load();
    now = 3;
    await expect(source.loadSnapshot()).resolves.toMatchObject({ fetchedAt: 3, stale: false });
    await source.load();
    expect(calls).toBe(2);
  });

  test('pre-aborted requests reject before reading cache', async () => {
    let calls = 0;
    const source = createCodexModelSource({ identity: identity('acct-preabort'), execute: async () => { calls += 1; return response(fixture); } });
    await source.load();
    const controller = new AbortController();
    controller.abort();
    await expect(source.load(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(1);
  });

  test('cancels non-json error bodies and rejects wrong content type', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('not-json')); },
      cancel() { cancelled = true; },
    });
    const source = createCodexModelSource({ identity: identity('acct-content-type'), execute: async () => new Response(body, { status: 403, headers: { 'content-type': 'text/plain' } }) });
    await expect(source.load()).rejects.toMatchObject({ kind: 'network', status: 403 });
    expect(cancelled).toBe(true);

    const wrongType = createCodexModelSource({ identity: identity('acct-wrong-type'), execute: async () => response(fixture, 200, { 'content-type': 'text/html' }) });
    await expect(wrongType.load()).rejects.toMatchObject({ kind: 'invalid_content_type' });
  });

  test('cancels a response that arrives after the deadline', async () => {
    let resolve!: (value: Response) => void;
    let cancelled = false;
    const source = createCodexModelSource({
      identity: identity('acct-late'), timeoutMs: 5,
      execute: async () => new Promise<Response>((r) => { resolve = r; }),
    });
    const pending = source.load();
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(cancelled).toBe(true);
  });

  test('rejects malformed, oversized, and unauthorized responses', async () => {
    expect(() => parseCodexModelsBody('{bad')).toThrowError(new CodexModelsError('invalid_json'));
    expect(() => parseCodexModelsBody(JSON.stringify({ models: [{ slug: 1 }] }))).toThrowError(new CodexModelsError('invalid_structure'));
    expect(() => parseCodexModelsBody('{}')).toThrowError(new CodexModelsError('invalid_structure'));
    const oversized = createCodexModelSource({ identity: identity('acct-large'), maxBodyBytes: 4, execute: async () => response(JSON.stringify(fixture)) });
    await expect(oversized.load()).rejects.toMatchObject({ kind: 'body_limit' });
  });
});
