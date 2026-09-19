import { describe, expect, test } from 'bun:test';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision';
import {
  createPluginControlRpcCredential,
  createPluginControlRpcResult,
  encodePluginControlRpcMessage,
  hashPluginControlRpcBody,
  parsePluginControlRpcMessage,
  serializePluginControlRpcMessage,
  samePluginControlRpcCredential,
  signPluginControlRpcMessage,
  verifyPluginControlRpcMessage,
  verifyPluginControlRpcResult,
  PluginControlRpcProtocolError,
  type PluginControlRpcCall,
  type PluginControlRpcCredential,
  type PluginControlRpcWorker,
} from '../../src/plugin-control';
import { PluginControlHttpBodyError, readPluginControlHttpBody } from '../../src/plugin-control/http-protocol';

const MATERIAL = new Uint8Array(32).fill(6);
const GENERATION = '10000000-0000-4000-8000-000000000001';
const WORKER_ID = '20000000-0000-4000-8000-000000000001';
const BOOT = '30000000-0000-4000-8000-000000000001';
const CONTROLLER = '40000000-0000-4000-8000-000000000001';
const ATTEMPT = '50000000-0000-4000-8000-000000000001';
const REQUEST = '60000000-0000-4000-8000-000000000001';
const OTHER = '60000000-0000-4000-8000-000000000002';
const worker: PluginControlRpcWorker = {
  master_generation: GENERATION, worker_instance_id: WORKER_ID, worker_slot: 3, boot_nonce: BOOT,
};
const supervision = deriveWorkerSupervisionCredential(
  deriveWorkerSupervisionSeed(MATERIAL, GENERATION, WORKER_ID, worker.worker_slot), BOOT,
);
const credential = createPluginControlRpcCredential(supervision, worker, 'plugin-control');
const authority = { controller_epoch: 2, controller_id: CONTROLLER };

function expectCode(action: () => unknown, code: string): void {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(PluginControlRpcProtocolError);
    expect((error as PluginControlRpcProtocolError).code).toBe(code as any);
    return;
  }
  throw new Error(`expected ${code}`);
}

function callInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    revision: 4, endpoint_id: 'endpoint-a', attempt_id: ATTEMPT, method: 'credential',
    payload: { bindingOptions: { opaque: true }, accountRef: 'opaque-business-data' },
  };
  return {
    protocol: 'bungee-plugin-control-rpc/v1', kind: 'call', direction: 'worker-to-controller', authority,
    sequence: 1, request_id: REQUEST, deadline_at: 10_500, body_hash: hashPluginControlRpcBody(body), body, ...overrides,
  };
}

function call(overrides: Record<string, unknown> = {}): PluginControlRpcCall {
  return signPluginControlRpcMessage(callInput(overrides) as any, credential) as PluginControlRpcCall;
}

