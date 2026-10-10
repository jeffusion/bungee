import { describe, expect, test } from 'bun:test';
import { deriveSupervisionProcessKey } from '../../../src/supervision';
import {
  HostRpcAdapter,
  type HostRpcOwnerHandle,
  type HostRpcRemoteCallerHandle,
} from '../../../src/plugin-services/host-rpc';
import type { CommandJournal } from '../../../src/plugin-services/command-journal';
import {
  PEER_BODY_MAX_BYTES,
  createPluginPeerCredential,
  type PluginPeerAuthority,
  type PluginPeerCredential,
} from '../../../src/plugin-services/peer-protocol';
import { decodePluginPeerFrame } from '../../../src/plugin-services/peer-frame';
import {
  PluginPeerRpcLink,
  PluginPeerRpcLinkError,
  type PluginPeerRpcInboundCall,
  type PluginPeerRpcLinkErrorCode,
  type PluginPeerRpcRequestExecution,
  type PluginPeerRpcRequestHandler,
  type PluginPeerRpcSendAdapter,
} from '../../../src/plugin-services/peer-rpc-link';
import {
  RpcInvocationError,
  RpcServiceRuntime,
  type RpcEndpointBinding,
  type RpcEndpointHandle,
  type RpcInvocationErrorCode,
  type RpcInvokeRequest,
  type RpcProxyExecution,
} from '../../../src/plugin-services/rpc-runtime';
import {
  PEER_RPC_ERROR_CODES,
  PEER_RPC_ERROR_PREFIX,
  PEER_RPC_METADATA_MAX_BYTES,
  PluginPeerRpcMappingError,
  createPluginPeerRpcProxy,
  createPluginPeerRpcRequestHandler,
  decodePeerRpcCallMetadata,
  decodePeerRpcInputBody,
  decodePeerRpcResultBody,
  encodePeerRpcCallMetadata,
  encodePeerRpcErrorBody,
  encodePeerRpcJsonBody,
  resolvePeerRpcErrorCode,
  type PeerRpcCallMetadata,
  type PluginPeerRpcHostMetadataCompiler,
  type PluginPeerRpcNativeDispatch,
} from '../../../src/plugin-services/peer-rpc-mapping';
import { RPC_JSON_MAX_BYTES, type RpcJson } from '../../../src/plugin-services/wire-contract';

/* -------------------------------------------------------------------------- */
/* Fixtures: real supervision-derived credential, real signed links            */
/* -------------------------------------------------------------------------- */

const ROOT_KEY = new Uint8Array(32).fill(31);
const INSTANCE = '10000000-0000-4000-8000-0000000000c1';
const WORKER_ID = '20000000-0000-4000-8000-0000000000c1';
const BOOT = '30000000-0000-4000-8000-0000000000c1';
const CONTROLLER = '40000000-0000-4000-8000-0000000000c1';

const credential: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT),
);
const AUTHORITY: PluginPeerAuthority = Object.freeze({ controller_epoch: 3, controller_id: CONTROLLER });

const CONTRACT = {
  id: 'link.mapped',
  version: 2,
  methods: {
    echo: {
      kind: 'query', input: { type: 'json' }, output: { type: 'json' },
      purposes: ['bootstrap', 'background', 'management', 'request', 'attempt'],
    },
    boom: { kind: 'query', input: { type: 'null' }, output: { type: 'null' }, purposes: ['background'] },
    add: {
      kind: 'command',
      input: { type: 'object', properties: { amount: { type: 'number', integer: true } } },
      output: { type: 'object', properties: { count: { type: 'number', integer: true } } },
      purposes: ['background', 'management'],
      command: { deduplication: 'local-transaction', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 4096 },
    },
  },
} as const;

const LIFECYCLE = Object.freeze({
  endpoint: 'endpoint.control.provider', instance: 'instance.control.provider',
  generation: 3, catalog: 'catalog.1', subject: 'provider',
});
const BINDING: RpcEndpointBinding = Object.freeze({
  endpoint: LIFECYCLE.endpoint, process: 'control', instance: LIFECYCLE.instance,
  generation: LIFECYCLE.generation, catalog: LIFECYCLE.catalog, scope: 'global', subject: LIFECYCLE.subject,
});

const ECHO_TARGET = { provider: 'provider', service: CONTRACT.id, major: CONTRACT.version, method: 'echo' } as const;
const ADD_TARGET = { provider: 'provider', service: CONTRACT.id, major: CONTRACT.version, method: 'add' } as const;
const BOOM_TARGET = { provider: 'provider', service: CONTRACT.id, major: CONTRACT.version, method: 'boom' } as const;
const PURPOSES = ['bootstrap', 'background', 'management', 'request', 'attempt'] as const;

function gateVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function tick(): Promise<void> {
  await delay(0);
}

async function rejection(promise: Promise<unknown>): Promise<RpcInvocationError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(RpcInvocationError);
    return error as RpcInvocationError;
  }
  throw new Error('expected rejection');
}

function expectLinkCode(action: () => unknown): string | null {
  try { action(); } catch (error) { return error instanceof PluginPeerRpcLinkError ? error.code : null; }
  return null;
}

function cleanup(...links: Array<PluginPeerRpcLink | undefined>): void {
  for (const link of links) {
    if (link === undefined) continue;
    try { link.confirmRemoteStopped(); } catch { /* host-only release is best-effort */ }
    try { link.dispose(); } catch { /* idempotent */ }
  }
}

/* --------------------------- in-memory signed wire ------------------------ */

interface WireState {
  leftToRight: Uint8Array[];
  rightToLeft: Uint8Array[];
  sentLeft: Uint8Array[];
  sentRight: Uint8Array[];
  acceptLeft: boolean;
  acceptRight: boolean;
}

interface Wire {
  readonly state: WireState;
  readonly sendLeft: PluginPeerRpcSendAdapter;
  readonly sendRight: PluginPeerRpcSendAdapter;
}

function makeWire(): Wire {
  const state: WireState = { leftToRight: [], rightToLeft: [], sentLeft: [], sentRight: [], acceptLeft: true, acceptRight: true };
  return {
    state,
    sendLeft: (frame) => {
      if (!state.acceptLeft) return false;
      const copy = Uint8Array.from(frame);
      state.sentLeft.push(copy);
      state.leftToRight.push(copy);
      return true;
    },
    sendRight: (frame) => {
      if (!state.acceptRight) return false;
      const copy = Uint8Array.from(frame);
      state.sentRight.push(copy);
      state.rightToLeft.push(copy);
      return true;
    },
  };
}

function deliver(target: PluginPeerRpcLink, frames: Uint8Array[]): void {
  for (const frame of frames.splice(0)) target.receive(frame);
}

/** Deterministic in-memory transport: real signed BPC1 frames, no protocol mocking. */
async function pump(state: WireState, left: PluginPeerRpcLink, right: PluginPeerRpcLink): Promise<void> {
  await Promise.resolve();
  for (let round = 0; round < 8; round += 1) {
    deliver(right, state.leftToRight);
    deliver(left, state.rightToLeft);
    await Promise.resolve();
  }
  await delay(0);
  for (let round = 0; round < 8; round += 1) {
    deliver(right, state.leftToRight);
    deliver(left, state.rightToLeft);
    await Promise.resolve();
  }
}

async function settle(state: WireState, left: PluginPeerRpcLink, right: PluginPeerRpcLink): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await pump(state, left, right);
    await delay(0);
  }
}

function callFrames(frames: Uint8Array[]): Uint8Array[] {
  return frames.filter((frame) => {
    const context = decodePluginPeerFrame(frame).header.context;
    return context !== null && typeof context === 'object' && !Array.isArray(context)
      && (context as unknown as { readonly op?: unknown }).op === 'call';
  });
}

function bindingMatches(binding: RpcEndpointBinding): boolean {
  return binding.endpoint === BINDING.endpoint && binding.process === BINDING.process
    && binding.instance === BINDING.instance && binding.generation === BINDING.generation
    && binding.catalog === BINDING.catalog && binding.scope === BINDING.scope
    && binding.subject === BINDING.subject;
}

/* ------------------------------- codec helpers ---------------------------- */

function metadataInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    target: { ...ECHO_TARGET },
    binding: { ...BINDING },
    caller: { subject: 'consumer', scope: 'global' },
    purpose: 'background',
    operationId: null,
    commandAction: null,
    host: { peer: 'worker-a' },
    ...overrides,
  };
}

function commandMetadataInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return metadataInput({ target: { ...ADD_TARGET }, operationId: 'cmd-1', commandAction: 'execute', purpose: 'management', ...overrides });
}

function inboundCall(
  overrides: Partial<{ lane: 'rpc'; metadata: RpcJson; context: RpcJson; body: Uint8Array; deadlineAt: number; sequence: number; requestId: string }> = {},
): PluginPeerRpcInboundCall {
  const caller = encodePeerRpcCallMetadata(metadataInput());
  return Object.freeze({
    requestId: 'req-1',
    lane: 'rpc' as const,
    metadata: caller,
    context: { op: 'call', caller } as RpcJson,
    body: encodePeerRpcJsonBody({ hello: 'world' }),
    deadlineAt: Date.now() + 60_000,
    sequence: 1,
    ...overrides,
  });
}

/** A synthetic link used only for exact protocol-error mapping; it is never a runtime. */
function syntheticLink(
  request: (context: RpcJson, body: Uint8Array, options: { readonly signal?: AbortSignal; readonly deadlineAt: number }) => RpcProxyExecution,
): PluginPeerRpcLink {
  return {
    request: (context: RpcJson, body: Uint8Array, options: { readonly signal?: AbortSignal; readonly deadlineAt: number }) => request(context, body, options),
  } as unknown as PluginPeerRpcLink;
}

interface ProxyRig {
  readonly runtime: RpcServiceRuntime;
  readonly invoke: (overrides?: Partial<RpcInvokeRequest>) => RpcProxyExecution;
  readonly calls: () => number;
  readonly releases: () => number;
  readonly stop: () => void;
}

function proxyRig(
  request: (context: RpcJson, body: Uint8Array, options: { readonly signal?: AbortSignal; readonly deadlineAt: number }) => RpcProxyExecution,
  options: {
    readonly compileHost?: PluginPeerRpcHostMetadataCompiler;
    readonly callee?: unknown;
    readonly calleeFor?: (index: number) => unknown;
    readonly binding?: RpcEndpointBinding;
  } = {},
): ProxyRig {
  let calls = 0;
  let releases = 0;
  let calleeIndex = 0;
  let endpoint!: RpcEndpointHandle;
  const link = syntheticLink((context, body, settings) => { calls += 1; return request(context, body, settings); });
  const runtime = new RpcServiceRuntime({
    limits: { drainTimeoutMs: 1 },
    admit: () => {
      const callee = options.calleeFor === undefined ? (options.callee ?? null) : options.calleeFor(calleeIndex);
      calleeIndex += 1;
      return { endpoint, callee, release: () => { releases += 1; } };
    },
  });
  endpoint = runtime.registerProxy({
    provider: 'provider',
    binding: options.binding ?? BINDING,
    contract: CONTRACT,
    execute: createPluginPeerRpcProxy('provider', link, options.compileHost ?? (() => ({}))),
  });
  runtime.markReady(endpoint);
  return {
    runtime,
    calls: () => calls,
    releases: () => releases,
    stop: () => { runtime.confirmProxyEndpointStopped(endpoint); },
    invoke: (overrides: Partial<RpcInvokeRequest> = {}) => runtime.invokeTracked({
      target: { ...ECHO_TARGET },
      caller: { subject: 'consumer', scope: 'global' },
      purpose: 'background',
      input: 'hello',
      ...overrides,
    }),
  };
}

/* ------------------------------- real pair -------------------------------- */

interface Records {
  callerReleases: number;
  remoteAcquire: number;
  remoteRelease: number;
  providerAcquire: number;
  providerRelease: number;
  invokes: number;
  journal: Array<{ action: string; operationId: string | null }>;
  metadata: PeerRpcCallMetadata[];
  native: Array<Omit<RpcInvokeRequest, 'caller' | 'callerToken'>>;
  contexts: Array<{ method: string; purpose: string; operationId: string | null }>;
  endpoints: Array<{ endpoint: string; process: string; instance: string; generation: number; catalog: string; scope: string; subject: string }>;
  inbound: PluginPeerRpcInboundCall[];
}

interface HarnessOptions {
  readonly echo?: (input: RpcJson) => RpcJson | Promise<RpcJson>;
  readonly terminalGate?: Promise<void>;
  readonly noJournal?: boolean;
  readonly authorize?: () => boolean;
  readonly onRequest?: PluginPeerRpcRequestHandler;
  readonly dispatch?: (
    metadata: PeerRpcCallMetadata,
    request: Omit<RpcInvokeRequest, 'caller' | 'callerToken'>,
    call: PluginPeerRpcInboundCall,
  ) => RpcProxyExecution | null;
  readonly compileHost?: PluginPeerRpcHostMetadataCompiler;
  readonly proxyBinding?: RpcEndpointBinding;
  readonly sendLeft?: PluginPeerRpcSendAdapter;
}

interface Harness {
  readonly wire: Wire;
  readonly sender: PluginPeerRpcLink;
  readonly receiver: PluginPeerRpcLink;
  readonly adapter: HostRpcAdapter;
  readonly provider: HostRpcOwnerHandle;
  readonly remoteCaller: HostRpcRemoteCallerHandle;
  readonly callerRuntime: RpcServiceRuntime;
  readonly invoke: (overrides?: Partial<RpcInvokeRequest>) => RpcProxyExecution;
  readonly records: Records;
  readonly dispose: () => Promise<void>;
}

function fakeJournal(records: Records): CommandJournal {
  return {
    execute: (execution: { readonly operationId: string; readonly executeBusiness: () => Promise<RpcJson> }) => {
      records.journal.push({ action: 'execute', operationId: execution.operationId });
      return execution.executeBusiness();
    },
    query: (operationId: string) => {
      records.journal.push({ action: 'query-result', operationId });
      return { count: 7 };
    },
    reconcile: (execution: { readonly operationId: string }) => {
      records.journal.push({ action: 'reconcile', operationId: execution.operationId });
      return { count: 8 };
    },
  } as unknown as CommandJournal;
}

