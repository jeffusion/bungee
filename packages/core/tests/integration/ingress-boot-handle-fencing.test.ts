import { expect, test } from 'bun:test';
import type { ServingConfigWorker } from '../../src/config-publication';
import type { AdmissionSet } from '../../src/ingress/admission-set';
import { MasterIngressController, type MasterIngressRecoveryEvent, type MasterIngressRecoveryResult } from '../../src/ingress/master-controller';
import { SupervisionProtocolError } from '../../src/supervision';
import type { CapturedProcessIdentity, ProcessIdentityProbe } from '../../src/master-runtime/process-identity';
import { PublicationTaskManager } from '../../src/master-runtime/publication-task-manager';
import { startIngressBoot, type IngressBootFixture } from '../fixtures/ingress-boot-handle-fencing-fixture';

const ROOT_KEY = new Uint8Array(32);
const INSTANCE_ID = '10000000-0000-4000-8000-000000000001';
const CONTROLLER_ID = '20000000-0000-4000-8000-000000000001';
const GENERATION = '30000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function waitWithTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function worker(id = '40000000-0000-4000-8000-000000000001', port = 40_001): ServingConfigWorker {
  return {
    process: {
      slot: 0,
      pid: 1,
      identity: { master_generation: GENERATION, worker_instance_id: id, worker_slot: 0 },
      send: async () => undefined,
      subscribeMessage: () => () => undefined,
      subscribeExit: () => () => undefined,
      terminate: async () => undefined,
    },
    boot_nonce: '50000000-0000-4000-8000-000000000001',
    revision: 1,
    content_hash: HASH,
    plugin_catalog_hash: CATALOG,
    private_port: port,
    publication: null,
  } as ServingConfigWorker;
}

function admission(sequence: number, workerId: string, nonce: string, port: number): AdmissionSet {
  return {
    master_generation: GENERATION,
    admission_sequence: sequence,
    revision: sequence,
    content_hash: HASH,
    plugin_catalog_hash: CATALOG,
    workers: [{
      master_generation: GENERATION,
      worker_instance_id: workerId,
      boot_nonce: nonce,
      worker_slot: 0,
      private_port: port,
    }],
  };
}

function controllerOptions(port: number, fetchImpl: FetchImplementation, callbacks: {
  readonly onRecovered?: (event: MasterIngressRecoveryEvent) => Promise<MasterIngressRecoveryResult | void> | MasterIngressRecoveryResult | void;
  readonly onNewBootAccepted?: (event: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }>) => void;
  readonly onAdmissionResolved?: (outcome: 'committed' | 'not_committed') => void;
  readonly probe?: (expected: CapturedProcessIdentity) => Promise<ProcessIdentityProbe>;
  readonly controllerEpoch?: number;
  readonly leaseDurationMs?: number;
  readonly startupTimeoutMs?: number;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
}) {
  return {
    rootKey: ROOT_KEY,
    instanceId: INSTANCE_ID,
    controllerId: CONTROLLER_ID,
    controllerEpoch: callbacks.controllerEpoch ?? 1,
    controlPort: port,
    publicHost: '127.0.0.1',
    publicPort: 1,
    instanceLockPath: '/tmp/bungee-ingress-boot-handle-fencing.lock',
    transportSecret: 'test-only',
    executable: process.execPath,
    entry: import.meta.path,
    cwd: import.meta.dir,
    leaseDurationMs: callbacks.leaseDurationMs ?? 1_000,
    startupTimeoutMs: callbacks.startupTimeoutMs,
    now: callbacks.now,
    monotonicNow: callbacks.monotonicNow,
    fetch: fetchImpl,
    // The fixture boots use synthetic process_instance_ids that the real OS capture must
    // reject; inject the unit-style fake so capture matches the signed status pid/marker.
    processIdentity: {
      capture: async (pid: number, processInstanceId: string): Promise<CapturedProcessIdentity> => ({
        pid, startToken: 'integration-fixture-start-token', executable: process.execPath, processInstanceId,
      }),
      probe: callbacks.probe ?? (async () => 'exact' as const),
    },
    onRecovered: callbacks.onRecovered,
    onNewBootAccepted: callbacks.onNewBootAccepted,
    onAdmissionResolved: callbacks.onAdmissionResolved === undefined ? undefined : ({ outcome }: { readonly outcome: 'committed' | 'not_committed' }) => callbacks.onAdmissionResolved!(outcome),
  };
}

