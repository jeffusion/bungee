import { describe, expect, test } from 'bun:test';
import {
  RpcInvocationError,
  RpcServiceRuntime,
  type RpcAdmission,
  type RpcAdmissionGrant,
  type RpcAdmissionRequest,
  type RpcCommandExecutor,
  type RpcEndpointBinding,
  type RpcEndpointHandle,
  type RpcHandlerContext,
  type RpcHandlerMap,
  type RpcInvokeRequest,
  type RpcInvokeTarget,
  type RpcRuntimeLimits,
} from '../../src/plugin-services/rpc-runtime';
import { RpcProtocolError, type InferRpcData, type RpcCallPurpose, type RpcMethodDefinition } from '../../src/plugin-services/wire-contract';

const service = {
  id: 'kernel.test',
  version: 1,
  methods: {
    echo: {
      kind: 'query',
      input: { type: 'string', maxLength: 64 },
      output: { type: 'string' },
      purposes: ['request', 'management'],
    },
    object: {
      kind: 'query',
      input: { type: 'object', properties: { name: { type: 'string' } } },
      output: { type: 'object', properties: { name: { type: 'string' }, count: { type: 'number' } } },
      purposes: ['request'],
    },
    slow: {
      kind: 'query',
      input: { type: 'null' },
      output: { type: 'null' },
      purposes: ['request'],
    },
    bootstrapOnly: {
      kind: 'query',
      input: { type: 'null' },
      output: { type: 'null' },
      purposes: ['bootstrap'],
    },
    run: {
      kind: 'command',
      input: { type: 'object', properties: { id: { type: 'string' } } },
      output: { type: 'null' },
      purposes: ['management'],
      command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 2048, maxResultBytes: 1024 },
    },
  },
} as const satisfies {
  readonly id: string;
  readonly version: number;
  readonly methods: Record<string, RpcMethodDefinition>;
};

type Methods = typeof service.methods;

const binding = {
  endpoint: 'kernel.test.primary',
  process: 'worker',
  instance: 'instance-1',
  generation: 1,
  catalog: 'catalog-1',
  scope: 'global',
  subject: 'callee',
} as const satisfies RpcEndpointBinding;

const baseHandlers: RpcHandlerMap<Methods, unknown> = {
  echo: (input: string) => input,
  object: (input: { name: string }) => ({ name: input.name, count: input.name.length }),
  slow: async () => null,
  bootstrapOnly: () => null,
  run: () => null,
};

function target(method: keyof Methods): RpcInvokeTarget {
  return { provider: 'provider', service: service.id, major: service.version, method };
}

function req(method: keyof Methods, input: unknown, extra: Partial<RpcInvokeRequest> = {}): RpcInvokeRequest {
  return { target: target(method), caller: { subject: 'caller' }, purpose: 'request', input, ...extra };
}

async function rejection(promise: Promise<unknown>): Promise<RpcInvocationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RpcInvocationError) return error;
    throw error;
  }
  throw new Error('expected the RPC call to reject');
}

interface RuntimeOptions {
  readonly limits?: RpcRuntimeLimits;
  readonly ready?: boolean;
  readonly hostLifetime?: AbortSignal;
  readonly commandExecutor?: RpcCommandExecutor<unknown>;
  readonly admit?: (request: RpcAdmissionRequest, endpoint: RpcEndpointHandle) => RpcAdmissionGrant<unknown> | null;
}

function makeRuntime(overrides: Partial<RpcHandlerMap<Methods, unknown>> = {}, options: RuntimeOptions = {}) {
  const releases = { count: 0 };
  let endpoint: RpcEndpointHandle | null = null;
  const admit: RpcAdmission<unknown> = (request) => {
    if (options.admit) return options.admit(request, endpoint as RpcEndpointHandle);
    if (endpoint === null) return null;
    return { endpoint, callee: { trusted: true }, release: () => { releases.count += 1; } };
  };
  const runtime = new RpcServiceRuntime<unknown>({
    admit,
    commandExecutor: options.commandExecutor,
    hostLifetime: options.hostLifetime,
    limits: options.limits,
  });
  const handle = runtime.register({
    provider: 'provider',
    binding,
    contract: { id: service.id, version: service.version, methods: service.methods },
    handler: { ...baseHandlers, ...overrides } as unknown as RpcHandlerMap<Methods, unknown>,
  });
  endpoint = handle;
  if (options.ready !== false) runtime.markReady(handle);
  return { runtime, handle, releases };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
}

async function idle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('host absolute deadline bounds', () => {
  test('the handler receives the exact inherited upper bound, not a recomputed relative duration', async () => {
    const deadlineAt = Date.now() + 1_000;
    let observed = Infinity;
    const { runtime } = makeRuntime({ echo: (input, context) => { observed = context.deadlineAt ?? Infinity; return input; } });
    expect(await runtime.invoke(req('echo', 'bounded', { timeoutMs: 5_000, deadlineAt }))).toBe('bounded');
    expect(observed).toBe(deadlineAt);
    await runtime.dispose();
  });

  test('an expired absolute bound is refused before admission or any lease', async () => {
    let admissions = 0;
    const { runtime, releases } = makeRuntime({}, { admit: () => { admissions += 1; return null; } });
    expect((await rejection(runtime.invoke(req('echo', 'expired', { deadlineAt: Date.now() - 1 })))).code).toBe('timeout');
    expect(admissions).toBe(0); expect(releases.count).toBe(0);
    expect(runtime.status().active).toBe(0);
    await runtime.dispose();
  });

  test('absolute-bound cancellation preserves the actual non-cooperative task lease until terminal', async () => {
    const pending = gate();
    const { runtime, releases } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = rejection(runtime.invoke(req('slow', null, { timeoutMs: 5_000, deadlineAt: Date.now() + 30 })));
    expect((await call).code).toBe('timeout');
    expect(runtime.status().active).toBe(1); expect(releases.count).toBe(0);
    pending.open(); await idle();
    expect(runtime.status().active).toBe(0); expect(releases.count).toBe(1);
    await runtime.dispose();
  });
});

