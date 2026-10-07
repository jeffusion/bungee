import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import type { Sha256Digest } from '@jeffusion/bungee-types';
import { ConfigPublicationMessageError, type ConfigProcessIdentity } from '../../src/config-publication/types';
import {
  SupervisedConfigWorkerProcessAdapter,
  type ProcessIdentityControl,
  type SupervisedWorkerConfigurationTarget,
} from '../../src/master-runtime/supervised-worker-process-adapter';
import { SupervisedConfigWorkerFactory, type SupervisedConfigWorkerSpawn } from '../../src/master-runtime/supervised-worker-factory';
import { WorkerControllerClient } from '../../src/master-runtime/supervised-worker-client';
import {
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  signSupervisionMessage,
  signWorkerDescriptor,
} from '../../src/supervision';
import { drainMessage, startCurrentMessage, startMessage, TEST_KERNEL_BOOT_ID } from './config-publication-worker-runtime.fixtures';

const ROOT = new Uint8Array(32).fill(5);
const AUTHORITY = { controller_epoch: 1, controller_id: '83000000-0000-4000-8000-000000000001' } as const;

// Adapter fixtures: a ready-client backed adapter that never touches the OS.
const ADAPTER_IDENTITY = {
  master_generation: '53000000-0000-4000-8000-000000000001',
  worker_instance_id: '63000000-0000-4000-8000-000000000001',
  worker_slot: 0,
} as const;
const ADAPTER_BOOT = '73000000-0000-4000-8000-000000000001';

// Factory fixtures: an exact worker identity and its derived Host-private credential.
const GENERATION = '10000000-0000-4000-8000-000000000001';
const SESSION_IDENTITY: ConfigProcessIdentity = {
  master_generation: GENERATION,
  worker_instance_id: '40000000-0000-4000-8000-000000000042',
  worker_slot: 0,
};
const SESSION_BOOT = '50000000-0000-4000-8000-000000000042';
const OTHER_UUID = '40000000-0000-4000-8000-0000000000ff';
const HASH = `sha256:${'a'.repeat(64)}` as Sha256Digest;
const CATALOG = `sha256:${'b'.repeat(64)}` as Sha256Digest;
const SESSION_DIRECTORY = join(tmpdir(), 'bungee-supervised-physical-session');

type FakeCredential = {
  readonly identity: { readonly role: 'worker' | 'ingress'; readonly process_instance_id: string; readonly boot_nonce: string };
  readonly process_key: Readonly<Uint8Array>;
};

/**
 * A fetch that must never be reached. `Object.assign` keeps the typed `preconnect`
 * member so the value matches `typeof globalThis.fetch` without masking casts.
 */
function offlineFetch(): typeof globalThis.fetch {
  const handler = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error('physical session lookup must not use the network');
  };
  return Object.assign(handler, { preconnect: async (): Promise<void> => undefined });
}

function countingIdentityControl() {
  let captures = 0;
  let probes = 0;
  const control: ProcessIdentityControl = {
    capture: async (pid, processInstanceId) => { captures += 1; return { pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId }; },
    probe: async () => { probes += 1; return 'exact'; },
  };
  return { control, get captures() { return captures; }, get probes() { return probes; } };
}

function fakeReadyClient(credential: FakeCredential, beforeStart?: () => Promise<void>) {
  const starts: unknown[] = [];
  let statusCalls = 0;
  const client = {
    credential,
    cachedStatus: null,
    state: 'attached' as const,
    subscribeControlState: () => () => undefined,
    async attach() { return {}; },
    async start(message: unknown) { if (beforeStart !== undefined) await beforeStart(); starts.push(message); return { evidence: { message: undefined } }; },
    async status() { statusCalls += 1; throw new Error('physical getters must not request status'); },
    disconnect() {},
    get starts() { return starts; },
    get statusCalls() { return statusCalls; },
  };
  return client;
}

function adapterSeed() {
  return deriveWorkerSupervisionSeed(ROOT, ADAPTER_IDENTITY.master_generation, ADAPTER_IDENTITY.worker_instance_id, ADAPTER_IDENTITY.worker_slot);
}

function adapterFor(client: ReturnType<typeof fakeReadyClient>, control: ProcessIdentityControl): SupervisedConfigWorkerProcessAdapter {
  return new SupervisedConfigWorkerProcessAdapter({
    identity: ADAPTER_IDENTITY, descriptorPath: 'unused', supervisionSeed: adapterSeed(),
    client: { authority: AUTHORITY }, pid: 44_001, readyClient: client as never,
    processIdentity: control, kernelBootId: async () => TEST_KERNEL_BOOT_ID,
  });
}

function adapterCommand() {
  return { ...startCurrentMessage(), ...ADAPTER_IDENTITY };
}