test('old admission handles cannot cross an authenticated ingress boot fence after commit ACK and status loss', async () => {
  let oldBoot: IngressBootFixture | null = null;
  let replacement: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let dropOldResponses = false;
  let ownershipProbes = 0;
  const outcomes: string[] = [];
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const isCommand = url.pathname === '/__supervision/command';
    const command = isCommand && typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { readonly message?: { readonly path?: unknown } }).message?.path
      : undefined;
    const response = await fetch(input, init);
    if (dropOldResponses && (url.pathname === '/__supervision/status' || command === '/commit')) {
      await response.arrayBuffer(); // The signed request reached the old server; only its client response is lost.
      throw new Error('test transport response lost');
    }
    return response;
  };
  try {
    oldBoot = startIngressBoot({
      port: 0,
      rootKey: ROOT_KEY,
      instanceId: INSTANCE_ID,
      processInstanceId: '60000000-0000-4000-8000-000000000001',
      bootNonce: '60000000-0000-4000-8000-000000000002',
    });
    controller = new MasterIngressController(controllerOptions(oldBoot.port, interceptedFetch, {
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
      probe: async () => { ownershipProbes += 1; return 'exact'; },
    }));
    await controller.connect();
    const handle = await controller.prepare([worker()]);

    dropOldResponses = true;
    await expect(handle.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(oldBoot.commands.map(({ path }) => path)).toContain('/commit');
    expect(outcomes).not.toContain('not_committed');

    await oldBoot.stop();
    oldBoot = null;
    replacement = startIngressBoot({
      port: controller.controlPort,
      rootKey: ROOT_KEY,
      instanceId: INSTANCE_ID,
      processInstanceId: '70000000-0000-4000-8000-000000000001',
      bootNonce: '70000000-0000-4000-8000-000000000002',
      seed: [
        admission(41, '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004', 40_011),
      ],
    });
    dropOldResponses = false;
    const oldStatusError = await controller.status().catch((error: unknown) => error);
    expect(oldStatusError).toBeInstanceOf(SupervisionProtocolError);
    expect(oldStatusError).toMatchObject({ code: 'identity_mismatch' });

    const oldCommitError = await handle.commit().catch((error: unknown) => error);
    expect(oldCommitError).toMatchObject({ code: 'outcome_unknown' });
    const oldCommit = oldCommitError as { readonly cause?: unknown };
    const oldCommitCauses = oldCommit.cause instanceof AggregateError ? oldCommit.cause.errors : [];
    expect(oldCommitCauses.length).toBeGreaterThan(0);
    expect(oldCommitCauses.every((error: unknown) => error instanceof SupervisionProtocolError
      && error.code === 'identity_mismatch')).toBeTrue();
    const oldRecoveryError = await controller.recover().catch((error: unknown) => error);
    expect(oldRecoveryError).toMatchObject({ code: 'outcome_unknown' });
    expect(ownershipProbes).toBeGreaterThan(0);

    await controller.disconnect();
    expect(replacement.commands.filter(({ path }) => path === '/commit')).toHaveLength(1);
    controller = new MasterIngressController(controllerOptions(replacement.port, interceptedFetch, {
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
      controllerEpoch: 2,
    }));
    await controller.connect();
    const currentHandle = await controller.prepare([worker('90000000-0000-4000-8000-000000000001', 40_012)]);
    await currentHandle.commit();
    expect(controller.currentState).toBe('attached');
    expect(controller.authenticatedRateLimitSession()).toEqual({
      supervisionPort: replacement.port,
      expectedIngress: {
        process_instance_id: '70000000-0000-4000-8000-000000000001',
        boot_nonce: '70000000-0000-4000-8000-000000000002',
      },
    });
    expect(replacement.commands.filter(({ path }) => path === '/commit').map(({ admissionSequence }) => admissionSequence))
      .toEqual([1, 42]);
    expect(outcomes).toEqual(['committed']);
  } finally {
    await controller?.disconnect();
    await replacement?.stop();
    await oldBoot?.stop();
  }
}, 10_000);

