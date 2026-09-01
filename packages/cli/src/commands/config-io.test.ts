import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { importCommand } from './config-io';

const originalFetch = globalThis.fetch;
let file: string;

function operation(state: 'committed' | 'converged' | 'degraded') {
  return {
    mutation_id: 'import-operation',
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
    result_status: state === 'converged' ? 200 : state === 'degraded' ? 202 : null,
    error_code: state === 'degraded' ? 'replacement_convergence_failed' : null,
    error_detail: state === 'degraded' ? 'worker rejected configuration' : null,
  };
}

function accepted(): Response {
  return Response.json({
    operation_id: 'import-operation',
    revision: 8,
    operation: operation('committed'),
    workers: [],
  }, { status: 202 });
}

beforeEach(async () => {
  file = `/tmp/bungee-config-io-${crypto.randomUUID()}.json`;
  await Bun.write(file, '{}');
});

afterEach(async () => {
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: originalFetch });
  await rm(file, { force: true });
  mock.restore();
});

describe('config import', () => {
  test('waits for a committed operation to converge before printing success', async () => {
    // Given
    const requests: Array<{ readonly url: string; readonly init?: RequestInit }> = [];
    const pollStarted = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<Response>();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return accepted();
        pollStarted.resolve();
        return await terminal.promise;
      },
    });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    const command = importCommand({ file, token: 'old-token', nextToken: 'next-token' });
    await Promise.race([pollStarted.promise, Bun.sleep(25)]);

    // Then
    expect(log).not.toHaveBeenCalled();
    terminal.resolve(Response.json({ operation: operation('converged'), workers: [] }));
    await command;
    expect(log).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer old-token',
      'x-bungee-next-authorization': 'Bearer next-token',
    });
    expect(requests[1]?.url).toBe('http://localhost:8088/__ui/api/config/operations/import-operation');
    expect(requests[1]?.init?.headers).toMatchObject({ authorization: 'Bearer next-token' });
  });

  test('rejects when a committed operation becomes degraded', async () => {
    // Given
    let requestCount = 0;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (): Promise<Response> => {
        requestCount += 1;
        return requestCount === 1
          ? accepted()
          : Response.json({ operation: operation('degraded'), workers: [] });
      },
    });
    const log = spyOn(console, 'log').mockImplementation(() => undefined);

    // When
    const command = importCommand({ file, token: 'token' });
    let error: unknown;
    try {
      await command;
    } catch (cause) {
      error = cause;
    }

    // Then
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new TypeError('Expected import to reject with an Error');
    expect(error.message).toContain('worker rejected configuration');
    expect(log).not.toHaveBeenCalled();
  });
});
