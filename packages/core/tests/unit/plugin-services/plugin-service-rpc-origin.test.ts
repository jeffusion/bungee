import { describe, expect, test } from 'bun:test';
import { HostRpcAdapter, RpcServiceError, type HostRpcOwnerInput } from '../../../src/plugin-services/host-rpc';
import { RpcInvocationError, RpcServiceRuntime, type RpcEndpointHandle } from '../../../src/plugin-services/rpc-runtime';

const contract = { id: 'origin.echo', version: 1, methods: {
  echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['background'] },
} } as const;
const target = { provider: 'provider', service: contract.id, major: 1, method: 'echo' };
const binding = { endpoint: 'origin.endpoint', process: 'control', instance: 'origin.instance', generation: 1, catalog: 'origin.catalog', scope: 'global', subject: 'provider' } as const;
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function request(callerToken: object, input: string) { return { target, caller: { subject: 'shared-plugin', scope: 'global' as const }, callerToken, purpose: 'background' as const, input }; }

describe('host-private concrete caller lifetime identity', () => {
  test('revokes and drains one origin without touching another instance of the same logical plugin', async () => {
    const a = Object.freeze({}); const b = Object.freeze({});
    const workA = gate<string>(); const workB = gate<string>();
    let endpoint!: RpcEndpointHandle; let releases = 0;
    const runtime = new RpcServiceRuntime({ admit: ({ callerToken }) => callerToken === a || callerToken === b
      ? { endpoint, callee: null, release: () => { releases += 1; } } : null });
    endpoint = runtime.register({ provider: 'provider', contract, binding, handler: { echo: (input, context) => {
      expect(context.caller).toEqual({ subject: 'shared-plugin', scope: 'global' });
      expect(Object.hasOwn(context, 'callerToken')).toBe(false);
      expect(Object.hasOwn(context.caller, 'callerToken')).toBe(false);
      return input === 'a' ? workA.promise : workB.promise;
    } } });
    runtime.markReady(endpoint);
    const callA = runtime.invokeTracked(request(a, 'a')); const callB = runtime.invokeTracked(request(b, 'b'));
    const resultA = callA.result.catch(error => error);
    let endedB = false; void callB.terminal.then(() => { endedB = true; });
    runtime.revokeCaller('shared-plugin', a);
    expect((await resultA as RpcInvocationError).code).toBe('revoked');
    expect(await runtime.drainOwner('shared-plugin', [], { callerToken: a, timeoutMs: 1 })).toEqual({ drained: false, active: 1 });
    expect(runtime.status().active).toBe(2); expect(releases).toBe(0); expect(endedB).toBe(false);
    workA.resolve('a'); await callA.terminal;
    expect(await runtime.drainOwner('shared-plugin', [], { callerToken: a, timeoutMs: 1 })).toEqual({ drained: true, active: 0 });
    expect(runtime.status().active).toBe(1); expect(releases).toBe(1); expect(endedB).toBe(false);
    workB.resolve('b'); expect(await callB.result).toBe('b'); await callB.terminal;
    expect(releases).toBe(2); await runtime.dispose();
  });

  test('concrete origin never evades the logical caller capacity budget', async () => {
    const work = gate<string>(); let endpoint!: RpcEndpointHandle;
    const runtime = new RpcServiceRuntime({ limits: { callerMaxInFlight: 1 }, admit: () => ({ endpoint, callee: null, release() {} }) });
    endpoint = runtime.register({ provider: 'provider', contract, binding, handler: { echo: () => work.promise } }); runtime.markReady(endpoint);
    const first = runtime.invokeTracked(request({}, 'a'));
    await expect(runtime.invoke(request({}, 'b'))).rejects.toMatchObject({ code: 'overloaded' });
    work.resolve('a'); await first.result; await first.terminal; await runtime.dispose();
  });

  test('malformed origin identities fail before authorization or leases', async () => {
    let admits = 0;
    const runtime = new RpcServiceRuntime({ admit: () => { admits += 1; return null; } });
    for (const token of [null, 42, 'secret', () => {}, new Proxy({}, { get() { throw new Error('must not run'); } })]) {
      await expect(runtime.invoke({ ...request({}, 'a'), callerToken: token as object })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(admits).toBe(0); await runtime.dispose();
  });

  test('explicit invalid admission tokens never fall back to an untracked caller identity', async () => {
    for (const token of [null, 42, 'secret', () => {}, new Proxy({}, {})]) {
      let endpoint!: RpcEndpointHandle; let runs = 0; let releases = 0;
      const runtime = new RpcServiceRuntime({ admit: () => ({ endpoint, callee: null, callerToken: token as object, release: () => { releases += 1; } }) });
      endpoint = runtime.register({ provider: 'provider', contract, binding, handler: { echo: input => { runs += 1; return input; } } }); runtime.markReady(endpoint);
      for (const withInputToken of [false, true]) {
        const invoke = { target, caller: { subject: 'shared-plugin' }, purpose: 'background' as const, input: 'unused', ...(withInputToken ? { callerToken: {} } : {}) };
        const tracked = runtime.invokeTracked(invoke);
        await expect(tracked.result).rejects.toMatchObject({ code: 'unauthorized' }); await tracked.terminal;
      }
      expect(runs).toBe(0); expect(releases).toBe(2); expect(runtime.status().active).toBe(0); await runtime.dispose();
    }
  });

  test('admission assigns the authoritative token instead of the caller hint', async () => {
    const canonical = Object.freeze({}); const hint = Object.freeze({}); const work = gate<string>();
    let endpoint!: RpcEndpointHandle;
    const runtime = new RpcServiceRuntime({ admit: () => ({ endpoint, callee: null, callerToken: canonical, release() {} }) });
    endpoint = runtime.register({ provider: 'provider', contract, binding, handler: { echo: () => work.promise } }); runtime.markReady(endpoint);
    const call = runtime.invokeTracked(request(hint, 'a')); const rejected = call.result.catch(error => error);
    runtime.revokeCaller('shared-plugin', hint);
    expect(await runtime.drainOwner('shared-plugin', [], { callerToken: hint, timeoutMs: 1 })).toEqual({ drained: true, active: 0 });
    expect(runtime.status().active).toBe(1);
    runtime.revokeCaller('shared-plugin', canonical); expect((await rejected as RpcInvocationError).code).toBe('revoked');
    expect(await runtime.drainOwner('shared-plugin', [], { callerToken: canonical, timeoutMs: 1 })).toEqual({ drained: false, active: 1 });
    work.resolve('late'); await call.terminal; await runtime.dispose();
  });

  test('legacy subject-wide revocation still includes every concrete origin', async () => {
    const work = gate<string>(); let endpoint!: RpcEndpointHandle;
    const runtime = new RpcServiceRuntime({ admit: () => ({ endpoint, callee: null, release() {} }) });
    endpoint = runtime.register({ provider: 'provider', contract, binding, handler: { echo: () => work.promise } }); runtime.markReady(endpoint);
    const a = runtime.invokeTracked(request({}, 'a')); const b = runtime.invokeTracked(request({}, 'b'));
    const resultA = a.result.catch(error => error); const resultB = b.result.catch(error => error);
    runtime.revokeCaller('shared-plugin');
    expect((await resultA as RpcInvocationError).code).toBe('revoked'); expect((await resultB as RpcInvocationError).code).toBe('revoked');
    expect(await runtime.drainOwner('shared-plugin', [], { timeoutMs: 1 })).toEqual({ drained: false, active: 2 });
    work.resolve('late'); await Promise.all([a.terminal, b.terminal]); await runtime.dispose();
  });

  test('the canonical adapter binds its real owner token and refuses forged token/subject/scope tuples', async () => {
    let runs = 0; let observedToken: object | undefined;
    const slow = gate<string>();
    const adapter = new HostRpcAdapter({ process: 'control', limits: { drainTimeoutMs: 1 }, resolvePlacement: () => null, resolveJournal: () => null,
      resolveCallee: invocation => { observedToken = invocation.callerToken; return null; } });
    const input = (plugin: string): HostRpcOwnerInput => ({
      token: Object.freeze({}), plugin, scope: 'global',
      declarations: plugin === 'provider' ? { provides: [{ id: contract.id, version: 1, kind: 'rpc', process: 'control' }] }
        : { consumes: [{ plugin: 'provider', id: contract.id, version: 1, kind: 'rpc', process: 'control' }] },
      dependencies: plugin === 'provider' ? {} : { provider: '*' },
      lifecycle: { endpoint: `${plugin}.endpoint`, instance: `${plugin}.instance`, generation: binding.generation, catalog: binding.catalog, subject: plugin },
      getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }),
      acquireLease: () => ({ release() {} }), resolveInvocationContext: () => null,
    });
    const provider = adapter.createOwner(input('provider')); const owner = adapter.createOwner(input('consumer'));
    provider.publish(contract, { echo: value => { runs += 1; return value === 'slow' ? slow.promise : value; } }); provider.markReady(); owner.markReady();
    const client = owner.consume('provider', contract);
    expect(await client.echo('ok')).toBe('ok'); expect(observedToken).toBe(owner.owner.token);
    const invoke = { target, caller: { subject: 'consumer', scope: 'global' as const }, purpose: 'background' as const, input: 'bad' };
    await expect(adapter.runtime.invoke({ ...invoke, callerToken: {} })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(adapter.runtime.invoke({ ...invoke, callerToken: provider.owner.token })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(adapter.runtime.invoke({ ...invoke, callerToken: owner.owner.token, caller: { subject: 'consumer', scope: 'binding' } })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(client.echo('bad', { callerToken: owner.owner.token } as never)).rejects.toBeInstanceOf(RpcServiceError);
    expect(runs).toBe(1);
    // A trusted legacy internal call without an input token still acquires this
    // canonical owner; admission must stamp its identity so disposal joins it.
    const legacy = adapter.runtime.invokeTracked({ ...invoke, input: 'slow' });
    const legacyResult = legacy.result.catch(error => error);
    expect(await owner.dispose()).toEqual({ drained: false, active: 1 });
    expect((await legacyResult as RpcInvocationError).code).toBe('revoked');
    expect(adapter.runtime.status().active).toBe(1);
    slow.resolve('late'); await legacy.terminal;
    expect(await owner.dispose()).toEqual({ drained: true, active: 0 });
    await provider.dispose(); await adapter.dispose();
  });
});