test('same-boot signed recovery resolves a lost commit idempotently', async () => {
  let boot: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let loseCommitAck = false;
  let loseStatus = false;
  const outcomes: string[] = [];
  let recovered = 0;
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const command = url.pathname === '/__supervision/command' && typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { readonly message?: { readonly path?: unknown } }).message?.path
      : undefined;
    const response = await fetch(input, init);
    if ((loseCommitAck && command === '/commit') || (loseStatus && url.pathname === '/__supervision/status')) {
      await response.arrayBuffer();
      throw new Error('test transport response lost');
    }
    return response;
  };
  try {
    boot = startIngressBoot({
      port: 0,
      rootKey: ROOT_KEY,
      instanceId: INSTANCE_ID,
      processInstanceId: '90000000-0000-4000-8000-000000000001',
      bootNonce: '90000000-0000-4000-8000-000000000002',
    });
    controller = new MasterIngressController(controllerOptions(boot.port, interceptedFetch, {
      onRecovered: () => { recovered += 1; },
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
    }));
    await controller.connect();
    const handle = await controller.prepare([worker()]);
    loseCommitAck = true;
    loseStatus = true;
    await expect(handle.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });

    loseCommitAck = false;
    loseStatus = false;
    await controller.recover();

    expect(controller.currentState).toBe('attached');
    expect(recovered).toBeGreaterThan(0);
    expect(outcomes).toEqual(['committed']);
    expect(boot.commands.filter(({ path }) => path === '/commit')).toHaveLength(1);
  } finally {
    await controller?.disconnect();
    await boot?.stop();
  }
}, 10_000);

test('same-boot recovery renews an expired lease before resolving an uncertain commit', async () => {
  let now = 100;
  let boot: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let loseCommit = true;
  let loseStatus = false;
  const outcomes: string[] = [];
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const command = url.pathname === '/__supervision/command' && typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { readonly message?: { readonly path?: unknown } }).message?.path
      : undefined;
    const response = await fetch(input, init);
    if (loseCommit && command === '/commit') {
      now = 200;
      loseStatus = true;
      await response.arrayBuffer();
      throw new Error('test commit response lost');
    }
    if (loseStatus && url.pathname === '/__supervision/status') {
      await response.arrayBuffer();
      throw new Error('test status response lost');
    }
    return response;
  };
  try {
    boot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '91000000-0000-4000-8000-000000000001',
      bootNonce: '91000000-0000-4000-8000-000000000002', clock: () => now,
    });
    const base = controllerOptions(boot.port, interceptedFetch, {
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
    });
    controller = new MasterIngressController({ ...base, now: () => now, monotonicNow: () => now, leaseDurationMs: 50 });
    await controller.connect();
    const handle = await controller.prepare([worker()]);
    await expect(handle.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });

    loseCommit = false;
    loseStatus = false;
    await controller.recover();

    expect(controller.currentState).toBe('attached');
    expect(outcomes).toEqual(['committed']);
    expect(boot.commands.filter(({ path }) => path === '/commit')).toHaveLength(1);
    expect(boot.commands.filter(({ path }) => path === '/admission/fence')).toHaveLength(1);
  } finally {
    await controller?.disconnect();
    await boot?.stop();
  }
}, 10_000);

test('same-boot recovery resolves an expired frozen commit as not committed without repeating it', async () => {
  let now = 100;
  let boot: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  const outcomes: string[] = [];
  try {
    boot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '97000000-0000-4000-8000-000000000001',
      bootNonce: '97000000-0000-4000-8000-000000000002', clock: () => now,
    });
    const base = controllerOptions(boot.port, fetch, {
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
      leaseDurationMs: 50,
    });
    controller = new MasterIngressController({ ...base, now: () => now, monotonicNow: () => now });
    await controller.connect();
    const handle = await controller.prepare([worker()]);
    now = 200;
    await expect(handle.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });
    await controller.recover();

    expect(controller.currentState).toBe('attached');
    expect(outcomes).toEqual(['not_committed']);
    expect(boot.commands.filter(({ path }) => path === '/commit')).toHaveLength(1);
    expect(controller.isMutationReady()).toBeFalse();
  } finally {
    await controller?.disconnect();
    await boot?.stop();
  }
}, 10_000);

