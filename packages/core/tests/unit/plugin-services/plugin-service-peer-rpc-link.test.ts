import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { deriveSupervisionProcessKey } from '../../../src/supervision';
import {
  PEER_BODY_MAX_BYTES,
  PluginPeerProtocolError,
  createPluginPeerCredential,
  signPluginPeerPacket,
  type PluginPeerAuthority,
  type PluginPeerCredential,
  type PluginPeerDirection,
  type PluginPeerKind,
  type PluginPeerProtocolErrorCode,
} from '../../../src/plugin-services/peer-protocol';
import { encodePluginPeerFrame } from '../../../src/plugin-services/peer-frame';
import {
  PluginPeerRpcLink,
  PluginPeerRpcLinkError,
  type PluginPeerRpcInboundCall,
  type PluginPeerRpcLinkLimits,
  type PluginPeerRpcRequestHandler,
  type PluginPeerRpcSendAdapter,
  type PluginPeerRpcLinkErrorCode,
} from '../../../src/plugin-services/peer-rpc-link';
import { RpcInvocationError, RpcServiceRuntime, type RpcEndpointHandle } from '../../../src/plugin-services/rpc-runtime';
import { decodeRpcJson, defineRpcService, encodeRpcJson, type RpcJson } from '../../../src/plugin-services/wire-contract';

/**
 * Protocol-test fixtures only: a fixed root key derives real supervision keys,
 * which mint real peer credentials. No production key material, no business data,
 * and every frame is a real signed BPC1 frame.
 */
const ROOT_KEY = new Uint8Array(32).fill(21);
const INSTANCE = '10000000-0000-4000-8000-0000000000b1';
const WORKER_ID = '20000000-0000-4000-8000-0000000000b1';
const INGRESS_ID = '20000000-0000-4000-8000-0000000000b2';
const BOOT = '30000000-0000-4000-8000-0000000000b1';
const BOOT_2 = '30000000-0000-4000-8000-0000000000b2';
const CONTROLLER = '40000000-0000-4000-8000-0000000000b1';
const EMPTY = new Uint8Array(0);

const credential: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT),
);
const ingressCredential: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'ingress', INGRESS_ID, BOOT_2),
);
const AUTHORITY: PluginPeerAuthority = Object.freeze({ controller_epoch: 7, controller_id: CONTROLLER });

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function gateVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