function harness(options: HarnessOptions = {}): Harness {
  const records: Records = {
    callerReleases: 0, remoteAcquire: 0, remoteRelease: 0, providerAcquire: 0, providerRelease: 0, invokes: 0,
    journal: [], metadata: [], native: [], contexts: [], endpoints: [], inbound: [],
  };
  const adapter = new HostRpcAdapter({
    process: 'control',
    limits: { drainTimeoutMs: 1 },
    resolvePlacement: () => null,
    resolveCallee: () => null,
    resolveJournal: () => (options.noJournal === true ? null : fakeJournal(records)),
  });
  const providerState = { ready: true, retiring: false, revoked: false };
  const provider = adapter.createOwner({
    token: {},
    plugin: 'provider',
    scope: 'global',
    declarations: { provides: [{ id: CONTRACT.id, version: CONTRACT.version, process: 'control', kind: 'rpc' }] },
    dependencies: {},

    lifecycle: { ...LIFECYCLE },
    getLifecycleState: () => ({ ...providerState }),
    acquireLease: () => {
      records.providerAcquire += 1;
      let released = false;
      return { release: () => { if (!released) { released = true; records.providerRelease += 1; } } };
    },
    resolveInvocationContext: () => null,
  });
  provider.publish(CONTRACT, {
    echo: (input: RpcJson, context: { readonly method: string; readonly purpose: string; readonly operationId: string | null }) => {
      records.contexts.push({ method: context.method, purpose: context.purpose, operationId: context.operationId ?? null });
      return options.echo === undefined ? input : options.echo(input);
    },
    boom: () => { throw new Error('provider boom'); },
    add: (input: unknown, context: { readonly method: string; readonly purpose: string; readonly operationId: string | null }) => {
      records.contexts.push({ method: context.method, purpose: context.purpose, operationId: context.operationId ?? null });
      return { count: (input as { readonly amount: number }).amount };
    },
  } as never);
  provider.markReady();

  const remoteCaller = adapter.createRemoteCaller({
    token: {},
    plugin: 'consumer',
    scope: 'global',
    declarations: { consumes: [{ plugin: 'provider', id: CONTRACT.id, version: CONTRACT.version, process: 'worker', kind: 'rpc' }] },
    dependencies: { provider: '*' },

    lifecycle: { endpoint: 'endpoint.worker-peer', instance: 'instance.worker-peer', generation: 1, catalog: 'catalog.1', subject: 'consumer' },
    getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }),
    acquireLease: () => {
      records.remoteAcquire += 1;
      let released = false;
      return { release: () => { if (!released) { released = true; records.remoteRelease += 1; } } };
    },
    resolveInvocationContext: () => null,
    process: 'worker',
    authorizeIncoming: (_request, endpoint) => {
      records.endpoints.push({
        endpoint: endpoint.binding.endpoint, process: endpoint.binding.process, instance: endpoint.binding.instance,
        generation: endpoint.binding.generation, catalog: endpoint.binding.catalog,
        scope: endpoint.binding.scope, subject: endpoint.binding.subject,
      });
      return options.authorize === undefined ? true : options.authorize();
    },
  });

  const terminalGate = options.terminalGate;
  const dispatch: PluginPeerRpcNativeDispatch = options.dispatch ?? ((metadata, request, _call) => {
    if (!bindingMatches(metadata.binding)) return null;
    records.invokes += 1;
    const tracked = remoteCaller.invokeTracked(request);
    return {
      result: tracked.result,
      terminal: terminalGate === undefined ? tracked.terminal : tracked.terminal.then(() => terminalGate),
    };
  });
  const receiver = new PluginPeerRpcLink({
    credential,
    authority: AUTHORITY,
    outgoingDirection: 'control-to-peer',
    onRequest: options.onRequest ?? createPluginPeerRpcRequestHandler((metadata, request, call) => {
      records.metadata.push(metadata);
      records.native.push(request);
      records.inbound.push(call);
      return dispatch(metadata, request, call);
    }),
  });
  const sender = new PluginPeerRpcLink({
    credential,
    authority: AUTHORITY,
    outgoingDirection: 'peer-to-control',
    onRequest: () => ({ result: Promise.resolve(new Uint8Array()), terminal: Promise.resolve() }),
  });

  const wire = makeWire();
  sender.attach(options.sendLeft ?? wire.sendLeft);
  receiver.attach(wire.sendRight);

  let callerEndpoint!: RpcEndpointHandle;
  const callerRuntime = new RpcServiceRuntime({
    limits: { drainTimeoutMs: 1 },
    admit: () => ({ endpoint: callerEndpoint, callee: null, release: () => { records.callerReleases += 1; } }),
  });
  callerEndpoint = callerRuntime.registerProxy({
    provider: 'provider',
    binding: options.proxyBinding ?? BINDING,
    contract: CONTRACT,
    execute: createPluginPeerRpcProxy('provider', sender, options.compileHost ?? (() => ({ peer: 'worker-a' }))),
  });
  callerRuntime.markReady(callerEndpoint);

  const invoke = (overrides: Partial<RpcInvokeRequest> = {}): RpcProxyExecution => callerRuntime.invokeTracked({
    target: { ...ECHO_TARGET },
    caller: { subject: 'consumer', scope: 'global' },
    purpose: 'background',
    input: null,
    ...overrides,
  });

  const dispose = async (): Promise<void> => {
    cleanup(sender, receiver);
    try { await callerRuntime.dispose(); } catch { /* best-effort */ }
    try { await remoteCaller.dispose(); } catch { /* best-effort */ }
    try { await provider.dispose(); } catch { /* best-effort */ }
    try { await adapter.dispose(); } catch { /* best-effort */ }
  };

  return { wire, sender, receiver, adapter, provider, remoteCaller, callerRuntime, invoke, records, dispose };
}

/* -------------------------------------------------------------------------- */
/* Metadata codec                                                             */
/* -------------------------------------------------------------------------- */