function adapterClient(): { credential: ReturnType<typeof deriveWorkerSupervisionCredential>; client: ReturnType<typeof fakeReadyClient> } {
  const credential = deriveWorkerSupervisionCredential(adapterSeed(), ADAPTER_BOOT);
  return { credential, client: fakeReadyClient(credential) };
}

test('adapter pins the first start target from the validated snapshot before dispatch and freezes the dispatched tree', async () => {
  const { client } = adapterClient();
  const control = countingIdentityControl();
  const adapter = adapterFor(client, control.control);
  try {
    await adapter.initialization;
    expect(adapter.configurationTarget).toBeNull();
    const start = adapterCommand();
    const pending = adapter.send(start);
    // Pinned at send entry, before the ready client is awaited or anything is dispatched.
    const target = adapter.configurationTarget;
    if (target === null) throw new Error('validated start target was not pinned');
    expect(target).toEqual({ revision: start.revision, content_hash: start.content_hash, plugin_catalog_hash: start.plugin_catalog_hash });
    expect(Object.isFrozen(target)).toBeTrue();
    expect(client.starts).toHaveLength(0);
    await pending;
    expect(client.starts).toHaveLength(1);
    const dispatched = client.starts[0] as { revision: number; content_hash: string; plugin_catalog_hash: string };
    expect(Object.isFrozen(dispatched)).toBeTrue();
    expect(dispatched.revision).toBe(start.revision);
    expect(dispatched.content_hash).toBe(start.content_hash);
    // Dispatch uses the independent validated snapshot: mutating the caller payload later
    // changes neither the pin nor what was sent.
    (start as { revision: number }).revision = 999;
    (start as { content_hash: string }).content_hash = `sha256:${'f'.repeat(64)}`;
    expect(adapter.configurationTarget).toEqual(target);
    expect(dispatched.revision).toBe(target.revision);
    expect(dispatched.content_hash).not.toBe(`sha256:${'f'.repeat(64)}`);
    expect(control.probes).toBe(0);
    expect(client.statusCalls).toBe(0);
  } finally { adapter.disconnect(); }
});

test('adapter rejects foreign, invalid, and non-matching starts with zero dispatch', async () => {
  const { client } = adapterClient();
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    // Foreign identity parses but must never pin or dispatch.
    await expect(adapter.send({ ...adapterCommand(), worker_instance_id: OTHER_UUID })).rejects.toThrow('identity does not match this adapter');
    // start-config-worker with publication null is structurally invalid.
    const valid = adapterCommand();
    await expect(adapter.send({ ...valid, command: 'start-config-worker', publication: null } as never)).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    // content_hash that does not match the aggregate.
    await expect(adapter.send({ ...valid, content_hash: `sha256:${'d'.repeat(64)}` as Sha256Digest })).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    // activated_plugin_names that do not match the aggregate activations.
    await expect(adapter.send({ ...valid, activated_plugin_names: [] })).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    // aggregate that cannot be normalized/compiled.
    await expect(adapter.send({ ...valid, aggregate: [] as never })).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    // revision 0 is not a positive integer.
    await expect(adapter.send({ ...valid, revision: 0 })).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    expect(client.starts).toHaveLength(0);
    expect(adapter.configurationTarget).toBeNull();
  } finally { adapter.disconnect(); }
});

test('adapter rejects Proxy and accessor start payloads without invoking accessors or dispatching', async () => {
  const { client } = adapterClient();
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    let getterCalls = 0;
    const accessor = { ...adapterCommand() };
    Object.defineProperty(accessor, 'content_hash', {
      enumerable: true, configurable: true,
      get() { getterCalls += 1; return HASH; },
    });
    await expect(adapter.send(accessor)).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    expect(getterCalls).toBe(0);
    await expect(adapter.send(new Proxy({ ...adapterCommand() }, {}))).rejects.toBeInstanceOf(ConfigPublicationMessageError);
    expect(client.starts).toHaveLength(0);
    expect(adapter.configurationTarget).toBeNull();
  } finally { adapter.disconnect(); }
});

test('adapter accepts an identical retry and rejects a different target for the same physical instance', async () => {
  const { client } = adapterClient();
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    const first = adapterCommand();
    await adapter.send(first);
    await adapter.send(adapterCommand());
    expect(adapter.configurationTarget).toEqual({ revision: first.revision, content_hash: first.content_hash, plugin_catalog_hash: first.plugin_catalog_hash });
    const conflicting = { ...startMessage(9), ...ADAPTER_IDENTITY };
    await expect(adapter.send(conflicting)).rejects.toThrow('different configuration target');
    // The conflicting start was rejected before dispatch; the pinned target is unchanged.
    expect(client.starts).toHaveLength(2);
    expect(adapter.configurationTarget).toEqual({ revision: first.revision, content_hash: first.content_hash, plugin_catalog_hash: first.plugin_catalog_hash });
  } finally { adapter.disconnect(); }
});