test('uncertain old-boot admission is invalidated, not classified, after a dead-owner takeover', async () => {
  let oldBoot: IngressBootFixture | null = null;
  let replacement: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let loseCommit = true;
  let loseStatus = false;
  let probes = 0;
  const outcomes: string[] = [];
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const command = url.pathname === '/__supervision/command' && typeof init?.body === 'string'
      ? (JSON.parse(init.body) as { readonly message?: { readonly path?: unknown } }).message?.path
      : undefined;
    const response = await fetch(input, init);
    if (loseCommit && command === '/commit') {
      loseStatus = true;
      await response.arrayBuffer();
      throw new Error('test old commit response lost');
    }
    if (loseStatus && url.pathname === '/__supervision/status') {
      await response.arrayBuffer();
      throw new Error('test old status response lost');
    }
    return response;
  };
  try {
    oldBoot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '93000000-0000-4000-8000-000000000001',
      bootNonce: '93000000-0000-4000-8000-000000000002',
    });
    controller = new MasterIngressController(controllerOptions(oldBoot.port, interceptedFetch, {
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
      probe: async () => { probes += 1; return 'dead'; },
    }));
    await controller.connect();
    const handle = await controller.prepare([worker()]);
    await expect(handle.commit()).rejects.toMatchObject({ code: 'outcome_unknown' });

    loseCommit = false;
    loseStatus = false;
    await oldBoot.stop();
    oldBoot = null;
    replacement = startIngressBoot({
      port: controller.controlPort, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '94000000-0000-4000-8000-000000000001',
      bootNonce: '94000000-0000-4000-8000-000000000002',
    });

    await controller.recover();
    expect(probes).toBeGreaterThan(0);
    expect(controller.currentState).toBe('attached');
    expect(controller.isMutationReady()).toBeFalse();
    await expect(handle.commit()).rejects.toMatchObject({ code: 'stale_boot' });
    expect(outcomes).toEqual([]);
    expect(replacement.commands.filter(({ path }) => path === '/commit')).toHaveLength(0);
  } finally {
    await controller?.disconnect();
    await replacement?.stop();
    await oldBoot?.stop();
  }
}, 10_000);

test('complete controller lease renewal stays attached and ready beyond the replay capacity', async () => {
  let boot: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let leaseResponses = 0;
  let confirmedRenewals = 0;
  let confirmedResponseCount = 0;
  let confirmedState: string = 'stopped';
  let lastState = 'stopped';
  let lastReadiness: ReturnType<MasterIngressController['mutationReadiness']> = { ready: false, reason: 'not_attached' };
  let confirmedReadiness: ReturnType<MasterIngressController['mutationReadiness']> = lastReadiness;
  let baselineLeaseResponses = 0;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeState: (() => void) | null = null;
  let clearDeadline: () => void = () => undefined;
  let release: () => void = () => undefined;
  let rejectCompletion: (error: Error) => void = () => undefined;
  const logicClock = (): number => 1_000_000;
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const response = await fetch(input, init);
    if (url.pathname === '/__supervision/lease' && response.ok) leaseResponses += 1;
    return response;
  };
  try {
    boot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '95000000-0000-4000-8000-000000000001',
      bootNonce: '95000000-0000-4000-8000-000000000002',
      seed: [admission(1, '96000000-0000-4000-8000-000000000001', '96000000-0000-4000-8000-000000000002', 40_001)],
      clock: logicClock,
    });
    controller = new MasterIngressController(controllerOptions(boot.port, interceptedFetch, {
      leaseDurationMs: 10, now: logicClock, monotonicNow: logicClock,
    }));
    await controller.connect();
    baselineLeaseResponses = leaseResponses;
    let finish: (() => void) | null = null;
    const completed = new Promise<void>((resolve, reject) => {
      finish = resolve;
      release = resolve;
      rejectCompletion = reject;
      const timer = setTimeout(() => reject(new Error(
        `lease renewal timeout: leaseResponses=${leaseResponses}, confirmedRenewals=${confirmedRenewals}, `
        + `currentState=${lastState}, lastReadiness=${lastReadiness.ready ? 'ready' : lastReadiness.reason}`,
      )), 10_000);
      clearDeadline = () => clearTimeout(timer);
    });
    const observe = (): void => {
      lastState = controller!.currentState;
      lastReadiness = controller!.mutationReadiness();
      if (leaseResponses <= baselineLeaseResponses || leaseResponses <= confirmedResponseCount
        || lastState !== 'attached' || !lastReadiness.ready) return;
      confirmedResponseCount = leaseResponses;
      confirmedRenewals += 1;
      confirmedState = lastState;
      confirmedReadiness = lastReadiness;
      if (confirmedRenewals >= 310) finish?.();
    };
    const observeState = (state: string): void => {
      lastState = state;
      lastReadiness = controller!.mutationReadiness();
      if (state === 'control_recovering') {
        rejectCompletion(new Error(
          `lease renewal entered control_recovering: leaseResponses=${leaseResponses}, confirmedRenewals=${confirmedRenewals}, `
          + `currentState=${state}, lastReadiness=${lastReadiness.ready ? 'ready' : lastReadiness.reason}`,
        ));
      }
    };
    // Install and evaluate without an await gap: the first lease response after the baseline
    // must be paired with the eligibility snapshot that made the cycle mutation-ready.
    unsubscribeState = controller.subscribeState(observeState);
    unsubscribe = controller.subscribeEligibilityChange(observe);
    if (controller.currentState === 'control_recovering') observeState(controller.currentState);
    observe();
    await completed;
    expect(leaseResponses - baselineLeaseResponses).toBeGreaterThanOrEqual(310);
    expect(confirmedRenewals).toBeGreaterThanOrEqual(310);
    expect(confirmedState).toBe('attached');
    expect(confirmedReadiness.ready).toBeTrue();
  } finally {
    unsubscribeState?.();
    unsubscribe?.();
    clearDeadline();
    release();
    await controller?.disconnect();
    await boot?.stop();
  }
}, 15_000);