describe('registration', () => {
  test('endpoint capacity is reclaimed only after revocation and actual work completes', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime({ slow: () => pending.promise.then(() => null) }, { limits: { maxEndpoints: 1 } });
    const add = () => runtime.register({ provider: 'provider', binding, contract: service, handler: baseHandlers });
    expect(() => add()).toThrow(RpcInvocationError);
    const cancelled = rejection(runtime.invoke(req('slow', null)));
    runtime.revoke(handle);
    expect((await cancelled).code).toBe('revoked');
    expect(runtime.status().endpoints).toBe(1);
    expect(() => add()).toThrow(RpcInvocationError);
    pending.open();
    await idle();
    expect(runtime.status().endpoints).toBe(0);
    const replacement = add();
    expect(runtime.markReady(replacement)).toBe(true);
    expect(await runtime.dispose()).toEqual({ disposed: true, active: 0 });
    expect(runtime.status().endpoints).toBe(0);
    expect(() => add()).toThrow(RpcInvocationError);
  });
  test('validates the contract, deployment binding, and handler shape', () => {
    const runtime = new RpcServiceRuntime<unknown>({ admit: () => null });
    const contract = { id: service.id, version: service.version, methods: service.methods };
    expect(() => runtime.register({
      provider: 'provider',
      binding,
      contract,
      handler: { echo: baseHandlers.echo } as unknown as RpcHandlerMap<Methods, unknown>,
    })).toThrow(RpcProtocolError);
    expect(() => runtime.register({
      provider: 'provider',
      binding,
      contract,
      handler: { ...baseHandlers, extra: () => null } as unknown as RpcHandlerMap<Methods, unknown>,
    })).toThrow(RpcProtocolError);
    expect(() => runtime.register({
      provider: 'provider',
      binding,
      contract,
      handler: { ...baseHandlers, echo: 1 } as unknown as RpcHandlerMap<Methods, unknown>,
    })).toThrow(RpcProtocolError);

    const accessor = { ...baseHandlers } as Record<string, unknown>;
    Object.defineProperty(accessor, 'echo', { get: () => () => 'x', enumerable: true });
    expect(() => runtime.register({
      provider: 'provider',
      binding,
      contract,
      handler: accessor as unknown as RpcHandlerMap<Methods, unknown>,
    })).toThrow(RpcProtocolError);

    class Provider {
      echo = () => 'x';
    }
    expect(() => runtime.register({
      provider: 'provider',
      binding,
      contract,
      handler: new Provider() as unknown as RpcHandlerMap<Methods, unknown>,
    })).toThrow(RpcProtocolError);

    expect(() => runtime.register({
      provider: 'provider',
      binding: { ...binding, generation: 0 },
      contract,
      handler: baseHandlers,
    })).toThrow(RpcProtocolError);
  });

  test('literal contracts produce typed handler inputs and outputs', () => {
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Expect<T extends true> = T;
    const handlers = {
      echo: (input: string) => input.toUpperCase(),
      object: (input: { name: string }) => ({ name: input.name, count: input.name.length }),
      slow: async () => null,
      bootstrapOnly: () => null,
      run: () => null,
    } satisfies RpcHandlerMap<Methods, unknown>;
    type _EchoInput = Expect<Equal<InferRpcData<Methods['echo']['input']>, string>>;
    type _EchoOutput = Expect<Equal<InferRpcData<Methods['echo']['output']>, string>>;
    type _ObjectInput = Expect<Equal<InferRpcData<Methods['object']['input']>, { readonly name: string }>>;
    type _ObjectOutput = Expect<Equal<InferRpcData<Methods['object']['output']>, { readonly name: string; readonly count: number }>>;
    type _CommandInput = Expect<Equal<InferRpcData<Methods['run']['input']>, { readonly id: string }>>;
    const compileChecks: [_EchoInput, _EchoOutput, _ObjectInput, _ObjectOutput, _CommandInput] = [true, true, true, true, true];
    void compileChecks;

    const echoHandler: (input: string, context: RpcHandlerContext<unknown>) => string | Promise<string> = handlers.echo;
    expect(echoHandler('a', {
      endpoint: { ...binding, service: service.id, version: service.version },
      caller: { subject: 'c' },
      method: 'echo',
      kind: 'query',
      purpose: 'request',
      operationId: null,
      signal: new AbortController().signal,
      callee: null,
    })).toBe('A');
  });
});

describe('admission and lifecycle', () => {
  test('readiness, bootstrap admission, retirement, and revocation gate calls', async () => {
    const { runtime, handle, releases } = makeRuntime({}, { ready: false });
    expect((await rejection(runtime.invoke(req('echo', 'x')))).code).toBe('not_ready');
    expect(releases.count).toBe(1);
    runtime.markReady(handle);
    expect(await runtime.invoke(req('echo', 'x'))).toBe('x');
    runtime.retire(handle);
    expect((await rejection(runtime.invoke(req('echo', 'x')))).code).toBe('retired');
    runtime.revoke(handle);
    expect((await rejection(runtime.invoke(req('echo', 'x')))).code).toBe('revoked');
  });

  test('a trusted callback may admit a bootstrap call to a not-ready endpoint, but purposes still apply', async () => {
    const { runtime, handle } = makeRuntime({}, {
      ready: false,
      admit: (_request, endpoint) => (endpoint
        ? { endpoint, callee: null, release: () => undefined, allowUnready: true }
        : null),
    });
    expect(await runtime.invoke(req('bootstrapOnly', null, { purpose: 'bootstrap' }))).toBeNull();
    expect((await rejection(runtime.invoke(req('echo', 'x', { purpose: 'request' })))).code).toBe('not_ready');
    runtime.markReady(handle);
    expect((await rejection(runtime.invoke(req('bootstrapOnly', null, { purpose: 'request' })))).code).toBe('wrong_purpose');
  });

  test('denied, forged, and cross-runtime handles are rejected', async () => {
    const first = makeRuntime();

    const second = new RpcServiceRuntime<unknown>({
      admit: () => ({ endpoint: first.handle, callee: null, release: () => undefined }),
    });
    const secondHandle = second.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    second.markReady(secondHandle);
    expect((await rejection(second.invoke(req('echo', 'x')))).code).toBe('unauthorized');

    const forged = new RpcServiceRuntime<unknown>({
      admit: () => ({ endpoint: {} as RpcEndpointHandle, callee: null, release: () => undefined }),
    });
    const forgedHandle = forged.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    forged.markReady(forgedHandle);
    expect((await rejection(forged.invoke(req('echo', 'x')))).code).toBe('unauthorized');

    const denied = new RpcServiceRuntime<unknown>({ admit: () => null });
    denied.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    expect((await rejection(denied.invoke(req('echo', 'x')))).code).toBe('unauthorized');

    const thrown = new RpcServiceRuntime<unknown>({
      admit: () => { throw new Error('admission exploded'); },
    });
    thrown.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    expect((await rejection(thrown.invoke(req('echo', 'x')))).code).toBe('unauthorized');
  });

  test('target mismatches and unsupported methods are rejected', async () => {
    const { runtime } = makeRuntime();
    expect((await rejection(runtime.invoke({
      ...req('echo', 'x'),
      target: { provider: 'other', service: service.id, major: service.version, method: 'echo' },
    }))).code).toBe('unauthorized');
    expect((await rejection(runtime.invoke({
      ...req('echo', 'x'),
      target: { provider: 'provider', service: service.id, major: 9, method: 'echo' },
    }))).code).toBe('unauthorized');
    expect((await rejection(runtime.invoke({
      ...req('echo', 'x'),
      target: { provider: 'provider', service: service.id, major: service.version, method: 'missing' },
    }))).code).toBe('unsupported_method');
  });
});