test('adapter pins the first target under concurrent sends without a second queue', async () => {
  const { client } = adapterClient();
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    const first = adapterCommand();
    const conflicting = { ...startMessage(9), ...ADAPTER_IDENTITY };
    const pending = adapter.send(first);
    // Readable after the first pin but before the first command is actually dispatched.
    expect(adapter.configurationTarget).toEqual({ revision: first.revision, content_hash: first.content_hash, plugin_catalog_hash: first.plugin_catalog_hash });
    expect(client.starts).toEqual([]);
    await expect(adapter.send(conflicting)).rejects.toThrow('different configuration target');
    await pending;
    expect(adapter.configurationTarget).toEqual({ revision: first.revision, content_hash: first.content_hash, plugin_catalog_hash: first.plugin_catalog_hash });
    const dispatched = client.starts[0] as { revision: number };
    expect(client.starts).toHaveLength(1);
    expect(dispatched.revision).toBe(first.revision);
  } finally { adapter.disconnect(); }
});

test('adapter dispatches the pre-validated snapshot while an injected client waits and caller mutates input', async () => {
  const credential = deriveWorkerSupervisionCredential(adapterSeed(), ADAPTER_BOOT);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const client = fakeReadyClient(credential, () => gate);
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    const start = adapterCommand();
    const pending = adapter.send(start);
    const target = adapter.configurationTarget;
    expect(target).not.toBeNull();
    if (target === null) throw new Error('validated FIFO target was not pinned');
    // Injected delayed client fixture, not a claim of actual OS/IPC FIFO acceptance.
    (start as { revision: number }).revision = 999;
    (start as { content_hash: string }).content_hash = `sha256:${'f'.repeat(64)}`;
    expect(client.starts).toHaveLength(0);
    release();
    await pending;
    const dispatched = client.starts[0] as { revision: number; content_hash: string };
    expect(dispatched.revision).toBe(target.revision);
    expect(dispatched.content_hash).toBe(target.content_hash);
    expect(adapter.configurationTarget).toEqual(target);
  } finally { adapter.disconnect(); }
});

test('adapter covers both start-config-worker and start-current-config-worker targets', async () => {
  const { client } = adapterClient();
  const adapter = adapterFor(client, countingIdentityControl().control);
  try {
    await adapter.initialization;
    const command = { ...startMessage(), ...ADAPTER_IDENTITY };
    await adapter.send(command);
    expect(adapter.configurationTarget).toEqual({ revision: command.revision, content_hash: command.content_hash, plugin_catalog_hash: command.plugin_catalog_hash });
  } finally { adapter.disconnect(); }
});

type PhysicalStatus = {
  role: string;
  master_generation: string;
  worker_instance_id: string;
  worker_slot: number;
  boot_nonce: string;
  pid: number;
  phase: 'candidate' | 'serving' | 'draining' | 'stopped';
  frozen: boolean;
  private_port: number | null;
  revision: number | null;
  content_hash: Sha256Digest | null;
  plugin_catalog_hash: Sha256Digest | null;
};

type CapturedFake = { pid: number; startToken: string; executable: string; processInstanceId: string };

type PhysicalFake = {
  identity: ConfigProcessIdentity;
  bootNonce: string;
  origin: 'spawned' | 'adopted';
  pid: number;
  supervisionCredential: FakeCredential | null;
  capturedProcessIdentity: CapturedFake | null;
  cachedStatus: PhysicalStatus | null;
  latestSignedStatus: PhysicalStatus | null;
  controlState: 'detached' | 'attached' | 'recovering' | 'unavailable' | 'disconnected';
  configurationTarget: SupervisedWorkerConfigurationTarget | null;
  readonly statusCalls: number;
  status: () => Promise<PhysicalStatus | null>;
  disconnect: () => void;
};

function candidateStatus(identity: ConfigProcessIdentity, bootNonce: string, pid: number): PhysicalStatus {
  return { role: 'worker', ...identity, boot_nonce: bootNonce, pid, phase: 'candidate', frozen: true,
    private_port: null, revision: null, content_hash: null, plugin_catalog_hash: null };
}

