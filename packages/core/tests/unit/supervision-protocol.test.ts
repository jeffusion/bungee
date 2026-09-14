import { describe, expect, test } from 'bun:test';
import {
  acceptAttach,
  deriveSupervisionProcessKey,
  importSupervisionCredential,
  PendingChallengeStore,
  parseSupervisionMessage,
  serializeSupervisionCredential,
  signSupervisionMessage,
  SupervisionAuthorityGuard,
  SupervisionCommandGuard,
  SupervisionProtocolError,
  SupervisionSendQueue,
  verifySupervisionMessage,
  type AttachMessage,
  type CommandEnvelope,
  type ProcessIdentity,
  type SupervisionProcessCredential,
  type SupervisionProtocolErrorCode,
  type UnsignedSupervisionMessage,
} from '../../src/supervision';

const INSTANCE = '10000000-0000-4000-8000-000000000001';
const PROCESS = '20000000-0000-4000-8000-000000000001';
const OTHER_PROCESS = '20000000-0000-4000-8000-000000000002';
const BOOT = '30000000-0000-4000-8000-000000000001';
const REQUEST = '40000000-0000-4000-8000-000000000001';
const OTHER_REQUEST = '40000000-0000-4000-8000-000000000002';
const CONTROLLER = '50000000-0000-4000-8000-000000000001';
const OTHER_CONTROLLER = '50000000-0000-4000-8000-000000000002';
const KEY = new Uint8Array(32).fill(7);
const HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;

const identity: ProcessIdentity = { role: 'worker', process_instance_id: PROCESS, boot_nonce: BOOT };
const credential = deriveSupervisionProcessKey(KEY, INSTANCE, identity.role, PROCESS, BOOT);

function expectCode(action: () => unknown, code: SupervisionProtocolErrorCode): void {
  let captured: unknown;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(SupervisionProtocolError);
  if (captured instanceof SupervisionProtocolError) expect(captured.code).toBe(code);
}

function command(
  sequence = 1,
  requestId = REQUEST,
  epoch = 1,
  controllerId = CONTROLLER,
  path = '/attach',
): Extract<UnsignedSupervisionMessage, { kind: 'command' }> {
  return {
    protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process', ...identity,
    controller_epoch: epoch, controller_id: controllerId, sequence, request_id: requestId,
    method: 'POST', path, body_hash: HASH,
  };
}

function signedCommand(
  sequence = 1,
  requestId = REQUEST,
  epoch = 1,
  controllerId = CONTROLLER,
  path = '/attach',
  processCredential: SupervisionProcessCredential = credential,
): CommandEnvelope {
  return signSupervisionMessage(command(sequence, requestId, epoch, controllerId, path), processCredential) as CommandEnvelope;
}

function establishAuthority(
  authority: SupervisionAuthorityGuard,
  epoch = 1,
  controllerId = CONTROLLER,
): void {
  const store = new PendingChallengeStore({ clock: () => 100 });
  const pending = store.issue({ ...identity, controller_epoch: epoch, controller_id: controllerId,
    sequence: 1, request_id: REQUEST });
  const attach = signSupervisionMessage({
    protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process', ...identity,
    controller_epoch: epoch, controller_id: controllerId, sequence: 1, request_id: REQUEST,
    challenge_nonce: pending.challenge_nonce,
  }, credential) as AttachMessage;
  acceptAttach(attach, credential, store, authority);
}

