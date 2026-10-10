import { describe, expect, spyOn, test } from 'bun:test';
import { RpcInvocationError, RpcServiceRuntime, type RpcEndpointHandle, type RpcProxyExecutor } from '../../../src/plugin-services/rpc-runtime';

const contract = { id: 'peer.proxy', version: 1, methods: {
  echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background'] },
  change: { kind: 'command', input: { type: 'string' }, output: { type: 'string' }, purposes: ['management'],
    command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 } },
} } as const;
const binding = { endpoint: 'peer.proxy.endpoint', process: 'worker', instance: 'peer-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'provider' } as const;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(execute: RpcProxyExecutor, maxEndpoints = 128) {
  let endpoint!: RpcEndpointHandle;
  let releases = 0;
  const runtime = new RpcServiceRuntime({ limits: { maxEndpoints }, admit: () => ({ endpoint, callee: null, release: () => { releases += 1; } }) });
  endpoint = runtime.registerProxy({ provider: 'provider', contract, binding, execute });
  runtime.markReady(endpoint);
  const request = (input = 'hello', signal?: AbortSignal) => ({ target: { provider: 'provider', service: contract.id, major: 1, method: 'echo' }, caller: { subject: 'consumer', scope: 'global' as const }, purpose: 'background' as const, input, signal });
  return { runtime, endpoint, request, releases: () => releases };
}
async function rejected(promise: Promise<unknown>) {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(RpcInvocationError); return error as RpcInvocationError; }
  throw new Error('expected rejection');
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('host remote proxy actual-terminal barrier', () => {
  test('expired malformed output retains timeout/unknown precedence over invalid_output', async () => {
    for (const command of [false, true]) {
      const clock = spyOn(Date, 'now');
      const terminal = deferred<void>();
      const made = fixture(request => {
        clock.mockReturnValue((request.context.deadlineAt ?? Date.now()) + 1);
        return { result: Promise.resolve(123), terminal: terminal.promise };
      });
      try {
        const request = command ? { ...made.request(), target: { ...made.request().target, method: 'change' }, purpose: 'management' as const, operationId: 'expired-output' } : made.request();
        expect((await rejected(made.runtime.invoke(request))).code).toBe(command ? 'unknown' : 'timeout');
        expect(made.releases()).toBe(0);
      } finally { clock.mockRestore(); made.runtime.confirmProxyEndpointStopped(made.endpoint); }
    }
  });

  test('invalid proxy shape consumes any identifiable rejected promise without accepting terminal proof', async () => {
    for (const missingTerminal of [true, false]) {
      const made = fixture(() => ({
        result: missingTerminal ? Promise.reject(new Error('transport-secret')) : undefined,
        terminal: missingTerminal ? undefined : Promise.reject(new Error('terminal-secret')),
      } as any));
      expect((await rejected(made.runtime.invoke(made.request()))).code).toBe('failed');
      await tick();
      expect(made.releases()).toBe(0); expect(made.runtime.status().active).toBe(1);
      made.runtime.confirmProxyEndpointStopped(made.endpoint); expect(made.releases()).toBe(1);
    }
  });

  test('a successful reply is not terminal evidence, including after endpoint revocation', async () => {
    const terminal = deferred<void>();
    const made = fixture(() => ({ result: Promise.resolve('reply'), terminal: terminal.promise }));
    expect(await made.runtime.invoke(made.request())).toBe('reply');
    expect(made.runtime.status().active).toBe(1); expect(made.releases()).toBe(0);
    made.runtime.revoke(made.endpoint);
    expect(made.runtime.endpointInfo(made.endpoint)).not.toBeNull();
    expect(made.releases()).toBe(0);
    terminal.resolve(); await tick();
    expect(made.runtime.status().active).toBe(0); expect(made.releases()).toBe(1);
    expect(made.runtime.endpointInfo(made.endpoint)).toBeNull();
  });

  test('caller cancellation holds the remote lease and discards a late reply after terminal', async () => {
    const result = deferred<string>(), terminal = deferred<void>();
    let remoteSignal!: AbortSignal;
    const made = fixture(request => { remoteSignal = request.context.signal; return { result: result.promise, terminal: terminal.promise }; });
    const controller = new AbortController();
    const call = rejected(made.runtime.invoke(made.request('hello', controller.signal)));
    controller.abort();
    expect((await call).code).toBe('cancelled'); expect(remoteSignal.aborted).toBe(true);
    expect(made.runtime.status().active).toBe(1); expect(made.releases()).toBe(0);
    terminal.resolve(); await tick();
    expect(made.releases()).toBe(1); result.resolve('late'); await tick();
    expect(made.releases()).toBe(1); expect(made.runtime.status().active).toBe(0);
    await made.runtime.dispose();
  });

  test('terminal arriving before the result preserves delivery and ownership until caller settlement', async () => {
    const result = deferred<string>();
    const made = fixture(() => ({ result: result.promise, terminal: Promise.resolve() }));
    const call = made.runtime.invoke(made.request());
    await tick(); expect(made.releases()).toBe(0); expect(made.runtime.status().active).toBe(1);
    result.resolve('ordered'); expect(await call).toBe('ordered'); await tick();
    expect(made.releases()).toBe(1); await made.runtime.dispose();
  });

  test('a rejected terminal confirmation retains capacity until actual verified endpoint-stop proof', async () => {
    const terminal = deferred<void>(), result = deferred<string>();
    const made = fixture(() => ({ result: result.promise, terminal: terminal.promise }));
    const call = rejected(made.runtime.invoke(made.request()));
    terminal.reject(new Error('secret-transport-details'));
    const error = await call;
    expect(error.code).toBe('failed'); expect(error.cause).toBeUndefined();
    expect(error.message).not.toContain('secret'); expect(made.releases()).toBe(0);
    expect(await made.runtime.drain(made.endpoint, { timeoutMs: 1 })).toEqual({ drained: false, active: 1 });
    expect(made.runtime.confirmProxyEndpointStopped(made.endpoint)).toBe(true);
    expect(made.releases()).toBe(1); expect(made.runtime.status().active).toBe(0);
    result.resolve('late'); await tick(); expect(made.releases()).toBe(1);
  });

  test('commands and result queries forward the same operation identity without executing a source-side journal', async () => {
    const seen: Array<{ action: string | undefined; operation: string | null; input: unknown }> = [];
    const made = fixture(request => {
      seen.push({ action: request.commandAction, operation: request.context.operationId ?? null, input: request.input });
      return { result: Promise.resolve('remote-result'), terminal: Promise.resolve() };
    });
    const request = { ...made.request(), target: { ...made.request().target, method: 'change' }, purpose: 'management' as const, operationId: 'stable-command' };
    expect(await made.runtime.invoke(request)).toBe('remote-result');
    expect(await made.runtime.invoke({ ...request, input: null, commandAction: 'query-result' })).toBe('remote-result');
    expect(seen).toEqual([{ action: 'execute', operation: 'stable-command', input: 'hello' }, { action: 'query-result', operation: 'stable-command', input: null }]);
    await made.runtime.dispose();
  });

  test('unconfirmed command transport failure is unknown, not a false known rejection or early lease release', async () => {
    const terminal = deferred<void>();
    const made = fixture(() => ({ result: Promise.reject(new Error('network-secret')), terminal: terminal.promise }));
    const request = { ...made.request(), target: { ...made.request().target, method: 'change' }, purpose: 'management' as const, operationId: 'network-command' };
    const error = await rejected(made.runtime.invoke(request));
    expect(error.code).toBe('unknown'); expect(error.operationId).toBe('network-command'); expect(error.cause).toBeUndefined();
    expect(made.releases()).toBe(0);
    expect(await made.runtime.dispose({ timeoutMs: 1 })).toEqual({ disposed: false, active: 1 });
    made.runtime.confirmProxyEndpointStopped(made.endpoint);
    expect(made.releases()).toBe(1);
  });

  test('endpoint capacity is not reclaimed by a reply; actual-terminal releases the revoked record', async () => {
    const terminal = deferred<void>();
    const made = fixture(() => ({ result: Promise.resolve('reply'), terminal: terminal.promise }), 1);
    await made.runtime.invoke(made.request()); made.runtime.revoke(made.endpoint);
    const add = () => made.runtime.registerProxy({ provider: 'provider', contract, binding, execute: () => ({ result: Promise.resolve('new'), terminal: Promise.resolve() }) });
    expect(() => add()).toThrow(RpcInvocationError);
    terminal.resolve(); await tick();
    expect(() => add()).not.toThrow(); await made.runtime.dispose();
  });

  test('expiry before dispatch never invokes the remote transport or acquires a lease', async () => {
    let calls = 0;
    const made = fixture(() => { calls += 1; return { result: Promise.resolve('new'), terminal: Promise.resolve() }; });
    expect((await rejected(made.runtime.invoke({ ...made.request(), deadlineAt: Date.now() - 1 }))).code).toBe('timeout');
    expect(calls).toBe(0); expect(made.releases()).toBe(0); await made.runtime.dispose();
  });
});