function physicalProcess(identity: ConfigProcessIdentity, bootNonce: string): PhysicalFake {
  const pid = 55_001;
  const status = candidateStatus(identity, bootNonce, pid);
  let statusCalls = 0;
  const session: PhysicalFake = {
    identity, bootNonce, origin: 'adopted', pid,
    supervisionCredential: deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(ROOT, identity.master_generation, identity.worker_instance_id, identity.worker_slot), bootNonce),
    capturedProcessIdentity: { pid, startToken: '100', executable: '/usr/bin/bungee', processInstanceId: identity.worker_instance_id },
    cachedStatus: status,
    latestSignedStatus: status,
    controlState: 'attached',
    configurationTarget: null,
    get statusCalls() { return statusCalls; },
    async status() { statusCalls += 1; return session.latestSignedStatus; },
    disconnect() {},
  };
  return session;
}

function sessionKey(identity: ConfigProcessIdentity): string {
  return JSON.stringify([identity.master_generation, identity.worker_instance_id, identity.worker_slot]);
}

function own(workerFactory: SupervisedConfigWorkerFactory, process: object, identity: ConfigProcessIdentity): void {
  const internal = workerFactory as unknown as {
    owned: Map<object, { process: object }>;
    adapters: Map<string, object>;
  };
  internal.owned.set(process, { process });
  internal.adapters.set(sessionKey(identity), process);
}

function disown(workerFactory: SupervisedConfigWorkerFactory, process: object, identity: ConfigProcessIdentity): void {
  const internal = workerFactory as unknown as { owned: Map<object, unknown>; adapters: Map<string, unknown> };
  internal.owned.delete(process);
  internal.adapters.delete(sessionKey(identity));
}

function createFactory(control: ProcessIdentityControl = countingIdentityControl().control): SupervisedConfigWorkerFactory {
  return new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: SESSION_DIRECTORY, authority: AUTHORITY, masterControlPort: 3011,
    accessLogDbPath: join(SESSION_DIRECTORY, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 1, shutdownTimeoutMs: 25, processIdentity: control,
    client: { fetch: offlineFetch() },
  });
}

