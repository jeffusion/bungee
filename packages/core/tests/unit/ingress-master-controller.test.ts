import { expect, test } from 'bun:test';
import {
  MasterIngressController,
  type MasterIngressControllerOrigin,
  type MasterIngressRecoveryResult,
} from '../../src/ingress/master-controller';
import { credentialFromSerialized, IngressAdmissionRegistry, IngressControllerClient, IngressSupervisionHttpServer, type IngressStatusPayload } from '../../src/ingress';
import { deriveSupervisionProcessKey, type ProcessIdentity } from '../../src/supervision';
import type { ServingConfigWorker } from '../../src/config-publication';
import { admissionSetIdentity, type AdmissionSet } from '../../src/ingress/admission-set';

const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;
const GENERATION = '10000000-0000-4000-8000-000000000001';

function options(onRecovered?: () => Promise<MasterIngressRecoveryResult | void> | MasterIngressRecoveryResult | void) {
  return {
    rootKey: new Uint8Array(32), instanceId: '20000000-0000-4000-8000-000000000001',
    controllerId: '30000000-0000-4000-8000-000000000001', controllerEpoch: 1,
    controlPort: 3010, publicHost: '127.0.0.1', publicPort: 8080,
    instanceLockPath: '/tmp/bungee-ingress.lock', transportSecret: 'secret',
    executable: process.execPath, entry: '/tmp/ingress.ts', cwd: '/tmp',
    leaseDurationMs: 100, onRecovered,
  };
}

function worker(): ServingConfigWorker {
  const process = {
    slot: 0, pid: 42,
    identity: {
      master_generation: GENERATION,
      worker_instance_id: '40000000-0000-4000-8000-000000000001', worker_slot: 0,
    },
    send: async () => undefined,
    subscribeMessage: () => () => undefined,
    subscribeExit: () => () => undefined,
    terminate: async () => undefined,
  };
  return {
    process, boot_nonce: '50000000-0000-4000-8000-000000000001', revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG, private_port: 40_000, publication: null,
  } as ServingConfigWorker;
}

function status(registry: IngressStatusPayload['registry'] = {
  active: null, prepared: null, retired: [],
}): IngressStatusPayload {
  return { state: 'attached', registry };
}

function identity(id: string, nonce: string): ProcessIdentity {
  return { role: 'ingress', process_instance_id: id, boot_nonce: nonce };
}

function attachFake(
  controller: MasterIngressController,
  client: Partial<IngressControllerClient>,
  origin: MasterIngressControllerOrigin = 'adopted',
): void {
  const internal = controller as unknown as {
    client: IngressControllerClient;
    state: 'attached';
    disconnected: boolean;
    ingressOrigin: MasterIngressControllerOrigin;
  };
  internal.client = client as IngressControllerClient;
  internal.state = 'attached';
  internal.disconnected = false;
  internal.ingressOrigin = origin;
}

test('readiness expires from the injected lease clock before the renewal timer runs', () => {
  let wallNow = 1_000;
  let monotonicNow = 1_000;
  const controller = new MasterIngressController({ ...options(), now: () => wallNow, monotonicNow: () => monotonicNow });
  const active = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ master_generation: GENERATION, worker_instance_id: worker().process.identity.worker_instance_id,
      boot_nonce: worker().boot_nonce!, worker_slot: 0, private_port: 40_000 }],
  };
  attachFake(controller, { status: async () => status() });
  const internal = controller as unknown as {
    trustedStatus: IngressStatusPayload;
    trustedStatusAt: number;
    trustedStatusAuthority: { controller_id: string; controller_epoch: number };
    leaseDeadline: number;
  };
  internal.trustedStatus = status({ active, prepared: null, retired: [] });
  internal.trustedStatusAt = monotonicNow;
  internal.trustedStatusAuthority = { controller_id: '30000000-0000-4000-8000-000000000001', controller_epoch: 1 };
  internal.leaseDeadline = 1_100;

  expect(controller.isMutationReady({ revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG, hasActiveOperation: false })).toBeTrue();
  wallNow = 1;
  monotonicNow = 1_067;
  expect(controller.isMutationReady({ revision: 1, content_hash: HASH, plugin_catalog_hash: CATALOG, hasActiveOperation: false })).toBeFalse();
  void controller.disconnect();
});

test('trusted active admission requires attached state, current authority, and unexpired lease', async () => {
  let monotonicNow = 1_000;
  const controller = new MasterIngressController({ ...options(), monotonicNow: () => monotonicNow });
  const admission = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  };
  attachFake(controller, { status: async () => status() });
  const internal = controller as unknown as {
    trustedStatus: IngressStatusPayload;
    trustedStatusAt: number;
    trustedStatusAuthority: { controller_id: string; controller_epoch: number };
    leaseDeadline: number;
  };
  internal.trustedStatus = status({ active: admission, prepared: null, retired: [admission] });
  internal.trustedStatusAt = monotonicNow;
  internal.trustedStatusAuthority = { controller_id: '30000000-0000-4000-8000-000000000001', controller_epoch: 1 };
  internal.leaseDeadline = 1_100;
  expect(controller.trustedActiveAdmissionIfFresh()).toEqual(admission);
  monotonicNow = 1_100;
  expect(controller.trustedActiveAdmissionIfFresh()).toBeNull();
  monotonicNow = 1_001;
  (controller as unknown as { state: 'control_recovering' }).state = 'control_recovering';
  expect(controller.trustedActiveAdmissionIfFresh()).toBeNull();
  (controller as unknown as { state: 'stopped' }).state = 'stopped';
  await controller.disconnect();
});

test('recovery readiness permits zero active workers but rejects untrusted transitional control state', async () => {
  const controller = new MasterIngressController({ ...options(), monotonicNow: () => 1_000 });
  attachFake(controller, { status: async () => status() });
  const internal = controller as unknown as {
    trustedStatus: IngressStatusPayload;
    trustedStatusAt: number;
    trustedStatusAuthority: { controller_id: string; controller_epoch: number };
    leaseDeadline: number;
    pendingAdmission: unknown;
    uncertainAdmission: unknown;
    pendingRetiredRelease: unknown;
  };
  internal.trustedStatus = status();
  internal.trustedStatusAt = 1_000;
  internal.trustedStatusAuthority = { controller_id: '30000000-0000-4000-8000-000000000001', controller_epoch: 1 };
  internal.leaseDeadline = 1_100;
  internal.pendingAdmission = null;
  internal.uncertainAdmission = null;
  internal.pendingRetiredRelease = null;
  expect(controller.isRecoveryReady()).toBeTrue();
  internal.trustedStatus = status({ active: null, prepared: worker() as never, retired: [] });
  expect(controller.isRecoveryReady()).toBeFalse();
  internal.trustedStatus = status({ active: null, prepared: null, retired: [worker() as never] });
  expect(controller.isRecoveryReady()).toBeFalse();
  internal.trustedStatus = status();
  internal.pendingAdmission = {};
  expect(controller.isRecoveryReady()).toBeFalse();
  internal.pendingAdmission = null;
  internal.uncertainAdmission = {};
  expect(controller.isRecoveryReady()).toBeFalse();
  internal.uncertainAdmission = null;
  internal.trustedStatusAuthority = { controller_id: '30000000-0000-4000-8000-000000000099', controller_epoch: 1 };
  expect(controller.isRecoveryReady()).toBeFalse();
  await controller.disconnect();
});