test('a failed normal renewal cannot be counted as a completed ready cycle', async () => {
  let boot: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let failNextRenewal = false;
  let leaseResponses = 0;
  let unsubscribeState: () => void = () => undefined;
  const logicClock = (): number => 2_000_000;
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    const response = await fetch(input, init);
    if (url.pathname === '/__supervision/lease') {
      if (failNextRenewal) {
        failNextRenewal = false;
        throw new Error('injected normal renewal transport failure');
      }
      if (response.ok) leaseResponses += 1;
    }
    return response;
  };
  try {
    boot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '97000000-0000-4000-8000-000000000001',
      bootNonce: '97000000-0000-4000-8000-000000000002',
      seed: [admission(1, '97100000-0000-4000-8000-000000000001', '97100000-0000-4000-8000-000000000002', 40_001)],
      clock: logicClock,
    });
    controller = new MasterIngressController(controllerOptions(boot.port, interceptedFetch, {
      leaseDurationMs: 10, now: logicClock, monotonicNow: logicClock,
    }));
    await controller.connect();
    let enteredRecovery = false;
    let stateAtReject = 'attached';
    const completion = new Promise<void>((_resolve, reject) => {
      unsubscribeState = controller!.subscribeState((state) => {
        if (state !== 'control_recovering' || enteredRecovery) return;
        enteredRecovery = true;
        stateAtReject = state;
        const readiness = controller!.mutationReadiness();
        reject(new Error(
          `renewal completion rejected: leaseResponses=${leaseResponses}, currentState=${state}, `
          + `lastReadiness=${readiness.ready ? 'ready' : readiness.reason}`,
        ));
      });
    });
    failNextRenewal = true;
    await expect(waitWithTimeout(completion, `injected renewal did not recover: leaseResponses=${leaseResponses}`))
      .rejects.toThrow('renewal completion rejected');
    expect(enteredRecovery).toBeTrue();
    expect(leaseResponses).toBe(1);
    expect(stateAtReject).toBe('control_recovering');
  } finally {
    unsubscribeState();
    await controller?.disconnect();
    await boot?.stop();
  }
}, 15_000);

test('pending prepare is invalidated, not resolved from an empty new-boot registry', async () => {
  let oldBoot: IngressBootFixture | null = null;
  let replacement: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let swapOnLease = false;
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    if (swapOnLease && url.pathname === '/__supervision/lease') {
      swapOnLease = false;
      await oldBoot?.stop();
      oldBoot = null;
      replacement = startIngressBoot({
        port: controller!.controlPort, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
        processInstanceId: '98000000-0000-4000-8000-000000000001',
        bootNonce: '98000000-0000-4000-8000-000000000002',
      });
    }
    return fetch(input, init);
  };
  try {
    oldBoot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '99000000-0000-4000-8000-000000000001',
      bootNonce: '99000000-0000-4000-8000-000000000002',
    });
    controller = new MasterIngressController(controllerOptions(oldBoot.port, interceptedFetch, {
      startupTimeoutMs: 20,
      leaseDurationMs: 50,
      probe: async () => 'dead',
    }));
    await controller.connect();
    const internal = controller as unknown as {
      enqueueTask<Result>(operation: (signal: AbortSignal) => Promise<Result>): { result: Promise<Result> };
    };
    const blocker = internal.enqueueTask(async (signal) => new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    void blocker.result.catch(() => undefined);
    swapOnLease = true;
    const preparing = controller.prepare([worker()]);
    await expect(preparing).rejects.toMatchObject({ code: 'stale_boot' });
    expect(controller.currentState).toBe('attached');
    expect(controller.isMutationReady()).toBeFalse();
    const replacementBoot = replacement as IngressBootFixture | null;
    expect(replacementBoot === null ? [] : replacementBoot.commands.filter(({ path }) => path === '/prepare')).toHaveLength(0);
  } finally {
    await controller?.disconnect();
    await (replacement as IngressBootFixture | null)?.stop();
    await oldBoot?.stop();
  }
}, 10_000);