test('lookupPhysicalSession returns a frozen candidate fact with independent credential, captured and status copies', () => {
  const workerFactory = createFactory();
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  const sourceCredential = session.supervisionCredential;
  const sourceCaptured = session.capturedProcessIdentity;
  const sourceStatus = session.latestSignedStatus;
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    expect(fact).not.toBeNull();
    expect(Object.isFrozen(fact)).toBeTrue();
    expect(fact).toMatchObject({ pid: session.pid, origin: 'adopted', controlState: 'attached',
      committed: false, phase: 'candidate', frozen: true, revision: null, content_hash: null,
      plugin_catalog_hash: null, configurationTarget: null });
    // The process reference is shared by design; the rest are independent copies.
    expect(Object.is(fact!.process, session)).toBe(true);
    expect(Object.is(fact!.captured, sourceCaptured)).toBe(false);
    expect(isDeepStrictEqual(fact!.captured, sourceCaptured)).toBe(true);
    expect(Object.isFrozen(fact!.captured)).toBeTrue();
    expect(Object.is(fact!.status, sourceStatus)).toBe(false);
    expect(isDeepStrictEqual(fact!.status, sourceStatus)).toBe(true);
    expect(Object.isFrozen(fact!.status)).toBeTrue();
    expect(Object.is(fact!.credential, sourceCredential)).toBe(false);
    expect(isDeepStrictEqual(fact!.credential.identity, sourceCredential?.identity)).toBe(true);
    expect(Object.is(fact!.credential.process_key, sourceCredential?.process_key)).toBe(false);
    expect(Array.from(fact!.credential.process_key)).toEqual(Array.from(sourceCredential!.process_key));
    // The signed status copy is memoized by source identity, so repeated reads reuse it.
    const again = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    expect(Object.is(again!.status, fact!.status)).toBe(true);
    // The existing committed+serving+attached gate is untouched: a candidate stays refused.
    expect(workerFactory.lookupExactControlSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT,
      private_port: 41_003, revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG })).toBeNull();
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession copies are isolated from later base-state mutation and never call status', () => {
  const control = countingIdentityControl();
  const workerFactory = createFactory(control.control);
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    expect(fact).not.toBeNull();
    expect(Reflect.set(fact!.captured, 'startToken', 'wrong-exit-identity')).toBe(false);
    expect(session.capturedProcessIdentity!.startToken).toBe('100');
    expect(Reflect.set(fact!.status, 'phase', 'serving')).toBe(false);
    expect(session.latestSignedStatus!.phase).toBe('candidate');
    const originalKeyByte = session.supervisionCredential!.process_key[0]!;
    const ownedFactKey = fact!.credential.process_key as Uint8Array;
    ownedFactKey[0] = originalKeyByte ^ 0xff;
    expect(session.supervisionCredential!.process_key[0]).toBe(originalKeyByte);
    expect(workerFactory.lookupExactControlSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT,
      private_port: 41_003, revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG })).toBeNull();
    // Mutating the worker's own base state afterwards cannot change the earlier fact.
    session.capturedProcessIdentity!.startToken = 'tampered';
    session.latestSignedStatus!.revision = 99;
    expect(fact!.captured.startToken).toBe('100');
    expect(fact!.status.revision).toBeNull();
    // The fact copies are frozen, so they cannot be mutated back into the base either.
    expect(Object.isFrozen(fact!.captured)).toBeTrue();
    expect(Object.isFrozen(fact!.status)).toBeTrue();
    // The factory never rewrites the adapter's base state: the old exact gate and the
    // exit probe still read the original (here mutated-by-the-test) base objects.
    expect(session.capturedProcessIdentity!.startToken).toBe('tampered');
    expect(session.latestSignedStatus!.revision).toBe(99);
    // Reading facts performs no status RPC, capture, or probe.
    expect(session.statusCalls).toBe(0);
    expect(control.captures).toBe(0);
    expect(control.probes).toBe(0);
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession reports committed serving facts without loosening the exact gate', () => {
  const workerFactory = createFactory();
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  const serving = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, session.pid), phase: 'serving' as const, frozen: false,
    private_port: 41_003, revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG };
  session.cachedStatus = serving;
  session.latestSignedStatus = serving;
  session.configurationTarget = { revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG };
  own(workerFactory, session, SESSION_IDENTITY);
  workerFactory.markCommitted([session as never]);
  try {
    const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    expect(fact).toMatchObject({ committed: true, phase: 'serving', frozen: false, revision: 7,
      content_hash: HASH, plugin_catalog_hash: CATALOG,
      configurationTarget: { revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG } });
    const exact = workerFactory.lookupExactControlSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT,
      private_port: 41_003, revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG });
    expect(exact).not.toBeNull();
    expect(Object.is(exact!.process, session)).toBe(true);
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession returns null for missing, mismatched, or foreign physical facts', () => {
  const workerFactory = createFactory();
  const cases: Array<{ readonly label: string; readonly session: PhysicalFake }> = [];
  const base = (): PhysicalFake => physicalProcess(SESSION_IDENTITY, SESSION_BOOT);

  const wrongBoot = base(); wrongBoot.bootNonce = '50000000-0000-4000-8000-0000000000fe';
  cases.push({ label: 'boot nonce mismatch', session: wrongBoot });

  const noCredential = base(); noCredential.supervisionCredential = null;
  cases.push({ label: 'missing credential', session: noCredential });

  const wrongRole = base();
  wrongRole.supervisionCredential = { identity: { role: 'ingress', process_instance_id: SESSION_IDENTITY.worker_instance_id, boot_nonce: SESSION_BOOT }, process_key: new Uint8Array(32) };
  cases.push({ label: 'foreign credential role', session: wrongRole });

  const wrongCredentialInstance = base();
  wrongCredentialInstance.supervisionCredential = { identity: { role: 'worker', process_instance_id: OTHER_UUID, boot_nonce: SESSION_BOOT }, process_key: new Uint8Array(32) };
  cases.push({ label: 'foreign credential instance', session: wrongCredentialInstance });

  const noCapture = base(); noCapture.capturedProcessIdentity = null;
  cases.push({ label: 'missing captured identity', session: noCapture });

  const wrongCapturePid = base();
  wrongCapturePid.capturedProcessIdentity = { ...wrongCapturePid.capturedProcessIdentity!, pid: 9_999 };
  cases.push({ label: 'captured pid mismatch', session: wrongCapturePid });

  const wrongCaptureInstance = base();
  wrongCaptureInstance.capturedProcessIdentity = { ...wrongCaptureInstance.capturedProcessIdentity!, processInstanceId: OTHER_UUID };
  cases.push({ label: 'captured instance mismatch', session: wrongCaptureInstance });

  const noStatus = base(); noStatus.latestSignedStatus = null;
  cases.push({ label: 'missing signed status', session: noStatus });

  const wrongStatusGeneration = base();
  wrongStatusGeneration.latestSignedStatus = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, wrongStatusGeneration.pid), master_generation: OTHER_UUID };
  cases.push({ label: 'signed generation mismatch', session: wrongStatusGeneration });

  const wrongStatusBoot = base();
  wrongStatusBoot.latestSignedStatus = { ...candidateStatus(SESSION_IDENTITY, '50000000-0000-4000-8000-0000000000fd', wrongStatusBoot.pid) };
  cases.push({ label: 'signed boot nonce mismatch', session: wrongStatusBoot });

  const wrongStatusInstance = base();
  wrongStatusInstance.latestSignedStatus = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, wrongStatusInstance.pid), worker_instance_id: OTHER_UUID };
  cases.push({ label: 'signed instance mismatch', session: wrongStatusInstance });

  const wrongStatusPid = base();
  wrongStatusPid.latestSignedStatus = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, 9_999) };
  cases.push({ label: 'signed pid mismatch', session: wrongStatusPid });

  const wrongStatusSlot = base();
  wrongStatusSlot.latestSignedStatus = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, wrongStatusSlot.pid), worker_slot: SESSION_IDENTITY.worker_slot + 1 };
  cases.push({ label: 'signed slot mismatch', session: wrongStatusSlot });

  try {
    for (const { label, session } of cases) {
      own(workerFactory, session, SESSION_IDENTITY);
      const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
      if (fact !== null) throw new Error(`physical session should be null for: ${label}`);
      expect(fact).toBeNull();
      disown(workerFactory, session, SESSION_IDENTITY);
    }
    // An identity that was never owned is refused without touching any map.
    const unowned = physicalProcess({ ...SESSION_IDENTITY, worker_instance_id: OTHER_UUID }, SESSION_BOOT);
    expect(workerFactory.lookupPhysicalSession({ ...unowned.identity, boot_nonce: SESSION_BOOT })).toBeNull();
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession returns null when the factory already recorded an injected exit fact and keeps ownership', () => {
  const workerFactory = createFactory();
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    expect(workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT })).not.toBeNull();
    // Injected fixture: this is the factory's recorded-exit channel, not real OS proof.
    const internal = workerFactory as unknown as { exitHistory: Map<object, { exited: true; pid: number }> };
    internal.exitHistory.set(session, { exited: true, pid: session.pid });
    expect(workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT })).toBeNull();
    // The exit fact is surfaced, but the existing owned-retention/settlement rules are unchanged.
    expect(workerFactory.owns(session as never)).toBe(true);
    expect(workerFactory.snapshot()).toHaveLength(1);
    expect(Object.is(workerFactory.snapshot()[0], session)).toBe(true);
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession performs no OS probe, status RPC, or ownership mutation', () => {
  const control = countingIdentityControl();
  const workerFactory = createFactory(control.control);
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT })).not.toBeNull();
    }
    expect(control.captures).toBe(0);
    expect(control.probes).toBe(0);
    expect(session.statusCalls).toBe(0);
    expect(workerFactory.owns(session as never)).toBe(true);
    expect(workerFactory.snapshot()).toHaveLength(1);
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession distinguishes the pinned target from the signed candidate snapshot', () => {
  const workerFactory = createFactory();
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  session.configurationTarget = { revision: 9, content_hash: HASH, plugin_catalog_hash: CATALOG };
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    // The target is reported, but the signed snapshot is still an unserved candidate.
    expect(fact).toMatchObject({ phase: 'candidate', revision: null, content_hash: null, plugin_catalog_hash: null });
    expect(fact!.configurationTarget).toEqual({ revision: 9, content_hash: HASH, plugin_catalog_hash: CATALOG });
  } finally { workerFactory.disconnect(); }
});