test('eligibility observers are notified after trust/clear/state facts and isolated from observer errors', async () => {
  const controller = new MasterIngressController(options());
  let notifications = 0;
  controller.subscribeEligibilityChange(() => { throw new Error('observer failure'); });
  const unsubscribe = controller.subscribeEligibilityChange(() => { notifications += 1; });
  attachFake(controller, { status: async () => status() });

  await controller.status();
  expect(notifications).toBe(1);
  await controller.disconnect();
  expect(notifications).toBe(3);
  unsubscribe();
  await controller.status().catch(() => undefined);
  expect(notifications).toBe(3);
});

test('ambiguous signed commit status enters recovery before throwing', async () => {
  const controller = new MasterIngressController(options());
  const client: Partial<IngressControllerClient> = {
    command: async () => undefined,
    status: async () => status(),
  };
  attachFake(controller, client);

  const prepared = await controller.prepare([worker()]);
  await expect(prepared.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(controller.currentState).toBe('control_recovering');
  await controller.disconnect();
});

test('reuses an identical uncertain admission instead of replacing it', async () => {
  const controller = new MasterIngressController(options());
  const target = (controller as unknown as { toAdmissionSet(workers: readonly ServingConfigWorker[]): AdmissionSet }).toAdmissionSet([worker()]);
  const internal = controller as unknown as {
    beginUncertainAdmission(set: AdmissionSet): void;
    uncertainAdmission: { readonly target: AdmissionSet; readonly identity: string } | null;
  };
  internal.beginUncertainAdmission(target);
  const original = internal.uncertainAdmission;
  internal.beginUncertainAdmission({ ...target, workers: target.workers.map((entry) => ({ ...entry })) });
  expect(internal.uncertainAdmission).toBe(original);
  await controller.disconnect();
});

test('rejects a conflicting prepared handle without overwriting uncertain identity', async () => {
  const controller = new MasterIngressController(options());
  const target = (controller as unknown as { toAdmissionSet(workers: readonly ServingConfigWorker[]): AdmissionSet }).toAdmissionSet([worker()]);
  const conflicting = { ...target, admission_sequence: target.admission_sequence + 1 };
  const internal = controller as unknown as {
    beginUncertainAdmission(set: AdmissionSet): void;
    uncertainAdmission: { readonly target: AdmissionSet; readonly identity: string } | null;
  };
  internal.beginUncertainAdmission(target);
  const original = internal.uncertainAdmission;
  expect(() => internal.beginUncertainAdmission(conflicting)).toThrow(/different uncertain admission/);
  expect(internal.uncertainAdmission).toBe(original);
  await controller.disconnect();
});

test('a second prepared handle cannot commit over the first handle in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let commitTarget: AdmissionSet | null = null;
  let commitStarted!: () => void;
  const started = new Promise<void>((resolve) => { commitStarted = resolve; });
  const controller = new MasterIngressController(options());
  attachFake(controller, {
    command: async (...args: unknown[]) => {
      if (args[2] !== '/commit') return;
      commitTarget = args[3] as AdmissionSet;
      commitStarted();
      await gate;
    },
    status: async () => status({ active: commitTarget, prepared: null, retired: [] }),
  });
  const first = await controller.prepare([worker()]);
  const secondWorker = { ...worker(), private_port: 40_001 };
  const second = await controller.prepare([secondWorker]);
  const firstCommit = first.commit();
  await started;
  await expect(second.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });
  const uncertain = (controller as unknown as { uncertainAdmission: { readonly target: AdmissionSet } }).uncertainAdmission;
  expect(commitTarget).not.toBeNull();
  expect(uncertain.target).toEqual(commitTarget!);
  release();
  await firstCommit;
  await controller.disconnect();
});

test('a prepared handle conflict remains rejected while the first resolution callback is pending', async () => {
  let releaseCommand!: () => void;
  const commandGate = new Promise<void>((resolve) => { releaseCommand = resolve; });
  let releaseCallback!: () => void;
  const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
  let commitTarget: AdmissionSet | null = null;
  let callbackStarted!: () => void;
  const callbackReady = new Promise<void>((resolve) => { callbackStarted = resolve; });
  const controller = new MasterIngressController({ ...options(), onAdmissionResolved: async () => {
    callbackStarted();
    await callbackGate;
  }});
  attachFake(controller, {
    command: async (...args: unknown[]) => {
      if (args[2] === '/commit') { commitTarget = args[3] as AdmissionSet; await commandGate; }
    },
    status: async () => status({ active: commitTarget, prepared: null, retired: [] }),
  });
  const first = await controller.prepare([worker()]);
  const second = await controller.prepare([{ ...worker(), private_port: 40_002 }]);
  const firstCommit = first.commit();
  releaseCommand();
  await callbackReady;
  await expect(second.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });
  releaseCallback();
  await firstCommit;
  await controller.disconnect();
});

test('generation cancellation acknowledges quiescence before the next queue item starts', async () => {
  const events: string[] = [];
  const controller = new MasterIngressController(options());
  const internal = controller as unknown as {
    enqueueTask<Result>(operation: (signal: AbortSignal) => Promise<Result>, parentSignal?: AbortSignal): {
      result: Promise<Result>;
      quiesced: Promise<void>;
    };
    client: IngressControllerClient;
    state: 'attached';
    disconnected: boolean;
  };
  const first = internal.enqueueTask(async (signal) => {
    events.push('first-start');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => {
      events.push('abort-ack');
      resolve();
    }, { once: true }));
    return 'old';
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.stopRecovery();
  internal.disconnected = false;
  internal.state = 'attached';
  internal.client = {} as IngressControllerClient;
  const next = internal.enqueueTask(async () => { events.push('next-start'); return 'new'; });

  await expect(first.result).rejects.toBeDefined();
  await expect(next.result).resolves.toBe('new');
  expect(events).toEqual(['first-start', 'abort-ack', 'next-start']);
  await controller.disconnect();
});

