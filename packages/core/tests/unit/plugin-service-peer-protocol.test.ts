import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { encodeCanonicalRpcJson as canonicalJson } from '../../src/plugin-services/wire-contract';
import { deriveSupervisionProcessKey } from '../../src/supervision';
import {
  PEER_BODY_MAX_BYTES,
  PEER_HEADER_MAX_BASE64URL_CHARS,
  PEER_HEADER_MAX_BYTES,
  PEER_PROTOCOL,
  PEER_REPLAY_WINDOW_DEFAULT_CAPACITY,
  PluginPeerProtocolError,
  PluginPeerReplayWindow,
  createPluginPeerCredential,
  decodePluginPeerHeader,
  encodePluginPeerHeader,
  hashPluginPeerBody,
  parsePluginPeerHeader,
  signPluginPeerPacket,
  verifyPluginPeerPacket,
  type PluginPeerCredential,
  type PluginPeerHeader,
  type PluginPeerProtocolErrorCode,
  type PluginPeerUnsignedFields,
} from '../../src/plugin-services/peer-protocol';

const ROOT_KEY = new Uint8Array(32).fill(9);
const INSTANCE = '10000000-0000-4000-8000-000000000001';
const WORKER_ID = '20000000-0000-4000-8000-000000000001';
const INGRESS_ID = '20000000-0000-4000-8000-000000000002';
const BOOT = '30000000-0000-4000-8000-000000000001';
const BOOT_2 = '30000000-0000-4000-8000-000000000002';
const CONTROLLER = '40000000-0000-4000-8000-000000000001';
const OTHER = '50000000-0000-4000-8000-000000000001';
const PEER_KEY_DOMAIN = 'bungee-plugin-communication/v1/peer-key';

const workerSupervision = deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT);
const ingressSupervision = deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'ingress', INGRESS_ID, BOOT_2);
const workerCredential = createPluginPeerCredential(workerSupervision);
const ingressCredential = createPluginPeerCredential(ingressSupervision);

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
    authority: { controller_epoch: 7, controller_id: CONTROLLER },
    sequence: 1,
    request_id: BOOT,
    lane: 'rpc',
    kind: 'request',
    deadline_at: 1_800_000_000_000,
    context: { plugin_id: WORKER_ID, purpose: 'request' },
    ...overrides,
  } as PluginPeerUnsignedFields;
}

function rawSupervision(role: 'worker' | 'ingress' = 'worker', keyByte = 5) {
  return {
    identity: { role, process_instance_id: role === 'worker' ? WORKER_ID : INGRESS_ID, boot_nonce: BOOT },
    process_key: new Uint8Array(32).fill(keyByte),
  };
}

function expectation(direction: 'peer-to-control' | 'control-to-peer' = 'peer-to-control') {
  return { direction, authority: { controller_epoch: 7, controller_id: CONTROLLER } };
}