test('lookupPhysicalSession reports draining or unavailable fixture facts without granting authorization', () => {
  const workerFactory = createFactory();
  const session = physicalProcess(SESSION_IDENTITY, SESSION_BOOT);
  session.controlState = 'unavailable';
  const draining = { ...candidateStatus(SESSION_IDENTITY, SESSION_BOOT, session.pid), phase: 'draining' as const, frozen: true,
    private_port: 41_003, revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG };
  session.cachedStatus = draining;
  session.latestSignedStatus = draining;
  own(workerFactory, session, SESSION_IDENTITY);
  try {
    const fact = workerFactory.lookupPhysicalSession({ ...SESSION_IDENTITY, boot_nonce: SESSION_BOOT });
    expect(fact).toMatchObject({ controlState: 'unavailable', committed: false, phase: 'draining', frozen: true,
      revision: 7, content_hash: HASH, plugin_catalog_hash: CATALOG });
  } finally { workerFactory.disconnect(); }
});

type LiveState = {
  phase: 'candidate' | 'serving' | 'draining' | 'stopped';
  frozen: boolean;
  private_port: number | null;
  revision: number | null;
  content_hash: Sha256Digest | null;
  plugin_catalog_hash: Sha256Digest | null;
};

/**
 * A real signed-status responder for a real `WorkerControllerClient`: challenge, attach,
 * lease and status all return a signed snapshot of the current live state. This exercises
 * the client's own renewal/recovery snapshot update rather than a fake map write.
 */