describe('data boundary', () => {
  test('input is cloned and validated before any business runs', async () => {
    const calls: unknown[] = [];
    const { runtime } = makeRuntime({ echo: (input: string) => { calls.push(input); return input; } });
    expect((await rejection(runtime.invoke(req('echo', 42)))).code).toBe('invalid_input');
    expect((await rejection(runtime.invoke(req('echo', 'x'.repeat(100))))).code).toBe('invalid_input');
    expect((await rejection(runtime.invoke(req('echo', 'abcd', { maxInputBytes: 3 })))).code).toBe('invalid_input');
    expect(calls).toEqual([]);
  });

  test('output is cloned and validated, and provider errors are not leaked', async () => {
    const response = { name: 'a', count: 1 };
    const { runtime } = makeRuntime({ object: () => response });
    const result = await runtime.invoke(req('object', { name: 'a' }));
    expect(result).toEqual({ name: 'a', count: 1 });
    expect(result).not.toBe(response);

    const { runtime: bad } = makeRuntime({ object: () => ({ name: 'a', count: 'x' as unknown as number }) });
    expect((await rejection(bad.invoke(req('object', { name: 'a' })))).code).toBe('invalid_output');

    const { runtime: failing } = makeRuntime({ echo: () => { throw new Error('super-secret-token'); } });
    const error = await rejection(failing.invoke(req('echo', 'x')));
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('super-secret-token');
  });

  test('cloned inputs and outputs cannot mutate the other side', async () => {
    let seenInput: { name: string } | null = null;
    const providerOutput = { name: 'a', count: 1 };
    const { runtime } = makeRuntime({ object: (input: { name: string }) => { seenInput = input; return providerOutput; } });
    const input = { name: 'a' };
    const result = await runtime.invoke(req('object', input));
    seenInput!.name = 'mutated';
    expect(input.name).toBe('a');
    (result as unknown as { name: string }).name = 'changed';
    expect(providerOutput.name).toBe('a');
  });

  test('the registered contract is an isolated validated clone', async () => {
    const methods = {
      echo: {
        kind: 'query' as const,
        input: { type: 'string' as const, maxLength: 4 },
        output: { type: 'null' as const },
        purposes: ['request'] as RpcCallPurpose[],
      },
    };
    let granted: RpcEndpointHandle | null = null;
    const runtime = new RpcServiceRuntime<unknown>({
      admit: () => (granted ? { endpoint: granted, callee: null, release: () => undefined } : null),
    });
    granted = runtime.register({
      provider: 'provider',
      binding,
      contract: { id: 'mutable.service', version: 1, methods },
      handler: { echo: () => null },
    });
    runtime.markReady(granted);
    methods.echo.input.maxLength = 100;
    expect((await rejection(runtime.invoke({
      target: { provider: 'provider', service: 'mutable.service', major: 1, method: 'echo' },
      caller: { subject: 'caller' },
      purpose: 'request',
      input: 'toolong',
    }))).code).toBe('invalid_input');
  });
});

describe('capacity, cancellation, and deadlines', () => {
  test('global, endpoint, and per-caller in-flight capacity is bounded', async () => {
    const gates: Array<ReturnType<typeof gate>> = [];
    const slow = () => { const pending = gate(); gates.push(pending); return pending.promise.then(() => null); };

    const globalLimited = makeRuntime({ slow }, { limits: { globalMaxInFlight: 1 } });
    const globalFirst = globalLimited.runtime.invoke(req('slow', null));
    expect((await rejection(globalLimited.runtime.invoke(req('slow', null)))).code).toBe('overloaded');
    gates[0].open();
    expect(await globalFirst).toBeNull();
    await idle();

    gates.length = 0;
    const endpointLimited = makeRuntime({ slow }, { limits: { endpointMaxInFlight: 1 } });
    const endpointFirst = endpointLimited.runtime.invoke(req('slow', null));
    expect((await rejection(endpointLimited.runtime.invoke(req('slow', null)))).code).toBe('overloaded');
    gates[0].open();
    expect(await endpointFirst).toBeNull();
    await idle();

    gates.length = 0;
    const callerLimited = makeRuntime({ slow }, { limits: { callerMaxInFlight: 1 } });
    const callerFirst = callerLimited.runtime.invoke(req('slow', null));
    expect((await rejection(callerLimited.runtime.invoke(req('slow', null)))).code).toBe('overloaded');
    const otherCaller = callerLimited.runtime.invoke(req('slow', null, { caller: { subject: 'other' } }));
    expect(callerLimited.runtime.status().active).toBe(2);
    for (const pending of gates) pending.open();
    expect(await callerFirst).toBeNull();
    expect(await otherCaller).toBeNull();
    await idle();
    expect(callerLimited.runtime.status().active).toBe(0);
  });

  test('an already-cancelled call never starts the handler', async () => {
    const calls: unknown[] = [];
    const { runtime, releases } = makeRuntime({ echo: (input: string) => { calls.push(input); return input; } });
    const controller = new AbortController();
    controller.abort();
    expect((await rejection(runtime.invoke({ ...req('echo', 'x'), signal: controller.signal }))).code).toBe('cancelled');
    expect(calls).toEqual([]);
    expect(releases.count).toBe(0);
  });

  test('cancelling a non-cooperative query keeps its count and lease until the gate ends', async () => {
    const pending = gate();
    const { runtime, releases } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const controller = new AbortController();
    const call = runtime.invoke({ ...req('slow', null), signal: controller.signal });
    expect(runtime.status().active).toBe(1);
    controller.abort();
    expect((await rejection(call)).code).toBe('cancelled');
    expect(runtime.status().active).toBe(1);
    expect(releases.count).toBe(0);
    pending.open();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
  });

  test('a query deadline rejects as timeout but retains the lease until the gate ends', async () => {
    const pending = gate();
    const { runtime, releases } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = runtime.invoke(req('slow', null, { timeoutMs: 10 }));
    expect((await rejection(call)).code).toBe('timeout');
    expect(runtime.status().active).toBe(1);
    expect(releases.count).toBe(0);
    pending.open();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
  });
});