test('short queue deadline aborts, quiesces, fences first, and disambiguates without late commit', async () => {
  const target = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  } as AdmissionSet;
  for (const kind of ['active', 'prepared', 'absent'] as const) {
    const events: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    let recoveryCommit = false;
    let recoveryStarted = false;
    let commitCalls = 0;
    const controller = new MasterIngressController({ ...options(), startupTimeoutMs: 20,
      onAdmissionResolved: ({ outcome }) => { events.push(`resolved:${outcome}`); },
    });
    attachFake(controller, {
      command: async (...args: unknown[]) => {
        const path = String(args[2]);
        events.push(path);
        if (path !== '/commit') return;
        commitCalls += 1;
        recoveryCommit = true;
      },
      fence: async () => {
        events.push('/admission/fence');
        return status({
          active: kind === 'active' ? target : null,
          prepared: kind === 'prepared' ? target : null,
          retired: [],
        });
      },
      lease: async () => status({ active: kind === 'active' || recoveryCommit ? target : null, prepared: null, retired: [] }),
      status: async () => {
        if (recoveryStarted) await Bun.sleep(35);
        return status({ active: kind === 'active' || recoveryCommit ? target : null, prepared: null, retired: [] });
      },
    });
    process.on('unhandledRejection', onUnhandled);
    try {
      const prepared = await controller.prepare([worker()]);
      const internal = controller as unknown as {
        enqueueTask<Result>(operation: (signal: AbortSignal) => Promise<Result>): { result: Promise<Result>; quiesced: Promise<void> };
      };
      const hung = internal.enqueueTask(async (signal) => {
        events.push('hung-start');
        await new Promise<void>((resolve) => {
          if (signal.aborted) { events.push('abort-ack'); resolve(); return; }
          signal.addEventListener('abort', () => { events.push('abort-ack'); resolve(); }, { once: true });
        });
      });
      void hung.result.catch(() => undefined);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      recoveryStarted = true;
      const committing = prepared.commit();
      if (kind === 'absent') await expect(committing).rejects.toMatchObject({ code: 'admission_not_committed' });
      else await expect(committing).resolves.toBeUndefined();
      const abortIndex = events.indexOf('abort-ack');
      await hung.quiesced;
      const fenceIndex = events.indexOf('/admission/fence');
      expect(abortIndex).toBeGreaterThanOrEqual(0);
      expect(fenceIndex).toBeGreaterThan(abortIndex);
      expect(events.indexOf('resolved:not_committed') >= 0).toBe(kind === 'absent');
      expect(events.indexOf('resolved:committed') >= 0).toBe(kind !== 'absent');
      expect(commitCalls).toBe(kind === 'prepared' ? 1 : 0);
      expect(events.slice(fenceIndex + 1).filter((event) => event === '/commit').length).toBe(kind === 'prepared' ? 1 : 0);
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await controller.disconnect();
    }
  }
});

test('prepared commit execution deadline recovers the original promise without a late commit', async () => {
  const target = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  } as AdmissionSet;
  for (const kind of ['active', 'prepared', 'absent'] as const) {
    const events: string[] = [];
    const unhandled: unknown[] = [];
    let commitCalls = 0;
    let commitAbortAck = false;
    let recoveryCommit = false;
    const controller = new MasterIngressController({ ...options(), startupTimeoutMs: 20,
      onAdmissionResolved: ({ outcome }) => { events.push(`resolved:${outcome}`); },
    });
    attachFake(controller, {
      command: async (...args: unknown[]) => {
        const path = String(args[2]);
        if (path !== '/commit') return;
        commitCalls += 1;
        events.push('/commit');
        const signal = args[5] as AbortSignal;
        if (commitCalls > 1) { recoveryCommit = true; return; }
        await new Promise<void>((resolve) => {
          if (signal.aborted) { commitAbortAck = true; events.push('commit-abort-ack'); resolve(); return; }
          signal.addEventListener('abort', () => { commitAbortAck = true; events.push('commit-abort-ack'); resolve(); }, { once: true });
        });
      },
      fence: async () => {
        events.push('/admission/fence');
        return status({ active: kind === 'active' ? target : null, prepared: kind === 'prepared' ? target : null, retired: [] });
      },
      lease: async () => status({ active: kind === 'active' || recoveryCommit ? target : null, prepared: null, retired: [] }),
      status: async () => status({ active: kind === 'active' || recoveryCommit ? target : null, prepared: null, retired: [] }),
    });
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const prepared = await controller.prepare([worker()]);
      const committing = prepared.commit();
      if (kind === 'active' || kind === 'prepared') await expect(committing).resolves.toBeUndefined();
      else await expect(committing).rejects.toMatchObject({ code: 'admission_not_committed' });
      expect(commitAbortAck).toBeTrue();
      expect(events.indexOf('/admission/fence')).toBeGreaterThan(events.indexOf('commit-abort-ack'));
      expect(commitCalls).toBe(kind === 'prepared' ? 2 : 1);
      expect(events.filter((event) => event === '/commit')).toHaveLength(kind === 'prepared' ? 2 : 1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await controller.disconnect();
    }
  }
});

test('prepare execution deadline recovers the original promise from signed prepared, active, or absent state', async () => {
  const target = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  } as AdmissionSet;
  for (const kind of ['prepared', 'active', 'absent'] as const) {
    const events: string[] = [];
    const unhandled: unknown[] = [];
    let prepareCalls = 0;
    const controller = new MasterIngressController({ ...options(), startupTimeoutMs: 20 });
    attachFake(controller, {
      command: async (...args: unknown[]) => {
        if (args[2] !== '/prepare') return;
        prepareCalls += 1;
        events.push('/prepare');
        const signal = args[5] as AbortSignal;
        await new Promise<void>((resolve) => {
          if (signal.aborted) { events.push('prepare-abort-ack'); resolve(); return; }
          signal.addEventListener('abort', () => { events.push('prepare-abort-ack'); resolve(); }, { once: true });
        });
      },
      fence: async () => {
        events.push('/admission/fence');
        return status({ active: kind === 'active' ? target : null, prepared: kind === 'prepared' ? target : null, retired: [] });
      },
      lease: async () => status({ active: kind === 'active' ? target : null, prepared: kind === 'prepared' ? target : null, retired: [] }),
      status: async () => status({ active: kind === 'active' ? target : null, prepared: kind === 'prepared' ? target : null, retired: [] }),
    });
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const preparing = controller.prepare([worker()]);
      if (kind === 'absent') await expect(preparing).rejects.toMatchObject({ code: 'admission_not_committed' });
      else await expect(preparing).resolves.toBeDefined();
      expect(events.indexOf('/admission/fence')).toBeGreaterThan(events.indexOf('prepare-abort-ack'));
      expect(prepareCalls).toBe(1);
      expect(events.filter((event) => event === '/prepare')).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await controller.disconnect();
    }
  }
});

