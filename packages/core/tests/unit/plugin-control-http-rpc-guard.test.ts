import { describe, expect, test } from 'bun:test';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision';
import {
  createPluginControlRpcCredential,
  createPluginControlRpcResult,
  hashPluginControlRpcBody,
  signPluginControlRpcMessage,
  PluginControlRpcProtocolError,
  PluginControlRpcRequestGuard,
  PluginControlRpcResponseGuard,
  type PluginControlRpcCall,
  type PluginControlRpcCancel,
  type PluginControlRpcCredential,
  type PluginControlRpcAuthority,
} from '../../src/plugin-control';

const MATERIAL = new Uint8Array(32).fill(7);
const GENERATION = '11000000-0000-4000-8000-000000000001';
const WORKER_ID = '22000000-0000-4000-8000-000000000001';
const BOOT = '33000000-0000-4000-8000-000000000001';
const CONTROLLER = '44000000-0000-4000-8000-000000000001';
const OTHER_CONTROLLER = '44000000-0000-4000-8000-000000000002';
const ATTEMPT = '55000000-0000-4000-8000-000000000001';
const worker = { master_generation: GENERATION, worker_instance_id: WORKER_ID, worker_slot: 1, boot_nonce: BOOT } as const;
const supervision = deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(MATERIAL, GENERATION, WORKER_ID, 1), BOOT);
const credential = createPluginControlRpcCredential(supervision, worker);
const authority = { controller_epoch: 2, controller_id: CONTROLLER } as const;
const otherAuthority = { controller_epoch: 3, controller_id: OTHER_CONTROLLER } as const;
const BASE_NOW = Date.now();

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(PluginControlRpcProtocolError);
    expect((error as PluginControlRpcProtocolError).code).toBe(code as any);
    return;
  }
  throw new Error(`expected ${code}`);
}

function call(
  sequence: number,
  requestId: string,
  now = BASE_NOW,
  payload: unknown = { value: 1 },
  requestAuthority: PluginControlRpcAuthority = authority,
  deadline = now + 5_000,
): PluginControlRpcCall {
  const body = { revision: 1, endpoint_id: 'endpoint', attempt_id: ATTEMPT, method: 'get', payload };
  return signPluginControlRpcMessage({
    protocol: 'bungee-plugin-control-rpc/v1', kind: 'call', direction: 'worker-to-controller', authority: requestAuthority,
    sequence, request_id: requestId, deadline_at: deadline, body_hash: hashPluginControlRpcBody(body), body,
  } as any, credential) as PluginControlRpcCall;
}

function cancel(sequence: number, requestId: string, target: string, now = BASE_NOW, requestAuthority: PluginControlRpcAuthority = authority, deadline = now + 5_000): PluginControlRpcCancel {
  const body = { target_request_id: target };
  return signPluginControlRpcMessage({
    protocol: 'bungee-plugin-control-rpc/v1', kind: 'cancel', direction: 'worker-to-controller', authority: requestAuthority,
    sequence, request_id: requestId, deadline_at: deadline, body_hash: hashPluginControlRpcBody(body), body,
  } as any, credential) as PluginControlRpcCancel;
}

function options(
  overrides: Partial<ConstructorParameters<typeof PluginControlRpcRequestGuard>[0]> = {},
  credentialValue: PluginControlRpcCredential = credential,
): ConstructorParameters<typeof PluginControlRpcRequestGuard>[0] {
  return { credential: credentialValue, authority, ...overrides };
}