describe('W3a1 plugin control RPC protocol', () => {
  test('creates a branded credential from the worker supervision credential', () => {
    expect(credential.worker).toEqual(worker);
    expect(credential.channel).toBe('plugin-control');
    const clone = { ...credential } as PluginControlRpcCredential;
    expectCode(() => verifyPluginControlRpcMessage(call(), clone), 'identity_mismatch');
    expectCode(() => createPluginControlRpcCredential(supervision, { ...worker, worker_instance_id: OTHER }), 'identity_mismatch');
  });

  test('keeps a timer terminal error when cancel synchronously resolves the reader', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let timerCalls = 0;
    globalThis.setTimeout = ((callback: TimerHandler) => { timerCalls += 1; if (typeof callback === 'function') callback(); return 1; }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;
    try {
      for (const part of [
        { done: true, value: undefined },
        { done: false, value: new Uint8Array([1, 2, 3]) },
      ]) {
        const errors: string[] = [];
        const cancellations: number[] = [];
        for (let index = 0; index < 50; index += 1) {
          let cancelled = 0;
          let wasCancelled = false;
          const body = { getReader: () => ({
            read: async () => wasCancelled ? part : await new Promise<never>(() => undefined),
            cancel: () => { cancelled += 1; wasCancelled = true; },
          }) } as unknown as ReadableStream<Uint8Array>;
          try {
            await readPluginControlHttpBody(body, { maxBytes: 64 * 1024, deadlineAt: 1, wallClock: () => 0 });
          } catch (error) {
            errors.push(error instanceof PluginControlHttpBodyError ? error.code : 'wrong');
          }
          cancellations.push(cancelled);
        }
        expect(errors).toEqual(Array.from({ length: 50 }, () => 'body_timeout'));
        expect(cancellations).toEqual(Array.from({ length: 50 }, () => 1));
      }
      expect(timerCalls).toBe(100);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test('recognizes freshly derived equivalent credentials without accepting clones', () => {
    const fresh = createPluginControlRpcCredential(
      deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(MATERIAL, GENERATION, WORKER_ID, worker.worker_slot), BOOT),
      worker,
      'plugin-control',
    );
    expect(samePluginControlRpcCredential(credential, fresh)).toBe(true);
    expect(samePluginControlRpcCredential(credential, { ...credential } as PluginControlRpcCredential)).toBe(false);
  });

  test('sign injects the complete worker and binds channel in the MAC', () => {
    const message = call();
    expect(message.worker).toEqual(worker);
    expect(verifyPluginControlRpcMessage(message, credential)).toBe(true);
    const otherChannel = createPluginControlRpcCredential(supervision, worker, 'other-channel');
    expectCode(() => verifyPluginControlRpcMessage(message, otherChannel), 'invalid_mac');
  });

  test('requires a short safe channel name', () => {
    expectCode(() => createPluginControlRpcCredential(supervision, worker, ''), 'identity_mismatch');
    expectCode(() => createPluginControlRpcCredential(supervision, worker, 'bad channel'), 'identity_mismatch');
    expectCode(() => createPluginControlRpcCredential(supervision, worker, `${'a'.repeat(64)}!`), 'identity_mismatch');
    expect(createPluginControlRpcCredential(supervision, worker, 'a'.repeat(64)).channel.length).toBe(64);
  });

  test('rejects a worker supplied to sign and wrong generation or slot on verify', () => {
    expectCode(() => signPluginControlRpcMessage({ ...callInput(), worker } as any, credential), 'malformed_message');
    const message = call();
    expectCode(() => verifyPluginControlRpcMessage({ ...message, worker: { ...worker, master_generation: OTHER } }, credential), 'identity_mismatch');
    expectCode(() => verifyPluginControlRpcMessage({ ...message, worker: { ...worker, worker_slot: 4 } }, credential), 'identity_mismatch');
  });

  test('uses controller_epoch/controller_id and rejects envelope extras', () => {
    const message = call();
    expect(parsePluginControlRpcMessage(message)).toEqual(message);
    expectCode(() => parsePluginControlRpcMessage({ ...message, bindingOptions: {} }), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...message, plugin: 'p' }), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...message, authority: { ...authority, epoch: 1 } }), 'malformed_message');
  });

  test('keeps payload opaque while body remains exact', () => {
    const message = call();
    expect((message.body.payload as Record<string, unknown>).accountRef).toBe('opaque-business-data');
    expectCode(() => parsePluginControlRpcMessage({ ...message, body: { ...message.body, bindingOptions: {} } }), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...message, body: { ...message.body, accountRef: 'x' } }), 'malformed_message');
  });

  test('rejects unsafe JSON, prototypes, non-UUIDs and invalid numbers', () => {
    expectCode(() => hashPluginControlRpcBody(Number.NaN), 'malformed_message');
    expectCode(() => hashPluginControlRpcBody(Infinity), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...call(), prototype: true }), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...call(), request_id: 'NOT-A-UUID' }), 'malformed_message');
    expectCode(() => parsePluginControlRpcMessage({ ...call(), sequence: 0 }), 'malformed_message');
  });

  test('rejects oversized call at sign and parse boundaries', () => {
    const payload = { data: 'x'.repeat(70 * 1024) };
    expectCode(() => call({ body: {
      revision: 1, endpoint_id: 'ep', attempt_id: ATTEMPT, method: 'm', payload,
    }, body_hash: hashPluginControlRpcBody({ revision: 1, endpoint_id: 'ep', attempt_id: ATTEMPT, method: 'm', payload }) }), 'message_too_large');
    expectCode(() => parsePluginControlRpcMessage('x'.repeat(70 * 1024)), 'message_too_large');
  });

  test('checks canonical body hash and constant-time MAC', () => {
    const message = call();
    expectCode(() => parsePluginControlRpcMessage({ ...message, body_hash: hashPluginControlRpcBody({ changed: true }) }), 'malformed_message');
    expectCode(() => verifyPluginControlRpcMessage({ ...message, mac: `hmac-sha256:${'0'.repeat(64)}` }, credential), 'invalid_mac');
  });

  test('creates and validates correlated success and failure results', () => {
    const request = call();
    const success = createPluginControlRpcResult(request, { ok: true, result: { version: 1 } }, credential);
    expect(verifyPluginControlRpcResult(success, request, credential)).toBe(true);
    const failure = createPluginControlRpcResult(request, { ok: false, error: 'action_failed' }, credential);
    expect(verifyPluginControlRpcResult(failure, request, credential)).toBe(true);
    expectCode(() => parsePluginControlRpcMessage({ ...success, body: { ok: true, result: 'x', error: 'extra' } }), 'malformed_message');
  });

  test('rejects result body hash, MAC and request correlation failures', () => {
    const request = call();
    const result = createPluginControlRpcResult(request, { ok: true, result: 'ok' }, credential);
    expectCode(() => verifyPluginControlRpcResult({ ...result, request_id: OTHER }, request, credential), 'invalid_response');
    expectCode(() => verifyPluginControlRpcResult({ ...result, body_hash: hashPluginControlRpcBody({ ok: false, error: 'action_failed' }) }, request, credential), 'invalid_response');
    expectCode(() => verifyPluginControlRpcResult({ ...result, mac: `hmac-sha256:${'0'.repeat(64)}` }, request, credential), 'invalid_response');
  });

  test('serializes canonical UTF-8 wire data', () => {
    const message = call();
    const text = serializePluginControlRpcMessage(message);
    expect(new TextDecoder().decode(encodePluginControlRpcMessage(message))).toBe(text);
    expect(parsePluginControlRpcMessage(text)).toEqual(message);
  });
});
