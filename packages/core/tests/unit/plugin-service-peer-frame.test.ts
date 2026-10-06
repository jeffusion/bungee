import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { encodeCanonicalRpcJson as canonicalJson } from '../../src/plugin-services/wire-contract';
import {
  PEER_BODY_MAX_BYTES,
  PEER_HEADER_MAX_BYTES,
  PluginPeerProtocolError,
  PluginPeerReplayWindow,
  createPluginPeerCredential,
  encodePluginPeerHeader,
  signPluginPeerPacket,
  verifyPluginPeerPacket,
  type PluginPeerCredential,
  type PluginPeerExpectation,
  type PluginPeerPacket,
  type PluginPeerProtocolErrorCode,
  type PluginPeerUnsignedFields,
} from '../../src/plugin-services/peer-protocol';
import {
  PEER_FRAME_MAX_BYTES,
  PEER_FRAME_PREFIX_BYTES,
  decodePluginPeerFrame,
  encodePluginPeerFrame,
} from '../../src/plugin-services/peer-frame';
import { deriveSupervisionProcessKey } from '../../src/supervision';

/**
 * Protocol-test fixtures only: a fixed root key derives real supervision keys,
 * which mint real peer credentials. None of this is production key material or
 * business data.
 */
const ROOT_KEY = new Uint8Array(32).fill(11);
const INSTANCE = '10000000-0000-4000-8000-0000000000f1';
const WORKER_ID = '20000000-0000-4000-8000-0000000000f1';
const INGRESS_ID = '20000000-0000-4000-8000-0000000000f2';
const BOOT = '30000000-0000-4000-8000-0000000000f1';
const BOOT_2 = '30000000-0000-4000-8000-0000000000f2';
const CONTROLLER = '40000000-0000-4000-8000-0000000000f1';

const workerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT),
);
const ingressCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'ingress', INGRESS_ID, BOOT_2),
);

const AUTHORITY = { controller_epoch: 7, controller_id: CONTROLLER } as const;

/** `"BPC1"` big-endian. */
const FRAME_MAGIC = 0x42504331;