describe('W3a1 request guard authority and sequence', () => {
  test('requires trusted authority and rejects ordinary authority advancement', () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => 'ok' }));
    expectCode(() => { void guard.handleCall(call(1, '66000000-0000-4000-8000-000000000001', 1_000, {}, otherAuthority)); }, 'stale_controller');
    expect(guard.currentAuthority).toEqual(authority);
    guard.replaceAuthority(authority);
    expect(guard.currentAuthority).toEqual(authority);
  });

  test('replaceAuthority distinguishes idempotent, stale and split brain changes', () => {
    const guard = new PluginControlRpcRequestGuard(options());
    guard.replaceAuthority(authority);
    expectCode(() => guard.replaceAuthority({ controller_epoch: 1, controller_id: CONTROLLER }), 'stale_controller');
    expectCode(() => guard.replaceAuthority({ controller_epoch: 2, controller_id: OTHER_CONTROLLER }), 'split_brain');
    expect(guard.currentAuthority).toEqual(authority);
  });

  test('expired higher-epoch request cannot mutate authority or abort active work', async () => {
    let release!: () => void;
    const guard = new PluginControlRpcRequestGuard(options({ wallClock: () => 1_000, execute: async () => new Promise((resolve) => { release = () => resolve('done'); }) }));
    const active = guard.handleCall(call(1, '66000000-0000-4000-8000-000000000002', 1_000, {}, authority, 1_100));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectCode(() => { void guard.handleCall(call(2, '66000000-0000-4000-8000-000000000003', 1_000, {}, otherAuthority, 1_000)); }, 'stale_controller');
    expect(guard.currentAuthority).toEqual(authority);
    expect(guard.activeCount).toBe(1);
    release();
    await active;
  });

  test('accepts out-of-order sequence 127/128 window boundary and rejects below it', async () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => 'ok' }));
    await guard.handleCall(call(128, '66000000-0000-4000-8000-000000000010'));
    await guard.handleCall(call(1, '66000000-0000-4000-8000-000000000011'));
    expectCode(() => { void guard.handleCall(call(0, '66000000-0000-4000-8000-000000000012')); }, 'malformed_message');
    expectCode(() => { void guard.handleCall(call(1, '66000000-0000-4000-8000-000000000013')); }, 'sequence_replay');
  });

  test('rejects different request IDs reusing one sequence', async () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => 'ok' }));
    await guard.handleCall(call(4, '66000000-0000-4000-8000-000000000020'));
    expectCode(() => { void guard.handleCall(call(4, '66000000-0000-4000-8000-000000000021')); }, 'sequence_replay');
  });

  test('deduplicates same semantic request and invokes action once', async () => {
    let runs = 0;
    let release!: () => void;
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => {
      runs += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { answer: 42 };
    } }));
    const first = guard.handleCall(call(1, '66000000-0000-4000-8000-000000000030'));
    const duplicate = guard.handleCall(call(2, '66000000-0000-4000-8000-000000000030'));
    expect(first).toBe(duplicate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await first).toBe(await duplicate);
    expect(runs).toBe(1);
  });

  test('rejects same ID with a different semantic fingerprint', async () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => 'ok' }));
    await guard.handleCall(call(1, '66000000-0000-4000-8000-000000000031'));
    expectCode(() => { void guard.handleCall(call(2, '66000000-0000-4000-8000-000000000031', 1_000, { changed: true })); }, 'request_replay');
  });
});