describe('commands', () => {
  test('repeated executor access to the business closure never repeats the side effect', async () => {
    let calls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async execution => {
        const first = execution.executeBusiness();
        const second = execution.executeBusiness();
        expect(first).toBe(second);
        await first;
        return second;
      },
    };
    const { runtime } = makeRuntime({ run: () => { calls += 1; return null; } }, { commandExecutor });
    expect(await runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-once' }))).toBeNull();
    expect(calls).toBe(1);
  });
  test('commands run only through the host executor, exactly once, and report unknown after delivery', async () => {
    const pending = gate();
    let executorCalls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async (execution) => { executorCalls += 1; return execution.executeBusiness(); },
    };
    const { runtime, releases } = makeRuntime({ run: () => pending.promise.then(() => null) }, { commandExecutor });
    const controller = new AbortController();
    const call = runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-1', signal: controller.signal }));
    expect(executorCalls).toBe(1);
    controller.abort();
    const error = await rejection(call);
    expect(error.code).toBe('unknown');
    expect(error.operationId).toBe('op-1');
    expect(runtime.status().active).toBe(1);
    expect(releases.count).toBe(0);
    expect(executorCalls).toBe(1);
    pending.open();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
    expect(executorCalls).toBe(1);
  });

  test('a command without a host executor fails explicitly and never falls back to the handler', async () => {
    const calls: unknown[] = [];
    const { runtime, releases } = makeRuntime({ run: (input: { id: string }) => { calls.push(input); return null; } });
    expect((await rejection(runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-2' })))).code)
      .toBe('capability_unavailable');
    expect(calls).toEqual([]);
    expect(releases.count).toBe(1);
    expect((await rejection(runtime.invoke(req('run', { id: 'op' }, { purpose: 'management' })))).code)
      .toBe('invalid_operation_id');
    expect((await rejection(runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'bad id!' })))).code)
      .toBe('invalid_operation_id');
  });
});

describe('retirement, drain, and disposal', () => {
  test('a revoked generation never delivers a late reply', async () => {
    const pending = gate();
    const { runtime, handle, releases } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = runtime.invoke(req('slow', null));
    runtime.revoke(handle);
    expect((await rejection(call)).code).toBe('revoked');
    expect(runtime.status().active).toBe(1);
    pending.open();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
  });

  test('drain is bounded, reports the real active state, and completes once the gate ends', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = runtime.invoke(req('slow', null));
    expect(await runtime.drain(handle, { timeoutMs: 5 })).toEqual({ drained: false, active: 1 });
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(await runtime.drain(handle, { timeoutMs: 100 })).toEqual({ drained: true, active: 0 });
  });

  test('dispose aborts callers and never reports success while real work is still active', async () => {
    const pending = gate();
    const { runtime } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const cancelled = rejection(runtime.invoke(req('slow', null)));
    expect(await runtime.dispose({ timeoutMs: 5 })).toEqual({ disposed: false, active: 1 });
    expect((await cancelled).code).toBe('closed');
    expect((await rejection(runtime.invoke(req('slow', null)))).code).toBe('closed');
    pending.open();
    await idle();
    expect(await runtime.dispose({ timeoutMs: 100 })).toEqual({ disposed: true, active: 0 });
  });
});

describe('request snapshot and admission re-entrancy', () => {
  test('the outer invoke request is snapshotted without invoking accessors, proxies, or unknown keys', async () => {
    const { runtime, handle } = makeRuntime();
    let accessorReads = 0;
    const accessorRequest = {
      target: target('echo'),
      caller: { subject: 'caller' },
      purpose: 'request',
      get input() { accessorReads += 1; runtime.revoke(handle); return 'x'; },
    } as unknown as RpcInvokeRequest;
    expect((await rejection(runtime.invoke(accessorRequest))).code).toBe('invalid_input');
    expect(accessorReads).toBe(0);
    expect(runtime.status().endpoints).toBe(1);

    const proxyRequest = new Proxy({ ...req('echo', 'x') }, {}) as RpcInvokeRequest;
    expect((await rejection(runtime.invoke(proxyRequest))).code).toBe('invalid_input');

    const unknownKeys = { ...req('echo', 'x'), extra: 1 } as unknown as RpcInvokeRequest;
    expect((await rejection(runtime.invoke(unknownKeys))).code).toBe('invalid_input');

    let targetReads = 0;
    const targetAccessor = {
      ...req('echo', 'x'),
      target: { get provider() { targetReads += 1; return 'provider'; }, service: service.id, major: 1, method: 'echo' },
    } as unknown as RpcInvokeRequest;
    expect((await rejection(runtime.invoke(targetAccessor))).code).toBe('invalid_input');
    expect(targetReads).toBe(0);
    expect(await runtime.invoke(req('echo', 'x'))).toBe('x');
  });

  test('re-entrant admission revocation, retirement, and lifetime abort reject without dropping the lease', async () => {
    const leases = { revoke: 0, retire: 0, abort: 0 };
    const build = (kind: 'revoke' | 'retire' | 'abort') => {
      let handle: RpcEndpointHandle | null = null;
      const lifetime = new AbortController();
      const runtime = new RpcServiceRuntime<unknown>({
        admit: () => {
          if (!handle) return null;
          if (kind === 'revoke') runtime.revoke(handle);
          else if (kind === 'retire') runtime.retire(handle);
          else lifetime.abort();
          return { endpoint: handle, callee: null, release: () => { leases[kind] += 1; } };
        },
        hostLifetime: lifetime.signal,
      });
      handle = runtime.register({
        provider: 'provider',
        binding,
        contract: { id: service.id, version: service.version, methods: service.methods },
        handler: baseHandlers,
      });
      runtime.markReady(handle);
      return runtime;
    };
    expect((await rejection(build('revoke').invoke(req('echo', 'x')))).code).toBe('revoked');
    expect((await rejection(build('retire').invoke(req('echo', 'x')))).code).toBe('retired');
    expect((await rejection(build('abort').invoke(req('echo', 'x')))).code).toBe('closed');
    expect(leases).toEqual({ revoke: 1, retire: 1, abort: 1 });
  });
});