function liveStatusFetch(identity: ConfigProcessIdentity, credential: ReturnType<typeof deriveWorkerSupervisionCredential>,
  bootNonce: string, pid: number, controlPort: number) {
  let state: LiveState = { phase: 'candidate', frozen: true, private_port: null, revision: null, content_hash: null, plugin_catalog_hash: null };
  let sequence = 0;
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const request = JSON.parse(String(init?.body ?? '{}')) as { message?: { request_id?: string }; request_id?: string };
    const envelope = request.message ?? request;
    const requestId = String(envelope.request_id ?? '');
    if (path === '/__supervision/challenge') {
      return Response.json({ message: signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'challenge', direction: 'process-to-controller',
        ...credential.identity, ...AUTHORITY, sequence: 1, request_id: requestId, challenge_nonce: 'c'.repeat(64), expires_at: Date.now() + 10_000 }, credential) });
    }
    const replay = { sequence: ++sequence, request_id: requestId };
    const withoutHash = {
      schema: 'bungee-worker-status-v1' as const, role: 'worker' as const, ...identity, boot_nonce: bootNonce, pid,
      control_port: controlPort, master_control_port: 3011, phase: state.phase, frozen: state.frozen,
      private_port: state.private_port, revision: state.revision, content_hash: state.content_hash,
      plugin_catalog_hash: state.plugin_catalog_hash, started_at: 1, authority: AUTHORITY,
      request_correlation: requestId, replay, evidence: { kind: 'candidate' as const },
    };
    const body = { ...withoutHash, snapshot_hash: hashSupervisionBody(withoutHash) };
    const status = signSupervisionMessage({ protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
      ...credential.identity, ...AUTHORITY, sequence: replay.sequence, request_id: requestId,
      status: state.frozen ? 'frozen' : state.phase, body_hash: hashSupervisionBody(body) }, credential);
    return Response.json({ message: status, body });
  };
  return {
    fetch: Object.assign(handler, { preconnect: async (): Promise<void> => undefined }),
    setState(next: LiveState) { state = next; },
  };
}

test('lookupPhysicalSession observes actual bound-client renewal with an injected signed fetch', async () => {
  const identity: ConfigProcessIdentity = { master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000043', worker_slot: 0 };
  const boot = '50000000-0000-4000-8000-000000000043';
  const seed = deriveWorkerSupervisionSeed(ROOT, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
  const credential = deriveWorkerSupervisionCredential(seed, boot);
  const pid = 44_777;
  const live = liveStatusFetch(identity, credential, boot, pid, 43_777);
  const client = new WorkerControllerClient({ baseUrl: 'http://127.0.0.1:43777', credential, authority: AUTHORITY,
    fetch: live.fetch, timeoutMs: 1_000, leaseDurationMs: 60_000, renewBeforeMs: 50_000 });
  await client.attach();
  const adapter = new SupervisedConfigWorkerProcessAdapter({
    identity, descriptorPath: 'unused', supervisionSeed: seed, client: { authority: AUTHORITY },
    pid, readyClient: client, processIdentity: countingIdentityControl().control, kernelBootId: async () => TEST_KERNEL_BOOT_ID,
  });
  await adapter.initialization;
  const workerFactory = createFactory();
  own(workerFactory, adapter, identity);
  try {
    const before = workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot });
    expect(before).toMatchObject({ controlState: 'attached', phase: 'candidate', frozen: true, revision: null });
    // The bound client's own renewal snapshot moves to a new version/phase/frozen. The
    // adapter's recorded lastStatus stays stale, proving the fact follows the client.
    live.setState({ phase: 'draining', frozen: true, private_port: 41_003, revision: 2, content_hash: HASH, plugin_catalog_hash: CATALOG });
    await client.lease();
    const after = workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot });
    expect(after).toMatchObject({ phase: 'draining', frozen: true, revision: 2, content_hash: HASH, plugin_catalog_hash: CATALOG });
    expect(after!.status.revision).toBe(2);
  } finally {
    adapter.disconnect();
    workerFactory.disconnect();
  }
});

function spyChild(pid: number) {
  const listeners = new Map<string, () => void>();
  const child = {
    pid, unref: () => undefined,
    kill: () => true,
    once: (event: string, listener: () => void) => { listeners.set(event, listener); return child; },
  } as unknown as ChildProcess;
  return { child, emitExit: () => listeners.get('exit')?.() };
}

