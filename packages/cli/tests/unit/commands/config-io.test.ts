import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { importCommand } from '../../../src/commands/config-io';

const originalFetch = globalThis.fetch;
const snapshot = { format: 'bungee-config', source_revision: 3, aggregate: {} };
let file: string;

type RequestRecord = { readonly url: string; readonly init?: RequestInit };

function operation(mutationId: string, state: 'committed' | 'superseded') {
  return {
    mutation_id: mutationId,
    request_hash: 'sha256:request',
    expected_revision: 7,
    committed_revision: 8,
    kind: 'config',
    target_worker_count: 1,
    drain_recovery_generation: 0,
    last_drain_recovery_previous_generation: null,
    created_at: 1,
    updated_at: 2,
    state,
    result_status: state === 'superseded' ? 202 : null,
    error_code: null,
    error_detail: null,
  };
}

function current(revision = 7): Response {
  return Response.json({ config: {}, revision, content_hash: 'sha256:current' });
}

function accepted(mutationId: string, state: 'committed' | 'superseded' = 'committed'): Response {
  return Response.json({
    operation_id: mutationId,
    revision: 8,
    operation: operation(mutationId, state),
    workers: [],
  }, { status: 202 });
}

function install(handler: (request: RequestRecord, index: number) => Response | Promise<Response>): RequestRecord[] {
  const requests: RequestRecord[] = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = { url: String(input), init };
      requests.push(request);
      return await handler(request, requests.length - 1);
    },
  });
  return requests;
}

function importBody(request: RequestRecord): Record<string, unknown> {
  return JSON.parse(String(request.init?.body)) as Record<string, unknown>;
}

beforeEach(async () => {
  file = `/tmp/bungee-config-io-${crypto.randomUUID()}.json`;
  await Bun.write(file, JSON.stringify(snapshot));
});

afterEach(async () => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  await rm(file, { force: true });
  mock.restore();
});

describe('config import', () => {
  test('reads the target revision and reports the saved operation immediately without polling', async () => {
    // Given
    const requests = install((request, index) => index === 0
      ? current()
      : accepted(String(importBody(request).mutation_id)));
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    await importCommand({ file, token: 'session-token' });

    // Then
    expect(requests.map((request) => request.url)).toEqual([
      'http://localhost:8089/api/config',
      'http://localhost:8089/api/config/import',
    ]);
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: 'Bearer session-token' });
    expect(requests[1]?.init?.method).toBe('POST');
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: 'Bearer session-token',
      'content-type': 'application/json',
    });
    const body = importBody(requests[1]!);
    expect(Object.keys(body).sort()).toEqual(['envelope', 'expected_revision', 'mutation_id']);
    expect(body.expected_revision).toBe(7);
    expect(body.mutation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.envelope).toEqual(snapshot);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(`Config saved from ${file}`);
    expect(log.mock.calls[0]?.[0]).not.toContain('converged');
    expect(log.mock.calls[0]?.[0]).not.toContain('applied');
  });

  test('rejects a non-2xx import without reporting success', async () => {
    // Given
    const requests = install((_request, index) => index === 0
      ? current()
      : new Response('invalid snapshot', { status: 400 }));
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    let error: unknown;
    try {
      await importCommand({ file, token: 'token' });
    } catch (cause) {
      error = cause;
    }

    // Then
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new TypeError('Expected import to reject with an Error');
    expect(error.message).toContain('400');
    expect(error.message).toContain('invalid snapshot');
    expect(requests).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test('reports a superseded acknowledgement as saved without claiming separate application', async () => {
    // Given
    const requests = install((request, index) => index === 0
      ? current()
      : accepted(String(importBody(request).mutation_id), 'superseded'));
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    await importCommand({ file, token: 'token' });

    // Then
    expect(requests).toHaveLength(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toBe(`Config saved from ${file}`);
  });

  test('keeps the generated operation ID when a successful response is invalid', async () => {
    // Given
    let mutationId = '';
    install((request, index) => {
      if (index === 0) return current();
      mutationId = String(importBody(request).mutation_id);
      return Response.json({ operation_id: mutationId }, { status: 202 });
    });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    let error: unknown;
    try {
      await importCommand({ file, token: 'token' });
    } catch (cause) {
      error = cause;
    }

    // Then
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new TypeError('Expected import to reject with an Error');
    expect(error.message).toContain('Import result is unknown');
    expect(error.message).toContain(mutationId);
    expect(error.message).not.toContain('/api/config/operations/');
    expect(error.message).not.toContain('Import failed');
    expect(log).not.toHaveBeenCalled();
  });

  test.each(['headers', 'error body'] as const)('keeps the generated operation ID when response %s are lost', async phase => {
    // Given
    let mutationId = '';
    const requests = install((request, index) => {
      if (index === 0) return current();
      mutationId = String(importBody(request).mutation_id);
      if (phase === 'headers') throw new TypeError('network lost');
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('network lost')); } }), { status: 503 });
    });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    let error: unknown;
    try {
      await importCommand({ file, token: 'token' });
    } catch (cause) {
      error = cause;
    }

    // Then
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new TypeError('Expected import to reject with an Error');
    expect(error.message).toContain('Import result is unknown');
    expect(error.message).toContain(mutationId);
    expect(error.message).not.toContain('Import failed');
    expect(requests).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });

  test('reports a server result_unknown as unknown rather than a failed write', async () => {
    // Given
    const requests = install((_request, index) => index === 0
      ? current()
      : Response.json({ error: 'result_unknown', mutation_id: 'pending-operation' }, { status: 503 }));
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    let error: unknown;
    try {
      await importCommand({ file, token: 'token' });
    } catch (cause) {
      error = cause;
    }

    // Then
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new TypeError('Expected import to reject with an Error');
    expect(error.message).toContain('Import result is unknown');
    expect(error.message).toContain(String(importBody(requests[1]!).mutation_id));
    expect(error.message).not.toContain('pending-operation');
    expect(error.message).not.toContain('Import failed');
    expect(requests).toHaveLength(2);
    expect(log).not.toHaveBeenCalled();
  });
});