describe('command business tracking', () => {
  test('synchronous handler re-entry receives the same already-installed business promise', async () => {
    let saved!: () => Promise<unknown>;
    let reentered: Promise<unknown> | undefined;
    let first: Promise<unknown> | undefined;
    let calls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: execution => { saved = execution.executeBusiness; first = saved(); return first; },
    };
    const { runtime } = makeRuntime({ run: () => {
      calls += 1;
      reentered = saved();
      void reentered.catch(() => undefined);
      return null;
    } }, { commandExecutor });
    expect(await runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-reentrant' }))).toBeNull();
    expect(reentered).toBe(first);
    expect(calls).toBe(1);
  });

  for (const reason of ['cancel', 'timeout'] as const) {
    test(`${reason} forbids a delayed first business dispatch while retaining the executor lease`, async () => {
      const pending = gate();
      const controller = new AbortController();
      let calls = 0;
      const commandExecutor: RpcCommandExecutor<unknown> = {
        execute: async execution => { await pending.promise; return execution.executeBusiness(); },
      };
      const { runtime, releases } = makeRuntime({ run: () => { calls += 1; return null; } }, { commandExecutor });
      const error = rejection(runtime.invoke(req('run', { id: 'op' }, {
        purpose: 'management', operationId: `op-delayed-${reason}`, signal: controller.signal,
        ...(reason === 'timeout' ? { timeoutMs: 5 } : {}),
      })));
      if (reason === 'cancel') controller.abort();
      expect((await error).code).toBe('unknown');
      expect(runtime.status().active).toBe(1);
      expect(releases.count).toBe(0);
      pending.open();
      await idle();
      expect(calls).toBe(0);
      expect(runtime.status().active).toBe(0);
      expect(releases.count).toBe(1);
    });
  }

  test('a fire-and-forget executor keeps counts and lease until the real business ends', async () => {
    const pending = gate();
    let handlerCalls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: (execution) => { void execution.executeBusiness(); return Promise.resolve(null); },
    };
    const { runtime, handle, releases } = makeRuntime(
      { run: () => { handlerCalls += 1; return pending.promise.then(() => null); } },
      { commandExecutor },
    );
    const call = runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-fire' }));
    await idle();
    expect(handlerCalls).toBe(1);
    expect(runtime.status().active).toBe(1);
    expect(releases.count).toBe(0);
    expect(await runtime.drain(handle, { timeoutMs: 5 })).toEqual({ drained: false, active: 1 });
    expect(releases.count).toBe(0);
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
  });

  test('a late business closure after the executor returns is refused and never runs user code', async () => {
    let saved: (() => Promise<unknown>) | null = null;
    let handlerCalls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: (execution) => { saved = execution.executeBusiness; return Promise.resolve(null); },
    };
    const { runtime } = makeRuntime({ run: () => { handlerCalls += 1; return null; } }, { commandExecutor });
    expect(await runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-late' }))).toBeNull();
    expect(handlerCalls).toBe(0);
    const refused = await rejection(saved!());
    expect(refused.code).toBe('unknown');
    expect(refused.operationId).toBe('op-late');
    expect(handlerCalls).toBe(0);
  });

  test('a late business closure after dispose is refused and never runs user code', async () => {
    let saved: (() => Promise<unknown>) | null = null;
    let handlerCalls = 0;
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: (execution) => { saved = execution.executeBusiness; return Promise.resolve(null); },
    };
    const { runtime } = makeRuntime({ run: () => { handlerCalls += 1; return null; } }, { commandExecutor });
    expect(await runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-disposed' }))).toBeNull();
    expect(await runtime.dispose()).toEqual({ disposed: true, active: 0 });
    const refused = await rejection(saved!());
    expect(refused.code).toBe('closed');
    expect(handlerCalls).toBe(0);
  });

  test('an unawaited business rejection is surfaced without leaking or going unhandled', async () => {
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: (execution) => { void execution.executeBusiness(); return Promise.resolve(null); },
    };
    const { runtime, releases } = makeRuntime(
      { run: () => { throw new Error('secret-business-token'); } },
      { commandExecutor },
    );
    const error = await rejection(runtime.invoke(req('run', { id: 'op' }, { purpose: 'management', operationId: 'op-reject' })));
    expect(error.code).toBe('failed');
    expect(error.message).not.toContain('secret-business-token');
    expect('cause' in error).toBe(false);
    await idle();
    expect(releases.count).toBe(1);
  });
});