test('an attached worker fact becomes null after injected child exit without releasing required retirement ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-physical-session-exit-'));
  const identity: ConfigProcessIdentity = { master_generation: GENERATION, worker_instance_id: '40000000-0000-4000-8000-000000000072', worker_slot: 1 };
  const boot = '50000000-0000-4000-8000-000000000072';
  const child = spyChild(57_102);
  const controlPort = 43_772;
  const credential = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(ROOT, identity.master_generation, identity.worker_instance_id, identity.worker_slot), boot);
  const live = liveStatusFetch(identity, credential, boot, child.child.pid!, controlPort);
  const control = countingIdentityControl();
  const spawn: SupervisedConfigWorkerSpawn = () => child.child;
  const workerFactory = new SupervisedConfigWorkerFactory({
    kernelBootId: async () => TEST_KERNEL_BOOT_ID,
    launch: { source: 'compiled', executable: process.execPath, args: [] }, rootKey: ROOT,
    runtimeWorkersDirectory: directory, authority: AUTHORITY, masterControlPort: 3011,
    accessLogDbPath: join(directory, 'access.db'), transportSecret: 'secret',
    initializationTimeoutMs: 1_000, shutdownTimeoutMs: 25, processIdentity: control.control,
    client: { fetch: live.fetch }, allocateControlPort: () => controlPort, spawn,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopPhysical: (() => void) | undefined;
  const usableRetirements: unknown[] = [];
  const stopRetirement = workerFactory.subscribeExit((_process, evidence) => { usableRetirements.push(evidence); });
  try {
    // Valid MAC descriptor and actual WorkerControllerClient attach; OS identity
    // and HTTP transport are explicitly injected fixtures, not real process proof.
    await writeFile(join(directory, `${identity.worker_instance_id}.json`), JSON.stringify(signWorkerDescriptor({
      schema: 'bungee-worker-descriptor-v1', role: 'worker', ...identity,
      boot_nonce: boot, pid: child.child.pid!, control_port: controlPort,
      phase: 'candidate', frozen: true, private_port: null,
      revision: null, content_hash: null, plugin_catalog_hash: null,
      started_at: 1, evidence: { kind: 'candidate' },
    }, credential.process_key)));
    const adapter = workerFactory.spawn(identity);
    await adapter.initialization;
    const before = workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot });
    expect(before).not.toBeNull();
    expect(before).toMatchObject({ controlState: 'attached', phase: 'candidate', pid: child.child.pid! });
    expect(before!.captured.startToken).toBe('100');
    expect(before!.credential.identity.boot_nonce).toBe(boot);
    expect(control.captures).toBe(1);
    const drain = { ...drainMessage(), command: 'drain-worker' as const, ...identity, boot_nonce: boot, pid: adapter.pid };
    live.setState({ phase: 'draining', frozen: true, private_port: 41_003,
      revision: drain.revision, content_hash: drain.content_hash, plugin_catalog_hash: drain.plugin_catalog_hash });
    await adapter.send(drain);
    workerFactory.markCommitted([adapter]);
    expect(workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot }))
      .toMatchObject({ committed: true, phase: 'draining', frozen: true });
    expect(adapter.hasDrainTask).toBe(true);
    expect(adapter.latestSignedStatus!.evidence.kind).toBe('candidate');
    const physical = new Promise<unknown>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('injected physical exit was not observed')), 1_000);
      stopPhysical = adapter.subscribeExit(resolve);
    });
    child.emitExit();
    const proof = await physical;
    expect(proof).toMatchObject({ exited: true, pid: adapter.pid });
    expect(proof).not.toHaveProperty('terminalDrain');
    clearTimeout(timeout!);
    const internal = workerFactory as unknown as { exitHistory: Map<object, { exited: true; pid: number }> };
    expect(internal.exitHistory.has(adapter)).toBe(true);
    // Actual exit publication disconnects control, but this facts-only lookup
    // deliberately does not treat disconnect as physical death. Other exact
    // facts remain present: only recorded exit invalidates this snapshot.
    expect(adapter.controlState).toBe('disconnected');
    expect(adapter.bootNonce).toBe(boot);
    expect(adapter.latestSignedStatus!.phase).toBe('draining');
    expect(workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot })).toBeNull();
    // Isolated mutation check: demonstrate every other lookup predicate still
    // succeeds without the known-exit record, then restore it immediately. This
    // is injected fixture bookkeeping, NEVER production or an alive claim.
    const recorded = internal.exitHistory.get(adapter)!;
    internal.exitHistory.delete(adapter);
    try {
      expect(workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot })).not.toBeNull();
    } finally { internal.exitHistory.set(adapter, recorded); }
    expect(workerFactory.lookupPhysicalSession({ ...identity, boot_nonce: boot })).toBeNull();
    // Physical exit is distinct from cleanup-usable required retirement proof.
    expect(workerFactory.owns(adapter)).toBe(true);
    expect(usableRetirements).toHaveLength(0);
    expect(workerFactory.snapshot()).toHaveLength(1);
    expect(Object.is(workerFactory.snapshot()[0], adapter)).toBe(true);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    stopPhysical?.(); stopRetirement(); workerFactory.disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