test('recovery fences first and resolves active, prepared, and absent uncertain states', async () => {
  const target = {
    master_generation: GENERATION, admission_sequence: 9, revision: 9,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  } as AdmissionSet;
  for (const kind of ['active', 'prepared', 'absent'] as const) {
    const calls: string[] = [];
    const controller = new MasterIngressController(options());
    const active = kind === 'active' ? target : null;
    const prepared = kind === 'prepared' ? target : null;
    attachFake(controller, {
      fence: async () => { calls.push('/admission/fence'); return status({ active, prepared, retired: [] }); },
      command: async (...args: unknown[]) => { calls.push(String(args[2])); },
      status: async () => status({ active: kind === 'prepared' ? target : null, prepared: null, retired: [] }),
    });
    (controller as unknown as { uncertainAdmission: unknown }).uncertainAdmission = {
      target, identity: admissionSetIdentity(target), previousActive: null,
      pendingResolution: null, resolutionPromise: null,
    };
    const internal = controller as unknown as {
      resolveUncertain(value: IngressStatusPayload, scope?: unknown, signal?: AbortSignal, fenceFirst?: boolean): Promise<string | null>;
    };
    await expect(internal.resolveUncertain(status(), undefined, undefined, true)).resolves.toBe(kind === 'absent' ? 'not_committed' : 'committed');
    expect(calls[0]).toBe('/admission/fence');
    if (kind === 'prepared') expect(calls).toEqual(['/admission/fence', '/commit']);
    else expect(calls).toEqual(['/admission/fence']);
    await controller.disconnect();
  }
});

test('uncertain admission callback is concurrent at-most-once and retries after callback failure', async () => {
  const admission = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ master_generation: GENERATION, worker_instance_id: worker().process.identity.worker_instance_id,
      boot_nonce: worker().boot_nonce!, worker_slot: 0, private_port: 40_000 }],
  };
  let statusCalls = 0;
  let commandCalls = 0;
  let callbackCalls = 0;
  let markCallbackStarted!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { markCallbackStarted = resolve; });
  let releaseCallback!: () => void;
  const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
  let failCallback = true;
  const controller = new MasterIngressController({ ...options(), onAdmissionResolved: async () => {
    callbackCalls += 1;
    if (callbackCalls === 1) { markCallbackStarted(); await callbackGate; }
    if (failCallback) { failCallback = false; throw new Error('cleanup retry'); }
  }});
  attachFake(controller, {
    command: async () => { commandCalls += 1; },
    status: async () => status(statusCalls++ === 0 ? undefined : { active: admission, prepared: null, retired: [] }),
  });

  const prepared = await controller.prepare([worker()]);
  const first = prepared.commit();
  await callbackStarted;
  const concurrent = prepared.commit();
  releaseCallback();
  // The first callback deliberately fails; the concurrent caller observes the same result.
  const failures = await Promise.allSettled([first, concurrent]);
  expect(failures.every((result) => result.status === 'rejected')).toBe(true);
  expect(failures[0]).toMatchObject({ reason: { message: 'cleanup retry' } });
  expect(failures[1]).toMatchObject({ reason: { message: 'cleanup retry' } });
  expect(callbackCalls).toBe(1);
  expect(commandCalls).toBe(2);

  await prepared.commit();
  expect(callbackCalls).toBe(2);
  await controller.disconnect();
});

test('recovery callback runs after the controller queue and may call controller APIs', async () => {
  let controller!: MasterIngressController;
  let callbackCalls = 0;
  controller = new MasterIngressController(options(async () => {
    callbackCalls += 1;
    await controller.status();
    const prepared = await controller.prepare([worker()]);
    await prepared.abort();
  }));
  const client: Partial<IngressControllerClient> = {
    command: async () => undefined,
    status: async () => status(),
    lease: async () => status(),
  };
  attachFake(controller, client);
  (controller as unknown as { state: 'control_recovering' }).state = 'control_recovering';

  await controller.recover();

  expect(callbackCalls).toBe(1);
  expect(controller.currentState).toBe('attached');
  await controller.disconnect();
});

test('a malformed recovery identity retains the old authenticated session and never publishes a candidate', async () => {
  const oldIdentity = {
    role: 'ingress' as const,
    process_instance_id: '70000000-0000-4000-8000-000000000001',
    boot_nonce: '70000000-0000-4000-8000-000000000002',
  };
  const controller = new MasterIngressController({
    ...options(),
    fetch: async () => Response.json({ role: 'ingress', process_instance_id: 'not-a-uuid' }),
  });
  attachFake(controller, { status: async () => { throw new Error('old ingress unavailable'); } });
  const internal = controller as unknown as {
    state: 'control_recovering';
    authenticatedIngressIdentity: typeof oldIdentity;
  };
  internal.state = 'control_recovering';
  internal.authenticatedIngressIdentity = oldIdentity;

  await expect(controller.recover()).rejects.toThrow('ingress discovery identity is invalid');
  expect(controller.authenticatedRateLimitSession()).toEqual({
    supervisionPort: 3010,
    expectedIngress: { process_instance_id: oldIdentity.process_instance_id, boot_nonce: oldIdentity.boot_nonce },
  });
  await controller.disconnect();
});

test('Bun ConnectionRefused discovery triggers ingress spawn', async () => {
  let spawns = 0;
  const controller = new MasterIngressController({
    ...options(),
    fetch: async () => { throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }); },
    spawn: (() => { spawns += 1; throw new Error('spawned'); }) as never,
  });

  await expect(controller.connect()).rejects.toThrow('spawned');
  expect(spawns).toBe(1);
  await controller.disconnect();
});