describe('error sanitation', () => {
  test('provider-forged errors, causes, and thrown strings never leak or spoof codes', async () => {
    const { runtime } = makeRuntime({ echo: () => { throw new Error('super-secret-token'); } });
    const plain = await rejection(runtime.invoke(req('echo', 'x')));
    expect(plain.code).toBe('failed');
    expect(plain.message).toBe('RPC call failed');
    expect('cause' in plain).toBe(false);

    const forged = new RpcInvocationError('unauthorized', 'evil-op');
    forged.message = 'forged-secret';
    (forged as unknown as { cause?: unknown }).cause = { secret: 'cause-secret' };
    const { runtime: forgedRuntime } = makeRuntime({ echo: () => { throw forged; } });
    const sanitized = await rejection(forgedRuntime.invoke(req('echo', 'x')));
    expect(sanitized).not.toBe(forged);
    expect(sanitized.code).toBe('failed');
    expect(sanitized.operationId).toBeNull();
    expect(sanitized.message).not.toContain('forged-secret');
    expect(sanitized.message).not.toContain('cause-secret');
    expect('cause' in sanitized).toBe(false);

    const { runtime: stringRuntime } = makeRuntime({ echo: () => { throw 'string-secret-token'; } });
    const stringError = await rejection(stringRuntime.invoke(req('echo', 'x')));
    expect(stringError.code).toBe('failed');
    expect(stringError.message).not.toContain('string-secret-token');
    expect('cause' in stringError).toBe(false);
  });
});

describe('endpoint retention', () => {
  test('a released revoked handle stays revoked for its runtime and is unauthorized elsewhere', async () => {
    const first = makeRuntime();
    expect(await first.runtime.invoke(req('echo', 'x'))).toBe('x');
    first.runtime.revoke(first.handle);
    expect(first.runtime.status().endpoints).toBe(0);
    expect((await rejection(first.runtime.invoke(req('echo', 'x')))).code).toBe('revoked');

    const foreign = new RpcServiceRuntime<unknown>({
      admit: () => ({ endpoint: first.handle, callee: null, release: () => undefined }),
    });
    const foreignHandle = foreign.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    foreign.markReady(foreignHandle);
    expect((await rejection(foreign.invoke(req('echo', 'x')))).code).toBe('unauthorized');
  });

  test('a retired record is not released before its real work ends and revocation then reclaims it', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = runtime.invoke(req('slow', null));
    runtime.retire(handle);
    expect(runtime.status().endpoints).toBe(1);
    expect((await rejection(runtime.invoke(req('slow', null)))).code).toBe('retired');
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(runtime.status().endpoints).toBe(1);
    runtime.revoke(handle);
    expect(runtime.status().endpoints).toBe(0);
    expect((await rejection(runtime.invoke(req('slow', null)))).code).toBe('revoked');
  });
});

describe('waiter capacity', () => {
  test('waiter slots are bounded and a timed-out wait frees its slot for a later wait', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime(
      { slow: () => pending.promise.then(() => null) },
      { limits: { maxWaiters: 1 } },
    );
    const call = runtime.invoke(req('slow', null));
    const first = runtime.drain(handle, { timeoutMs: 5 });
    expect((await rejection(runtime.drain(handle, { timeoutMs: 5 }))).code).toBe('overloaded');
    expect(runtime.status().active).toBe(1);
    expect(await first).toEqual({ drained: false, active: 1 });
    const second = runtime.drain(handle, { timeoutMs: 200 });
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(await second).toEqual({ drained: true, active: 0 });
    expect(runtime.status().waiters).toBe(0);
  });

  test('an overflowing timeout is rejected instead of silently clamping to a 1ms timer', async () => {
    const { runtime, handle } = makeRuntime();
    let overflow: unknown;
    try { await runtime.drain(handle, { timeoutMs: 2_147_483_648 }); } catch (error) { overflow = error; }
    expect(overflow).toBeInstanceOf(RpcProtocolError);
  });
});

describe('endpoint metadata', () => {
  test('endpointInfo exposes only frozen provider/binding/contract metadata for live handles', () => {
    const { runtime, handle } = makeRuntime();
    const info = runtime.endpointInfo(handle);
    expect(info).not.toBeNull();
    expect(info!.provider).toBe('provider');
    expect(info!.binding).toEqual(binding);
    expect(info!.contract.id).toBe(service.id);
    expect(info!.contract.version).toBe(service.version);
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info!.binding)).toBe(true);
    expect(Object.isFrozen(info!.contract)).toBe(true);
    expect('handler' in info!).toBe(false);
    expect('owner' in info!).toBe(false);
    expect('context' in info!).toBe(false);
    expect(Reflect.set(info!.binding as object, 'endpoint', 'other')).toBe(false);
    expect(info!.binding.endpoint).toBe(binding.endpoint);
    expect(Reflect.set(info!.contract as object, 'id', 'evil')).toBe(false);
    expect(info!.contract.id).toBe(service.id);

    const foreign = new RpcServiceRuntime<unknown>({ admit: () => null });
    const foreignHandle = foreign.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    expect(runtime.endpointInfo(foreignHandle)).toBeNull();
    expect(runtime.endpointInfo({} as RpcEndpointHandle)).toBeNull();
    expect(runtime.endpointInfo(null as unknown as RpcEndpointHandle)).toBeNull();

    runtime.revoke(handle);
    expect(runtime.endpointInfo(handle)).toBeNull();
  });
});