function expectProtoCode(action: () => unknown, code: PluginPeerProtocolErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPeerProtocolError);
    expect((error as PluginPeerProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function expectLinkCode(action: () => unknown, code: PluginPeerRpcLinkErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPeerRpcLinkError);
    expect((error as PluginPeerRpcLinkError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

async function rejectionOf(promise: Promise<unknown>): Promise<PluginPeerRpcLinkError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPeerRpcLinkError);
    return error as PluginPeerRpcLinkError;
  }
  throw new Error('expected rejection');
}

function makeLink(
  onRequest: PluginPeerRpcRequestHandler,
  outgoingDirection: PluginPeerDirection = 'peer-to-control',
  limits?: PluginPeerRpcLinkLimits,
): PluginPeerRpcLink {
  return new PluginPeerRpcLink({
    credential,
    authority: AUTHORITY,
    outgoingDirection,
    onRequest,
    ...(limits === undefined ? {} : { limits }),
  });
}

function immediateHandler(bytes: Uint8Array = new Uint8Array([7])): PluginPeerRpcRequestHandler {
  return () => ({ result: Promise.resolve(new Uint8Array(bytes)), terminal: Promise.resolve() });
}

function hangingHandler(): PluginPeerRpcRequestHandler {
  return () => ({ result: new Promise<Uint8Array>(() => undefined), terminal: new Promise<void>(() => undefined) });
}

function cleanup(...links: Array<PluginPeerRpcLink | undefined>): void {
  for (const link of links) {
    if (link === undefined) continue;
    try { link.confirmRemoteStopped(); } catch { /* host-only release is best-effort */ }
    try { link.dispose(); } catch { /* idempotent */ }
  }
}

interface WireState {
  leftToRight: Uint8Array[];
  rightToLeft: Uint8Array[];
  acceptLeft: boolean;
  acceptRight: boolean;
}

function makeWire(): { state: WireState; sendLeft: PluginPeerRpcSendAdapter; sendRight: PluginPeerRpcSendAdapter } {
  const state: WireState = { leftToRight: [], rightToLeft: [], acceptLeft: true, acceptRight: true };
  return {
    state,
    sendLeft: (frame) => { if (!state.acceptLeft) return false; state.leftToRight.push(Uint8Array.from(frame)); return true; },
    sendRight: (frame) => { if (!state.acceptRight) return false; state.rightToLeft.push(Uint8Array.from(frame)); return true; },
  };
}

function deliver(target: PluginPeerRpcLink, frames: Uint8Array[]): void {
  for (const frame of frames.splice(0)) target.receive(frame);
}

/** Deterministic in-memory transport: real signed frames, no protocol mocking. */
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

function encodeBody(value: unknown): Uint8Array {
  return new TextEncoder().encode(encodeRpcJson(value));
}

function decodeBody(bytes: Uint8Array): RpcJson {
  return decodeRpcJson(new TextDecoder().decode(bytes));
}

interface CraftedFrame {
  readonly sequence: number;
  readonly requestId: string;
  readonly kind: PluginPeerKind;
  readonly deadlineAt: number;
  readonly context: RpcJson;
  readonly direction?: PluginPeerDirection;
  readonly authority?: PluginPeerAuthority;
  readonly credential?: PluginPeerCredential;
  readonly body?: Uint8Array;
}

function craft(frame: CraftedFrame): Uint8Array {
  return encodePluginPeerFrame(signPluginPeerPacket({
    direction: frame.direction ?? 'peer-to-control',
    authority: frame.authority ?? AUTHORITY,
    sequence: frame.sequence,
    request_id: frame.requestId,
    lane: 'rpc',
    kind: frame.kind,
    deadline_at: frame.deadlineAt,
    context: frame.context,
  }, frame.body ?? EMPTY, frame.credential ?? credential));
}

describe('P4 authenticated paired RPC link', () => {
  test('round-trips a call and never exposes a terminal before the provider terminal', async () => {
    const resultGate = gate<Uint8Array>();
    const terminalGate = gateVoid();
    const received: PluginPeerRpcInboundCall[] = [];
    const right = makeLink((call) => {
      received.push(call);
      return { result: resultGate.promise, terminal: terminalGate.promise };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);

      expect(left.status()).toMatchObject({ attached: true, outboundPending: 0, inboundActive: 0 });
      const call = left.request({ target: 'echo' }, new Uint8Array([1, 2, 3]), { deadlineAt: Date.now() + 60_000 });
      expect(left.status().outboundPending).toBe(1);
      let resultDone = false;
      let terminalDone = false;
      void call.result.then(() => { resultDone = true; });
      void call.terminal.then(() => { terminalDone = true; });

      await pump(wire.state, left, right);
      expect(received).toHaveLength(1);
      expect(received[0].requestId).toBeString();
      expect(Array.from(received[0].body)).toEqual([1, 2, 3]);
      expect(received[0].metadata).toEqual({ target: 'echo' });
      expect(right.status().inboundActive).toBe(1);
      expect(resultDone).toBe(false);
      expect(terminalDone).toBe(false);

      resultGate.resolve(new Uint8Array([9, 9]));
      await pump(wire.state, left, right);
      expect(resultDone).toBe(true);
      expect(terminalDone).toBe(false);
      expect(Array.from(await call.result)).toEqual([9, 9]);

      terminalGate.resolve();
      await pump(wire.state, left, right);
      expect(terminalDone).toBe(true);
      await call.terminal;
      expect(left.status()).toMatchObject({ outboundPending: 0, ackOutbox: 0 });
      expect(right.status()).toMatchObject({ inboundActive: 0, inboundReceipts: 0 });
    } finally {
      cleanup(left, right);
    }
  });

  test('rejects unadmitted outbound calls without entering the transport', async () => {
    const sender = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      const disconnected = sender.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(disconnected.result)).code).toBe('disconnected');
      await disconnected.terminal;

      sender.attach(wire.sendLeft);
      const badContext = sender.request((() => undefined) as unknown as RpcJson, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(badContext.result)).code).toBe('invalid_call');
      await badContext.terminal;

      const oversized = sender.request({}, new Uint8Array(PEER_BODY_MAX_BYTES + 1), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(oversized.result)).code).toBe('invalid_call');
      await oversized.terminal;

      const expired = sender.request({}, new Uint8Array([1]), { deadlineAt: Date.now() });
      expect((await rejectionOf(expired.result)).code).toBe('expired');
      await expired.terminal;

      const controller = new AbortController();
      controller.abort();
      const cancelled = sender.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000, signal: controller.signal });
      expect((await rejectionOf(cancelled.result)).code).toBe('cancelled');
      await cancelled.terminal;

      expect(sender.status().outboundPending).toBe(0);
      expect(wire.state.leftToRight).toHaveLength(0);
    } finally {
      cleanup(sender);
    }
  });

  test('R1: prepare failure and explicit send-false are known-not-started; a send throw keeps the terminal pending', async () => {
    const peer = makeLink(immediateHandler(), 'control-to-peer');
    const wire = makeWire();
    const left = makeLink(immediateHandler());
    const thrown = makeLink(immediateHandler());
    try {
      peer.attach(wire.sendRight);
      left.attach(wire.sendLeft);
      wire.state.acceptLeft = false; // explicit rejection, nothing queued
      const refused = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(refused.result)).code).toBe('disconnected');
      await refused.terminal;
      expect(left.status().outboundPending).toBe(0);
      expect(wire.state.leftToRight).toHaveLength(0);

      thrown.attach(() => { throw new Error('adapter fault'); });
      const thrownCall = thrown.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(thrownCall.result)).code).toBe('unknown');
      let thrownTerminal = false;
      void thrownCall.terminal.then(() => { thrownTerminal = true; });
      await delay(0);
      expect(thrownTerminal).toBe(false); // not proven finished
      expect(thrown.status().outboundPending).toBe(1);
      thrown.confirmRemoteStopped();
      await delay(0);
      expect(thrownTerminal).toBe(true);
    } finally {
      cleanup(peer, left, thrown);
    }
  });

  test('R2: a synchronous peer reply during the write correlates because the record already exists', async () => {
    const right = makeLink(immediateHandler(), 'control-to-peer');
    const left = makeLink(immediateHandler());
    try {
      let leftLink!: PluginPeerRpcLink;
      right.attach((frame) => { leftLink.receive(frame); return true; });
      right.dispose(); // peer rejects new calls, but the record map is already live
      leftLink = left;
      left.attach((frame) => { right.receive(frame); return true; });

      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(call.result)).code).toBe('closed');
      await call.terminal;
      expect(left.status()).toMatchObject({ outboundPending: 0, ackOutbox: 0 });
      expect(right.status()).toMatchObject({ inboundActive: 0, inboundReceipts: 0 });
    } finally {
      cleanup(left, right);
    }
  });

  test('a non-cooperative provider: abort and deadline settle the result while the terminal stays unknown', async () => {
    const signals: AbortSignal[] = [];
    const right = makeLink((_call, signal) => {
      signals.push(signal);
      return { result: new Promise<Uint8Array>(() => undefined), terminal: new Promise<void>(() => undefined) };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);

      const controller = new AbortController();
      const aborted = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000, signal: controller.signal });
      let abortedTerminal = false;
      void aborted.terminal.then(() => { abortedTerminal = true; });
      await pump(wire.state, left, right);
      expect(signals[0]).toBeDefined();

      controller.abort();
      expect((await rejectionOf(aborted.result)).code).toBe('cancelled');
      await pump(wire.state, left, right);
      expect(signals[0]?.aborted).toBe(true);
      expect(abortedTerminal).toBe(false);
      expect(left.status().outboundPending).toBe(1); // retained until a real terminal or host proof

      const timed = left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 300 });
      let timedTerminal = false;
      void timed.terminal.then(() => { timedTerminal = true; });
      deliver(right, wire.state.leftToRight); // admit the call right away, then let the deadline fire
      await delay(500);
      expect((await rejectionOf(timed.result)).code).toBe('timeout');
      expect(timedTerminal).toBe(false);
      expect(right.status().inboundActive).toBe(2);
    } finally {
      cleanup(left, right);
    }
  });

  test('disconnect never fabricates a terminal and host proof releases the outbound barrier', async () => {
    const right = makeLink(hangingHandler(), 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);

      let resultError: PluginPeerRpcLinkError | null = null;
      let terminalDone = false;
      void call.result.catch((error: unknown) => { resultError = error as PluginPeerRpcLinkError; });
      void call.terminal.then(() => { terminalDone = true; });

      left.disconnect();
      await delay(0);
      expect(left.status().attached).toBe(false);
      expect(resultError).toBeNull();
      expect(terminalDone).toBe(false);

      left.confirmRemoteStopped();
      await delay(0);
      expect(terminalDone).toBe(true);
      expect((resultError as unknown as PluginPeerRpcLinkError).code).toBe('unknown');
    } finally {
      cleanup(left, right);
    }
  });

  test('reconnect inspects pending work and recovers the result without re-running the handler', async () => {
    let handlerCalls = 0;
    const right = makeLink(() => {
      handlerCalls += 1;
      return { result: Promise.resolve(new Uint8Array([42])), terminal: Promise.resolve() };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      wire.state.acceptRight = false; // the peer cannot answer yet
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      expect(handlerCalls).toBe(1);
      expect(wire.state.rightToLeft).toHaveLength(0);
      let resultDone = false;
      void call.result.then(() => { resultDone = true; });
      await delay(0);
      expect(resultDone).toBe(false);

      left.disconnect();
      wire.state.acceptRight = true;
      left.attach(wire.sendLeft);
      await pump(wire.state, left, right);
      expect(Array.from(await call.result)).toEqual([42]);
      await call.terminal;
      expect(handlerCalls).toBe(1);
    } finally {
      cleanup(left, right);
    }
  });

  test('a missing inspect answer burns the original sequence so a late CALL cannot start work', async () => {
    let handlerCalls = 0;
    const right = makeLink(() => {
      handlerCalls += 1;
      return { result: Promise.resolve(new Uint8Array([1])), terminal: Promise.resolve() };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      const lateCall = wire.state.leftToRight.splice(0)[0]; // the CALL is lost before delivery
      expect(lateCall).toBeInstanceOf(Uint8Array);

      left.disconnect();
      left.attach(wire.sendLeft); // recovery inspects the pending call
      await pump(wire.state, left, right);
      expect((await rejectionOf(call.result)).code).toBe('unknown');
      await call.terminal;
      expect(handlerCalls).toBe(0);
      expectProtoCode(() => right.receive(lateCall), 'replayed');
      expect(handlerCalls).toBe(0);
    } finally {
      cleanup(left, right);
    }
  });

  test('R3: a full ACK outbox retains the finished call and drains after reconnect', async () => {
    const peer = makeLink(immediateHandler(), 'control-to-peer');
    const link = makeLink(immediateHandler(), 'peer-to-control', { maxAckOutbox: 1 });
    const wire = makeWire();
    try {
      link.attach(wire.sendLeft);
      peer.attach(wire.sendRight);
      const one = link.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      const two = link.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      deliver(peer, wire.state.leftToRight); // both CALLs reach the peer...
      wire.state.acceptLeft = false; // ...but every ACK is lost
      await pump(wire.state, link, peer);
      await one.terminal;
      await two.terminal;
      expect(link.status().ackOutbox).toBe(1);
      expect(link.status().outboundPending).toBe(1); // the second finished call keeps its slot
      expect(peer.status().inboundReceipts).toBe(2);

      wire.state.acceptLeft = true;
      link.attach(wire.sendLeft); // resend retained ACK, then flush the waiting transfer
      await pump(wire.state, link, peer);
      expect(link.status().ackOutbox).toBe(0);
      expect(link.status().outboundPending).toBe(0);
      expect(peer.status().inboundReceipts).toBe(0);
      expect(peer.status().inboundActive).toBe(0);
    } finally {
      cleanup(link, peer);
    }
  });

  test('burns a duplicate call identity with a different fingerprint and replays the known answer', () => {
    let handlerCalls = 0;
    const link = makeLink(() => {
      handlerCalls += 1;
      return { result: Promise.resolve(new Uint8Array([1])), terminal: Promise.resolve() };
    }, 'control-to-peer');
    const requestId = randomUUID();
    const deadline = Date.now() + 60_000;
    const call = (sequence: number, body: Uint8Array, caller: RpcJson) => craft({ sequence, requestId, kind: 'request', deadlineAt: deadline, context: { op: 'call', caller }, body });
    try {
      link.receive(call(1, new Uint8Array([1]), { a: true }));
      expect(handlerCalls).toBe(1);
      link.receive(call(2, new Uint8Array([1]), { a: true }));
      expect(handlerCalls).toBe(1);
      expectLinkCode(() => link.receive(call(3, new Uint8Array([2]), { a: true })), 'duplicate_conflict');
    } finally {
      cleanup(link);
    }
  });

  test('rejects spoofed MAC, direction, authority, identity, lane and replayed sequences', () => {
    let handlerCalls = 0;
    const link = makeLink(() => {
      handlerCalls += 1;
      return { result: Promise.resolve(new Uint8Array()), terminal: Promise.resolve() };
    }, 'control-to-peer');
    const deadline = Date.now() + 60_000;
    const valid = craft({ sequence: 1, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, context: { op: 'call', caller: {} }, body: new Uint8Array([1, 2, 3]) });
    try {
      link.receive(valid);
      expect(handlerCalls).toBe(1);
      expectProtoCode(() => link.receive(valid), 'replayed');

      const tampered = Uint8Array.from(valid);
      tampered[tampered.length - 1] ^= 0xff;
      expectProtoCode(() => link.receive(tampered), 'authentication_failed');
      expectProtoCode(() => link.receive(craft({ sequence: 3, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, direction: 'control-to-peer', context: { op: 'call', caller: {} } })), 'direction_mismatch');
      expectProtoCode(() => link.receive(craft({ sequence: 4, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, authority: { controller_epoch: 8, controller_id: CONTROLLER }, context: { op: 'call', caller: {} } })), 'authority_mismatch');
      expectProtoCode(() => link.receive(craft({ sequence: 5, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, credential: ingressCredential, context: { op: 'call', caller: {} } })), 'identity_mismatch');
      expectLinkCode(() => link.receive(craft({ sequence: 6, requestId: randomUUID(), kind: 'response', deadlineAt: deadline, context: { op: 'call', caller: {} } })), 'invalid_context');
      expectLinkCode(() => link.receive(craft({ sequence: 7, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, context: { op: 'call', caller: {}, extra: 1 } })), 'invalid_context');
      expectLinkCode(() => link.receive(craft({ sequence: 8, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, context: { op: 'bogus' } })), 'invalid_context');
      expect(handlerCalls).toBe(1);
    } finally {
      cleanup(link);
    }
  });

  test('bounds inbound records and outbound pending calls', async () => {
    let handlerCalls = 0;
    const right = makeLink(() => {
      handlerCalls += 1;
      return { result: new Promise<Uint8Array>(() => undefined), terminal: new Promise<void>(() => undefined) };
    }, 'control-to-peer', { maxInboundRecords: 1 });
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      left.request({ first: true }, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      const second = left.request({ second: true }, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      expect(handlerCalls).toBe(1);
      expect((await rejectionOf(second.result)).code).toBe('overloaded');
      await second.terminal;
      expect(right.status().inboundActive).toBe(1);
      expect(left.status().outboundPending).toBe(1);
    } finally {
      cleanup(left, right);
    }

    const saturated = makeLink(immediateHandler(), 'peer-to-control', { maxOutboundPending: 1 });
    const saturatedWire = makeWire();
    try {
      saturated.attach(saturatedWire.sendLeft);
      saturated.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      const refused = saturated.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      expect((await rejectionOf(refused.result)).code).toBe('overloaded');
      await refused.terminal;
      expect(saturated.status().outboundPending).toBe(1);
    } finally {
      cleanup(saturated);
    }
  });

  test('R8: control ops with a wrong deadline change no state', async () => {
    const seen: PluginPeerRpcInboundCall[] = [];
    const signals: AbortSignal[] = [];
    const terminals: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const right = makeLink((call, signal) => {
      seen.push(call);
      signals.push(signal);
      const terminal = gateVoid();
      terminals.push(terminal);
      return { result: Promise.resolve(new Uint8Array([1])), terminal: terminal.promise };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const one = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      wire.state.acceptLeft = false; // keep the ACK in the outbox
      terminals[0].resolve();
      await pump(wire.state, left, right);
      await one.terminal;
      expect(seen).toHaveLength(2);
      const receipt = seen[0];
      const active = seen[1];
      expect(right.status().inboundReceipts).toBe(1);
      expect(left.status().ackOutbox).toBe(1);

      // ACK with a wrong deadline must not release the receipt.
      expectLinkCode(() => right.receive(craft({ sequence: 100, requestId: receipt.requestId, kind: 'response', deadlineAt: receipt.deadlineAt + 1, context: { op: 'ack' } })), 'invalid_context');
      expect(right.status().inboundReceipts).toBe(1);
      right.receive(craft({ sequence: 101, requestId: receipt.requestId, kind: 'response', deadlineAt: receipt.deadlineAt, context: { op: 'ack' } }));
      expect(right.status().inboundReceipts).toBe(0);

      // CANCEL with a wrong deadline must not abort the task.
      expectLinkCode(() => right.receive(craft({ sequence: 102, requestId: active.requestId, kind: 'cancel', deadlineAt: active.deadlineAt + 1, context: { op: 'cancel' } })), 'invalid_context');
      expect(signals[1]?.aborted).toBe(false);
      right.receive(craft({ sequence: 103, requestId: active.requestId, kind: 'cancel', deadlineAt: active.deadlineAt, context: { op: 'cancel' } }));
      expect(signals[1]?.aborted).toBe(true);

      // ACK-CONFIRMED with a wrong deadline must not clear the outbox.
      expectLinkCode(() => left.receive(craft({ sequence: 104, requestId: receipt.requestId, kind: 'response', direction: 'control-to-peer', deadlineAt: receipt.deadlineAt + 1, context: { op: 'ack-confirmed' } })), 'invalid_context');
      expect(left.status().ackOutbox).toBe(1);
      left.receive(craft({ sequence: 105, requestId: receipt.requestId, kind: 'response', direction: 'control-to-peer', deadlineAt: receipt.deadlineAt, context: { op: 'ack-confirmed' } }));
      expect(left.status().ackOutbox).toBe(0);
    } finally {
      cleanup(left, right);
    }
  });

  test('R8: an inspect with a mismatched correlation does not burn the original sequence', async () => {
    let handlerCalls = 0;
    const right = makeLink(() => {
      handlerCalls += 1;
      return { result: Promise.resolve(new Uint8Array([1])), terminal: Promise.resolve() };
    }, 'control-to-peer');
    const deadline = Date.now() + 60_000;
    const callFrame = craft({ sequence: 1, requestId: randomUUID(), kind: 'request', deadlineAt: deadline, context: { op: 'call', caller: {} } });
    try {
      // Wrong original deadline: rejected, no burn.
      expectLinkCode(() => right.receive(craft({
        sequence: 2,
        requestId: randomUUID(),
        kind: 'request',
        deadlineAt: deadline,
        context: { op: 'inspect', original_call_sequence: 1, original_deadline_at: deadline + 1 },
      })), 'invalid_context');
      // The late CALL is therefore still admissible.
      right.receive(callFrame);
      expect(handlerCalls).toBe(1);
    } finally {
      cleanup(right);
    }
  });

  test('R8: control wrappers reject a non-empty body even for an unknown request id', () => {
    const right = makeLink(immediateHandler(), 'control-to-peer');
    const deadline = Date.now() + 60_000;
    try {
      expectLinkCode(() => right.receive(craft({ sequence: 1, requestId: randomUUID(), kind: 'terminal', deadlineAt: deadline, context: { op: 'terminal' }, body: new Uint8Array([1]) })), 'invalid_context');
      expectLinkCode(() => right.receive(craft({ sequence: 2, requestId: randomUUID(), kind: 'response', deadlineAt: deadline, context: { op: 'ack' }, body: new Uint8Array([1]) })), 'invalid_context');
      expectLinkCode(() => right.receive(craft({ sequence: 3, requestId: randomUUID(), kind: 'response', deadlineAt: deadline, context: { op: 'result', error: 'failed' }, body: new Uint8Array([1]) })), 'invalid_context');
      expectLinkCode(() => right.receive(craft({ sequence: 4, requestId: randomUUID(), kind: 'cancel', deadlineAt: deadline, context: { op: 'cancel', extra: 1 } })), 'invalid_context');
    } finally {
      cleanup(right);
    }
  });

  test('an ACK never releases a live inbound task', () => {
    const seen: PluginPeerRpcInboundCall[] = [];
    const right = makeLink((call) => {
      seen.push(call);
      return { result: new Promise<Uint8Array>(() => undefined), terminal: new Promise<void>(() => undefined) };
    }, 'control-to-peer');
    try {
      right.receive(craft({ sequence: 1, requestId: randomUUID(), kind: 'request', deadlineAt: Date.now() + 60_000, context: { op: 'call', caller: {} } }));
      const record = seen[0];
      expect(record).toBeDefined();
      right.receive(craft({ sequence: 2, requestId: record.requestId, kind: 'response', deadlineAt: record.deadlineAt, context: { op: 'ack' } }));
      expect(right.status().inboundActive).toBe(1);
    } finally {
      cleanup(right);
    }
  });

  test('an ACK releases a receipt only after the producer result, and an unknown ACK is confirmed', async () => {
    const resultGate = gate<Uint8Array>();
    const seen: PluginPeerRpcInboundCall[] = [];
    const right = makeLink((call) => {
      seen.push(call);
      return { result: resultGate.promise, terminal: Promise.resolve() };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      const record = seen[0];
      expect(record).toBeDefined();
      expect(right.status().inboundReceipts).toBe(1); // terminal arrived, result still pending

      right.receive(craft({ sequence: 100, requestId: record.requestId, kind: 'response', deadlineAt: record.deadlineAt, context: { op: 'ack' } }));
      expect(right.status().inboundReceipts).toBe(1); // not released: the producer result was not consumed

      resultGate.resolve(new Uint8Array([5]));
      await pump(wire.state, left, right);
      expect(Array.from(await call.result)).toEqual([5]);
      expect(right.status().inboundReceipts).toBe(0); // the caller's ACK drained it once the result existed

      right.receive(craft({ sequence: 101, requestId: randomUUID(), kind: 'response', deadlineAt: Date.now() + 60_000, context: { op: 'ack' } }));
      expect(wire.state.rightToLeft).toHaveLength(1); // ack-confirmed for the unknown ACK
    } finally {
      cleanup(left, right);
    }
  });

  test('a rejected provider terminal retains the inbound record fail-closed', async () => {
    const right = makeLink(() => ({
      result: Promise.resolve(new Uint8Array([5])),
      terminal: Promise.reject(new Error('provider terminal rejected')),
    }), 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      let terminalDone = false;
      void call.terminal.then(() => { terminalDone = true; });
      await pump(wire.state, left, right);
      expect(Array.from(await call.result)).toEqual([5]);
      await delay(0);
      expect(terminalDone).toBe(false);
      expect(right.status()).toMatchObject({ inboundActive: 1, inboundReceipts: 0 });
      expect(left.status().outboundPending).toBe(1);
    } finally {
      cleanup(left, right);
    }
  });

  test('R6: a throwing result getter becomes a fixed failure while a valid terminal still settles', async () => {
    const shapes: Array<'result-broken' | 'terminal-broken'> = ['result-broken', 'terminal-broken'];
    const terminalGate = gateVoid();
    const right = makeLink(() => {
      const shape = shapes.shift();
      if (shape === 'result-broken') {
        return { get result(): Promise<Uint8Array> { throw new Error('result getter broke'); }, terminal: terminalGate.promise };
      }
      return { result: Promise.resolve(new Uint8Array([3])), get terminal(): Promise<void> { throw new Error('terminal getter broke'); } };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);

      const first = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      let firstTerminal = false;
      void first.terminal.then(() => { firstTerminal = true; });
      const second = left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      let secondTerminal = false;
      void second.terminal.then(() => { secondTerminal = true; });
      await pump(wire.state, left, right);

      expect((await rejectionOf(first.result)).code).toBe('failed');
      expect(firstTerminal).toBe(false);
      terminalGate.resolve();
      await pump(wire.state, left, right);
      expect(firstTerminal).toBe(true); // the valid terminal still settled

      expect(Array.from(await second.result)).toEqual([3]);
      await delay(0);
      expect(secondTerminal).toBe(false); // a broken terminal getter never forges completion
      expect(right.status().inboundActive).toBe(1);
    } finally {
      cleanup(left, right);
    }
  });

  test('R10: throwing native promise subscriptions cannot leak an error or suppress an independent terminal', async () => {
    const terminalGate = gateVoid();
    const result = Promise.resolve(new Uint8Array([1]));
    Object.defineProperty(result, 'then', { value: () => { throw new Error('private subscription failure'); } });
    const terminal = Promise.resolve();
    Object.defineProperty(terminal, 'then', { value: () => { throw new Error('private terminal subscription failure'); } });
    let runs = 0;
    const right = makeLink(() => ++runs === 1
      ? { result, terminal: terminalGate.promise }
      : { result: Promise.resolve(new Uint8Array([3])), terminal }, 'control-to-peer');
    const left = makeLink(immediateHandler()); const wire = makeWire();
    try {
      left.attach(wire.sendLeft); right.attach(wire.sendRight);
      const first = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      const second = left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      let firstEnded = false; let secondEnded = false;
      void first.terminal.then(() => { firstEnded = true; }); void second.terminal.then(() => { secondEnded = true; });
      await pump(wire.state, left, right);
      const failure = await rejectionOf(first.result);
      expect(failure.code).toBe('failed'); expect(failure.message).not.toContain('private'); expect(Object.hasOwn(failure, 'cause')).toBe(false);
      expect(firstEnded).toBe(false); expect(Array.from(await second.result)).toEqual([3]); expect(secondEnded).toBe(false);
      terminalGate.resolve(); await pump(wire.state, left, right);
      expect(firstEnded).toBe(true); expect(secondEnded).toBe(false); expect(right.status().inboundActive).toBe(1);
    } finally { terminalGate.resolve(); cleanup(left, right); }
  });

  for (const mode of ['abort', 'dispose'] as const) test(`R9: late producer result drains an early ACK after ${mode} without reconnecting`, async () => {
    const resultGate = gate<Uint8Array>();
    const right = makeLink(() => ({ result: resultGate.promise, terminal: Promise.resolve() }), 'control-to-peer');
    const left = makeLink(immediateHandler()); const wire = makeWire(); const controller = new AbortController();
    try {
      left.attach(wire.sendLeft); right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000, signal: controller.signal });
      await pump(wire.state, left, right); await call.terminal;
      if (mode === 'abort') controller.abort(); else left.dispose();
      expect((await rejectionOf(call.result)).code).toBe(mode === 'abort' ? 'cancelled' : 'closed');
      await pump(wire.state, left, right);
      expect(left.status()).toMatchObject({ outboundPending: 0, ackOutbox: 1 });
      expect(right.status().inboundReceipts).toBe(1);
      resultGate.resolve(new Uint8Array([9])); await pump(wire.state, left, right);
      expect(left.status()).toMatchObject({ outboundPending: 0, ackOutbox: 0 });
      expect(right.status()).toMatchObject({ inboundActive: 0, inboundReceipts: 0 });
      expect((await rejectionOf(call.result)).code).toBe(mode === 'abort' ? 'cancelled' : 'closed'); // Never re-settle the user result.
      if (mode === 'abort') {
        const next = left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
        await pump(wire.state, left, right); expect(Array.from(await next.result)).toEqual([9]); await next.terminal;
        expect(right.status().inboundReceipts).toBe(0);
      }
    } finally { resultGate.resolve(new Uint8Array([9])); cleanup(left, right); }
  });

  test('R7: a detached result buffer becomes a fixed failure, never an empty success', async () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    view.set([1, 2, 3]);
    structuredClone(buffer, { transfer: [buffer] }); // detaches the buffer/view
    const right = makeLink(() => ({
      result: Promise.resolve(view),
      terminal: Promise.resolve(),
    }), 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      expect((await rejectionOf(call.result)).code).toBe('failed');
      await call.terminal;
      expect(right.status()).toMatchObject({ inboundActive: 0, inboundReceipts: 0 });
    } finally {
      cleanup(left, right);
    }
  });

  test('R4: dispose stops new admission but keeps draining an existing real terminal', async () => {
    const terminalGate = gateVoid();
    const right = makeLink(() => ({ result: Promise.resolve(new Uint8Array([7])), terminal: terminalGate.promise }), 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      const call = left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      expect(Array.from(await call.result)).toEqual([7]);

      left.dispose();
      expect(left.status().closed).toBe(true);
      expect((await rejectionOf(left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 }).result)).code).toBe('closed');
      let terminalDone = false;
      void call.terminal.then(() => { terminalDone = true; });
      await delay(0);
      expect(terminalDone).toBe(false);

      terminalGate.resolve(); // the real provider terminal arrives after dispose
      await pump(wire.state, left, right);
      expect(terminalDone).toBe(true);
      expect(left.status().outboundPending).toBe(0);
      expect(right.status().inboundReceipts).toBe(0);
    } finally {
      cleanup(left, right);
    }
  });

  test('R5: confirmRemoteStopped clears ACKs and completed receipts but keeps active work until its terminal', async () => {
    const seen: PluginPeerRpcInboundCall[] = [];
    const signals: AbortSignal[] = [];
    const terminals: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const right = makeLink((call, signal) => {
      seen.push(call);
      signals.push(signal);
      const terminal = gateVoid();
      terminals.push(terminal);
      return { result: Promise.resolve(new Uint8Array([1])), terminal: terminal.promise };
    }, 'control-to-peer');
    const left = makeLink(immediateHandler());
    const wire = makeWire();
    try {
      left.attach(wire.sendLeft);
      right.attach(wire.sendRight);
      left.request({}, new Uint8Array([1]), { deadlineAt: Date.now() + 60_000 });
      left.request({}, new Uint8Array([2]), { deadlineAt: Date.now() + 60_000 });
      await pump(wire.state, left, right);
      wire.state.acceptLeft = false; // retain the ACK
      terminals[0].resolve();
      await pump(wire.state, left, right);
      expect(right.status().inboundReceipts).toBe(1);
      expect(right.status().inboundActive).toBe(1);
      expect(left.status().ackOutbox).toBe(1);

      right.confirmRemoteStopped();
      expect(right.status().inboundReceipts).toBe(0); // completed receipt dropped
      expect(right.status().inboundActive).toBe(1); // active task retained
      expect(signals[1]?.aborted).toBe(true);
      left.confirmRemoteStopped();
      expect(left.status().ackOutbox).toBe(0);
      expect(left.status().outboundPending).toBe(0);
      expect((await rejectionOf(left.request({}, new Uint8Array([3]), { deadlineAt: Date.now() + 60_000 }).result)).code).toBe('closed');

      terminals[1].resolve(); // the local task really finished
      await delay(0);
      expect(right.status().inboundActive).toBe(0);
      expect(seen).toHaveLength(2);
    } finally {
      cleanup(left, right);
    }
  });

  test('drives a real invokeTracked receiver and holds the caller proxy lease until the actual terminal', async () => {
    const contract = defineRpcService({
      id: 'link.echo',
      version: 1,
      methods: { echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background', 'management', 'request', 'attempt'] } },
    });
    const wire = makeWire();
    const work = gate<string>();
    const releaseGate = gateVoid();
    let receiverEndpoint!: RpcEndpointHandle;
    let receiverReleases = 0;
    let callerEndpoint!: RpcEndpointHandle;
    let callerReleases = 0;
    const receiverRuntime = new RpcServiceRuntime({ admit: () => ({ endpoint: receiverEndpoint, callee: null, release: () => { receiverReleases += 1; } }) });
    const callerRuntime = new RpcServiceRuntime({ admit: () => ({ endpoint: callerEndpoint, callee: null, release: () => { callerReleases += 1; } }) });
    let receiver!: PluginPeerRpcLink;
    let sender!: PluginPeerRpcLink;
    try {
      receiverEndpoint = receiverRuntime.register({
        provider: 'provider',
        contract,
        binding: { endpoint: 'receiver.endpoint', process: 'control', instance: 'receiver-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'provider' },
        handler: { echo: (input: string) => work.promise.then(() => input) },
      });
      receiverRuntime.markReady(receiverEndpoint);
      receiver = new PluginPeerRpcLink({
        credential,
        authority: AUTHORITY,
        outgoingDirection: 'control-to-peer',
        onRequest: (call) => {
          const input = decodeBody(call.body) as string;
          const tracked = receiverRuntime.invokeTracked({
            target: { provider: 'provider', service: contract.id, major: 1, method: 'echo' },
            caller: { subject: 'remote-peer', scope: 'global' },
            purpose: 'request',
            input,
            deadlineAt: call.deadlineAt,
          });
          return { result: tracked.result.then((output) => encodeBody(output)), terminal: tracked.terminal.then(() => releaseGate.promise) };
        },
      });
      sender = new PluginPeerRpcLink({ credential, authority: AUTHORITY, outgoingDirection: 'peer-to-control', onRequest: immediateHandler() });
      sender.attach(wire.sendLeft);
      receiver.attach(wire.sendRight);

      callerEndpoint = callerRuntime.registerProxy({
        provider: 'consumer-provider',
        contract,
        binding: { endpoint: 'caller.endpoint', process: 'control', instance: 'caller-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'consumer' },
        execute: (proxyRequest) => {
          const call = sender.request({}, encodeBody(proxyRequest.input), { deadlineAt: proxyRequest.context.deadlineAt ?? Date.now() + 5_000, signal: proxyRequest.context.signal });
          return { result: call.result.then((bytes) => decodeBody(bytes)), terminal: call.terminal };
        },
      });
      callerRuntime.markReady(callerEndpoint);

      const tracked = callerRuntime.invokeTracked({
        target: { provider: 'consumer-provider', service: contract.id, major: 1, method: 'echo' },
        caller: { subject: 'consumer', scope: 'global' },
        purpose: 'request',
        input: 'hello',
      });
      await pump(wire.state, sender, receiver);
      expect(callerRuntime.status().active).toBe(1);
      expect(receiverRuntime.status().active).toBe(1);
      expect(callerReleases).toBe(0);
      expect(receiverReleases).toBe(0);

      work.resolve('hello');
      await pump(wire.state, sender, receiver);
      expect(await tracked.result).toBe('hello');
      await delay(0);
      expect(receiverReleases).toBe(1);
      expect(callerReleases).toBe(0);

      releaseGate.resolve();
      await pump(wire.state, sender, receiver);
      await tracked.terminal;
      expect(callerReleases).toBe(1);
      expect(receiverRuntime.status().active).toBe(0);
    } finally {
      await callerRuntime.dispose();
      await receiverRuntime.dispose();
      cleanup(sender, receiver);
    }
  });

  test('R2/R4 fault: a sender throw after a delivered CALL keeps the caller lease until the real terminal, and a late ACK after dispose releases', async () => {
    const contract = defineRpcService({
      id: 'fault.echo',
      version: 1,
      methods: { echo: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background', 'management', 'request', 'attempt'] } },
    });
    const work = gate<string>();
    let receiverEndpoint!: RpcEndpointHandle;
    let receiverReleases = 0;
    let callerEndpoint!: RpcEndpointHandle;
    let callerReleases = 0;
    const receiverRuntime = new RpcServiceRuntime({ admit: () => ({ endpoint: receiverEndpoint, callee: null, release: () => { receiverReleases += 1; } }) });
    const callerRuntime = new RpcServiceRuntime({ admit: () => ({ endpoint: callerEndpoint, callee: null, release: () => { callerReleases += 1; } }) });
    const wire = makeWire();
    let sender!: PluginPeerRpcLink;
    let receiver!: PluginPeerRpcLink;
    let faulted = false;
    try {
      receiverEndpoint = receiverRuntime.register({
        provider: 'provider',
        contract,
        binding: { endpoint: 'receiver.endpoint', process: 'control', instance: 'receiver-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'provider' },
        handler: { echo: (input: string) => work.promise.then(() => input) },
      });
      receiverRuntime.markReady(receiverEndpoint);
      receiver = new PluginPeerRpcLink({
        credential,
        authority: AUTHORITY,
        outgoingDirection: 'control-to-peer',
        onRequest: (call) => {
          const input = decodeBody(call.body) as string;
          const tracked = receiverRuntime.invokeTracked({
            target: { provider: 'provider', service: contract.id, major: 1, method: 'echo' },
            caller: { subject: 'remote-peer', scope: 'global' },
            purpose: 'request',
            input,
            deadlineAt: call.deadlineAt,
          });
          return { result: tracked.result.then((output) => encodeBody(output)), terminal: tracked.terminal };
        },
      });
      sender = new PluginPeerRpcLink({ credential, authority: AUTHORITY, outgoingDirection: 'peer-to-control', onRequest: immediateHandler() });

      // The CALL reaches the receiver, then the transport throws: the real
      // outcome is unknown to the sender.
      const senderSend: PluginPeerRpcSendAdapter = (frame) => {
        if (!faulted) { faulted = true; receiver.receive(frame); throw new Error('transport fault after write'); }
        wire.state.leftToRight.push(Uint8Array.from(frame));
        return true;
      };
      sender.attach(senderSend);
      receiver.attach(wire.sendRight);

      callerEndpoint = callerRuntime.registerProxy({
        provider: 'consumer-provider',
        contract,
        binding: { endpoint: 'caller.endpoint', process: 'control', instance: 'caller-instance', generation: 1, catalog: 'unit-catalog', scope: 'global', subject: 'consumer' },
        execute: (proxyRequest) => {
          const call = sender.request({}, encodeBody(proxyRequest.input), { deadlineAt: proxyRequest.context.deadlineAt ?? Date.now() + 5_000, signal: proxyRequest.context.signal });
          return { result: call.result.then((bytes) => decodeBody(bytes)), terminal: call.terminal };
        },
      });
      callerRuntime.markReady(callerEndpoint);

      const tracked = callerRuntime.invokeTracked({
        target: { provider: 'consumer-provider', service: contract.id, major: 1, method: 'echo' },
        caller: { subject: 'consumer', scope: 'global' },
        purpose: 'request',
        input: 'late',
      });
      let resultError: RpcInvocationError | null = null;
      void tracked.result.catch((error: unknown) => { resultError = error as RpcInvocationError; });

      expect(receiverRuntime.status().active).toBe(1);
      expect(callerRuntime.status().active).toBe(1);
      expect(callerReleases).toBe(0); // lease held even though the send faulted
      await delay(0);
      expect((resultError as unknown as RpcInvocationError).code).toBe('failed'); // Queries report a safe host failure; commands use unknown.
      expect(callerReleases).toBe(0); // still held: no terminal proof yet

      work.resolve('late');
      await delay(0); // Finish the real receiver; keep its signed replies undelivered.
      sender.dispose();
      expect(callerReleases).toBe(0);
      await pump(wire.state, sender, receiver);
      await tracked.terminal;
      expect(receiverReleases).toBe(1);
      expect(callerReleases).toBe(1); // released only by the real terminal

      // The terminal and ACK crossed the draining link after dispose, not before it.
      await pump(wire.state, sender, receiver);
      expect(receiver.status().inboundReceipts).toBe(0);
      expect(sender.status().ackOutbox).toBe(0);
    } finally {
      await callerRuntime.dispose();
      await receiverRuntime.dispose();
      cleanup(sender, receiver);
    }
  });
});
