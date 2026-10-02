import { describe, expect, test } from 'bun:test';
import { generateWorkerTransportSecret } from '../../src/config-worker/private-transport';
import { admissionSetRetiredId, IngressAdmissionRegistry, AdmissionRegistryError, parseAdmissionSet, type AdmissionSet } from '../../src/ingress';
import { createIngressPublicListener } from '../../src/public-listener';

const generation = '90000000-0000-4000-8000-000000000001';
const hash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const catalog = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

function admission(sequence: number, revision = sequence): AdmissionSet {
  return {
    master_generation: generation,
    admission_sequence: sequence,
    revision,
    content_hash: hash,
    plugin_catalog_hash: catalog,
    workers: [0, 1].map((slot) => ({
      master_generation: generation,
      worker_instance_id: `91000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      boot_nonce: `92000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      worker_slot: slot,
      private_port: 40_000 + slot,
    })),
  };
}

describe('ingress admission set and registry', () => {
  test('strictly parses, sorts, and deep freezes a complete set', () => {
    const parsed = parseAdmissionSet(admission(1));
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed.workers)).toBeTrue();
    expect(Object.isFrozen(parsed.workers[0])).toBeTrue();
    expect(() => parseAdmissionSet({ ...admission(1), extra: true })).toThrow();
    expect(() => parseAdmissionSet({ ...admission(1), workers: [admission(1).workers[0], { ...admission(1).workers[1], worker_slot: 2 }] })).toThrow();
    expect(() => parseAdmissionSet({ ...admission(1), workers: [{ ...admission(1).workers[0], master_generation: '90000000-0000-4000-8000-000000000002' }, admission(1).workers[1]] })).toThrow();
  }, 30_000);

  test('prepare does not cut traffic, commit is exact and retires the old active set', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    const second = admission(2);
    registry.prepare(first);
    expect(registry.select()).toBeNull();
    expect(registry.status().prepared?.admission_sequence).toBe(1);
    registry.prepare(second);
    expect(registry.status().prepared?.admission_sequence).toBe(2);
    expect(() => registry.prepare(first)).toThrow(AdmissionRegistryError);
    registry.abort(second);
    registry.prepare(first);
    registry.commit(first);
    expect(registry.select()?.private_port).toBe(40_000);
    registry.prepare(second);
    expect(registry.select()?.private_port).toBe(40_001);
    registry.commit(second);
    expect(registry.status().retired.map((set) => set.admission_sequence)).toEqual([1]);
    expect(registry.select()?.private_port).toBe(40_000);
  });

  test('supports exact prepare idempotency, abort, and rejects stale or mixed identity', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    expect(registry.prepare(first)).toEqual(registry.prepare(first));
    registry.abort(first);
    expect(() => registry.abort(first)).not.toThrow();
    expect(registry.status().prepared).toBeNull();
    registry.prepare(first);
    expect(() => registry.prepare({ ...first, admission_sequence: 1, revision: 2 })).toThrow(AdmissionRegistryError);
    registry.commit(first);
    expect(() => registry.commit(first)).not.toThrow();
    expect(() => registry.prepare(first)).toThrow(AdmissionRegistryError);
    const third = admission(3);
    const fourth = admission(4);
    const second = admission(2);
    registry.prepare(second);
    registry.commit(second);
    registry.prepare(third);
    registry.commit(third);
    registry.prepare(fourth);
    expect(() => registry.commit(fourth)).toThrow(AdmissionRegistryError);
    registry.releaseRetired(second);
    expect(() => registry.releaseRetired(second)).not.toThrow();
  });

  test('keeps commit retries idempotent across prepared, active, retired, and released history', () => {
    const registry = new IngressAdmissionRegistry();
    const first = admission(1);
    const second = admission(2);
    registry.prepare(first);
    registry.commit(first);
    registry.prepare(second);
    registry.commit(first);
    expect(registry.status().prepared?.admission_sequence).toBe(2);
    registry.commit(second);
    expect(() => registry.commit(first)).not.toThrow();
    registry.releaseRetired(first);
    expect(() => registry.commit(first)).not.toThrow();
    expect(registry.status().active?.admission_sequence).toBe(2);
  });

  test('keeps an old in-flight request on the old active worker during commit', async () => {
    const requestControl: { release?: () => void } = {};
    let requestStartedResolve!: () => void;
    const requestStarted = new Promise<void>((resolve) => { requestStartedResolve = resolve; });
    const releasePending = () => { requestControl.release?.(); };
    const worker = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => new Promise<Response>((resolve) => {
        requestControl.release = () => resolve(new Response('old'));
        requestStartedResolve();
      }),
    });
    let monotonicNow = 0;
    const registry = new IngressAdmissionRegistry(() => monotonicNow);
    let newRequests = 0;
    const newWorker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      newRequests += 1;
      return new Response('new');
    } });
    const first = admission(1);
    const second = admission(2);
    const firstWithPort = { ...first, workers: [{ ...first.workers[0]!, private_port: worker.port! }] };
    const secondWithPort = { ...second, workers: [{ ...second.workers[0]!, private_port: newWorker.port! }] };
    registry.prepare(firstWithPort);
    registry.commit(firstWithPort);
    const listener = createIngressPublicListener({
      admission: registry,
      transportSecret: generateWorkerTransportSecret(),
      hostname: '127.0.0.1', port: 0,
    });
    listener.start();
    try {
      const pending = fetch(`http://127.0.0.1:${listener.port}/health`);
      await requestStarted;
      const prepared = registry.prepare(secondWithPort, 5);
      expect(prepared.admission_sequence).toBe(2);
      registry.commit(secondWithPort);
      expect(registry.status().handoff).toMatchObject({
        retired_id: admissionSetRetiredId(firstWithPort), pending: 1, complete: false, remaining_ms: 5,
      });
      monotonicNow = 10;
      expect(registry.status().handoff).toMatchObject({ pending: 1, complete: false, remaining_ms: 0 });
      registry.commit(secondWithPort);
      expect(registry.status().handoff).toMatchObject({ pending: 1, complete: false, remaining_ms: 0 });
      expect(await (await fetch(`http://127.0.0.1:${listener.port}/health`)).text()).toBe('new');
      expect(newRequests).toBe(1);
      releasePending();
      expect(await (await pending).text()).toBe('old');
      expect(registry.status().handoff).toMatchObject({ pending: 0, complete: true, remaining_ms: 0 });
    } finally {
      releasePending();
      await listener.stop();
      await worker.stop(true);
      await newWorker.stop(true);
    }
  });
});