test('ingress script and compiled launches retain their shape and carry exact replacement markers', async () => {
  const markers: string[] = [];
  const processInstanceIds: string[] = [];
  for (const entry of ['/tmp/ingress.ts', process.execPath] as const) {
    let captured: readonly string[] | undefined;
    let processInstanceId: string | undefined;
    const controller = new MasterIngressController({
      ...options(), entry, transportSecret: 'ingress-supervision-secret',
      environment: { BUNGEE_DAEMON_SHUTDOWN_SECRET: 'ingress-shutdown-secret' },
      fetch: async () => { throw Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' }); },
      spawn: ((_executable: string, args: readonly string[], spawnOptions: { readonly env?: NodeJS.ProcessEnv }) => {
        captured = args;
        const serialized = spawnOptions.env?.BUNGEE_INGRESS_CREDENTIAL;
        if (serialized === undefined) throw new Error('missing ingress credential');
        processInstanceId = credentialFromSerialized(serialized).identity.process_instance_id;
        throw new Error('marker capture');
      }) as never,
    });
    await expect(controller.connect()).rejects.toThrow('marker capture');
    const marker = captured?.at(-1);
    expect(processInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(marker).toBe(`--bungee-process-identity=${processInstanceId}`);
    expect(captured).toEqual([entry, `--bungee-process-identity=${processInstanceId}`]);
    expect(captured?.filter((value) => value.startsWith('--bungee-process-identity=')).length).toBe(1);
    expect(captured?.join(' ')).not.toContain('ingress-shutdown-secret');
    expect(captured?.join(' ')).not.toContain('ingress-supervision-secret');
    markers.push(marker!);
    processInstanceIds.push(processInstanceId!);
    await controller.disconnect();
  }
  expect(processInstanceIds[0]).not.toBe(processInstanceIds[1]);
  expect(markers[0]).not.toBe(markers[1]);
});

test('adoption does not spawn and exposes the descriptor process_instance_id through the authenticated API', async () => {
  const descriptorIdentity = identity(
    '70000000-0000-4000-8000-000000000010',
    '70000000-0000-4000-8000-000000000011',
  );
  const baseOptions = options();
  const server = new IngressSupervisionHttpServer({
    credential: deriveSupervisionProcessKey(new Uint8Array(32), baseOptions.instanceId, 'ingress',
      descriptorIdentity.process_instance_id, descriptorIdentity.boot_nonce),
    registry: new IngressAdmissionRegistry(),
  });
  let spawns = 0;
  const controller = new MasterIngressController({
    ...baseOptions,
    fetch: (input, init) => server.fetch(new Request(input, init)),
    spawn: (() => { spawns += 1; throw new Error('adoption must not spawn'); }) as never,
  });
  try {
    await controller.connect();
    expect(spawns).toBe(0);
    expect(controller.origin).toBe('adopted');
    expect(controller.authenticatedRateLimitSession()).toEqual({
      supervisionPort: baseOptions.controlPort,
      expectedIngress: {
        process_instance_id: descriptorIdentity.process_instance_id,
        boot_nonce: descriptorIdentity.boot_nonce,
      },
    });
  } finally {
    await controller.disconnect();
    server.stop();
  }
});

test('unknown, aborted, and malformed discovery results never spawn ingress', async () => {
  const failures = [
    { fetch: async () => { throw new Error('Unable to connect. Is the computer able to access the url?'); }, code: 'outcome_unknown' },
    { fetch: async () => { const error = new Error('request aborted'); error.name = 'AbortError'; throw error; }, code: 'outcome_unknown' },
    { fetch: async () => Response.json({ role: 'ingress', process_instance_id: 'not-a-uuid' }), code: 'identity_mismatch' },
  ];
  for (const failure of failures) {
    let spawns = 0;
    const controller = new MasterIngressController({
      ...options(), fetch: failure.fetch,
      spawn: (() => { spawns += 1; throw new Error('must not spawn'); }) as never,
    });

    await expect(controller.connect()).rejects.toMatchObject({ code: failure.code });
    expect(spawns).toBe(0);
    await controller.disconnect();
  }
});

test('timed-out discovery never spawns ingress', async () => {
  let spawns = 0;
  const controller = new MasterIngressController({
    ...options(),
    fetch: () => new Promise<Response>(() => undefined),
    spawn: (() => { spawns += 1; throw new Error('must not spawn'); }) as never,
  });

  await expect(controller.connect()).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(spawns).toBe(0);
  await controller.disconnect();
});

test('a new ingress boot drops old uncertain and retired admission state without resolving it', () => {
  const controller = new MasterIngressController(options());
  const target = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  };
  const internal = controller as unknown as {
    uncertainAdmission: unknown;
    pendingRetiredRelease: unknown;
    resetForNewBoot(): void;
  };
  internal.uncertainAdmission = { target, previousActive: null, pendingResolution: null, resolutionPromise: null };
  internal.pendingRetiredRelease = { identity: 'old-boot', set: target };
  internal.resetForNewBoot();
  expect(internal.uncertainAdmission).toBeNull();
  expect(internal.pendingRetiredRelease).toBeNull();
});

test('an old admission handle cannot resolve against a replacement ingress boot', async () => {
  let phase: 'prepare' | 'commit' = 'prepare';
  let markStatusStarted!: () => void;
  const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
  let releaseStatus!: () => void;
  const delayedStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
  let resolved = 0;
  const oldCommands: string[] = [];
  const replacementCommands: string[] = [];
  const controller = new MasterIngressController({ ...options(), onAdmissionResolved: () => { resolved += 1; } });
  attachFake(controller, {
    command: async (...args: unknown[]) => { oldCommands.push(String(args[2])); },
    status: async () => {
      if (phase === 'commit') { markStatusStarted(); await delayedStatus; }
      return status();
    },
  });
  const handle = await controller.prepare([worker()]);
  phase = 'commit';
  const committing = handle.commit();
  await statusStarted;
  const internal = controller as unknown as {
    bootGeneration: number;
    connectionGeneration: number;
    client: IngressControllerClient;
    authenticatedIngressIdentity: { role: 'ingress'; process_instance_id: string; boot_nonce: string };
  };
  internal.bootGeneration += 1;
  internal.connectionGeneration += 1;
  internal.authenticatedIngressIdentity = {
    role: 'ingress', process_instance_id: '70000000-0000-4000-8000-000000000003',
    boot_nonce: '70000000-0000-4000-8000-000000000004',
  };
  internal.client = { command: async (...args: unknown[]) => { replacementCommands.push(String(args[2])); }, status: async () => status() } as unknown as IngressControllerClient;
  releaseStatus();

  await expect(committing).rejects.toMatchObject({ code: 'stale_boot' });
  expect(oldCommands).toEqual(['/prepare', '/commit']);
  expect(replacementCommands).toEqual([]);
  expect(resolved).toBe(0);
  await controller.disconnect();
});

test('coalesced recovery events rerun the callback after the current callback completes', async () => {
  let controller!: MasterIngressController;
  let callbackCalls = 0;
  controller = new MasterIngressController(options(async () => {
    callbackCalls += 1;
    if (callbackCalls === 1) await (controller as unknown as { invokeRecovered(): Promise<void> }).invokeRecovered();
  }));
  attachFake(controller, {
    status: async () => status(),
    lease: async () => status(),
  });
  (controller as unknown as { state: 'control_recovering' }).state = 'control_recovering';

  await controller.recover();

  expect(callbackCalls).toBe(2);
  await controller.disconnect();
});

test('a failed recovery callback returns to recovering and schedules another recovery', async () => {
  const controller = new MasterIngressController(options(() => { throw new Error('resume failed'); }));
  attachFake(controller, {
    command: async () => undefined,
    status: async () => status(),
    lease: async () => status(),
  });
  (controller as unknown as { state: 'control_recovering' }).state = 'control_recovering';

  await expect(controller.recover()).rejects.toThrow('resume failed');
  expect(controller.currentState).toBe('control_recovering');
  await controller.disconnect();
});

test('typed retryable recovery schedules backoff while typed fatal recovery does not retry', async () => {
  for (const result of ['retryable', 'fatal'] as const) {
    const controller = new MasterIngressController(options(() => result));
    attachFake(controller, {
      status: async () => status(),
      lease: async () => status(),
    });
    (controller as unknown as { state: 'control_recovering' }).state = 'control_recovering';

    await controller.recover();

    const internal = controller as unknown as { leaseTimer: ReturnType<typeof setTimeout> | null };
    expect(controller.currentState).toBe('control_recovering');
    if (result === 'retryable') expect(internal.leaseTimer).not.toBeNull();
    else expect(internal.leaseTimer).toBeNull();
    await controller.disconnect();
  }
});

test('release uses the exact previous active admission and confirms it is gone', async () => {
  const calls: string[] = [];
  const old = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ master_generation: GENERATION, worker_instance_id: '60000000-0000-4000-8000-000000000001',
      boot_nonce: '70000000-0000-4000-8000-000000000001', worker_slot: 0, private_port: 40_001 }],
  };
  const target = { ...old, workers: [{ ...old.workers[0]!, boot_nonce: worker().boot_nonce!, private_port: 40_000 }] };
  const controller = new MasterIngressController(options());
  attachFake(controller, {
    command: async (...args: unknown[]) => { calls.push(String(args[2])); },
    status: async () => {
      const last = calls.at(-1);
      return last === '/prepare'
        ? status({ active: old, prepared: target, retired: [] })
        : status({ active: target, prepared: null, retired: [] });
    },
  });

  const prepared = await controller.prepare([worker()]);
  await prepared.releaseRetiredAfterExitProof?.();

  expect(calls).toEqual(['/prepare', '/release-retired']);
  await controller.disconnect();
});