describe('P4 plugin peer protocol leaf', () => {
  test('all legal RPC property names round-trip without configuration restrictions or prototype mutation', () => {
    const context = JSON.parse('{"privateMetadata":{"constructor":1,"prototype":2,"__proto__":{"polluted":true}},"10":"ten","2":"two"}');
    const packet = signPluginPeerPacket(baseFields({ context }), new Uint8Array([1]), workerCredential);
    const parsed = parsePluginPeerHeader(packet.header);
    const decoded = decodePluginPeerHeader(encodePluginPeerHeader(parsed));
    expect(decoded.context).toEqual(context);
    expect(verifyPluginPeerPacket(decoded, packet.body, workerCredential, expectation())).toBe(true);
    expect(Object.prototype.hasOwnProperty.call((decoded.context as Record<string, any>).privateMetadata, '__proto__')).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(canonicalJson(JSON.parse('{"2":2,"10":10,"constructor":1}'))).toBe('{"10":10,"2":2,"constructor":1}');
  });

  test('round-trips sign/encode/decode/verify for both directions and deep-freezes', () => {
    for (const [credential, direction] of [
      [workerCredential, 'peer-to-control'],
      [ingressCredential, 'control-to-peer'],
    ] as const) {
      const packet = signPluginPeerPacket(baseFields({ direction }), new Uint8Array([1, 2, 3]), credential);
      expect(packet.header.protocol).toBe(PEER_PROTOCOL);
      expect(packet.header.peer).toEqual(credential.identity);
      expect(Object.isFrozen(packet.header)).toBe(true);
      expect(Object.isFrozen(packet.header.peer)).toBe(true);
      expect(Object.isFrozen(packet.header.authority)).toBe(true);
      expect(Object.isFrozen(packet.header.context)).toBe(true);

      const encoded = encodePluginPeerHeader(packet.header);
      const decoded = decodePluginPeerHeader(encoded);
      expect(canonicalJson(decoded)).toBe(canonicalJson(packet.header));
      expect(Object.isFrozen(decoded)).toBe(true);
      expect(verifyPluginPeerPacket(decoded, packet.body, credential, expectation(direction))).toBe(true);
      expect(verifyPluginPeerPacket(encoded, packet.body, credential, expectation(direction))).toBe(true);
    }
  });

  test('hashes the exact raw body bytes and keeps a byte-exact frozen context clone', () => {
    const body = new Uint8Array([0, 255, 10, 0, 66]);
    const context = { label: '抓包-好', nested: [1, 2, { ok: true }], empty: null };
    const packet = signPluginPeerPacket(baseFields({ context }), body, workerCredential);
    expect(packet.header.body_hash).toBe(hashPluginPeerBody(body));
    expect(canonicalJson(packet.header.context)).toBe(canonicalJson(context));
    const frozenContext = packet.header.context as unknown as { nested: unknown[] };
    expect(Object.isFrozen(frozenContext.nested)).toBe(true);
    expect(verifyPluginPeerPacket(packet.header, packet.body, workerCredential, expectation())).toBe(true);
  });

  test('rejects bare or cloned credential objects (WeakMap brand)', () => {
    const packet = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential);
    const bare = { identity: workerSupervision.identity } as unknown as PluginPeerCredential;
    const clone = { ...workerCredential } as PluginPeerCredential;
    expectCode(() => signPluginPeerPacket(baseFields(), new Uint8Array(), bare), 'invalid_credential');
    expectCode(() => verifyPluginPeerPacket(packet.header, packet.body, bare, expectation()), 'invalid_credential');
    expectCode(() => verifyPluginPeerPacket(packet.header, packet.body, clone, expectation()), 'invalid_credential');
  });

  test('mints credentials only for role/uuid/32-byte-key valid supervision credentials', () => {
    expect(Object.isFrozen(workerCredential)).toBe(true);
    expectCode(
      () => createPluginPeerCredential({ ...rawSupervision('worker'), process_key: new Uint8Array(16) }),
      'invalid_credential',
    );
    expectCode(
      () => createPluginPeerCredential({
        identity: { role: 'worker', process_instance_id: 'not-a-uuid', boot_nonce: BOOT },
        process_key: new Uint8Array(32),
      } as never),
      'invalid_credential',
    );
    expectCode(
      () => createPluginPeerCredential({
        identity: { role: 'admin', process_instance_id: WORKER_ID, boot_nonce: BOOT },
        process_key: new Uint8Array(32),
      } as never),
      'invalid_credential',
    );
  });

  test('derived key snapshot survives caller mutation of the supervision key', () => {
    const supervision = rawSupervision('worker', 7);
    const credential = createPluginPeerCredential(supervision);
    const first = signPluginPeerPacket(baseFields(), new Uint8Array([9]), credential);
    supervision.process_key.fill(0);
    const second = signPluginPeerPacket(baseFields(), new Uint8Array([9]), credential);
    expect(second.header.mac).toBe(first.header.mac);
    expect(verifyPluginPeerPacket(first.header, first.body, credential, expectation())).toBe(true);
  });

  test('signing snapshot ignores later mutation of the caller body and signed fields', () => {
    const body = new Uint8Array([1, 2, 3]);
    const context = { purpose: 'request' };
    const fields = baseFields({ context });
    const packet = signPluginPeerPacket(fields, body, workerCredential);
    const frozenHeader = packet.header;
    body.fill(9);
    context.purpose = 'tampered';
    (fields as { sequence: number }).sequence = 99;
    expect(Array.from(packet.body)).toEqual([1, 2, 3]);
    const frozenContext = frozenHeader.context as unknown as { purpose: string };
    expect(frozenContext.purpose).toBe('request');
    expect(frozenHeader.sequence).toBe(1);
    expect(verifyPluginPeerPacket(frozenHeader, packet.body, workerCredential, expectation())).toBe(true);
    expect(() => {
      (frozenHeader as { sequence: number }).sequence = 100;
    }).toThrow();
  });

  test('rejects tampering of every signed field and the body', () => {
    const body = new Uint8Array([7, 7, 7]);
    const packet = signPluginPeerPacket(baseFields(), body, workerCredential);
    const raw = () => JSON.parse(JSON.stringify(packet.header)) as Record<string, any>;
    const tampered: Array<[(value: Record<string, any>) => void, PluginPeerProtocolErrorCode]> = [
      [(value) => { value.direction = 'control-to-peer'; }, 'direction_mismatch'],
      [(value) => { value.authority.controller_epoch = 8; }, 'authority_mismatch'],
      [(value) => { value.authority.controller_id = OTHER; }, 'authority_mismatch'],
      [(value) => { value.peer.process_instance_id = OTHER; }, 'identity_mismatch'],
      [(value) => { value.peer.boot_nonce = OTHER; }, 'identity_mismatch'],
      [(value) => { value.peer.role = 'ingress'; }, 'identity_mismatch'],
      [(value) => { value.sequence = 2; }, 'authentication_failed'],
      [(value) => { value.request_id = OTHER; }, 'authentication_failed'],
      [(value) => { value.lane = 'stream'; }, 'authentication_failed'],
      [(value) => { value.kind = 'cancel'; }, 'authentication_failed'],
      [(value) => { value.deadline_at = value.deadline_at + 1; }, 'authentication_failed'],
      [(value) => { value.context = { purpose: 'other' }; }, 'authentication_failed'],
      [(value) => { value.body_hash = hashPluginPeerBody(new Uint8Array([8])); }, 'authentication_failed'],
      [(value) => { value.mac = `hmac-sha256:${'0'.repeat(64)}`; }, 'authentication_failed'],
    ];
    for (const [mutate, code] of tampered) {
      const value = raw();
      mutate(value);
      expectCode(() => verifyPluginPeerPacket(value, packet.body, workerCredential, expectation()), code);
    }
    expectCode(
      () => verifyPluginPeerPacket(packet.header, new Uint8Array([7, 7, 8]), workerCredential, expectation()),
      'authentication_failed',
    );
  });

  test('distinguishes wrong direction, authority, peer identity, and key', () => {
    const packet = signPluginPeerPacket(baseFields(), new Uint8Array([4]), workerCredential);
    expectCode(
      () => verifyPluginPeerPacket(packet.header, packet.body, workerCredential, expectation('control-to-peer')),
      'direction_mismatch',
    );
    expectCode(
      () => verifyPluginPeerPacket(packet.header, packet.body, workerCredential, {
        direction: 'peer-to-control',
        authority: { controller_epoch: 8, controller_id: CONTROLLER },
      }),
      'authority_mismatch',
    );
    expectCode(
      () => verifyPluginPeerPacket(packet.header, packet.body, ingressCredential, expectation()),
      'identity_mismatch',
    );
    const sameIdentityOtherKey = createPluginPeerCredential(rawSupervision('worker', 8));
    expectCode(
      () => verifyPluginPeerPacket(packet.header, packet.body, sameIdentityOtherKey, expectation()),
      'authentication_failed',
    );
  });

  test('isolates domains from supervision and the old plugin-control derivation', () => {
    const packet = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential);
    const { mac, ...unsigned } = packet.header;
    const identity = workerSupervision.identity;
    const derived = new Uint8Array(createHmac('sha256', workerSupervision.process_key as Uint8Array)
      .update(`${PEER_KEY_DOMAIN}\0${canonicalJson(identity)}`, 'utf8').digest());
    const expected = createHmac('sha256', derived).update(canonicalJson(unsigned), 'utf8').digest('hex');
    expect(mac).toBe(`hmac-sha256:${expected}`);
    const supervisionDirect = createHmac('sha256', workerSupervision.process_key as Uint8Array)
      .update(canonicalJson(unsigned), 'utf8').digest('hex');
    expect(mac).not.toBe(`hmac-sha256:${supervisionDirect}`);
    expectCode(
      () => verifyPluginPeerPacket(packet.header, packet.body, workerSupervision as unknown as PluginPeerCredential, expectation()),
      'invalid_credential',
    );
  });

  test('rejects extra, missing, or wrongly typed header fields', () => {
    const header = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential).header;
    const raw = () => JSON.parse(JSON.stringify(header)) as Record<string, any>;
    expectCode(() => parsePluginPeerHeader({ ...raw(), extra: 1 }), 'malformed_message');
    const missing = raw();
    delete missing.mac;
    expectCode(() => parsePluginPeerHeader(missing), 'malformed_message');
    expectCode(() => parsePluginPeerHeader(null), 'malformed_message');
    expectCode(() => parsePluginPeerHeader([raw()]), 'malformed_message');
    const protocol = raw();
    protocol.protocol = 'bungee-plugin-communication/v2';
    expectCode(() => parsePluginPeerHeader(protocol), 'unsupported_protocol');
    const uuid = raw();
    uuid.request_id = 'NOT-A-UUID';
    expectCode(() => parsePluginPeerHeader(uuid), 'malformed_message');
    const sequence = raw();
    sequence.sequence = 0;
    expectCode(() => parsePluginPeerHeader(sequence), 'malformed_message');
    const deadline = raw();
    deadline.deadline_at = 0;
    expectCode(() => parsePluginPeerHeader(deadline), 'malformed_message');
    const lane = raw();
    lane.lane = 'bogus';
    expectCode(() => parsePluginPeerHeader(lane), 'malformed_message');
    const bodyHash = raw();
    bodyHash.body_hash = 'sha256:zzzz';
    expectCode(() => parsePluginPeerHeader(bodyHash), 'malformed_message');
    const authority = raw();
    authority.authority.controller_epoch = -1;
    expectCode(() => parsePluginPeerHeader(authority), 'malformed_message');
  });

  test('rejects unsafe JSON, symbols, cycles, and never triggers getters', () => {
    const header = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential).header;
    const raw = () => JSON.parse(JSON.stringify(header)) as Record<string, any>;
    const getter = raw();
    let triggered = false;
    Object.defineProperty(getter, 'context', {
      enumerable: true,
      get() {
        triggered = true;
        return {};
      },
    });
    expectCode(() => parsePluginPeerHeader(getter), 'malformed_message');
    expect(triggered).toBe(false);

    const symbol = raw();
    (symbol as any)[Symbol('hidden')] = 1;
    expectCode(() => parsePluginPeerHeader(symbol), 'malformed_message');

    const cycle = raw();
    cycle.context = {};
    cycle.context.self = cycle.context;
    expectCode(() => parsePluginPeerHeader(cycle), 'malformed_message');

    for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, 1n, () => undefined, undefined]) {
      const value = raw();
      value.context = { unsafe };
      expectCode(() => parsePluginPeerHeader(value), 'malformed_message');
    }

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 70; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    const deepHeader = raw();
    deepHeader.context = deep;
    expectCode(() => parsePluginPeerHeader(deepHeader), 'malformed_message');
  });

  test('accepts an exact 64 KiB body frame, rejects +1, and keeps the header budget independent', () => {
    const full = new Uint8Array(PEER_BODY_MAX_BYTES);
    const packet = signPluginPeerPacket(
      baseFields({ context: { note: 'x'.repeat(512) } }),
      full,
      workerCredential,
    );
    expect(packet.body.byteLength).toBe(PEER_BODY_MAX_BYTES);
    expect(verifyPluginPeerPacket(packet.header, packet.body, workerCredential, expectation())).toBe(true);
    expect(Buffer.byteLength(canonicalJson(packet.header), 'utf8')).toBeLessThanOrEqual(PEER_HEADER_MAX_BYTES);

    const over = new Uint8Array(PEER_BODY_MAX_BYTES + 1);
    expectCode(() => signPluginPeerPacket(baseFields(), over, workerCredential), 'size_limit');
    expectCode(() => hashPluginPeerBody(over), 'size_limit');
    expectCode(() => verifyPluginPeerPacket(packet.header, over, workerCredential, expectation()), 'size_limit');
  });

  test('measures the 8 KiB header boundary in UTF-8 bytes, not JavaScript length', () => {
    const base = signPluginPeerPacket(baseFields({ context: { pad: '' } }), new Uint8Array(), workerCredential).header;
    const padding = PEER_HEADER_MAX_BYTES - Buffer.byteLength(canonicalJson(base), 'utf8');
    expect(padding).toBeGreaterThan(0);
    const exact = signPluginPeerPacket(baseFields({ context: { pad: 'a'.repeat(padding) } }), new Uint8Array(), workerCredential).header;
    expect(Buffer.byteLength(canonicalJson(exact), 'utf8')).toBe(PEER_HEADER_MAX_BYTES);
    expect(() => decodePluginPeerHeader(encodePluginPeerHeader(exact))).not.toThrow();
    expectCode(
      () => signPluginPeerPacket(baseFields({ context: { pad: 'a'.repeat(padding + 1) } }), new Uint8Array(), workerCredential),
      'size_limit',
    );

    const multibyte = '好'.repeat(2731);
    expect(multibyte.length).toBeLessThan(PEER_HEADER_MAX_BYTES);
    expectCode(
      () => signPluginPeerPacket(baseFields({ context: { pad: multibyte } }), new Uint8Array(), workerCredential),
      'size_limit',
    );
  });

  test('rejects non-canonical base64url, padding, whitespace, bad UTF-8, and oversized input', () => {
    const header = signPluginPeerPacket(baseFields(), new Uint8Array(), workerCredential).header;
    const encoded = encodePluginPeerHeader(header);
    expectCode(() => decodePluginPeerHeader('YR'), 'malformed_message');
    expectCode(() => decodePluginPeerHeader(`${encoded}=`), 'malformed_message');
    expectCode(() => decodePluginPeerHeader(`\n${encoded}`), 'malformed_message');
    expectCode(() => decodePluginPeerHeader(Buffer.from([0xff]).toString('base64url')), 'malformed_message');
    expectCode(() => decodePluginPeerHeader(Buffer.from('hello', 'utf8').toString('base64url')), 'malformed_message');
    expectCode(
      () => decodePluginPeerHeader(Buffer.from(`${canonicalJson(header)} `, 'utf8').toString('base64url')),
      'malformed_message',
    );
    expectCode(
      () => decodePluginPeerHeader('A'.repeat(PEER_HEADER_MAX_BASE64URL_CHARS + 1)),
      'size_limit',
    );
  });

  test('verification errors carry no cause and do not leak the body', () => {
    const secret = new TextEncoder().encode('SUPERSECRET');
    const packet = signPluginPeerPacket(baseFields(), secret, workerCredential);
    const tampered = JSON.parse(JSON.stringify(packet.header)) as Record<string, any>;
    tampered.mac = `hmac-sha256:${'0'.repeat(64)}`;
    try {
      verifyPluginPeerPacket(tampered, secret, workerCredential, expectation());
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginPeerProtocolError);
      expect((error as PluginPeerProtocolError).code).toBe('authentication_failed');
      expect((error as Error).message).not.toContain('SUPERSECRET');
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  test('does not treat an elapsed deadline as a verification failure', () => {
    const packet = signPluginPeerPacket(baseFields({ deadline_at: 1 }), new Uint8Array(), workerCredential);
    expect(verifyPluginPeerPacket(packet.header, packet.body, workerCredential, expectation())).toBe(true);
  });

  test('replay window accepts in-window reordering and rejects duplicates and old sequences', () => {
    const window = new PluginPeerReplayWindow();
    expect(window.capacity).toBe(PEER_REPLAY_WINDOW_DEFAULT_CAPACITY);
    window.accept(1);
    window.accept(3);
    window.accept(2);
    expect(window.highestAccepted).toBe(3);
    expectCode(() => window.accept(2), 'replayed');
    expectCode(() => window.accept(0), 'malformed_message');
    expectCode(() => window.accept(1.5), 'malformed_message');
    expect(window.windowSize).toBeLessThanOrEqual(PEER_REPLAY_WINDOW_DEFAULT_CAPACITY);
  });

  test('replay window prunes on a large jump and never grows past capacity', () => {
    const window = new PluginPeerReplayWindow({ capacity: 4 });
    for (const sequence of [1, 2, 3, 4]) window.accept(sequence);
    window.accept(10);
    expect(window.windowSize).toBe(1);
    expectCode(() => window.accept(6), 'replayed');
    window.accept(7);
    expectCode(() => window.accept(10), 'replayed');
    window.accept(11);
    expect(window.windowSize).toBeLessThanOrEqual(4);
  });

  test('replay window validates capacity and keeps windows independent', () => {
    expectCode(() => new PluginPeerReplayWindow({ capacity: 0 }), 'malformed_message');
    expectCode(() => new PluginPeerReplayWindow({ capacity: 4097 }), 'malformed_message');
    expectCode(() => new PluginPeerReplayWindow({ capacity: 1.5 }), 'malformed_message');
    const left = new PluginPeerReplayWindow({ capacity: 8 });
    const right = new PluginPeerReplayWindow({ capacity: 8 });
    left.accept(5);
    expect(right.highestAccepted).toBe(0);
    right.accept(5);
    expectCode(() => left.accept(5), 'replayed');
    expect(left.windowSize).toBe(1);
  });

  test('parse and encode are pure: they neither mutate nor leak the input header', () => {
    const packet = signPluginPeerPacket(baseFields({ context: { deep: { value: 1 } } }), new Uint8Array([1]), workerCredential);
    const snapshot = canonicalJson(packet.header);
    const parsed = parsePluginPeerHeader(packet.header);
    expect(canonicalJson(parsed)).toBe(snapshot);
    expect(canonicalJson(packet.header)).toBe(snapshot);
    const encoded = encodePluginPeerHeader(packet.header);
    expect(canonicalJson(packet.header)).toBe(snapshot);
    expect(decodePluginPeerHeader(encoded).body_hash).toBe(packet.header.body_hash);
    expect((parsed as PluginPeerHeader).protocol).toBe(PEER_PROTOCOL);
  });
});