describe('P4 native/plugin-peer RPC DTO mapping', () => {
  describe('call metadata codec', () => {
    test('round-trips and deep-freezes the complete version-1 metadata', () => {
      const input = commandMetadataInput({ host: { peer: 'worker-a', nested: [1, true, null, { label: 'x' }] } });
      const wire = encodePeerRpcCallMetadata(input);
      const decoded = decodePeerRpcCallMetadata(wire);
      expect(decoded.version).toBe(1);
      expect(decoded.target).toEqual({ ...ADD_TARGET });
      expect(decoded.binding).toEqual({ ...BINDING });
      expect(decoded.caller).toEqual({ subject: 'consumer', scope: 'global' });
      expect(decoded.purpose).toBe('management');
      expect(decoded.operationId).toBe('cmd-1');
      expect(decoded.commandAction).toBe('execute');
      expect(decoded.host).toEqual({ peer: 'worker-a', nested: [1, true, null, { label: 'x' }] });
      expect(Object.keys(decoded).sort()).toEqual(['binding', 'caller', 'commandAction', 'host', 'operationId', 'purpose', 'target', 'version']);
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(Object.isFrozen(decoded.target)).toBe(true);
      expect(Object.isFrozen(decoded.binding)).toBe(true);
      expect(Object.isFrozen(decoded.caller)).toBe(true);
      expect(Object.isFrozen(decoded.host)).toBe(true);
    });

    test('rejects extra fields, version drift, enum drift and the operation-id invariant', () => {
      const invalid: unknown[] = [
        { ...metadataInput(), extra: true },
        { ...metadataInput(), version: 2 },
        { ...metadataInput(), purpose: 'urgent' },
        { ...metadataInput(), caller: { subject: 'consumer' } },
        { ...metadataInput(), caller: { subject: 'consumer', scope: 'tenant' } },
        { ...metadataInput(), binding: { ...BINDING, process: 'bogus' } },
        { ...metadataInput(), binding: { ...BINDING, generation: 0 } },
        { ...metadataInput(), binding: { ...BINDING, scope: 'tenant' } },
        { ...commandMetadataInput({ operationId: null }) },
        { ...metadataInput({ operationId: 'cmd-1' }) },
        { ...metadataInput({ operationId: '!bad id', commandAction: 'execute' }) },
        { ...metadataInput(), target: { ...ECHO_TARGET, major: 0 } },
        { ...metadataInput(), target: { ...ECHO_TARGET, extra: 1 } },
        { ...metadataInput(), host: undefined },
      ];
      for (const bad of invalid) {
        expect(() => decodePeerRpcCallMetadata(bad)).toThrow(PluginPeerRpcMappingError);
      }
      expect(() => decodePeerRpcCallMetadata((() => undefined) as never)).toThrow(PluginPeerRpcMappingError);
      const accessor: Record<string, unknown> = metadataInput();
      Object.defineProperty(accessor, 'host', { get: () => ({ leak: true }), enumerable: true });
      expect(() => decodePeerRpcCallMetadata(accessor)).toThrow(PluginPeerRpcMappingError);
    });

    test('bounds the complete metadata and the trusted host DTO', () => {
      expect(PEER_RPC_METADATA_MAX_BYTES).toBeLessThan(RPC_JSON_MAX_BYTES);
      expect(() => decodePeerRpcCallMetadata(metadataInput({ host: { padding: 'h'.repeat(PEER_RPC_METADATA_MAX_BYTES) } })))
        .toThrow(PluginPeerRpcMappingError);
      // A host DTO that overflows only its own minimal bound is still refused.
      expect(() => encodePeerRpcCallMetadata(metadataInput({ host: { padding: 'h'.repeat(2500) } })))
        .toThrow(PluginPeerRpcMappingError);
      expect(() => encodePeerRpcCallMetadata(metadataInput({ host: { padding: 'h'.repeat(4096) } })))
        .toThrow(PluginPeerRpcMappingError);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Result codec                                                             */
  /* ------------------------------------------------------------------------ */

  describe('result codec', () => {
    test('keeps success JSON and the reserved error prefix unambiguous', () => {
      expect(decodePeerRpcResultBody(encodePeerRpcErrorBody('unauthorized'))).toEqual({ ok: false, code: 'unauthorized' });
      expect(decodePeerRpcResultBody(encodePeerRpcJsonBody({ a: 1 }))).toEqual({ ok: true, value: { a: 1 } });
      const trap = `${PEER_RPC_ERROR_PREFIX}failed`;
      expect(decodePeerRpcResultBody(encodePeerRpcJsonBody(trap))).toEqual({ ok: true, value: trap });
      expect(decodePeerRpcResultBody(encodePeerRpcJsonBody({ error: '!RPC1:unauthorized', ok: true })))
        .toEqual({ ok: true, value: { error: '!RPC1:unauthorized', ok: true } });
      expect(decodePeerRpcInputBody(encodePeerRpcJsonBody(trap))).toBe(trap);
    });

    test('rejects malformed, unknown-code, oversized and non-UTF-8 results', () => {
      const invalid: Uint8Array[] = [
        new Uint8Array(0),
        new TextEncoder().encode('{oops'),
        new TextEncoder().encode(`${PEER_RPC_ERROR_PREFIX}not_a_code`),
        new TextEncoder().encode(PEER_RPC_ERROR_PREFIX),
        new TextEncoder().encode('!nope'),
        new TextEncoder().encode(`${PEER_RPC_ERROR_PREFIX}failed extra`),
        new Uint8Array([0xc3, 0x28]),
        new Uint8Array(PEER_BODY_MAX_BYTES + 1),
      ];
      for (const bytes of invalid) {
        expect(() => decodePeerRpcResultBody(bytes)).toThrow(PluginPeerRpcMappingError);
      }
      expect(() => decodePeerRpcInputBody(new TextEncoder().encode('{oops'))).toThrow(PluginPeerRpcMappingError);
      expect(() => decodePeerRpcInputBody(new Uint8Array(PEER_BODY_MAX_BYTES + 1))).toThrow(PluginPeerRpcMappingError);
      expect(() => encodePeerRpcJsonBody('a'.repeat(RPC_JSON_MAX_BYTES))).toThrow(PluginPeerRpcMappingError);
      expect(() => encodePeerRpcJsonBody(() => undefined)).toThrow(PluginPeerRpcMappingError);
    });

    test('every declared error code is a real fixed runtime code and nothing else resolves', () => {
      const codes = [
        'unauthorized', 'not_ready', 'retired', 'revoked', 'unsupported_method', 'wrong_purpose',
        'invalid_input', 'invalid_output', 'invalid_operation_id', 'overloaded', 'cancelled', 'timeout',
        'unknown', 'capability_unavailable', 'closed', 'failed', 'conflict', 'expired', 'pending',
        'rejected', 'missing', 'storage_failure', 'deadlock', 'call_depth_exceeded',
      ] as const;
      expect([...PEER_RPC_ERROR_CODES].sort()).toEqual([...codes].sort());
      for (const code of codes) {
        // A real runtime code has a fixed message; an invented one does not.
        expect(new RpcInvocationError(code).message.length).toBeGreaterThan(0);
        expect(decodePeerRpcResultBody(encodePeerRpcErrorBody(code))).toEqual({ ok: false, code });
      }
      expect(new RpcInvocationError('definitely_not_a_code' as never).message).toBe('');
    });

    test('resolves native codes without invoking hostile accessors or leaking a cause', () => {
      expect(resolvePeerRpcErrorCode(new RpcInvocationError('not_ready'))).toBe('not_ready');
      expect(resolvePeerRpcErrorCode({ code: 'unauthorized' })).toBe('unauthorized');
      expect(resolvePeerRpcErrorCode({ code: 'leaky-secret' })).toBe('failed');
      expect(resolvePeerRpcErrorCode(null)).toBe('failed');
      expect(resolvePeerRpcErrorCode('code')).toBe('failed');
      const hostile = {};
      Object.defineProperty(hostile, 'code', { get: () => { throw new Error('SECRET-getter'); } });
      expect(resolvePeerRpcErrorCode(hostile)).toBe('failed');
      const trapped = new Proxy({}, { get: () => { throw new Error('SECRET-trap'); } });
      expect(resolvePeerRpcErrorCode(trapped)).toBe('failed');
      const restored = new RpcInvocationError(resolvePeerRpcErrorCode({ code: 'not_a_code', cause: 'SECRET' }));
      expect(restored.message).not.toContain('SECRET');
      expect(Object.hasOwn(restored, 'cause')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Request handler                                                          */
  /* ------------------------------------------------------------------------ */

  describe('request handler', () => {
    test('a provably not-dispatched parse failure is a fixed invalid_input rejection with a resolved terminal', async () => {
      let calls = 0;
      const handler = createPluginPeerRpcRequestHandler(() => {
        calls += 1;
        return { result: Promise.resolve(null), terminal: Promise.resolve() };
      });
      const signal = new AbortController().signal;
      const cases: Array<() => PluginPeerRpcRequestExecution> = [
        () => handler(inboundCall({ metadata: { ...metadataInput(), version: 2 } as RpcJson }), signal),
        () => handler(inboundCall({ metadata: { ...metadataInput(), extra: 1 } as RpcJson }), signal),
        () => handler(inboundCall({ metadata: { ...metadataInput(), caller: { subject: 'x' } } as RpcJson }), signal),
        () => handler(inboundCall({ body: new TextEncoder().encode('{oops') }), signal),
        () => handler(inboundCall({ body: new Uint8Array(PEER_BODY_MAX_BYTES + 1) }), signal),
        () => handler(inboundCall({ body: new Uint8Array(0) }), signal),
      ];
      for (const run of cases) {
        const execution = run();
        expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}invalid_input`);
        await execution.terminal;
      }
      expect(calls).toBe(0);
    });

    test('maps a native rejection to a fixed-code body and keeps the original terminal promise', async () => {
      const terminalGate = gateVoid();
      const handler = createPluginPeerRpcRequestHandler(() => ({
        result: Promise.reject(new RpcInvocationError('not_ready')),
        terminal: terminalGate.promise,
      }));
      const execution = handler(inboundCall(), new AbortController().signal);
      expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}not_ready`);
      expect(execution.terminal).toBe(terminalGate.promise);
      let settled = false;
      void execution.terminal.then(() => { settled = true; });
      await tick();
      expect(settled).toBe(false);
      terminalGate.resolve();
      await execution.terminal;
    });

    test('a null dispatch result is an explicit unauthorized rejection with a resolved terminal', async () => {
      const handler = createPluginPeerRpcRequestHandler(() => null);
      const execution = handler(inboundCall(), new AbortController().signal);
      expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}unauthorized`);
      await execution.terminal;
    });

    test('only an explicit null is a no-dispatch rejection; illegal returns never forge a terminal', async () => {
      const shapes: Array<() => unknown> = [
        () => undefined,
        () => ({}),
        () => (() => undefined),
        () => [],
        // An erroneous `async` callback: its settlement must never be the terminal.
        () => Promise.resolve({ result: Promise.resolve(null), terminal: Promise.resolve() }),
      ];
      for (const shape of shapes) {
        let invokes = 0;
        const handler = createPluginPeerRpcRequestHandler((() => {
          invokes += 1;
          return shape();
        }) as unknown as PluginPeerRpcNativeDispatch);
        const execution = handler(inboundCall(), new AbortController().signal);
        expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}failed`);
        let settled = false;
        void execution.terminal.then(() => { settled = true; });
        await tick();
        await tick();
        expect(settled).toBe(false);
        expect(invokes).toBe(1);
      }
    });

    test('a hostile result Promise constructor or synchronous then never loses an obtained valid terminal', async () => {
      const variants: Array<() => unknown> = [
        () => {
          const real = Promise.resolve(new Uint8Array([1]));
          Object.defineProperty(real, 'constructor', { get: () => { throw new Error('SECRET-constructor'); } });
          return real;
        },
        () => {
          const thenable: Record<string, unknown> = {};
          Object.defineProperty(thenable, 'then', { value: () => { throw new Error('SECRET-then'); } });
          return thenable;
        },
      ];
      for (const variant of variants) {
        const terminalGate = gateVoid();
        let dispatched = 0;
        const handler = createPluginPeerRpcRequestHandler((() => {
          dispatched += 1;
          return { result: variant(), terminal: terminalGate.promise };
        }) as unknown as PluginPeerRpcNativeDispatch);
        const execution = handler(inboundCall(), new AbortController().signal);
        expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}failed`);
        expect(execution.terminal).toBe(terminalGate.promise);
        let settled = false;
        void execution.terminal.then(() => { settled = true; });
        await tick();
        expect(settled).toBe(false);
        terminalGate.resolve();
        await execution.terminal;
        expect(dispatched).toBe(1);
      }
    });

    test('a throwing dispatch propagates so the link fails closed and no terminal is forged', () => {
      const handler = createPluginPeerRpcRequestHandler(() => { throw new Error('SECRET dispatch'); });
      expect(expectLinkCode(() => handler(inboundCall(), new AbortController().signal))).toBe('invalid_call');
    });

    test('unobservable command results are unknown while query-result stays a failed read', async () => {
      for (const action of ['execute', 'reconcile', 'query-result'] as const) {
        for (const fault of ['missing', 'getter', 'constructor', 'then', 'untyped-rejection', 'native-failed'] as const) {
          const terminalGate = gateVoid();
          const handler = createPluginPeerRpcRequestHandler((() => {
            if (fault === 'missing') return undefined;
            if (fault === 'getter') return {
              get result() { throw new Error('SECRET command result'); }, terminal: terminalGate.promise,
            };
            let result: unknown;
            if (fault === 'constructor') {
              result = Promise.resolve(null);
              Object.defineProperty(result, 'constructor', { get() { throw new Error('SECRET constructor'); } });
            } else if (fault === 'then') {
              result = { then() { throw new Error('SECRET then'); } };
            } else if (fault === 'native-failed') {
              result = Promise.reject(new RpcInvocationError('failed'));
            } else {
              result = Promise.reject(new Error('SECRET untyped result'));
            }
            return { result, terminal: terminalGate.promise };
          }) as PluginPeerRpcNativeDispatch);
          try {
            const execution = handler(inboundCall({ metadata: encodePeerRpcCallMetadata(
              commandMetadataInput({ commandAction: action }),
            ) }), new AbortController().signal);
            expect(decodePeerRpcResultBody(await execution.result)).toEqual({
              ok: false, code: action === 'query-result' || fault === 'native-failed' ? 'failed' : 'unknown',
            });
            let settled = false;
            void execution.terminal.then(() => { settled = true; });
            await tick();
            expect(settled).toBe(false);
            terminalGate.resolve();
            if (fault !== 'missing') await execution.terminal;
          } finally { terminalGate.resolve(); }
        }
      }
    });

    test('a hostile result/terminal getter neither leaks nor forges completion', async () => {
      const handler = createPluginPeerRpcRequestHandler(() => ({
        get result(): Promise<Uint8Array> { throw new Error('SECRET-result'); },
        get terminal(): Promise<void> { throw new Error('SECRET-terminal'); },
      }));
      const execution = handler(inboundCall(), new AbortController().signal);
      expect(new TextDecoder().decode(await execution.result)).toBe(`${PEER_RPC_ERROR_PREFIX}failed`);
      let settled = false;
      void execution.terminal.then(() => { settled = true; });
      await tick();
      expect(settled).toBe(false);
    });

    test('builds a native request from the decoded DTO with the real absolute deadline and signal', () => {
      const seen: Array<{ request: unknown; call: PluginPeerRpcInboundCall }> = [];
      const gateSignal = new AbortController();
      const handler = createPluginPeerRpcRequestHandler((_metadata, request, call) => {
        seen.push({ request, call });
        return { result: Promise.resolve(null), terminal: Promise.resolve() };
      });
      const call = inboundCall({ metadata: encodePeerRpcCallMetadata(commandMetadataInput()), body: encodePeerRpcJsonBody({ amount: 5 }) });
      handler(call, gateSignal.signal);
      expect(seen).toHaveLength(1);
      const request = seen[0].request as Record<string, unknown>;
      expect(request.target).toEqual({ ...ADD_TARGET });
      expect(request.purpose).toBe('management');
      expect(request.input).toEqual({ amount: 5 });
      expect(request.operationId).toBe('cmd-1');
      expect(request.commandAction).toBe('execute');
      expect(request.signal).toBe(gateSignal.signal);
      expect(request.deadlineAt).toBe(call.deadlineAt);
      expect(seen[0].call).toBe(call);
      expect(Object.hasOwn(request, 'caller')).toBe(false);
      expect(Object.hasOwn(request, 'callerToken')).toBe(false);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Proxy executor                                                           */
  /* ------------------------------------------------------------------------ */

  describe('proxy executor', () => {
    test('maps every link failure to a fixed query code and a conservative command code, with no retry', async () => {
      const scenarios: ReadonlyArray<{
        readonly code: PluginPeerRpcLinkErrorCode;
        readonly query: RpcInvocationErrorCode;
        readonly command: RpcInvocationErrorCode;
      }> = [
        { code: 'unknown', query: 'failed', command: 'unknown' },
        { code: 'failed', query: 'failed', command: 'unknown' },
        { code: 'disconnected', query: 'failed', command: 'unknown' },
        { code: 'invalid_call', query: 'failed', command: 'unknown' },
        { code: 'invalid_context', query: 'failed', command: 'unknown' },
        { code: 'duplicate_conflict', query: 'failed', command: 'unknown' },
        { code: 'closed', query: 'closed', command: 'unknown' },
        { code: 'overloaded', query: 'overloaded', command: 'overloaded' },
        { code: 'expired', query: 'timeout', command: 'timeout' },
        { code: 'cancelled', query: 'cancelled', command: 'unknown' },
        { code: 'timeout', query: 'timeout', command: 'unknown' },
      ];
      for (const scenario of scenarios) {
        const queryRig = proxyRig(() => ({
          result: Promise.reject(new PluginPeerRpcLinkError(scenario.code, 'synthetic transport')),
          terminal: new Promise<void>(() => undefined),
        }));
        const query = await rejection(queryRig.invoke().result);
        expect(query.code).toBe(scenario.query);
        expect(queryRig.calls()).toBe(1);
        await tick();
        expect(queryRig.releases()).toBe(0);
        queryRig.stop();
        expect(queryRig.releases()).toBe(1);
        await queryRig.runtime.dispose();

        const commandRig = proxyRig(() => ({
          result: Promise.reject(new PluginPeerRpcLinkError(scenario.code, 'synthetic transport')),
          terminal: new Promise<void>(() => undefined),
        }));
        const command = await rejection(commandRig.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: { amount: 1 }, operationId: 'op-1' }).result);
        expect(command.code).toBe(scenario.command);
        expect(command.operationId).toBe('op-1');
        expect(commandRig.calls()).toBe(1);
        commandRig.stop();
        await commandRig.runtime.dispose();
      }
    });

    test('query-result is a read: a transport failure is fixed and never an execution retry', async () => {
      const rig = proxyRig(() => ({
        result: Promise.reject(new PluginPeerRpcLinkError('unknown', 'synthetic transport')),
        terminal: Promise.resolve(),
      }));
      const call = rig.invoke({ target: { ...ADD_TARGET }, purpose: 'management', operationId: 'op-1', input: null, commandAction: 'query-result' });
      const error = await rejection(call.result);
      expect(error.code).toBe('failed');
      expect(rig.calls()).toBe(1);
      await call.terminal;
      await rig.runtime.dispose();
    });

    test('malformed and unknown-code responses become invalid_output', async () => {
      const bodies: Uint8Array[] = [
        new Uint8Array(0),
        new TextEncoder().encode('{oops'),
        new TextEncoder().encode(`${PEER_RPC_ERROR_PREFIX}not_a_code`),
        new TextEncoder().encode(`${PEER_RPC_ERROR_PREFIX}failed extra`),
        new Uint8Array([0xc3, 0x28]),
      ];
      for (const body of bodies) {
        const rig = proxyRig(() => ({ result: Promise.resolve(body), terminal: Promise.resolve() }));
        const error = await rejection(rig.invoke().result);
        expect(error.code).toBe('invalid_output');
        await tick();
        await rig.runtime.dispose();
      }
    });

    test('a success payload containing the reserved prefix stays a legal success', async () => {
      const payloads: unknown[] = [`${PEER_RPC_ERROR_PREFIX}failed`, { error: `${PEER_RPC_ERROR_PREFIX}unauthorized`, ok: true }, [`${PEER_RPC_ERROR_PREFIX}x`]];
      for (const payload of payloads) {
        const rig = proxyRig(() => ({ result: Promise.resolve(encodePeerRpcJsonBody(payload)), terminal: Promise.resolve() }));
        expect(await rig.invoke().result).toEqual(payload);
        await tick();
        await rig.runtime.dispose();
      }
    });

    test('a pure prepare failure is known-not-started with a resolved terminal and no frame', async () => {
      const rig = proxyRig(() => ({ result: Promise.resolve(encodePeerRpcJsonBody('never')), terminal: Promise.resolve() }));
      const call = rig.invoke({ caller: { subject: 'consumer' } });
      const error = await rejection(call.result);
      expect(error.code).toBe('invalid_input');
      await call.terminal;
      expect(rig.calls()).toBe(0);
      expect(rig.releases()).toBe(1);
      await rig.runtime.dispose();
    });

    test('a link that throws after being entered keeps the terminal unproven', async () => {
      // Protocol fault injection: the synthetic link replaces only the transport.
      for (const command of [false, true]) {
        const rig = proxyRig(() => { throw new Error('SECRET after enter'); });
        try {
          const call = command
            ? rig.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: { amount: 1 }, operationId: 'op-1' })
            : rig.invoke();
          const error = await rejection(call.result);
          expect(error.code).toBe(command ? 'unknown' : 'failed');
          if (command) expect(error.operationId).toBe('op-1');
          let settled = false;
          void call.terminal.then(() => { settled = true; });
          await tick();
          await tick();
          expect(settled).toBe(false);
          expect(rig.releases()).toBe(0);
          expect(rig.runtime.status().active).toBe(1);
          // Fixture-only explicit host proof; never OS-level completion evidence.
          rig.stop();
          expect(rig.releases()).toBe(1);
        } finally {
          await rig.runtime.dispose();
        }
      }
    });

    test('a protocol fault pair with a throwing result getter keeps the lease until its gated terminal fires', async () => {
      const terminalGate = gateVoid();
      const rig = proxyRig(() => ({
        get result(): Promise<Uint8Array> { throw new Error('SECRET-result'); },
        terminal: terminalGate.promise,
      }));
      try {
        const call = rig.invoke();
        const error = await rejection(call.result);
        expect(error.code).toBe('failed');
        expect(error.message).not.toContain('SECRET');
        expect(Object.hasOwn(error, 'cause')).toBe(false);
        await tick();
        expect(rig.releases()).toBe(0);
        expect(rig.runtime.status().active).toBe(1);
        terminalGate.resolve();
        await call.terminal;
        expect(rig.releases()).toBe(1);
        expect(rig.runtime.status().active).toBe(0);
      } finally {
        terminalGate.resolve();
        await rig.runtime.dispose();
      }
    });

    test('a protocol fault pair with a hostile result constructor or then normalizes while its terminal survives', async () => {
      const variants: Array<() => unknown> = [
        () => {
          const real = Promise.resolve(new Uint8Array([1]));
          Object.defineProperty(real, 'constructor', { get: () => { throw new Error('SECRET-constructor'); } });
          return real;
        },
        () => {
          const thenable: Record<string, unknown> = {};
          Object.defineProperty(thenable, 'then', { value: () => { throw new Error('SECRET-then'); } });
          return thenable;
        },
      ];
      for (const hostile of variants) {
        const terminalGate = gateVoid();
        const rig = proxyRig(() => ({ result: hostile() as Promise<Uint8Array>, terminal: terminalGate.promise }));
        try {
          const call = rig.invoke();
          const error = await rejection(call.result);
          expect(error.code).toBe('failed');
          expect(error.message).not.toContain('SECRET');
          expect(Object.hasOwn(error, 'cause')).toBe(false);
          await tick();
          expect(rig.releases()).toBe(0);
          terminalGate.resolve();
          await call.terminal;
          expect(rig.releases()).toBe(1);
        } finally {
          terminalGate.resolve();
          await rig.runtime.dispose();
        }
      }
    });

    test('a protocol fault pair with a broken terminal never completes until an explicit host proof', async () => {
      const rig = proxyRig(() => ({
        result: Promise.resolve(encodePeerRpcJsonBody('late')),
        terminal: { then: 'not-a-function' } as unknown as Promise<void>,
      }));
      try {
        const call = rig.invoke();
        expect(await call.result).toBe('late');
        let settled = false;
        void call.terminal.then(() => { settled = true; });
        await tick();
        await tick();
        expect(settled).toBe(false);
        expect(rig.releases()).toBe(0);
        expect(rig.runtime.status().active).toBe(1);
        // Fixture-only explicit host proof; never OS-level completion evidence.
        rig.stop();
        expect(rig.releases()).toBe(1);
      } finally {
        await rig.runtime.dispose();
      }
    });

    test('the trusted compiler reads each call\'s callee frame while the wire carries only selected fields', async () => {
      interface AdmissionFrame { readonly secret: string; readonly attempt: number }
      const frames: AdmissionFrame[] = [
        { secret: 'frame-A', attempt: 1 },
        { secret: 'frame-B', attempt: 2 },
      ];
      const contexts: Array<Record<string, unknown>> = [];
      const proofs: Array<{ readonly attempt: number; readonly proof: string; readonly method: string }> = [];
      let releases = 0;
      let index = 0;
      let endpoint!: RpcEndpointHandle;
      // The caller runtime is typed with the real callee frame, so the compiler's
      // TCallee is inferred from the executor position and reads THIS call's frame.
      const runtime = new RpcServiceRuntime<AdmissionFrame>({
        limits: { drainTimeoutMs: 1 },
        admit: () => {
          const callee = frames[index] ?? frames[0];
          index += 1;
          return { endpoint, callee, release: () => { releases += 1; } };
        },
      });
      const link = syntheticLink((context) => {
        contexts.push(context as unknown as Record<string, unknown>);
        return { result: Promise.resolve(encodePeerRpcJsonBody('ok')), terminal: Promise.resolve() };
      });
      endpoint = runtime.registerProxy({
        provider: 'provider',
        binding: BINDING,
        contract: CONTRACT,
        execute: createPluginPeerRpcProxy('provider', link, (context, callee: AdmissionFrame) => {
          const proof = { attempt: callee.attempt, proof: `proof-${callee.secret.slice('frame-'.length)}`, method: context.method };
          proofs.push(proof);
          return proof;
        }),
      });
      runtime.markReady(endpoint);
      const invoke = (): RpcProxyExecution => runtime.invokeTracked({
        target: { ...ECHO_TARGET },
        caller: { subject: 'consumer', scope: 'global' },
        purpose: 'background',
        input: 'identical',
      });

      expect(await invoke().result).toBe('ok');
      expect(await invoke().result).toBe('ok');
      await tick();

      expect(proofs).toEqual([
        { attempt: 1, proof: 'proof-A', method: 'echo' },
        { attempt: 2, proof: 'proof-B', method: 'echo' },
      ]);
      expect(contexts).toHaveLength(2);
      // Identical public fields; only the callee-derived host DTO differs.
      for (const key of ['target', 'binding', 'caller', 'purpose', 'operationId', 'commandAction']) {
        expect(contexts[0][key]).toEqual(contexts[1][key]);
      }
      expect(contexts[0].host).toEqual({ attempt: 1, proof: 'proof-A', method: 'echo' });
      expect(contexts[1].host).toEqual({ attempt: 2, proof: 'proof-B', method: 'echo' });
      // The opaque frame is read by the trusted compiler, never serialized.
      expect(Object.keys(contexts[0]).sort()).toEqual(['binding', 'caller', 'commandAction', 'host', 'operationId', 'purpose', 'target', 'version']);
      const serialized = JSON.stringify(contexts);
      expect(serialized).not.toContain('frame-A');
      expect(serialized).not.toContain('frame-B');
      expect(serialized).not.toContain('Cookie');
      expect(serialized).not.toContain('signal');
      expect(releases).toBe(2);
      await runtime.dispose();
    });
  });

  /* ------------------------------------------------------------------------ */
  /* End-to-end over a real signed peer pair                                  */
  /* ------------------------------------------------------------------------ */

  describe('real signed peer pair', () => {
    test('round-trips a query with the exact binding, caller, host DTO and purpose', async () => {
      const h = harness({ compileHost: () => ({ peer: 'worker-a', attempt: 1 }) });
      try {
        const call = h.invoke({ input: 'hello' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await call.result).toBe('hello');
        await call.terminal;
        await tick();

        expect(h.records.metadata).toHaveLength(1);
        const metadata = h.records.metadata[0];
        expect(metadata.version).toBe(1);
        expect(metadata.target).toEqual({ ...ECHO_TARGET });
        expect(metadata.binding).toEqual({ ...BINDING });
        expect(metadata.caller).toEqual({ subject: 'consumer', scope: 'global' });
        expect(metadata.purpose).toBe('background');
        expect(metadata.operationId).toBeNull();
        expect(metadata.commandAction).toBeNull();
        expect(metadata.host).toEqual({ peer: 'worker-a', attempt: 1 });
        const native = h.records.native[0];
        expect(native.purpose).toBe('background');
        expect(native.operationId).toBeNull();
        expect(native.deadlineAt).toBe(h.records.inbound[0].deadlineAt);
        expect(Object.hasOwn(native, 'commandAction')).toBe(false);
        expect(Object.hasOwn(native, 'caller')).toBe(false);
        expect(h.records.contexts).toEqual([{ method: 'echo', purpose: 'background', operationId: null }]);
        expect(h.records.endpoints).toEqual([{ ...BINDING }]);
        expect(h.records.remoteAcquire).toBe(1);
        expect(h.records.providerAcquire).toBe(1);
        expect(h.records.remoteRelease).toBe(1);
        expect(h.records.providerRelease).toBe(1);
        expect(h.records.callerReleases).toBe(1);
        expect(h.callerRuntime.status().active).toBe(0);
      } finally {
        await h.dispose();
      }
    });

    test('preserves every purpose across the link', async () => {
      for (const purpose of PURPOSES) {
        const h = harness();
        try {
          const call = h.invoke({ purpose, input: purpose });
          await settle(h.wire.state, h.sender, h.receiver);
          expect(await call.result).toBe(purpose);
          await call.terminal;
          expect(h.records.metadata[0].purpose).toBe(purpose);
          expect(h.records.native[0].purpose).toBe(purpose);
          expect(h.records.contexts[0].purpose).toBe(purpose);
        } finally {
          await h.dispose();
        }
      }
    });

    test('carries the exact 65536-byte input and success envelopes', async () => {
      const h = harness();
      try {
        const big = 'a'.repeat(RPC_JSON_MAX_BYTES - 2);
        const call = h.invoke({ input: big });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await call.result).toBe(big);
        await call.terminal;

        const callPackets = h.wire.state.sentLeft.map((frame) => decodePluginPeerFrame(frame))
          .filter((packet) => packet.body.byteLength === RPC_JSON_MAX_BYTES);
        expect(callPackets).toHaveLength(1);
        const callContext = callPackets[0].header.context as unknown as { readonly op?: unknown; readonly caller?: RpcJson };
        expect(callContext.op).toBe('call');
        expect(decodePeerRpcCallMetadata(callContext.caller).target.method).toBe('echo');

        const resultPackets = h.wire.state.sentRight.map((frame) => decodePluginPeerFrame(frame))
          .filter((packet) => packet.body.byteLength === RPC_JSON_MAX_BYTES);
        expect(resultPackets).toHaveLength(1);
        expect((resultPackets[0].header.context as unknown as { readonly op?: unknown }).op).toBe('result');
      } finally {
        await h.dispose();
      }
    });

    test('verifies the kernel-selected endpoint and restores a native error body without ambiguity', async () => {
      const h = harness();
      try {
        const literal = `${PEER_RPC_ERROR_PREFIX}unauthorized`;
        const literalCall = h.invoke({ input: literal });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await literalCall.result).toBe(literal);
        await literalCall.terminal;

        const objectCall = h.invoke({ input: { error: `${PEER_RPC_ERROR_PREFIX}failed`, ok: true } });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await objectCall.result).toEqual({ error: `${PEER_RPC_ERROR_PREFIX}failed`, ok: true });
        await objectCall.terminal;

        const failing = h.invoke({ target: { ...BOOM_TARGET }, input: null });
        await settle(h.wire.state, h.sender, h.receiver);
        const error = await rejection(failing.result);
        expect(error.code).toBe('failed');
        await failing.terminal;

        expect(h.records.endpoints).toEqual([{ ...BINDING }, { ...BINDING }, { ...BINDING }]);
      } finally {
        await h.dispose();
      }
    });

    test('rejects a mismatched target binding before any dispatch or lease', async () => {
      const h = harness({ proxyBinding: { ...BINDING, generation: 99 } });
      try {
        const call = h.invoke({ input: 'hello' });
        await settle(h.wire.state, h.sender, h.receiver);
        const error = await rejection(call.result);
        expect(error.code).toBe('unauthorized');
        await call.terminal;
        expect(h.records.metadata).toHaveLength(1);
        expect(h.records.metadata[0].binding.generation).toBe(99);
        expect(h.records.invokes).toBe(0);
        expect(h.records.endpoints).toHaveLength(0);
        expect(h.records.providerAcquire).toBe(0);
        expect(h.records.remoteAcquire).toBe(0);
      } finally {
        await h.dispose();
      }
    });

    test('a broker denial is refused on every call without faking completion', async () => {
      const h = harness({ authorize: () => false });
      try {
        const call = h.invoke({ input: 'hello' });
        await settle(h.wire.state, h.sender, h.receiver);
        const error = await rejection(call.result);
        expect(error.code).toBe('unauthorized');
        await call.terminal;
        expect(h.records.endpoints).toHaveLength(1);
        expect(h.records.contexts).toHaveLength(0);
        expect(h.records.providerAcquire).toBe(0);
        expect(h.records.remoteAcquire).toBe(0);
        expect(h.records.callerReleases).toBe(1);
      } finally {
        await h.dispose();
      }
    });

    test('a real link send fault keeps the caller lease until a real terminal arrives', async () => {
      const faulted: PluginPeerRpcSendAdapter = () => { throw new Error('transport fault before delivery'); };
      const h = harness({ sendLeft: faulted });
      try {
        const call = h.invoke({ input: 'x' });
        await tick();
        await tick();
        const error = await rejection(call.result);
        expect(error.code).toBe('failed');
        expect(h.records.callerReleases).toBe(0);
        expect(h.callerRuntime.status().active).toBe(1);
        // Real link recovery: reattach and let the peer answer the inspect with an
        // explicit unknown result plus terminal; that terminal is real completion.
        h.sender.attach(h.wire.sendLeft);
        await settle(h.wire.state, h.sender, h.receiver);
        await call.terminal;
        expect(h.records.callerReleases).toBe(1);
        expect(h.callerRuntime.status().active).toBe(0);
      } finally {
        await h.dispose();
      }
    });

    test('a throwing dispatch fails closed over the real link and never forges a terminal', async () => {
      const h = harness({ dispatch: () => { throw new Error('SECRET dispatch'); } });
      try {
        const call = h.invoke({ input: 'hello' });
        await settle(h.wire.state, h.sender, h.receiver);
        const error = await rejection(call.result);
        expect(error.code).toBe('failed');
        expect(error.message).not.toContain('SECRET');
        let settled = false;
        void call.terminal.then(() => { settled = true; });
        await tick();
        expect(settled).toBe(false);
        h.sender.confirmRemoteStopped();
        await tick();
        expect(settled).toBe(true);
      } finally {
        await h.dispose();
      }
    });

    test('an erroneous async dispatch crosses as an invalid pair with zero unhandled rejections', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      const h = harness({
        dispatch: (async () => {
          await delay(0);
          throw new Error('SECRET async dispatch');
        }) as unknown as PluginPeerRpcNativeDispatch,
      });
      try {
        const call = h.invoke({ input: 'x' });
        await settle(h.wire.state, h.sender, h.receiver);
        await delay(0);
        await delay(0);
        const error = await rejection(call.result);
        expect(error.code).toBe('failed');
        expect(error.message).not.toContain('SECRET');
        let settled = false;
        void call.terminal.then(() => { settled = true; });
        await tick();
        await tick();
        expect(settled).toBe(false);
        expect(h.records.callerReleases).toBe(0);
        // Fixture-only cleanup of an unprovable terminal (protocol fault injection).
        h.sender.confirmRemoteStopped();
        await tick();
        expect(settled).toBe(true);
        expect(unhandled).toHaveLength(0);
      } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        await h.dispose();
      }
    });

    test('a malformed signed peer response becomes invalid_output', async () => {
      for (const body of [
        new TextEncoder().encode('{oops'),
        new TextEncoder().encode(`${PEER_RPC_ERROR_PREFIX}not_a_code`),
      ]) {
        const h = harness({ onRequest: () => ({ result: Promise.resolve(body), terminal: Promise.resolve() }) });
        try {
          const call = h.invoke({ input: 'x' });
          await settle(h.wire.state, h.sender, h.receiver);
          const error = await rejection(call.result);
          expect(error.code).toBe('invalid_output');
          await call.terminal;
        } finally {
          await h.dispose();
        }
      }
    });

    test('a command that really starts but loses its callback result stays unknown without retry', async () => {
      for (const action of ['execute', 'reconcile'] as const) {
        for (const fault of ['missing', 'async', 'getter', 'constructor'] as const) {
          let h!: Harness;
          let native: RpcProxyExecution | undefined;
          h = harness({ dispatch: ((_metadata, request) => {
            native = h.remoteCaller.invokeTracked(request);
            void native.result.catch(() => undefined);
            if (fault === 'missing') return undefined;
            if (fault === 'async') return Promise.reject(new Error('SECRET async command'));
            if (fault === 'getter') return {
              get result() { throw new Error('SECRET command getter'); }, terminal: native.terminal,
            };
            const result = native.result;
            Object.defineProperty(result, 'constructor', { get() { throw new Error('SECRET command constructor'); } });
            return { result, terminal: native.terminal };
          }) as PluginPeerRpcNativeDispatch });
          try {
            const call = h.invoke({ target: ADD_TARGET, purpose: 'management', input: { amount: 2 },
              operationId: 'uncertain-command', commandAction: action });
            await settle(h.wire.state, h.sender, h.receiver);
            const error = await rejection(call.result);
            expect(error.code).toBe('unknown');
            expect(error.operationId).toBe('uncertain-command');
            expect(error.message).not.toContain('SECRET');
            expect(callFrames(h.wire.state.sentLeft)).toHaveLength(1);
            expect(h.records.journal).toEqual([{ action, operationId: 'uncertain-command' }]);
            expect(h.records.remoteAcquire).toBe(1);
            expect(h.records.providerAcquire).toBe(1);
            expect(h.records.remoteRelease).toBe(1);
            expect(h.records.providerRelease).toBe(1);
            if (fault === 'missing' || fault === 'async') {
              expect(h.records.callerReleases).toBe(0);
              expect(h.callerRuntime.status().active).toBe(1);
              // Protocol-fixture cleanup only; this is not physical process-exit evidence.
              h.sender.confirmRemoteStopped();
            }
            await call.terminal;
            expect(h.records.callerReleases).toBe(1);
          } finally { await h.dispose(); }
        }
      }
    });

    test('a real signed peer link drains every malformed DTO/payload rejection and still serves the next call', async () => {
      const h = harness();
      try {
        const badCalls: Array<{ readonly metadata: RpcJson; readonly body: Uint8Array }> = [
          { metadata: { ...metadataInput(), version: 2 } as RpcJson, body: encodePeerRpcJsonBody({ ok: true }) },
          { metadata: { ...metadataInput(), extra: 1 } as RpcJson, body: encodePeerRpcJsonBody({ ok: true }) },
          { metadata: encodePeerRpcCallMetadata(commandMetadataInput({ target: { ...ECHO_TARGET } })), body: new TextEncoder().encode('{oops') },
          { metadata: encodePeerRpcCallMetadata(metadataInput()), body: new Uint8Array(0) },
        ];
        for (let index = 0; index < 24; index += 1) {
          const bad = badCalls[index % badCalls.length];
          const call = h.sender.request(bad.metadata, bad.body, { deadlineAt: Date.now() + 60_000 });
          await settle(h.wire.state, h.sender, h.receiver);
          expect(decodePeerRpcResultBody(await call.result)).toEqual({ ok: false, code: 'invalid_input' });
          await call.terminal;
          await settle(h.wire.state, h.sender, h.receiver);
        }
        // The host dispatch callback was never reached for a rejected wrapper.
        expect(h.records.metadata).toHaveLength(0);
        expect(h.records.invokes).toBe(0);
        // Every receipt was recovered by the ordinary ACK path: no host stop proof.
        expect(h.receiver.status()).toMatchObject({ inboundActive: 0, inboundReceipts: 0 });
        const normal = h.invoke({ input: 'after' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await normal.result).toBe('after');
        await normal.terminal;
        expect(h.records.invokes).toBe(1);
      } finally {
        await h.dispose();
      }
    });

    test('keeps the caller and provider leases until the real terminal arrives after the result', async () => {
      const work = gateVoid();
      const terminalGate = gateVoid();
      const h = harness({ echo: () => work.promise.then(() => 'done'), terminalGate: terminalGate.promise });
      try {
        const call = h.invoke({ input: 'x' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(h.callerRuntime.status().active).toBe(1);
        expect(h.adapter.status().active).toBe(1);
        expect(h.records.callerReleases).toBe(0);
        expect(h.records.providerRelease).toBe(0);
        expect(h.records.remoteRelease).toBe(0);

        work.resolve();
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await call.result).toBe('done');
        await tick();
        expect(h.records.providerRelease).toBe(1);
        expect(h.records.callerReleases).toBe(0);

        terminalGate.resolve();
        await settle(h.wire.state, h.sender, h.receiver);
        await call.terminal;
        expect(h.records.callerReleases).toBe(1);
        expect(h.callerRuntime.status().active).toBe(0);
      } finally {
        terminalGate.resolve();
        await h.dispose();
      }
    });

    test('holds the lease across caller cancellation and deadline without faking completion', async () => {
      for (const mode of ['cancel', 'deadline'] as const) {
        const work = gateVoid();
        const h = harness({ echo: () => work.promise.then(() => 'late') });
        try {
          const controller = new AbortController();
          const call = mode === 'cancel'
            ? h.invoke({ input: 'x', signal: controller.signal })
            : h.invoke({ input: 'x', timeoutMs: 120 });
          await settle(h.wire.state, h.sender, h.receiver);
          if (mode === 'cancel') controller.abort();
          else await delay(200);
          const error = await rejection(call.result);
          expect(error.code).toBe(mode === 'cancel' ? 'cancelled' : 'timeout');
          await settle(h.wire.state, h.sender, h.receiver);
          expect(h.records.callerReleases).toBe(0);
          expect(h.callerRuntime.status().active).toBe(1);

          work.resolve();
          await settle(h.wire.state, h.sender, h.receiver);
          await call.terminal;
          expect(h.records.callerReleases).toBe(1);
          expect(h.callerRuntime.status().active).toBe(0);
        } finally {
          work.resolve();
          await h.dispose();
        }
      }
    });

    test('forwards command execute/query-result/reconcile with the operation id and never retries', async () => {
      const h = harness();
      try {
        const execute = h.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: { amount: 2 }, operationId: 'cmd-1' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await execute.result).toEqual({ count: 2 });
        await execute.terminal;

        const query = h.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: null, operationId: 'cmd-1', commandAction: 'query-result' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await query.result).toEqual({ count: 7 });
        await query.terminal;

        const reconcile = h.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: { amount: 3 }, operationId: 'cmd-1', commandAction: 'reconcile' });
        await settle(h.wire.state, h.sender, h.receiver);
        expect(await reconcile.result).toEqual({ count: 8 });
        await reconcile.terminal;

        expect(h.records.journal).toEqual([
          { action: 'execute', operationId: 'cmd-1' },
          { action: 'query-result', operationId: 'cmd-1' },
          { action: 'reconcile', operationId: 'cmd-1' },
        ]);
        expect(h.records.contexts).toHaveLength(1);
        expect(h.records.contexts[0]).toEqual({ method: 'add', purpose: 'management', operationId: 'cmd-1' });
        expect(h.records.metadata.map((metadata) => metadata.commandAction)).toEqual(['execute', 'query-result', 'reconcile']);
        expect(h.records.native.map((request) => request.operationId)).toEqual(['cmd-1', 'cmd-1', 'cmd-1']);
        expect(h.records.native.map((request) => request.commandAction)).toEqual(['execute', 'query-result', 'reconcile']);
        expect(callFrames(h.wire.state.sentLeft)).toHaveLength(3);
      } finally {
        await h.dispose();
      }
    });

    test('restores a legitimate server-side native error code exactly', async () => {
      const h = harness({ noJournal: true });
      try {
        const call = h.invoke({ target: { ...ADD_TARGET }, purpose: 'management', input: { amount: 1 }, operationId: 'cmd-1' });
        await settle(h.wire.state, h.sender, h.receiver);
        const error = await rejection(call.result);
        expect(error.code).toBe('capability_unavailable');
        expect(error.operationId).toBe('cmd-1');
        await call.terminal;
        expect(h.records.metadata[0].commandAction).toBe('execute');
        expect(h.records.journal).toHaveLength(0);
      } finally {
        await h.dispose();
      }
    });
  });
});