describe('strict supervision v1 protocol', () => {
  test('round-trips a credential through a real Bun subprocess', () => {
    const serialized = serializeSupervisionCredential(credential);
    const protocolPath = new URL('../../src/supervision/protocol.ts', import.meta.url).pathname;
    const child = Bun.spawnSync({
      cmd: [process.execPath, '-e', `
        const { importSupervisionCredential, signSupervisionMessage } = await import(${JSON.stringify(protocolPath)});
        const credential = importSupervisionCredential(process.argv[1]);
        const message = {
          protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
          ...credential.identity, controller_epoch: 1, controller_id: '${CONTROLLER}', sequence: 1,
          request_id: '${REQUEST}', status: 'ready', body_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        };
        process.stdout.write(JSON.stringify(signSupervisionMessage(message, credential)));
      `, serialized],
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(child.exitCode).toBe(0);
    const message = JSON.parse(new TextDecoder().decode(child.stdout)) as unknown;
    expect(verifySupervisionMessage(message, credential)).toBe(true);
    expect(serialized).not.toContain(Buffer.from(KEY).toString('base64url'));
    expect(() => importSupervisionCredential(`${serialized}=`)).toThrow();
  });

  test('isolates worker credentials from other workers and ingress', () => {
    const ingressIdentity = { ...identity, role: 'ingress' as const };
    const otherIdentity = { ...identity, process_instance_id: OTHER_PROCESS };
    const ingressCredential = deriveSupervisionProcessKey(KEY, INSTANCE, 'ingress', PROCESS, BOOT);
    const otherCredential = deriveSupervisionProcessKey(KEY, INSTANCE, 'worker', OTHER_PROCESS, BOOT);
    const ingressMessage = signSupervisionMessage({ ...command(), role: 'ingress' }, ingressCredential);
    const otherMessage = signSupervisionMessage({ ...command(), process_instance_id: OTHER_PROCESS }, otherCredential);
    expect(() => signSupervisionMessage({ ...command(), process_instance_id: OTHER_PROCESS }, credential)).toThrow();
    expect(() => signSupervisionMessage({ ...command(), role: 'ingress' }, credential)).toThrow();
    expectCode(() => verifySupervisionMessage(ingressMessage, credential), 'identity_mismatch');
    expectCode(() => verifySupervisionMessage(otherMessage, credential), 'identity_mismatch');
    expectCode(() => signSupervisionMessage(command(), KEY as unknown as SupervisionProcessCredential), 'invalid_key_material');
  });

  test('strictly covers all message shapes, direction, MAC, identity, and path rules', () => {
    const common = {
      protocol: 'bungee-supervision-v1' as const, direction: 'process-to-controller' as const, ...identity,
      controller_epoch: 1, controller_id: CONTROLLER, sequence: 1, request_id: REQUEST,
    };
    const messages: UnsignedSupervisionMessage[] = [
      { ...common, kind: 'challenge', challenge_nonce: 'a'.repeat(64), expires_at: 10 },
      { ...common, kind: 'status', status: 'ready', body_hash: HASH },
      { ...common, kind: 'attach', direction: 'controller-to-process', challenge_nonce: 'a'.repeat(64) },
      { ...common, kind: 'lease', direction: 'controller-to-process', lease_expires_at: 10 },
      signedCommand(),
    ];
    for (const unsigned of messages) {
      const signed = unsigned.kind === 'command' ? unsigned : signSupervisionMessage(unsigned, credential);
      expect(verifySupervisionMessage(signed, credential)).toBe(true);
    }
    expect(() => signSupervisionMessage({ ...command(), path: '/a//b' }, credential)).toThrow();
    expect(() => signSupervisionMessage({ ...command(), path: '/a/../b' }, credential)).toThrow();
    expect(() => signSupervisionMessage({ ...command(), path: '/a?x=1' }, credential)).toThrow();
    expect(() => parseSupervisionMessage({ ...signedCommand(), extra: true })).toThrow();
    expectCode(() => parseSupervisionMessage({ ...signedCommand(), extra: true }), 'malformed_message');
    expectCode(() => parseSupervisionMessage({ ...signedCommand(), protocol: 'bungee-supervision-v0' }), 'unsupported_protocol');
    expectCode(() => verifySupervisionMessage({ ...signedCommand(), mac: `hmac-sha256:${'b'.repeat(64)}` }, credential), 'invalid_mac');
  });

  test('atomically accepts attach and preserves state on every rejected transition', () => {
    let now = 100;
    const challenges = new PendingChallengeStore({ clock: () => now, ttlMs: 10 });
    const authority = new SupervisionAuthorityGuard();
    const pending = challenges.issue({ ...identity, controller_epoch: 1, controller_id: CONTROLLER,
      sequence: 1, request_id: REQUEST });
    const attach = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process', ...identity,
      controller_epoch: 1, controller_id: CONTROLLER, sequence: 1, request_id: REQUEST,
      challenge_nonce: pending.challenge_nonce,
    }, credential) as AttachMessage;
    expect(acceptAttach(attach, credential, challenges, authority)).toEqual(pending);
    expect(() => acceptAttach(attach, credential, challenges, authority)).toThrow();
    const before = authority.snapshot();
    const newer = challenges.issue({ ...identity, controller_epoch: 1, controller_id: CONTROLLER,
      sequence: 2, request_id: '40000000-0000-4000-8000-000000000002' });
    const badAttach = { ...attach, challenge_nonce: newer.challenge_nonce, sequence: 1 } as AttachMessage;
    expect(() => acceptAttach(badAttach, credential, challenges, authority)).toThrow(SupervisionProtocolError);
    expect(authority.snapshot()).toEqual(before);
    expect(challenges.peek(newer)).toEqual(newer);
    const stale = challenges.issue({ ...identity, controller_epoch: 0, controller_id: CONTROLLER,
      sequence: 3, request_id: '40000000-0000-4000-8000-000000000003' });
    const staleAttach = signSupervisionMessage({
      protocol: 'bungee-supervision-v1', kind: 'attach', direction: 'controller-to-process', ...identity,
      controller_epoch: 0, controller_id: CONTROLLER, sequence: 2, request_id: stale.request_id,
      challenge_nonce: stale.challenge_nonce,
    }, credential) as AttachMessage;
    try {
      acceptAttach(staleAttach, credential, challenges, authority);
    } catch (error) {
      expect((error as SupervisionProtocolError).code).toBe('stale_controller');
    }
    const split = challenges.issue({ ...identity, controller_epoch: 1, controller_id: OTHER_CONTROLLER,
      sequence: 4, request_id: '40000000-0000-0000-8000-000000000004' });
    const { mac: _mac, ...staleUnsigned } = staleAttach;
    const splitAttach = signSupervisionMessage({
      ...staleUnsigned, controller_epoch: 1, controller_id: OTHER_CONTROLLER,
      request_id: split.request_id, challenge_nonce: split.challenge_nonce,
    }, credential) as AttachMessage;
    try {
      acceptAttach(splitAttach, credential, challenges, authority);
    } catch (error) {
      expect((error as SupervisionProtocolError).code).toBe('split_brain');
    }
    expectCode(() => challenges.consume({ ...newer, challenge_nonce: 'b'.repeat(64) }), 'challenge_mismatch');
    now = 110;
    expectCode(() => challenges.consume(newer), 'challenge_expired');
  });

  test('guards authority reset, request promise idempotency, rejection, and capacity', async () => {
    const authority = new SupervisionAuthorityGuard();
    expectCode(() => authority.accept(signedCommand()), 'unattached_controller');
    establishAuthority(authority);
    authority.accept(signedCommand(2));
    expectCode(() => authority.accept(signedCommand(2)), 'sequence_replay');
    expect(() => authority.accept(signedCommand(2, REQUEST, 1, OTHER_CONTROLLER))).toThrow();
    const commands = new SupervisionCommandGuard(authority, { capacity: 2 });
    let executions = 0;
    const first = commands.execute(signedCommand(3), 'result-1', async () => { executions += 1; return 'ok'; });
    const second = commands.execute(signedCommand(4, OTHER_REQUEST), 'result-b', async () => { executions += 1; return 'b'; });
    const retryA = commands.execute(signedCommand(5), 'result-2', async () => { executions += 1; return 'bad'; });
    const retryB = commands.execute(signedCommand(3), 'result-3', async () => { executions += 1; return 'bad'; });
    expect(retryA).toBe(first);
    expect(retryB).toBe(first);
    expect(await first).toEqual({ kind: 'settled', result_lookup_key: 'result-1', result: 'ok' });
    expect(await second).toEqual({ kind: 'settled', result_lookup_key: 'result-b', result: 'b' });
    expect(executions).toBe(2);
    expectCode(() => commands.execute(signedCommand(6, REQUEST, 1, CONTROLLER, '/other'), 'result-4', () => 'bad'), 'request_replay');
    establishAuthority(authority, 2, OTHER_CONTROLLER);
    const rejectedAuthority = new SupervisionAuthorityGuard();
    establishAuthority(rejectedAuthority);
    const rejected = new SupervisionCommandGuard(rejectedAuthority);
    const rejectFirst = rejected.execute(signedCommand(2), 'reject-1', () => { throw new Error('boom'); });
    const rejectRetry = rejected.execute(signedCommand(3), 'reject-2', () => 'not-run');
    expect(rejectRetry).toBe(rejectFirst);
    await expect(rejectFirst).rejects.toThrow('boom');
    const boundedAuthority = new SupervisionAuthorityGuard();
    establishAuthority(boundedAuthority);
    const bounded = new SupervisionCommandGuard(boundedAuthority, { capacity: 1 });
    expect(() => bounded.execute(signedCommand(2), 'one', () => 'one')).not.toThrow();
    expectCode(() => bounded.execute(signedCommand(3, '40000000-0000-4000-8000-000000000002'), 'two', () => 'two'), 'request_capacity');
  });

  test('serializes each process and direction queue independently', async () => {
    const queue = new SupervisionSendQueue();
    const events: string[] = [];
    const first = queue.enqueue(identity, 'controller-to-process', async () => { events.push('start-a'); await Bun.sleep(5); events.push('end-a'); });
    const second = queue.enqueue(identity, 'controller-to-process', async () => { events.push('start-b'); events.push('end-b'); });
    await Promise.all([first, second]);
    expect(events).toEqual(['start-a', 'end-a', 'start-b', 'end-b']);
  });
});