function expectCode(action: () => unknown, code: PluginPeerProtocolErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginPeerProtocolError);
    expect((error as PluginPeerProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function baseFields(overrides: Record<string, unknown> = {}): PluginPeerUnsignedFields {
  return {
    direction: 'peer-to-control',
    authority: { ...AUTHORITY },
    sequence: 1,
    request_id: BOOT,
    lane: 'rpc',
    kind: 'request',
    deadline_at: 1_800_000_000_000,
    context: { plugin_id: WORKER_ID, purpose: 'request' },
    ...overrides,
  } as PluginPeerUnsignedFields;
}

function expectation(direction: 'peer-to-control' | 'control-to-peer' = 'peer-to-control'): PluginPeerExpectation {
  return { direction, authority: { ...AUTHORITY } };
}

function headerBytesOf(packet: PluginPeerPacket): Uint8Array {
  return new Uint8Array(Buffer.from(encodePluginPeerHeader(packet.header), 'base64url'));
}

/** Builds a frame prefix with declared lengths independent of the payload. */
function prefixFrame(headerLength: number, bodyLength: number, payload: Uint8Array, magic = FRAME_MAGIC): Uint8Array {
  const frame = new Uint8Array(PEER_FRAME_PREFIX_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, magic, false);
  view.setUint32(4, headerLength, false);
  view.setUint32(8, bodyLength, false);
  frame.set(payload, PEER_FRAME_PREFIX_BYTES);
  return frame;
}

/** Builds a structurally consistent frame from raw header/body bytes. */
function frameParts(headerBytes: Uint8Array, bodyBytes: Uint8Array): Uint8Array {
  const payload = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
  payload.set(headerBytes, 0);
  payload.set(bodyBytes, headerBytes.byteLength);
  return prefixFrame(headerBytes.byteLength, bodyBytes.byteLength, payload);
}

/**
 * Signs a packet whose canonical header is exactly {@link PEER_HEADER_MAX_BYTES}
 * bytes by padding the ASCII context, so the metadata budget can be exercised at
 * its true byte boundary.
 */
function signWithExactHeader(body: Uint8Array): PluginPeerPacket {
  const measure = signPluginPeerPacket(baseFields({ context: { pad: '' } }), new Uint8Array(), workerCredential);
  const pad = PEER_HEADER_MAX_BYTES - Buffer.byteLength(canonicalJson(measure.header), 'utf8');
  const packet = signPluginPeerPacket(baseFields({ context: { pad: 'a'.repeat(pad) } }), body, workerCredential);
  expect(Buffer.byteLength(canonicalJson(packet.header), 'utf8')).toBe(PEER_HEADER_MAX_BYTES);
  return packet;
}

describe('P4 plugin peer frame codec', () => {
  test('writes the frozen 12-byte prefix and measures the raw header bytes', () => {
    expect(PEER_FRAME_PREFIX_BYTES).toBe(12);
    expect(PEER_FRAME_MAX_BYTES).toBe(73740);
    expect(PEER_FRAME_MAX_BYTES).toBe(PEER_FRAME_PREFIX_BYTES + PEER_HEADER_MAX_BYTES + PEER_BODY_MAX_BYTES);

    const packet = signPluginPeerPacket(baseFields(), new Uint8Array([9, 8, 7]), workerCredential);
    const frame = encodePluginPeerFrame(packet);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(0, false)).toBe(FRAME_MAGIC);
    expect(String.fromCharCode(frame[0], frame[1], frame[2], frame[3])).toBe('BPC1');

    const headerBytes = headerBytesOf(packet);
    expect(view.getUint32(4, false)).toBe(headerBytes.byteLength);
    expect(view.getUint32(8, false)).toBe(3);
    expect(frame.byteLength).toBe(PEER_FRAME_PREFIX_BYTES + headerBytes.byteLength + 3);
    // The 8 KiB metadata budget is the raw JSON byte length, not the base64url text.
    expect(headerBytes.byteLength).toBe(Buffer.byteLength(canonicalJson(packet.header), 'utf8'));
    expect(encodePluginPeerHeader(packet.header).length).toBeGreaterThan(headerBytes.byteLength);
  });

  test('round-trips sign/encode/decode/verify for both peer roles', () => {
    for (const [credential, direction] of [
      [workerCredential, 'peer-to-control'],
      [ingressCredential, 'control-to-peer'],
    ] as const) {
      const packet = signPluginPeerPacket(
        baseFields({ direction }),
        new TextEncoder().encode('payload-好'),
        credential,
      );
      const decoded = decodePluginPeerFrame(encodePluginPeerFrame(packet));
      expect(canonicalJson(decoded.header)).toBe(canonicalJson(packet.header));
      expect(Array.from(decoded.body)).toEqual(Array.from(packet.body));
      expect(verifyPluginPeerPacket(decoded.header, decoded.body, credential, expectation(direction))).toBe(true);
    }
  });

  test('frames an exact 8 KiB header with an exact 64 KiB body in one 73740-byte message', () => {
    const packet = signWithExactHeader(new Uint8Array(PEER_BODY_MAX_BYTES).fill(7));
    const frame = encodePluginPeerFrame(packet);
    expect(frame.byteLength).toBe(PEER_FRAME_MAX_BYTES);
    const view = new DataView(frame.buffer);
    expect(view.getUint32(4, false)).toBe(PEER_HEADER_MAX_BYTES);
    expect(view.getUint32(8, false)).toBe(PEER_BODY_MAX_BYTES);

    const decoded = decodePluginPeerFrame(frame);
    expect(decoded.body.byteLength).toBe(PEER_BODY_MAX_BYTES);
    expect(Array.from(decoded.body.subarray(0, 1))).toEqual([7]);
    expect(verifyPluginPeerPacket(decoded.header, decoded.body, workerCredential, expectation())).toBe(true);
  });

  test('rejects an over-budget header or body at encode time', () => {
    const maxHeader = signWithExactHeader(new Uint8Array());
    const overHeader = JSON.parse(JSON.stringify(maxHeader.header));
    overHeader.context.pad = `${overHeader.context.pad}a`;
    expectCode(() => encodePluginPeerFrame({ header: overHeader, body: new Uint8Array() }), 'size_limit');
    expectCode(
      () => encodePluginPeerFrame({ header: maxHeader.header, body: new Uint8Array(PEER_BODY_MAX_BYTES + 1) }),
      'size_limit',
    );
  });

  test('rejects oversized declared lengths before parsing or allocating', () => {
    expectCode(() => decodePluginPeerFrame(prefixFrame(PEER_HEADER_MAX_BYTES + 1, 0, new Uint8Array())), 'size_limit');
    expectCode(() => decodePluginPeerFrame(prefixFrame(1, PEER_BODY_MAX_BYTES + 1, new Uint8Array())), 'size_limit');
    expectCode(() => decodePluginPeerFrame(prefixFrame(0xffffffff, 0, new Uint8Array())), 'size_limit');
    expectCode(() => decodePluginPeerFrame(prefixFrame(1, 0xffffffff, new Uint8Array())), 'size_limit');

    const frame = encodePluginPeerFrame(signWithExactHeader(new Uint8Array(PEER_BODY_MAX_BYTES)));
    const overloaded = new Uint8Array(frame.byteLength + 1);
    overloaded.set(frame);
    expectCode(() => decodePluginPeerFrame(overloaded), 'size_limit');
  });

  test('rejects bad magic, an empty header, truncation, and trailing bytes', () => {
    const packet = signPluginPeerPacket(baseFields(), new Uint8Array([1, 2, 3]), workerCredential);
    const frame = encodePluginPeerFrame(packet);

    const badMagic = Uint8Array.from(frame);
    badMagic[0] = 0x43;
    expectCode(() => decodePluginPeerFrame(badMagic), 'malformed_message');
    expectCode(() => decodePluginPeerFrame(prefixFrame(0, 0, new Uint8Array())), 'malformed_message');
    expectCode(() => decodePluginPeerFrame(frame.subarray(0, frame.byteLength - 1)), 'malformed_message');

    const suffixed = new Uint8Array(frame.byteLength + 1);
    suffixed.set(frame);
    expectCode(() => decodePluginPeerFrame(suffixed), 'malformed_message');

    for (const length of [0, 1, PEER_FRAME_PREFIX_BYTES - 1]) {
      expectCode(() => decodePluginPeerFrame(new Uint8Array(length)), 'malformed_message');
    }
    // Declared lengths that do not sum to the actual buffer.
    expectCode(() => decodePluginPeerFrame(prefixFrame(50, 0, new Uint8Array(10))), 'malformed_message');
  });

  test('honours byteOffset/byteLength and accepts an exact ArrayBuffer', () => {
    const packet = signPluginPeerPacket(baseFields(), new Uint8Array([5, 6]), workerCredential);
    const frame = encodePluginPeerFrame(packet);

    const padded = new Uint8Array(frame.byteLength + 6);
    padded.set(frame, 4);
    expect(Array.from(decodePluginPeerFrame(padded.subarray(4, 4 + frame.byteLength)).body)).toEqual([5, 6]);
    // `encodePluginPeerFrame` always allocates a fresh, exactly sized ArrayBuffer.
    expect(Array.from(decodePluginPeerFrame(frame.buffer as ArrayBuffer).body)).toEqual([5, 6]);
    // The same bytes read from the wrong offset are not a frame.
    expectCode(() => decodePluginPeerFrame(padded.buffer), 'malformed_message');
  });

  test('rejects header bytes that are not strict canonical UTF-8 JSON', () => {
    expectCode(() => decodePluginPeerFrame(frameParts(new Uint8Array([0xff]), new Uint8Array())), 'malformed_message');

    const packet = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential);
    const spaced = new TextEncoder().encode(canonicalJson(packet.header).replace('"protocol":', '"protocol": '));
    expectCode(() => decodePluginPeerFrame(frameParts(spaced, new Uint8Array())), 'malformed_message');
    expectCode(
      () => decodePluginPeerFrame(frameParts(new TextEncoder().encode('{}'), new Uint8Array())),
      'malformed_message',
    );
  });

  test('structural acceptance is never authentication', () => {
    const packet = signPluginPeerPacket(baseFields({ sequence: 3 }), new Uint8Array([1, 2, 3]), workerCredential);

    const tamperedBody = decodePluginPeerFrame(frameParts(headerBytesOf(packet), new Uint8Array([1, 2, 4])));
    expect(Array.from(tamperedBody.body)).toEqual([1, 2, 4]);
    expectCode(
      () => verifyPluginPeerPacket(tamperedBody.header, tamperedBody.body, workerCredential, expectation()),
      'authentication_failed',
    );
    // Direction and authority are still checked, and structure cannot vouch for them.
    expectCode(
      () => verifyPluginPeerPacket(tamperedBody.header, tamperedBody.body, workerCredential, expectation('control-to-peer')),
      'direction_mismatch',
    );

    const rawHeader = JSON.parse(JSON.stringify(packet.header));
    rawHeader.sequence = 4;
    const tamperedHeader = decodePluginPeerFrame(
      frameParts(new TextEncoder().encode(canonicalJson(rawHeader)), packet.body),
    );
    expect(tamperedHeader.header.sequence).toBe(4);
    expectCode(
      () => verifyPluginPeerPacket(tamperedHeader.header, tamperedHeader.body, workerCredential, expectation()),
      'authentication_failed',
    );
  });

  test('keeps encoded and decoded payloads independent of later caller mutation', () => {
    const first = signPluginPeerPacket(baseFields(), new Uint8Array([1, 2, 3]), workerCredential);
    const frame = encodePluginPeerFrame(first);
    const snapshot = Uint8Array.from(frame);
    first.body.fill(9);
    expect(Array.from(frame)).toEqual(Array.from(snapshot));
    expect(Array.from(decodePluginPeerFrame(snapshot).body)).toEqual([1, 2, 3]);

    const second = signPluginPeerPacket(baseFields(), new Uint8Array([4, 5, 6]), workerCredential);
    const source = encodePluginPeerFrame(second);
    const decoded = decodePluginPeerFrame(source);
    expect(Object.isFrozen(decoded)).toBe(true);
    source.fill(0);
    expect(Array.from(decoded.body)).toEqual([4, 5, 6]);
    expect(canonicalJson(decoded.header)).toBe(canonicalJson(second.header));
    expect(decoded.body.buffer).not.toBe(source.buffer);
  });

  test('rejects non-binary input with a fixed payload-free error', () => {
    const inputs: unknown[] = ['BPC1', 42, null, undefined, {}, new DataView(new ArrayBuffer(PEER_FRAME_PREFIX_BYTES))];
    for (const input of inputs) {
      try {
        decodePluginPeerFrame(input as never);
        throw new Error('expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(PluginPeerProtocolError);
        expect((error as PluginPeerProtocolError).code).toBe('malformed_message');
        expect((error as Error).message).toBe('peer frame must be binary');
        expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Real loopback WebSocket acceptance: one bounded binary frame per message,
// both sides decode + verify with an exact direction/authority, and the maximum
// 8 KiB header + 64 KiB body frame is never truncated by the transport.
// ---------------------------------------------------------------------------

type FrameConnectionData = { readonly replay: PluginPeerReplayWindow };

const UPLINK_AUTHORITY = { controller_epoch: 7, controller_id: CONTROLLER } as const;
const UPLINK_EXPECTATION: PluginPeerExpectation = { direction: 'peer-to-control', authority: { ...UPLINK_AUTHORITY } };
const SOCKET_TIMEOUT_MS = 6000;

let server: Server<FrameConnectionData> | undefined;
let serverError: Error | null = null;

/** Signs the control-to-peer reply, padded to the exact metadata budget. */
function signReply(request: PluginPeerPacket, body: Uint8Array): PluginPeerPacket {
  const fields = {
    direction: 'control-to-peer' as const,
    authority: request.header.authority,
    sequence: request.header.sequence,
    request_id: request.header.request_id,
    lane: 'rpc' as const,
    kind: 'response' as const,
    deadline_at: request.header.deadline_at,
    context: { reply_to: request.header.request_id },
  };
  const measure = signPluginPeerPacket({ ...fields, context: { ...fields.context, pad: '' } }, body, workerCredential);
  const pad = PEER_HEADER_MAX_BYTES - Buffer.byteLength(canonicalJson(measure.header), 'utf8');
  return signPluginPeerPacket({ ...fields, context: { ...fields.context, pad: 'a'.repeat(pad) } }, body, workerCredential);
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), SOCKET_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function toBinary(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new Error('unexpected WebSocket payload type');
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let cleanup = () => {};
  const opened = new Promise<WebSocket>((resolve, reject) => {
    const onOpen = () => resolve(socket);
    const onError = () => reject(new Error('WebSocket failed to open'));
    cleanup = () => { socket.removeEventListener('open', onOpen); socket.removeEventListener('error', onError); };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
  return withTimeout(opened, 'socket open').catch(error => { socket.close(); throw error; }).finally(() => cleanup());
}

function nextFrame(socket: WebSocket): Promise<Uint8Array> {
  let removeListeners = () => {};
  const pending = new Promise<Uint8Array>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      cleanup();
      try { resolve(toBinary(event.data)); } catch (error) { reject(error); }
    };
    const onClose = () => {
      cleanup();
      reject(new Error('socket closed before a frame arrived'));
    };
    const onError = () => {
      cleanup();
      reject(new Error('socket errored before a frame arrived'));
    };
    const cleanup = () => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    removeListeners = cleanup;
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
  });
  return withTimeout(pending, 'signed reply frame').finally(() => removeListeners());
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return withTimeout(new Promise<void>((resolve) => {
    socket.addEventListener('close', () => resolve(), { once: true });
  }), 'socket close');
}

describe('P4 plugin peer frame loopback WebSocket', () => {
  beforeAll(() => {
    server = Bun.serve<FrameConnectionData>({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, srv) {
        if (srv.upgrade(request, { data: { replay: new PluginPeerReplayWindow() } })) return undefined;
        return new Response('peer frame channel requires a WebSocket upgrade', { status: 426 });
      },
      websocket: {
        maxPayloadLength: PEER_FRAME_MAX_BYTES,
        open() {},
        drain() {},
        close() {},
        message(ws, message) {
          try {
            if (typeof message === 'string') throw new Error('peer frame channel received a text message');
            const packet = decodePluginPeerFrame(new Uint8Array(message));
            verifyPluginPeerPacket(packet.header, packet.body, workerCredential, UPLINK_EXPECTATION);
            ws.data.replay.accept(packet.header.sequence);
            ws.send(encodePluginPeerFrame(signReply(packet, packet.body)));
          } catch (error) {
            serverError = error instanceof Error ? error : new Error(String(error));
            ws.close(1011, 'peer frame rejected');
          }
        },
      },
    });
  });

  afterAll(async () => {
    await server?.stop(true);
  });

  beforeEach(() => {
    serverError = null;
  });

  function serverUrl(): string {
    if (server === undefined) throw new Error('peer frame test server is not running');
    return `ws://127.0.0.1:${server.port}/`;
  }

  test('round-trips a signed request and a signed reply over a real loopback socket', async () => {
    const socket = await openSocket(serverUrl());
    try {
      const request = signPluginPeerPacket(baseFields({ sequence: 1 }), new Uint8Array([1, 2, 3, 4]), workerCredential);
      const pending = nextFrame(socket);
      socket.send(encodePluginPeerFrame(request));
      const reply = decodePluginPeerFrame(await pending);

      expect(reply.header.direction).toBe('control-to-peer');
      expect(reply.header.authority).toEqual(UPLINK_AUTHORITY);
      expect(reply.header.kind).toBe('response');
      expect(Array.from(reply.body)).toEqual([1, 2, 3, 4]);
      expect(verifyPluginPeerPacket(reply.header, reply.body, workerCredential, {
        direction: 'control-to-peer',
        authority: { ...UPLINK_AUTHORITY },
      })).toBe(true);
      expect(serverError).toBeNull();
    } finally {
      socket.close();
      await waitForClose(socket);
    }
  }, 15000);

  test('carries an exact 8 KiB header and an exact 64 KiB body in both directions', async () => {
    const socket = await openSocket(serverUrl());
    try {
      const request = signWithExactHeader(new Uint8Array(PEER_BODY_MAX_BYTES).fill(3));
      const requestFrame = encodePluginPeerFrame(request);
      expect(requestFrame.byteLength).toBe(PEER_FRAME_MAX_BYTES);

      const pending = nextFrame(socket);
      socket.send(requestFrame);
      const replyFrame = await pending;
      expect(replyFrame.byteLength).toBe(PEER_FRAME_MAX_BYTES);

      const reply = decodePluginPeerFrame(replyFrame);
      expect(reply.header.direction).toBe('control-to-peer');
      expect(reply.body.byteLength).toBe(PEER_BODY_MAX_BYTES);
      expect(reply.header.body_hash).toBe(request.header.body_hash);
      expect(verifyPluginPeerPacket(reply.header, reply.body, workerCredential, {
        direction: 'control-to-peer',
        authority: { ...UPLINK_AUTHORITY },
      })).toBe(true);
      expect(serverError).toBeNull();
    } finally {
      socket.close();
      await waitForClose(socket);
    }
  }, 15000);

  test('rejects a structurally valid but unauthenticated frame over the socket', async () => {
    const socket = await openSocket(serverUrl());
    try {
      const packet = signPluginPeerPacket(baseFields(), new Uint8Array([1, 2, 3]), workerCredential);
      const pending = nextFrame(socket);
      socket.send(frameParts(headerBytesOf(packet), new Uint8Array([1, 2, 4])));
      await expect(pending).rejects.toThrow('socket closed before a frame arrived');
      expect(serverError).toBeInstanceOf(PluginPeerProtocolError);
      expect((serverError as PluginPeerProtocolError).code).toBe('authentication_failed');
    } finally {
      socket.close();
      await waitForClose(socket);
    }
  }, 15000);
});