test('publication task releases before new-boot recovery callback enqueue completes', async () => {
  let oldBoot: IngressBootFixture | null = null;
  let replacement: IngressBootFixture | null = null;
  let controller: MasterIngressController | null = null;
  let publicationTasks!: PublicationTaskManager;
  let swapOnLease = false;
  let callbackDone!: () => void;
  const callbackCompleted = new Promise<void>((resolve) => { callbackDone = resolve; });
  const events: string[] = [];
  let recoveredCallback: (event: MasterIngressRecoveryEvent) => Promise<MasterIngressRecoveryResult> = async () => 'retryable';
  const interceptedFetch: FetchImplementation = async (input, init) => {
    const url = new URL(input instanceof URL ? input : typeof input === 'string' ? input : input.url);
    if (swapOnLease && url.pathname === '/__supervision/lease') {
      swapOnLease = false;
      await oldBoot?.stop();
      oldBoot = null;
      replacement = startIngressBoot({
        port: controller!.controlPort, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
        processInstanceId: '9a000000-0000-4000-8000-000000000001',
        bootNonce: '9a000000-0000-4000-8000-000000000002',
      });
    }
    return fetch(input, init);
  };
  try {
    oldBoot = startIngressBoot({
      port: 0, rootKey: ROOT_KEY, instanceId: INSTANCE_ID,
      processInstanceId: '9b000000-0000-4000-8000-000000000001',
      bootNonce: '9b000000-0000-4000-8000-000000000002',
    });
    const base = controllerOptions(oldBoot.port, interceptedFetch, {
      startupTimeoutMs: 20,
      leaseDurationMs: 50,
      probe: async () => 'dead',
      onNewBootAccepted: () => events.push('new_boot'),
      onRecovered: (event) => recoveredCallback(event),
    });
    controller = new MasterIngressController({ ...base });
    publicationTasks = new PublicationTaskManager({
      publish: async () => {
        const handle = await controller!.prepare([worker()]);
        const internal = controller as unknown as {
          enqueueTask<Result>(operation: (signal: AbortSignal) => Promise<Result>): { result: Promise<Result> };
        };
        const blocker = internal.enqueueTask(async (signal) => new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        }));
        void blocker.result.catch(() => undefined);
        swapOnLease = true;
        try {
          await handle.commit();
        } catch (error) {
          events.push(`commit:${(error as { readonly code?: string }).code ?? 'unknown'}`);
        } finally {
          events.push('cleanup');
        }
        return { kind: 'converged', http_status: 200, operation: {} as never, serving: [] };
      },
    });
    publicationTasks.setFatalHandler((error) => { events.push(`fatal:${error.message}`); });
    recoveredCallback = async (event: MasterIngressRecoveryEvent): Promise<MasterIngressRecoveryResult> => {
      events.push(`callback:${event.kind}`);
      const result = await publicationTasks.enqueueRecovery(async () => {
        events.push('callback:recovery-start');
        await controller!.fenceAndStatus(event.token);
        events.push('callback:recovery-complete');
        callbackDone();
        return { kind: 'complete' as const };
      });
      return result.kind;
    };
    await controller.connect();
    publicationTasks.enqueue({} as never, []);
    await waitWithTimeout(callbackCompleted, 'recovery callback timed out');
    await publicationTasks.stop();

    expect(events).toContain('new_boot');
    expect(events).toContain('commit:stale_boot');
    expect(events.indexOf('cleanup')).toBeGreaterThan(events.indexOf('commit:stale_boot'));
    expect(events.indexOf('callback:recovery-complete')).toBeGreaterThan(events.indexOf('cleanup'));
    expect(events).not.toContain(expect.stringMatching(/^fatal:/));
    expect(oldBoot).toBeNull();
    const replacementBoot = replacement as IngressBootFixture | null;
    expect(replacementBoot === null ? [] : replacementBoot.commands.filter(({ path }) => path === '/commit')).toHaveLength(0);
  } finally {
    await controller?.disconnect();
    await (replacement as IngressBootFixture | null)?.stop();
    await oldBoot?.stop();
  }
}, 15_000);
