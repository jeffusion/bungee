import { expect, test } from 'bun:test';
import type { ServingConfigWorker } from '../../src/config-publication';
import type { AdmissionSet } from '../../src/ingress/admission-set';
import { MasterIngressController, type MasterIngressRecoveryEvent } from '../../src/ingress/master-controller';
import { startIngressBoot, type IngressBootFixture } from '../fixtures/ingress-boot-handle-fencing-fixture';

const ROOT_KEY = new Uint8Array(32);
const INSTANCE_ID = '10000000-0000-4000-8000-000000000001';
const CONTROLLER_ID = '20000000-0000-4000-8000-000000000001';
const GENERATION = '30000000-0000-4000-8000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const CATALOG = `sha256:${'b'.repeat(64)}` as const;
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  readonly onRecovered?: (event: MasterIngressRecoveryEvent) => Promise<void> | void;
  readonly onNewBootAccepted?: (event: Extract<MasterIngressRecoveryEvent, { readonly kind: 'new_boot' }>) => void;
  readonly onAdmissionResolved?: (outcome: 'committed' | 'not_committed') => void;
}) {
  return {
    rootKey: ROOT_KEY,
    instanceId: INSTANCE_ID,
    controllerId: CONTROLLER_ID,
    controllerEpoch: 1,
    controlPort: port,
    publicHost: '127.0.0.1',
    publicPort: 1,
    instanceLockPath: '/tmp/bungee-ingress-boot-handle-fencing.lock',
    transportSecret: 'test-only',
    executable: process.execPath,
    entry: import.meta.path,
    cwd: import.meta.dir,
    leaseDurationMs: 1_000,
    fetch: fetchImpl,
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
  const outcomes: string[] = [];
  const recoveryOrder: string[] = [];
  let acceptedToken: number | null = null;
  let recoveredToken: number | null = null;
  let recovered = 0;
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
      onRecovered: (event) => {
        recovered += 1;
        if (event.kind === 'new_boot') recoveredToken = event.token;
        recoveryOrder.push('recovered');
      },
      onNewBootAccepted: (event) => { acceptedToken = event.token; recoveryOrder.push('accepted'); },
      onAdmissionResolved: (outcome) => outcomes.push(outcome),
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
        admission(40, '80000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', 40_010),
        admission(41, '80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004', 40_011),
      ],
    });
    dropOldResponses = false;
    await controller.recover();

    expect(recovered).toBeGreaterThan(0);
    expect(acceptedToken).toBeGreaterThan(0);
    expect(recoveredToken).toBe(acceptedToken);
    expect(recoveryOrder.indexOf('accepted')).toBeLessThan(recoveryOrder.indexOf('recovered'));
    expect(controller.currentState).toBe('attached');
    expect(controller.authenticatedRateLimitSession()).toEqual({
      supervisionPort: replacement.port,
      expectedIngress: {
        process_instance_id: '70000000-0000-4000-8000-000000000001',
        boot_nonce: '70000000-0000-4000-8000-000000000002',
      },
    });
    await expect(handle.commit()).rejects.toMatchObject({ code: 'stale_boot' });
    await expect(handle.abort()).rejects.toMatchObject({ code: 'stale_boot' });
    await expect(handle.releaseRetiredAfterExitProof?.()).rejects.toMatchObject({ code: 'stale_boot' });
    expect(replacement.commands.map(({ path }) => path)).not.toContain('/commit');
    expect(replacement.commands.map(({ path }) => path)).not.toContain('/admission/fence');
    expect(replacement.commands.map(({ path }) => path)).not.toContain('/release-retired');
    expect(outcomes).not.toContain('not_committed');
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