test('release ACK loss is resolved by signed status, while loss of both stays pending until recovery', async () => {
  const old = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ master_generation: GENERATION, worker_instance_id: '60000000-0000-4000-8000-000000000001',
      boot_nonce: '70000000-0000-4000-8000-000000000001', worker_slot: 0, private_port: 40_001 }],
  };
  let loseStatus = false;
  let loseReleaseAck = true;
  let statusCalls = 0;
  const controller = new MasterIngressController(options());
  attachFake(controller, {
    command: async (...args: unknown[]) => {
      if (args[2] === '/release-retired' && loseReleaseAck) throw new Error('release ACK lost');
    },
    status: async () => {
      statusCalls += 1;
      if (statusCalls < 4) return status({ active: old, prepared: null, retired: [] });
      if (loseStatus) throw new Error('release status lost');
      return status({ active: old, prepared: null, retired: [] });
    },
    lease: async () => status({ active: old, prepared: null, retired: [] }),
  });

  const prepared = await controller.prepare([worker()]);
  await prepared.releaseRetiredAfterExitProof?.();
  loseReleaseAck = false;
  loseStatus = true;
  const pending = await controller.prepare([worker()]);
  const release = pending.releaseRetiredAfterExitProof?.() ?? Promise.resolve();
  await expect(release).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(controller.currentState).toBe('control_recovering');
  await controller.disconnect();
});

test('disconnect and stop(false) release adopted and spawned handles without control-plane shutdown', async () => {
  for (const origin of ['adopted', 'spawned'] as const) {
    const calls: string[] = [];
    const child = { kill: () => { calls.push('kill'); return true; } };
    const controller = new MasterIngressController(options());
    attachFake(controller, {
      command: async (...args: unknown[]) => { calls.push(String(args[2])); },
      status: async () => status(),
    }, origin);
    (controller as unknown as { child: unknown }).child = child;

    await controller.stop(false);

    expect(calls).toEqual([]);
    expect(controller.currentState).toBe('stopped');
    expect(controller.origin).toBe(origin);
  }
});

test('shutdownDataPlane sends shutdown and only terminates a spawned ingress', async () => {
  for (const origin of ['adopted', 'spawned'] as const) {
    const calls: string[] = [];
    const controller = new MasterIngressController(options());
    attachFake(controller, {
      command: async (...args: unknown[]) => { calls.push(String(args[2])); },
      status: async () => status(),
    }, origin);
    (controller as unknown as { child: unknown }).child = { kill: () => { calls.push('kill'); return true; } };

    await controller.shutdownDataPlane();

    expect(calls).toEqual(origin === 'spawned' ? ['/shutdown', 'kill'] : ['/shutdown']);
  }
});

test('lifecycle cleanup is safe before connect', async () => {
  const controller = new MasterIngressController(options());
  await controller.disconnect();
  await controller.shutdownDataPlane();
  await controller.stop(false);
  expect(controller.currentState).toBe('stopped');
});