describe('W3a1 request guard cancellation and lifecycle', () => {
  test('cancel-before-call tombstone lasts max deadline plus grace', async () => {
    let now = 1_000;
    let runs = 0;
    const guard = new PluginControlRpcRequestGuard(options({ wallClock: () => now, maxDeadlineMs: 500, graceMs: 10, execute: async () => { runs += 1; return 'ok'; } }));
    const target = '66000000-0000-4000-8000-000000000040';
    const nextTarget = '66000000-0000-4000-8000-000000000042';
    await guard.handleCancel(cancel(1, '66000000-0000-4000-8000-000000000041', target, now, authority, now + 100));
    now = 1_509;
    expect((await guard.handleCall(call(2, target, now, {}, authority, now + 50))).body).toEqual({ ok: false, error: 'cancelled' });
    await guard.handleCancel(cancel(3, '66000000-0000-4000-8000-000000000043', nextTarget, 1_510, authority, 1_610));
    now = 2_020;
    expect((await guard.handleCall(call(4, nextTarget, now, {}, authority, now + 50))).body).toEqual({ ok: true, result: 'ok' });
    expect(runs).toBe(1);
  });

  test('cancel-during aborts active work and settles its promise once', async () => {
    let release!: () => void;
    let aborted = false;
    const guard = new PluginControlRpcRequestGuard(options({ execute: async (_call, signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      await new Promise<void>((resolve) => { release = resolve; });
      return 'late';
    } }));
    const request = call(1, '66000000-0000-4000-8000-000000000050');
    const pending = guard.handleCall(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await guard.handleCancel(cancel(2, '66000000-0000-4000-8000-000000000051', request.request_id));
    expect((await pending).body).toEqual({ ok: false, error: 'cancelled' });
    expect(aborted).toBe(true);
    release();
  });

  test('cancel-after-completion does not rerun or fake cancellation', async () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => 'done' }));
    const request = call(1, '66000000-0000-4000-8000-000000000060');
    expect((await guard.handleCall(request)).body).toEqual({ ok: true, result: 'done' });
    await guard.handleCancel(cancel(2, '66000000-0000-4000-8000-000000000061', request.request_id));
  });

  test('authority replacement aborts old entry and ignores its late completion', async () => {
    let oldRelease!: () => void;
    const guard = new PluginControlRpcRequestGuard(options({ execute: async (request) => request.authority.controller_epoch === 2
      ? new Promise((resolve) => { oldRelease = () => resolve('old'); }) : 'new' }));
    const id = '66000000-0000-4000-8000-000000000070';
    const old = guard.handleCall(call(1, id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    guard.replaceAuthority(otherAuthority);
    expect((await old).body).toEqual({ ok: false, error: 'stale_controller' });
    const next = await guard.handleCall(call(1, id, BASE_NOW, {}, otherAuthority));
    expect(next.body).toEqual({ ok: true, result: 'new' });
    oldRelease();
    expect(guard.activeCount).toBe(0);
  });

  test('oversized action result becomes a small signed response_too_large', async () => {
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => ({ data: 'x'.repeat(70 * 1024) }) }));
    const result = await guard.handleCall(call(1, '66000000-0000-4000-8000-000000000080'));
    expect(result.body).toEqual({ ok: false, error: 'response_too_large' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('caches the same signed failure result', async () => {
    let runs = 0;
    const guard = new PluginControlRpcRequestGuard(options({ execute: async () => { runs += 1; throw new Error('secret'); } }));
    const request = call(1, '66000000-0000-4000-8000-000000000081');
    const first = await guard.handleCall(request);
    const second = await guard.handleCall(call(2, request.request_id));
    expect(second).toBe(first);
    expect(first.body).toEqual({ ok: false, error: 'action_failed' });
    expect(runs).toBe(1);
  });

  test('dispose is idempotent, clears cache/timers and rejects future calls', async () => {
    const global = { limit: 4, active: 0 };
    const guard = new PluginControlRpcRequestGuard(options({ globalCapacity: global, execute: async () => 'ok' }));
    await guard.handleCall(call(1, '66000000-0000-4000-8000-000000000090'));
    guard.dispose();
    guard.dispose();
    expect(guard.cachedCount).toBe(0);
    expect(guard.activeCount).toBe(0);
    expect(global.active).toBe(0);
    expectCode(() => { void guard.handleCall(call(2, '66000000-0000-4000-8000-000000000091')); }, 'disposed');
  });

  test('settled result is automatically evicted after deadline plus grace', async () => {
    const now = Date.now();
    const guard = new PluginControlRpcRequestGuard(options({ graceMs: 5, maxDeadlineMs: 100, execute: async () => 'secret' }));
    await guard.handleCall(call(1, '66000000-0000-4000-8000-000000000092', now, {}, authority, now + 20));
    expect(guard.cachedCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(guard.cachedCount).toBe(0);
  });

  test('disposing active request returns signed disposed and releases shared capacity', async () => {
    let release!: () => void;
    const global = { limit: 1, active: 0 };
    const guard = new PluginControlRpcRequestGuard(options({ globalCapacity: global, execute: async () => new Promise((resolve) => { release = () => resolve('late'); }) }));
    const pending = guard.handleCall(call(1, '66000000-0000-4000-8000-000000000093'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    guard.dispose();
    expect((await pending).body).toEqual({ ok: false, error: 'disposed' });
    expect(global.active).toBe(0);
    release();
  });
});

describe('W3a1 response guard', () => {
  test('registers outbound calls and accepts a correlated signed response', async () => {
    const guard = new PluginControlRpcResponseGuard(options());
    const request = call(1, '66000000-0000-4000-8000-000000000100');
    const pending = guard.registerCall(request);
    const accepted = guard.acceptResult(createPluginControlRpcResult(request, { ok: true, result: 'ok' }, credential));
    expect(await pending).toBe(accepted);
  });

  test('same signed response is idempotent and conflicting result is replay', async () => {
    const guard = new PluginControlRpcResponseGuard(options());
    const request = call(1, '66000000-0000-4000-8000-000000000101');
    const pending = guard.registerCall(request);
    const signed = createPluginControlRpcResult(request, { ok: true, result: 'same' }, credential);
    const first = guard.acceptResult(signed);
    expect(guard.acceptResult(signed)).toBe(first);
    expect(await pending).toBe(first);
    expectCode(() => guard.acceptResult(createPluginControlRpcResult(request, { ok: true, result: 'different' }, credential)), 'request_replay');
  });

  test('unknown, wrong correlation and duplicate response sequence are rejected', async () => {
    const guard = new PluginControlRpcResponseGuard(options());
    const firstRequest = call(1, '66000000-0000-4000-8000-000000000102');
    const secondRequest = call(2, '66000000-0000-4000-8000-000000000103');
    const firstPending = guard.registerCall(firstRequest);
    const secondPending = guard.registerCall(secondRequest);
    const firstResult = createPluginControlRpcResult(firstRequest, { ok: true, result: 1 }, credential, 8);
    const accepted = guard.acceptResult(firstResult);
    expect(await firstPending).toBe(accepted);
    expectCode(() => guard.acceptResult(createPluginControlRpcResult(call(3, '66000000-0000-4000-8000-000000000104'), { ok: true, result: 1 }, credential, 9)), 'invalid_response');
    expectCode(() => guard.acceptResult(createPluginControlRpcResult(secondRequest, { ok: true, result: 2 }, credential, 8)), 'sequence_replay');
    guard.dispose();
    await expect(secondPending).rejects.toMatchObject({ code: 'disposed' });
  });

  test('expired response is rejected and pending promise is settled', async () => {
    let now = 1_000;
    const guard = new PluginControlRpcResponseGuard(options({ wallClock: () => now }));
    const request = call(1, '66000000-0000-4000-8000-000000000105', now, {}, authority, now + 10);
    const pending = guard.registerCall(request);
    now = 1_010;
    expectCode(() => guard.acceptResult(createPluginControlRpcResult(request, { ok: true, result: 1 }, credential)), 'deadline_expired');
    await expect(pending).rejects.toMatchObject({ code: 'deadline_expired' });
  });

  test('outbound cancel registers a target without expecting a cancel response', async () => {
    const guard = new PluginControlRpcResponseGuard(options());
    const request = call(1, '66000000-0000-4000-8000-000000000106');
    const pending = guard.registerCall(request);
    guard.registerCancel(cancel(2, '66000000-0000-4000-8000-000000000107', request.request_id));
    expectCode(() => guard.acceptResult(createPluginControlRpcResult(request, { ok: true, result: 'late' }, credential)), 'cancelled');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  test('response authority replacement and dispose clear pending state', async () => {
    const global = { limit: 4, active: 0 };
    const guard = new PluginControlRpcResponseGuard(options({ globalCapacity: global }));
    const request = call(1, '66000000-0000-4000-8000-000000000108');
    const pending = guard.registerCall(request);
    guard.replaceAuthority(otherAuthority);
    await expect(pending).rejects.toMatchObject({ code: 'stale_controller' });
    guard.dispose();
    guard.dispose();
    expect(guard.cachedCount).toBe(0);
    expect(global.active).toBe(0);
    expectCode(() => guard.registerCall(call(1, '66000000-0000-4000-8000-000000000109', 1_000, {}, otherAuthority)), 'disposed');
  });

  test('shared global capacity spans request and response guards', async () => {
    let release!: () => void;
    const global = { limit: 1, active: 0 };
    const requestGuard = new PluginControlRpcRequestGuard(options({ globalCapacity: global, execute: async () => new Promise((resolve) => { release = () => resolve('ok'); }) }));
    const responseGuard = new PluginControlRpcResponseGuard(options({ globalCapacity: global }));
    const pending = requestGuard.handleCall(call(1, '66000000-0000-4000-8000-000000000110'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectCode(() => { void responseGuard.registerCall(call(2, '66000000-0000-4000-8000-000000000111')); }, 'concurrency_limit');
    release();
    await pending;
    expect(global.active).toBe(0);
  });
});