describe('absolute deadline enforcement', () => {
  for (const style of ['return', 'fire-and-forget'] as const) {
    test(`a synchronous executor that outlives the deadline cannot effect business or report success (${style})`, async () => {
      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;
      try {
        let effects = 0;
        const commandExecutor: RpcCommandExecutor<unknown> = {
          execute: (execution) => {
            // Block the event loop so the deadline timer cannot fire, then dispatch late.
            now = execution.context.deadlineAt! + 1;
            if (style === 'return') return execution.executeBusiness();
            void execution.executeBusiness();
            return Promise.resolve(null);
          },
        };
        const { runtime, releases } = makeRuntime({ run: () => { effects += 1; return null; } }, { commandExecutor });
        const error = await rejection(runtime.invoke(req('run', { id: 'x' }, {
          purpose: 'management', operationId: `op-sync-${style}`, timeoutMs: 1,
        })));
        expect(error.code).toBe('unknown');
        expect(error.operationId).toBe(`op-sync-${style}`);
        expect(effects).toBe(0);
        await idle();
        expect(releases.count).toBe(1);
        expect(runtime.status().active).toBe(0);
      } finally {
        Date.now = realNow;
      }
    });
  }

  test('a query that settles synchronously past the deadline is refused as timeout, not delivered', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const { runtime, releases } = makeRuntime({
        slow: (_input: null, context: RpcHandlerContext<unknown>) => {
          now = context.deadlineAt! + 1;
          return null;
        },
      });
      const error = await rejection(runtime.invoke(req('slow', null, { timeoutMs: 1 })));
      expect(error.code).toBe('timeout');
      expect(error.operationId).toBeNull();
      await idle();
      expect(releases.count).toBe(1);
      expect(runtime.status().active).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('command control actions', () => {
  test('query-result and reconcile share target authorization, purpose, and output validation', async () => {
    const seen: Array<{ action: string; input: unknown; operationId: string; business: boolean }> = [];
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async () => null,
      queryResult: async (execution) => {
        seen.push({
          action: 'query-result', input: execution.input, operationId: execution.operationId,
          business: Object.prototype.hasOwnProperty.call(execution, 'executeBusiness'),
        });
        return null;
      },
      reconcile: async (execution) => {
        seen.push({
          action: 'reconcile', input: execution.input, operationId: execution.operationId,
          business: Object.prototype.hasOwnProperty.call(execution, 'executeBusiness'),
        });
        return null;
      },
    };
    const { runtime, handle, releases } = makeRuntime({}, { commandExecutor });

    // query-result ignores the business input schema entirely and receives null.
    expect(await runtime.invoke(req('run', { id: 7 }, {
      purpose: 'management', operationId: 'op-qr', commandAction: 'query-result',
    }))).toBeNull();
    expect(seen[0]).toEqual({ action: 'query-result', input: null, operationId: 'op-qr', business: false });

    // reconcile clones and validates the real business input.
    const input = { id: 'y' };
    expect(await runtime.invoke(req('run', input, {
      purpose: 'management', operationId: 'op-rc', commandAction: 'reconcile',
    }))).toBeNull();
    expect(seen[1]).toEqual({ action: 'reconcile', input: { id: 'y' }, operationId: 'op-rc', business: false });
    expect(seen[1].input).not.toBe(input);

    expect((await rejection(runtime.invoke(req('run', { id: 7 }, {
      purpose: 'management', operationId: 'op-rc-bad', commandAction: 'reconcile',
    })))).code).toBe('invalid_input');
    expect((await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'request', operationId: 'op-qr-purpose', commandAction: 'query-result',
    })))).code).toBe('wrong_purpose');
    expect(seen).toHaveLength(2);
    await idle();
    expect(releases.count).toBe(4);

    runtime.revoke(handle);
    expect((await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-qr-revoked', commandAction: 'query-result',
    })))).code).toBe('revoked');
    expect(seen).toHaveLength(2);
    await idle();
    expect(releases.count).toBe(5);
  });

  test('control action output is the kernel output, and a missing capability is explicit', async () => {
    const bad: RpcCommandExecutor<unknown> = {
      execute: async () => null,
      queryResult: async () => 42,
      reconcile: async () => 'nope',
    };
    const { runtime } = makeRuntime({}, { commandExecutor: bad });
    expect((await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-b1', commandAction: 'query-result',
    })))).code).toBe('invalid_output');
    expect((await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-b2', commandAction: 'reconcile',
    })))).code).toBe('invalid_output');

    const onlyExecute: RpcCommandExecutor<unknown> = { execute: async () => null };
    const { runtime: missing } = makeRuntime({}, { commandExecutor: onlyExecute });
    expect((await rejection(missing.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-m1', commandAction: 'query-result',
    })))).code).toBe('capability_unavailable');
    expect((await rejection(missing.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-m2', commandAction: 'reconcile',
    })))).code).toBe('capability_unavailable');
  });

  test('a gated query-result keeps its lease and reports cancelled/timeout, never unknown', async () => {
    for (const reason of ['cancel', 'timeout'] as const) {
      const pending = gate();
      const commandExecutor: RpcCommandExecutor<unknown> = {
        execute: async () => null,
        queryResult: () => pending.promise.then(() => null),
      };
      const { runtime, releases } = makeRuntime({}, { commandExecutor });
      const controller = new AbortController();
      const call = rejection(runtime.invoke(req('run', { id: 'x' }, {
        purpose: 'management', operationId: `op-qr-${reason}`, commandAction: 'query-result',
        signal: controller.signal,
        ...(reason === 'timeout' ? { timeoutMs: 5 } : {}),
      })));
      if (reason === 'cancel') controller.abort();
      expect((await call).code).toBe(reason === 'cancel' ? 'cancelled' : 'timeout');
      expect(runtime.status().active).toBe(1);
      expect(releases.count).toBe(0);
      pending.open();
      await idle();
      expect(runtime.status().active).toBe(0);
      expect(releases.count).toBe(1);
    }
  });

  test('a gated reconcile keeps its lease and reports unknown after delivery', async () => {
    const pending = gate();
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async () => null,
      reconcile: () => pending.promise.then(() => null),
    };
    const { runtime, releases } = makeRuntime({}, { commandExecutor });
    const controller = new AbortController();
    const call = rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-rc-unknown', commandAction: 'reconcile', signal: controller.signal,
    })));
    controller.abort();
    expect((await call).code).toBe('unknown');
    expect(runtime.status().active).toBe(1);
    expect(releases.count).toBe(0);
    pending.open();
    await idle();
    expect(runtime.status().active).toBe(0);
    expect(releases.count).toBe(1);
  });

  test('control actions share the runtime capacity gate', async () => {
    const pending = gate();
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async () => null,
      queryResult: () => pending.promise.then(() => null),
    };
    const { runtime, releases } = makeRuntime({}, { commandExecutor, limits: { globalMaxInFlight: 1 } });
    const held = runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-cap-1', commandAction: 'query-result',
    }));
    expect(runtime.status().active).toBe(1);
    expect((await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-cap-2', commandAction: 'query-result',
    })))).code).toBe('overloaded');
    expect(releases.count).toBe(1);
    pending.open();
    expect(await held).toBeNull();
    await idle();
    expect(releases.count).toBe(2);
  });
});