test('startup failure cleanup follows ingress ownership evidence', async () => {
  const active = {
    master_generation: GENERATION, admission_sequence: 1, revision: 1,
    content_hash: HASH, plugin_catalog_hash: CATALOG,
    workers: [{ ...worker().process.identity, boot_nonce: worker().boot_nonce!, private_port: 40_000 }],
  };
  const cases: readonly { origin: MasterIngressControllerOrigin; registry: IngressStatusPayload['registry']; uncertain?: boolean; statusFailure?: boolean; kind: 'preserved' | 'shutdown_safe_empty'; reason?: 'adopted' | 'active' | 'prepared' | 'uncertain' | 'status_unavailable'; expected: string[] }[] = [
    { origin: 'adopted', registry: { active, prepared: null, retired: [] }, kind: 'preserved', reason: 'adopted', expected: [] },
    { origin: 'spawned', registry: { active, prepared: null, retired: [] }, kind: 'preserved', reason: 'active', expected: [] },
    { origin: 'spawned', registry: { active: null, prepared: active, retired: [] }, kind: 'preserved', reason: 'prepared', expected: [] },
    { origin: 'spawned', registry: { active: null, prepared: null, retired: [] }, kind: 'shutdown_safe_empty', expected: ['/shutdown', 'kill'] },
    { origin: 'spawned', registry: { active: null, prepared: null, retired: [] }, uncertain: true, kind: 'preserved', reason: 'uncertain', expected: [] },
    { origin: 'spawned', registry: { active: null, prepared: null, retired: [] }, statusFailure: true, kind: 'preserved', reason: 'status_unavailable', expected: [] },
  ];
  for (const entry of cases) {
    const calls: string[] = [];
    const controller = new MasterIngressController(options());
    attachFake(controller, {
      command: async (...args: unknown[]) => { calls.push(String(args[2])); },
      status: async () => {
        if (entry.statusFailure) throw new Error('status refresh failed');
        return status(entry.registry);
      },
    }, entry.origin);
    (controller as unknown as { child: { kill(): void } }).child = { kill: () => { calls.push('kill'); } };
    if (entry.uncertain) (controller as unknown as { uncertainAdmission: unknown }).uncertainAdmission = {};

    const disposition = await controller.cleanupAfterStartupFailure();

    expect(calls).toEqual(entry.expected);
    expect(disposition.kind).toBe(entry.kind);
    if (disposition.kind === 'preserved' && entry.reason !== undefined) expect(disposition.evidence.reason).toBe(entry.reason);
    if (entry.reason === 'active') expect(disposition.evidence.registry?.active).not.toBeNull();
    if (entry.reason === 'prepared') {
      expect(disposition.evidence.registry?.active).toBeNull();
      expect(disposition.evidence.registry?.prepared).not.toBeNull();
    }
    if (entry.reason === 'status_unavailable') {
      expect(disposition.evidence.registry).toBeNull();
      expect(disposition.evidence.statusRefreshed).toBeFalse();
    }
    expect(Object.isFrozen(disposition)).toBeTrue();
    expect(Object.isFrozen(disposition.evidence)).toBeTrue();
    if (disposition.evidence.registry !== null) expect(Object.isFrozen(disposition.evidence.registry)).toBeTrue();
    if (entry.registry.active !== null || entry.registry.prepared !== null) {
      expect(disposition.evidence.registry).toEqual(entry.registry);
    }
  }
});

test('MC-BCD coalesces a queued boot chain from B to D', async () => {
  const events: string[] = [];
  const controller = new MasterIngressController({
    ...options(), onRecovered: (event) => {
      if (event.kind === 'new_boot') events.push(`${event.previous.boot_nonce}->${event.current.boot_nonce}`);
    },
  });
  attachFake(controller, { status: async () => status(), lease: async () => status() });
  const internal = controller as unknown as {
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
    invokeRecovered(): Promise<void>;
  };
  const b = identity('60000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002');
  const c = identity('60000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000004');
  const d = identity('60000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000006');
  internal.acceptNewBoot(b, c, undefined, status(), 'adopted');
  internal.acceptNewBoot(c, d, undefined, status(), 'adopted');
  await internal.invokeRecovered();
  expect(events).toEqual(['60000000-0000-4000-8000-000000000002->60000000-0000-4000-8000-000000000006']);
  await controller.disconnect();
});

test('pending new boots preserve the first previous boot and latest current token', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let callbackCalls = 0;
  const controller = new MasterIngressController({
    ...options(), onRecovered: async (event) => {
      if (event.kind !== 'new_boot') return;
      events.push(`${event.previous.boot_nonce}->${event.current.boot_nonce}`);
      if (++callbackCalls === 1) await gate;
    },
  });
  attachFake(controller, { status: async () => status(), lease: async () => status() });
  const internal = controller as unknown as {
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
    invokeRecovered(): Promise<void>;
  };
  const b = identity('61000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002');
  const c = identity('61000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000004');
  const d = identity('61000000-0000-4000-8000-000000000005', '61000000-0000-4000-8000-000000000006');
  const e = identity('61000000-0000-4000-8000-000000000007', '61000000-0000-4000-8000-000000000008');
  internal.acceptNewBoot(b, c, undefined, status(), 'adopted');
  const running = internal.invokeRecovered();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  internal.acceptNewBoot(c, d, undefined, status(), 'adopted');
  internal.acceptNewBoot(d, e, undefined, status(), 'adopted');
  release();
  await running;
  expect(events).toEqual([
    '61000000-0000-4000-8000-000000000002->61000000-0000-4000-8000-000000000004',
    '61000000-0000-4000-8000-000000000004->61000000-0000-4000-8000-000000000008',
  ]);
  await controller.disconnect();
});

test('stale fatal recovery cannot disable the latest boot recovery', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new MasterIngressController({
    ...options(), onRecovered: async (event) => {
      if (event.kind !== 'new_boot') return 'complete';
      events.push(`${event.previous.boot_nonce}->${event.current.boot_nonce}`);
      if (events.length === 1) { await gate; return 'fatal'; }
      return 'retryable';
    },
  });
  attachFake(controller, { status: async () => status(), lease: async () => status() });
  const internal = controller as unknown as {
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
    invokeRecovered(): Promise<void>;
    recoveryTokenActive: boolean;
    pendingNewBootEvent: unknown;
    leaseTimer: ReturnType<typeof setTimeout> | null;
    sessionPublicationAllowed: boolean;
  };
  const b = identity('62000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000002');
  const c = identity('62000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000004');
  const d = identity('62000000-0000-4000-8000-000000000005', '62000000-0000-4000-8000-000000000006');
  internal.acceptNewBoot(b, c, undefined, status(), 'adopted');
  const running = internal.invokeRecovered();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  internal.acceptNewBoot(c, d, undefined, status(), 'adopted');
  release();
  await running;
  expect(events).toEqual([
    '62000000-0000-4000-8000-000000000002->62000000-0000-4000-8000-000000000004',
    '62000000-0000-4000-8000-000000000004->62000000-0000-4000-8000-000000000006',
  ]);
  expect(internal.recoveryTokenActive).toBeTrue();
  expect(internal.pendingNewBootEvent).toBeNull();
  expect(internal.leaseTimer).not.toBeNull();
  expect(internal.sessionPublicationAllowed).toBeTrue();
  await controller.disconnect();
});

