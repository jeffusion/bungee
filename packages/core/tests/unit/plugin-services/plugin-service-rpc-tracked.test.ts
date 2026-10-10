import { describe, expect, test } from 'bun:test';
import { RpcInvocationError, RpcServiceRuntime, type RpcCommandExecutor, type RpcEndpointHandle, type RpcProxyExecutor } from '../../../src/plugin-services/rpc-runtime';

const contract = { id: 'tracked.task', version: 1, methods: {
  read: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background'] },
  write: { kind: 'command', input: { type: 'string' }, output: { type: 'string' }, purposes: ['management'],
    command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 } },
} } as const;
const binding = { endpoint: 'tracked.endpoint', process: 'control', instance: 'control-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'provider' } as const;
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function fixture(read: () => string | Promise<string>, options: { unauthorized?: boolean; executor?: RpcCommandExecutor; proxy?: RpcProxyExecutor } = {}) {
  let endpoint!: RpcEndpointHandle;
  let releases = 0;
  const runtime = new RpcServiceRuntime({ commandExecutor: options.executor, admit: () => options.unauthorized ? null : ({ endpoint, callee: null, release: () => { releases += 1; } }) });
  endpoint = options.proxy ? runtime.registerProxy({ provider: 'provider', contract, binding, execute: options.proxy })
    : runtime.register({ provider: 'provider', contract, binding, handler: { read, write: read } });
  runtime.markReady(endpoint);
  const request = () => ({ target: { provider: 'provider', service: contract.id, major: 1, method: 'read' }, caller: { subject: 'consumer', scope: 'global' as const }, purpose: 'background' as const, input: 'value' });
  return { runtime, endpoint, request, releases: () => releases };
}
async function rejected(promise: Promise<unknown>) {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(RpcInvocationError); return error as RpcInvocationError; }
  throw new Error('expected rejection');
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); }

describe('native provider actual task observation', () => {
  test('a timed-out non-cooperative query emits terminal only after actual work and lease cleanup', async () => {
    const work = gate<string>(); const made = fixture(() => work.promise);
    const tracked = made.runtime.invokeTracked({ ...made.request(), timeoutMs: 2 });
    let ended = false; void tracked.terminal.then(() => { ended = true; });
    expect((await rejected(tracked.result)).code).toBe('timeout');
    expect(ended).toBe(false); expect(made.runtime.status().active).toBe(1); expect(made.releases()).toBe(0);
    work.resolve('finished'); await tracked.terminal;
    expect(made.runtime.status().active).toBe(0); expect(made.releases()).toBe(1);
    await made.runtime.dispose();
  });

  test('command executor early return does not hide actual business from terminal observation', async () => {
    const work = gate<string>();
    const made = fixture(() => work.promise, { executor: { execute: async execution => { void execution.executeBusiness(); return 'premature'; } } });
    const tracked = made.runtime.invokeTracked({ ...made.request(), target: { ...made.request().target, method: 'write' }, purpose: 'management', operationId: 'tracked-command', timeoutMs: 2 });
    let ended = false; void tracked.terminal.then(() => { ended = true; });
    expect((await rejected(tracked.result)).code).toBe('unknown'); expect(ended).toBe(false); expect(made.releases()).toBe(0);
    work.resolve('committed'); await tracked.terminal;
    expect(made.releases()).toBe(1); expect(made.runtime.status().active).toBe(0);
    await made.runtime.dispose();
  });

  test('pre-admission rejection produces terminal evidence with no borrowed lease', async () => {
    const made = fixture(() => 'unused', { unauthorized: true });
    const tracked = made.runtime.invokeTracked(made.request());
    expect((await rejected(tracked.result)).code).toBe('unauthorized'); await tracked.terminal;
    expect(made.releases()).toBe(0); expect(made.runtime.status().active).toBe(0); await made.runtime.dispose();
  });

  test('validation rejection releases admission and resolves terminal without dispatching business', async () => {
    let runs = 0; const made = fixture(() => { runs += 1; return 'unused'; });
    const tracked = made.runtime.invokeTracked({ ...made.request(), input: 123 });
    expect((await rejected(tracked.result)).code).toBe('invalid_input'); await tracked.terminal;
    expect(runs).toBe(0); expect(made.releases()).toBe(1); await made.runtime.dispose();
  });

  test('pre-cancelled invocation has no task to acknowledge or resource to retain', async () => {
    const made = fixture(() => 'unused'); const controller = new AbortController(); controller.abort();
    const tracked = made.runtime.invokeTracked({ ...made.request(), signal: controller.signal });
    expect((await rejected(tracked.result)).code).toBe('cancelled'); await tracked.terminal;
    expect(made.releases()).toBe(0); expect(made.runtime.status().active).toBe(0); await made.runtime.dispose();
  });

  test('revocation settles only the result; completion still follows the real retained task', async () => {
    const work = gate<string>(); const made = fixture(() => work.promise);
    const tracked = made.runtime.invokeTracked(made.request()); const result = rejected(tracked.result);
    made.runtime.revoke(made.endpoint); expect((await result).code).toBe('revoked');
    let ended = false; void tracked.terminal.then(() => { ended = true; }); await tick();
    expect(ended).toBe(false); expect(made.releases()).toBe(0);
    work.resolve('late'); await tracked.terminal;
    expect(made.releases()).toBe(1); expect(made.runtime.endpointInfo(made.endpoint)).toBeNull();
  });

  test('a relay observes terminal of its remote proxy, not the intermediate reply', async () => {
    const remote = gate<void>();
    const made = fixture(() => 'unused', { proxy: () => ({ result: Promise.resolve('reply'), terminal: remote.promise }) });
    const tracked = made.runtime.invokeTracked(made.request());
    expect(await tracked.result).toBe('reply');
    let ended = false; void tracked.terminal.then(() => { ended = true; }); await tick();
    expect(ended).toBe(false); expect(made.releases()).toBe(0);
    remote.resolve(); await tracked.terminal; expect(made.releases()).toBe(1); await made.runtime.dispose();
  });
});