describe('command business error sanitation', () => {
  for (const style of ['return', 'fire-and-forget'] as const) {
    test(`${style} executor cannot promote a provider-forged code to a trusted code`, async () => {
      const forged = new RpcInvocationError('conflict', 'evil-op');
      forged.message = 'forged-secret';
      (forged as unknown as { cause?: unknown }).cause = { secret: 'cause-secret' };
      const commandExecutor: RpcCommandExecutor<unknown> = style === 'return'
        ? { execute: (execution) => execution.executeBusiness() }
        : { execute: (execution) => { void execution.executeBusiness(); return Promise.resolve(null); } };
      const { runtime, releases } = makeRuntime({ run: () => { throw forged; } }, { commandExecutor });
      const error = await rejection(runtime.invoke(req('run', { id: 'x' }, {
        purpose: 'management', operationId: `op-forge-${style}`,
      })));
      expect(error.code).toBe('failed');
      expect(error.operationId).toBe(`op-forge-${style}`);
      expect(error.message).toBe('RPC call failed');
      expect(error.message).not.toContain('forged-secret');
      expect(error.message).not.toContain('cause-secret');
      expect('cause' in error).toBe(false);
      await idle();
      expect(releases.count).toBe(1);
    });
  }

  test('provider string throws and accessor codes are sanitized without running the accessor', async () => {
    const commandExecutor: RpcCommandExecutor<unknown> = { execute: (execution) => execution.executeBusiness() };
    const { runtime: stringRuntime } = makeRuntime(
      { run: () => { throw 'string-secret-token'; } },
      { commandExecutor },
    );
    const stringError = await rejection(stringRuntime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-str',
    })));
    expect(stringError.code).toBe('failed');
    expect(stringError.message).not.toContain('string-secret-token');
    expect('cause' in stringError).toBe(false);

    let getterReads = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'code', { get: () => { getterReads += 1; return 'conflict'; }, enumerable: true });
    accessor.cause = { secret: 'cause-secret' };
    const { runtime: accessorRuntime } = makeRuntime(
      { run: () => { throw accessor; } },
      { commandExecutor },
    );
    const accessorError = await rejection(accessorRuntime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-get',
    })));
    expect(accessorError.code).toBe('failed');
    expect(accessorError.message).not.toContain('cause-secret');
    expect('cause' in accessorError).toBe(false);
    expect(getterReads).toBe(0);
  });

  test('a genuine trusted executor conflict is preserved', async () => {
    const commandExecutor: RpcCommandExecutor<unknown> = {
      execute: async () => { throw new RpcInvocationError('conflict', 'executor-op'); },
      queryResult: async () => { throw new RpcInvocationError('conflict', 'executor-op'); },
    };
    const { runtime, releases } = makeRuntime({ run: () => null }, { commandExecutor });
    const executed = await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-exec-conflict',
    })));
    expect(executed.code).toBe('conflict');
    expect(executed.operationId).toBe('op-exec-conflict');
    const queried = await rejection(runtime.invoke(req('run', { id: 'x' }, {
      purpose: 'management', operationId: 'op-qr-conflict', commandAction: 'query-result',
    })));
    expect(queried.code).toBe('conflict');
    expect(queried.operationId).toBe('op-qr-conflict');
    await idle();
    expect(releases.count).toBe(2);
  });
});

describe('retirement proof and owner drain', () => {
  test('allowRetired needs an explicit request/attempt proof and never bypasses revoked or closed', async () => {
    let handle: RpcEndpointHandle | null = null;
    let releases = 0;
    const runtime = new RpcServiceRuntime<unknown>({
      admit: () => (handle
        ? { endpoint: handle, callee: null, release: () => { releases += 1; }, allowRetired: true }
        : null),
    });
    handle = runtime.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    runtime.markReady(handle);
    runtime.retire(handle);
    expect(await runtime.invoke(req('echo', 'x', { purpose: 'request' }))).toBe('x');
    expect((await rejection(runtime.invoke(req('echo', 'x', { purpose: 'management' })))).code).toBe('retired');
    runtime.revoke(handle);
    expect((await rejection(runtime.invoke(req('echo', 'x', { purpose: 'request' })))).code).toBe('revoked');
    await idle();
    expect(releases).toBe(3);

    const lifetime = new AbortController();
    let other: RpcEndpointHandle | null = null;
    const closedRuntime = new RpcServiceRuntime<unknown>({
      admit: () => (other
        ? { endpoint: other, callee: null, release: () => undefined, allowRetired: true }
        : null),
      hostLifetime: lifetime.signal,
    });
    other = closedRuntime.register({
      provider: 'provider',
      binding,
      contract: { id: service.id, version: service.version, methods: service.methods },
      handler: baseHandlers,
    });
    closedRuntime.markReady(other);
    closedRuntime.retire(other);
    lifetime.abort();
    expect((await rejection(closedRuntime.invoke(req('echo', 'x', { purpose: 'request' })))).code).toBe('closed');
  });

  test('drainOwner joins same-caller and callee work without double counting and waits for real tasks', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime({ slow: () => pending.promise.then(() => null) });
    const call = runtime.invoke(req('slow', null, { caller: { subject: 'loner' } }));
    // The caller has no publications: the caller-subject arm alone must join its real task.
    expect(await runtime.drainOwner('loner', [], { timeoutMs: 5 })).toEqual({ drained: false, active: 1 });
    // The handle arm finds the very same task once, not twice.
    expect(await runtime.drainOwner('loner', [handle], { timeoutMs: 5 })).toEqual({ drained: false, active: 1 });
    expect(await runtime.drainOwner('someone-else', [handle], { timeoutMs: 5 })).toEqual({ drained: false, active: 1 });
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(await runtime.drainOwner('loner', [handle], { timeoutMs: 100 })).toEqual({ drained: true, active: 0 });
  });

  test('drainOwner reports overloaded at waiter capacity instead of a fake drained verdict', async () => {
    const pending = gate();
    const { runtime, handle } = makeRuntime(
      { slow: () => pending.promise.then(() => null) },
      { limits: { maxWaiters: 1 } },
    );
    const call = runtime.invoke(req('slow', null));
    const first = runtime.drainOwner('caller', [handle], { timeoutMs: 5 });
    expect((await rejection(runtime.drainOwner('caller', [handle], { timeoutMs: 5 }))).code).toBe('overloaded');
    expect(runtime.status().active).toBe(1);
    expect(await first).toEqual({ drained: false, active: 1 });
    pending.open();
    expect(await call).toBeNull();
    await idle();
    expect(runtime.status().waiters).toBe(0);
  });
});