test('fenceAndStatus trusts the signed fence payload without a second status call', async () => {
  let statusCalls = 0;
  const fenced = status({ active: null, prepared: worker() as never, retired: [] });
  const controller = new MasterIngressController(options());
  attachFake(controller, {
    fence: async () => fenced,
    status: async () => { statusCalls += 1; throw new Error('status must not be called'); },
  });
  await expect(controller.fenceAndStatus()).resolves.toEqual(fenced.registry);
  expect(statusCalls).toBe(0);
  expect((controller as unknown as { trustedStatus: IngressStatusPayload }).trustedStatus).toEqual(fenced);
  await controller.disconnect();
});

test('spawned boot invokes the recovery gate before spawnAndAttach resolves', async () => {
  const previous = identity('63000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002');
  const current = identity('63000000-0000-4000-8000-000000000003', '63000000-0000-4000-8000-000000000004');
  const observations: string[] = [];
  const controller = new MasterIngressController({
    ...options(), onNewBootAccepted: () => { observations.push('gate'); },
  });
  const internal = controller as unknown as {
    disconnected: boolean;
    lifecycleGeneration: number;
    state: 'attached' | 'control_recovering' | 'stopped';
    childCredential: unknown;
    waitForIdentityAfterSpawn(environment: NodeJS.ProcessEnv): Promise<ProcessIdentity>;
    spawnAndAttach(previous: ProcessIdentity): Promise<unknown>;
  };
  internal.disconnected = false;
  internal.lifecycleGeneration = 1;
  internal.state = 'control_recovering';
  internal.waitForIdentityAfterSpawn = async () => {
    internal.childCredential = { identity: current, process_key: new Uint8Array(32) };
    return current;
  };

  const prototype = IngressControllerClient.prototype as any;
  const original = { identity: prototype.identity, challenge: prototype.challenge, attach: prototype.attach, status: prototype.status };
  prototype.identity = async () => current;
  prototype.challenge = async () => ({ challenge_nonce: 'nonce' });
  prototype.attach = async () => undefined;
  prototype.status = async () => status();
  try {
    const event = await internal.spawnAndAttach(previous) as { readonly token: number };
    observations.push(controller.authenticatedRateLimitSession(event.token) === null ? 'observer-missed' : 'observer');
    expect(observations).toEqual(['gate', 'observer']);
  } finally {
    prototype.identity = original.identity;
    prototype.challenge = original.challenge;
    prototype.attach = original.attach;
    prototype.status = original.status;
    await controller.disconnect();
  }
});

test('a same-boot callback dispatched on the old generation becomes stale after a new boot', async () => {
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new MasterIngressController({
    ...options(), onRecovered: async (event) => {
      events.push(event.kind);
      if (event.kind === 'same_boot') { await gate; return 'fatal'; }
      return 'complete';
    },
  });
  attachFake(controller, { status: async () => status(), lease: async () => status() });
  const internal = controller as unknown as {
    bootGeneration: number;
    recoveryEvent: unknown;
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
    invokeRecovered(): Promise<void>;
    recoveryTokenActive: boolean;
    sessionPublicationAllowed: boolean;
  };
  internal.recoveryEvent = { kind: 'same_boot', token: 0 };
  const running = internal.invokeRecovered();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const previous = identity('64000000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-000000000002');
  const current = identity('64000000-0000-4000-8000-000000000003', '64000000-0000-4000-8000-000000000004');
  internal.acceptNewBoot(previous, current, undefined, status(), 'adopted');
  release();
  await running;
  expect(events).toEqual(['same_boot', 'new_boot']);
  expect(internal.recoveryTokenActive).toBeFalse();
  expect(internal.sessionPublicationAllowed).toBeTrue();
  expect(controller.authenticatedRateLimitSession()).toEqual({
    supervisionPort: 3010,
    expectedIngress: { process_instance_id: current.process_instance_id, boot_nonce: current.boot_nonce },
  });
  await controller.disconnect();
});

test('spawn ownership survives replacement and graceful shutdown failure', async () => {
  const calls: string[] = [];
  const child = { kill: () => { calls.push('kill'); return true; } };
  const controller = new MasterIngressController(options());
  attachFake(controller, {
    command: async () => { throw new Error('graceful shutdown failed'); },
    status: async () => status(),
  }, 'spawned');
  const internal = controller as unknown as {
    child: unknown;
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
  };
  internal.child = child;
  const previous = identity('65000000-0000-4000-8000-000000000001', '65000000-0000-4000-8000-000000000002');
  const current = identity('65000000-0000-4000-8000-000000000003', '65000000-0000-4000-8000-000000000004');
  internal.acceptNewBoot(previous, current, undefined, status(), 'spawned');
  expect(controller.origin).toBe('spawned');
  expect(internal.child).toBe(child);
  await expect(controller.shutdownDataPlane()).rejects.toThrow('ingress controller shutdown failed');
  expect(calls).toEqual(['kill']);
});

test('the latest accepted boot publishes its token and identity while the prior callback is blocked', async () => {
  const accepted: Array<{ readonly token: number; readonly bootNonce: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let callbackCalls = 0;
  const controller = new MasterIngressController({
    ...options(),
    onNewBootAccepted: (event) => { accepted.push({ token: event.token, bootNonce: event.current.boot_nonce }); },
    onRecovered: async (event) => {
      if (++callbackCalls === 1) await gate;
      return event.kind === 'new_boot' ? 'complete' : undefined;
    },
  });
  attachFake(controller, { status: async () => status(), lease: async () => status() });
  const internal = controller as unknown as {
    acceptNewBoot(previous: ProcessIdentity, current: ProcessIdentity, client?: IngressControllerClient, attachedStatus?: IngressStatusPayload, origin?: MasterIngressControllerOrigin): unknown;
    invokeRecovered(): Promise<void>;
  };
  const b = identity('66000000-0000-4000-8000-000000000001', '66000000-0000-4000-8000-000000000002');
  const c = identity('66000000-0000-4000-8000-000000000003', '66000000-0000-4000-8000-000000000004');
  const d = identity('66000000-0000-4000-8000-000000000005', '66000000-0000-4000-8000-000000000006');
  internal.acceptNewBoot(b, c, undefined, status(), 'adopted');
  const running = internal.invokeRecovered();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  internal.acceptNewBoot(c, d, undefined, status(), 'adopted');
  expect(accepted).toEqual([
    { token: 1, bootNonce: c.boot_nonce },
    { token: 2, bootNonce: d.boot_nonce },
  ]);
  release();
  await running;
  await controller.disconnect();
});
