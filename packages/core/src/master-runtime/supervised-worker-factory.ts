import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ConfigProcessIdentity } from '../config-publication/types';
import type { ConfigPublicationWorkerFactory, ConfigPublicationWorkerProcess, ServingConfigWorker, WorkerExitEvidence } from '../config-publication/coordinator-types';
import type { ProcessCleanupResult } from '../config-publication/process-cleanup';
import { admissionSetIdentity, parseAdmissionSet, type AdmissionRegistryStatus, type AdmissionSet } from '../ingress';
import type { WorkerLaunch } from './process-options';
import { isLowercaseUuid } from '../config-storage/validation';
import { CONFIG_WORKER_ENV_NAMES, type SupervisedWorkerRateLimitSession } from '../config-worker/process-environment';
import { deriveWorkerSupervisionSeed, serializeWorkerSupervisionSeed, type SupervisionRootKeyMaterial } from '../supervision';
import { discoverSupervisedWorkers, type WorkerDiscoveryIssue } from './supervised-worker-discovery';
import { SupervisedConfigWorkerProcessAdapter, type ProcessIdentityControl, type WorkerUnavailableEvidence } from './supervised-worker-process-adapter';
import { WorkerControllerClient, type WorkerControllerClientOptions, type WorkerStatusPayload } from './supervised-worker-client';
import type { SupervisionProcessCredential } from '../supervision';
import type { WorkerRuntimeSnapshot } from '../supervision';
import { clearDaemonBootstrapEnvironment, DAEMON_BOOTSTRAP_ENV_NAMES } from '../daemon-control/bootstrap';
import { DAEMON_PROCESS_IDENTITY_MARKER_PREFIX } from '@jeffusion/bungee-types';

export type SupervisedControlPortAllocator = (identity: ConfigProcessIdentity) => number;
export type SupervisedConfigWorkerSpawn = (executable: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type SupervisedConfigWorkerFactoryOptions = {
  readonly launch: WorkerLaunch;
  readonly rootKey: SupervisionRootKeyMaterial;
  readonly runtimeWorkersDirectory: string;
  readonly authority: WorkerControllerClientOptions['authority'];
  readonly masterControlPort: number;
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly accessLogDbPath: string;
  readonly transportSecret: string;
  readonly rateLimitSession?: SupervisedWorkerRateLimitSession;
  readonly shutdownTimeoutMs: number;
  readonly configDbPath?: string;
  readonly client?: Omit<WorkerControllerClientOptions, 'baseUrl' | 'credential' | 'authority'>;
  readonly allocateControlPort?: SupervisedControlPortAllocator;
  readonly descriptorPathFor?: (identity: ConfigProcessIdentity) => string;
  readonly spawn?: SupervisedConfigWorkerSpawn;
  readonly initializationTimeoutMs?: number;
  /** Injectable exact-process OS operations; defaults to the real capture/probe/terminate. */
  readonly processIdentity?: ProcessIdentityControl;
  /** Re-checks signed ingress registry membership immediately before orphan cleanup. */
  readonly confirmOrphan?: () => Promise<AdmissionRegistryStatus>;
};

type Owned = { readonly process: SupervisedConfigWorkerProcessAdapter; readonly child?: ChildProcess };

export const STRIPPED_ROOT_ENV_NAMES = [
  'BUNGEE_PLUGIN_SECRETS_KEY', 'BUNGEE_SUPERVISION_ROOT_KEY', 'BUNGEE_ROOT_KEY', 'BUNGEE_MASTER_ROOT_KEY',
  'BUNGEE_MANAGEMENT_HOST', 'BUNGEE_MANAGEMENT_PORT',
  'BUNGEE_INGRESS_CREDENTIAL', 'BUNGEE_INGRESS_TRANSPORT_SECRET',
  CONFIG_WORKER_ENV_NAMES.ingressSupervisionPort, CONFIG_WORKER_ENV_NAMES.ingressProcessInstanceId, CONFIG_WORKER_ENV_NAMES.ingressBootNonce,
  'BUNGEE_PLUGIN_BINDING', 'BUNGEE_PLUGIN_BINDING_ID', 'BUNGEE_PLUGIN_BINDING_OPTIONS',
  'BUNGEE_PLUGIN_OPTIONS', 'BUNGEE_CONTROL_BINDING', 'BUNGEE_CONTROL_OPTIONS',
  DAEMON_BOOTSTRAP_ENV_NAMES.metadataPath, DAEMON_BOOTSTRAP_ENV_NAMES.bootNonce, DAEMON_BOOTSTRAP_ENV_NAMES.shutdownSecret,
] as const;
const STRIPPED_ROOT_ENV_NAMES_LOWER = new Set(STRIPPED_ROOT_ENV_NAMES.map((name) => name.toLowerCase()));

const DEFAULT_SPAWN: SupervisedConfigWorkerSpawn = (executable, args, options) => spawnChild(executable, [...args], options);

function rateLimitSessionEnvironment(session: SupervisedWorkerRateLimitSession | undefined): NodeJS.ProcessEnv {
  if (session === undefined) return {};
  if (typeof session !== 'object' || session === null || !Number.isSafeInteger(session.supervisionPort)
    || session.supervisionPort < 1 || session.supervisionPort > 65_535) {
    throw new Error('supervised rate-limit ingress port is invalid');
  }
  const ingress = session.expectedIngress;
  if (typeof ingress !== 'object' || ingress === null || !isLowercaseUuid(ingress.process_instance_id)
    || !isLowercaseUuid(ingress.boot_nonce)) {
    throw new Error('supervised rate-limit ingress identity is invalid');
  }
  return {
    [CONFIG_WORKER_ENV_NAMES.ingressSupervisionPort]: String(session.supervisionPort),
    [CONFIG_WORKER_ENV_NAMES.ingressProcessInstanceId]: ingress.process_instance_id,
    [CONFIG_WORKER_ENV_NAMES.ingressBootNonce]: ingress.boot_nonce,
  };
}

export type SupervisedAdoptionResult =
  | { readonly kind: 'adopted'; readonly workers: readonly SupervisedConfigWorkerProcessAdapter[]; readonly serving: readonly ServingConfigWorker[]; readonly issues: readonly WorkerDiscoveryIssue[] }
  | { readonly kind: 'recovering'; readonly code: 'admission_mismatch'; readonly workers: readonly []; readonly issues: readonly WorkerDiscoveryIssue[] }
  | { readonly kind: 'rejected'; readonly code: 'master_control_mismatch'; readonly workers: readonly []; readonly issues: readonly WorkerDiscoveryIssue[] };

export type AuthenticatedOrphanCleanupResult = {
  readonly cleaned: readonly ConfigProcessIdentity[];
  readonly exitUnknown: readonly ConfigProcessIdentity[];
  readonly issues: readonly WorkerDiscoveryIssue[];
};

export type IngressBootWorkerCleanupResult = {
  readonly kind: 'cleaned' | 'cleanup_debt' | 'retryable';
  readonly exited: readonly ConfigProcessIdentity[];
  /** Spawned children without OS exit proof; retry is required. */
  readonly spawnedExitUnconfirmed: readonly ConfigProcessIdentity[];
  /** Adopted workers received authenticated shutdown, but exit remains unproven. */
  readonly adoptedExitUnknown: readonly ConfigProcessIdentity[];
  /** Compatibility aggregate; callers must use the two fields above to choose recovery. */
  readonly exitUnknown: readonly ConfigProcessIdentity[];
} & ({ readonly kind: 'cleaned' | 'cleanup_debt' } | {
  readonly kind: 'retryable';
  readonly code: 'registry_unavailable' | 'registry_changed' | 'worker_facts_unavailable' | 'spawned_exit_unconfirmed';
});

export type IngressBootWorkerCleanupRequest = {
  /** Trusted current registry snapshot; every role is an exact protection set. */
  readonly registry: AdmissionRegistryStatus;
  /** Reads the same fenced registry again immediately before each signal/RPC. */
  readonly getFreshRegistry: () => Promise<AdmissionRegistryStatus>;
};

export type SupervisedWorkerAdmissionIdentity = {
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly private_port: number;
  readonly revision: number;
  readonly content_hash: string;
  readonly plugin_catalog_hash: string;
};

export type SupervisedWorkerControlSession = {
  readonly process: SupervisedConfigWorkerProcessAdapter;
  readonly credential: SupervisionProcessCredential;
  readonly controlState: WorkerControllerClient['state'];
  readonly status: () => Promise<WorkerStatusPayload>;
  readonly runtimeSnapshot?: (signal?: AbortSignal) => Promise<WorkerRuntimeSnapshot>;
};

export class SupervisedConfigWorkerFactoryError extends Error {
  readonly name = 'SupervisedConfigWorkerFactoryError';
  constructor(readonly code: 'already_owned' | 'worker_exit_unconfirmed', message: string) {
    super(message);
  }
}

function identityKey(identity: ConfigProcessIdentity): string {
  return JSON.stringify([identity.master_generation, identity.worker_instance_id, identity.worker_slot]);
}

export class SupervisedConfigWorkerFactory implements ConfigPublicationWorkerFactory {
  private readonly spawnWorker: SupervisedConfigWorkerSpawn;
  private rateLimitSession: SupervisedWorkerRateLimitSession | undefined;
  private readonly owned = new Map<ConfigPublicationWorkerProcess, Owned>();
  private readonly identities = new Set<string>();
  private readonly clients = new Map<string, { readonly client: WorkerControllerClient; readonly bootNonce: string; readonly port: number }>();
  private readonly adapters = new Map<string, SupervisedConfigWorkerProcessAdapter>();
  private readonly committed = new Set<ConfigPublicationWorkerProcess>();
  /** Exit proofs are keyed by process object: two adapters sharing a PID never consume each other's proof. */
  private readonly exitHistory = new Map<ConfigPublicationWorkerProcess, WorkerExitEvidence>();
  private readonly unavailableListeners = new Set<(process: SupervisedConfigWorkerProcessAdapter, evidence: WorkerUnavailableEvidence) => void>();
  private readonly exitListeners = new Set<(process: ConfigPublicationWorkerProcess, evidence: WorkerExitEvidence) => void>();
  private readonly eligibilityListeners = new Set<() => void>();

  constructor(private readonly options: SupervisedConfigWorkerFactoryOptions) {
    this.spawnWorker = options.spawn ?? DEFAULT_SPAWN;
    this.rateLimitSession = undefined;
    if (options.rateLimitSession !== undefined) this.setRateLimitSession(options.rateLimitSession);
    const port = options.masterControlPort;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error('supervised master control address is invalid');
    }
    if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0) {
      throw new Error('supervised shutdown timeout is invalid');
    }
  }

  spawn(identity: ConfigProcessIdentity): SupervisedConfigWorkerProcessAdapter {
    const key = identityKey(identity);
    if (this.identities.has(key)) throw new SupervisedConfigWorkerFactoryError('already_owned', 'supervised worker identity is already owned');
    const controlPort = this.options.allocateControlPort?.(identity) ?? 0;
    if (!Number.isSafeInteger(controlPort) || controlPort < 0 || controlPort > 65_535) throw new Error('supervised control port is invalid');
    const descriptorPath = this.options.descriptorPathFor?.(identity)
      ?? join(this.options.runtimeWorkersDirectory, `${identity.worker_instance_id}.json`);
    const seed = deriveWorkerSupervisionSeed(this.options.rootKey, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env) };
    for (const name of Object.keys(env)) {
      if (STRIPPED_ROOT_ENV_NAMES_LOWER.has(name.toLowerCase())) delete env[name];
    }
    clearDaemonBootstrapEnvironment(env);
    const child = this.spawnWorker(this.options.launch.executable, [...this.options.launch.args,
      `${DAEMON_PROCESS_IDENTITY_MARKER_PREFIX}${identity.worker_instance_id}`], {
      detached: true, shell: false, cwd: this.options.cwd, stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...env,
        BUNGEE_WORKER_STARTUP_WATCHDOG_MS: String(this.options.initializationTimeoutMs ?? 30_000),
        BUNGEE_ROLE: 'worker',
        BUNGEE_MASTER_GENERATION: identity.master_generation, BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id,
        BUNGEE_WORKER_SLOT: String(identity.worker_slot), BUNGEE_WORKER_CONTROL_PORT: String(controlPort),
         [CONFIG_WORKER_ENV_NAMES.masterControlPort]: String(this.options.masterControlPort),
        BUNGEE_WORKER_SUPERVISION_SEED: serializeWorkerSupervisionSeed(seed), BUNGEE_WORKER_DESCRIPTOR_PATH: resolve(descriptorPath),
        BUNGEE_WORKER_ATTACH_GRACE_MS: '5000',
        BUNGEE_ACCESS_DB_PATH: resolve(this.options.accessLogDbPath), BUNGEE_INTERNAL_TRANSPORT_SECRET: this.options.transportSecret,
        ...(this.options.configDbPath === undefined ? {} : { BUNGEE_CONFIG_DB_PATH: resolve(this.options.configDbPath) }),
        ...rateLimitSessionEnvironment(this.rateLimitSession),
      },
    });
    // No child.kill anywhere in the spawn path: every spawned worker carries its own
    // startup watchdog (BUNGEE_WORKER_STARTUP_WATCHDOG_MS) and self-terminates, and a
    // bare child PID must never be signaled without OS identity proof.
    child.unref();
    const workerProcess = new SupervisedConfigWorkerProcessAdapter({
      identity, descriptorPath: resolve(descriptorPath), supervisionSeed: seed,
      client: { ...(this.options.client ?? {}), authority: this.options.authority }, child,
      clientFor: (clientOptions) => this.clientFor(identity, clientOptions.authority, clientOptions),
      initializationTimeoutMs: this.options.initializationTimeoutMs,
      processIdentity: this.options.processIdentity,
    });
    this.identities.add(key);
    this.adapters.set(key, workerProcess);
    this.owned.set(workerProcess, { process: workerProcess, child });
    this.bindUnavailable(workerProcess);
    this.bindExit(workerProcess);
    // Initialization failure keeps ownership by design: the still-bound child exit event
    // or a later dead/mismatch verifyExactExit proof releases it. No OS signal is sent
    // and no ownership map is mutated here.
    void workerProcess.initialization.catch(() => undefined);
    return workerProcess;
  }

  /** Changes only the session captured by workers spawned after this call. */
  setRateLimitSession(session: SupervisedWorkerRateLimitSession): void {
    rateLimitSessionEnvironment(session);
    this.rateLimitSession = {
      supervisionPort: session.supervisionPort,
      expectedIngress: {
        process_instance_id: session.expectedIngress.process_instance_id,
        boot_nonce: session.expectedIngress.boot_nonce,
      },
    };
  }

  async discoverAndAdopt(expectedAdmissionSet: AdmissionSet): Promise<SupervisedAdoptionResult> {
    const admission = parseAdmissionSet(expectedAdmissionSet);
    const discovered = await discoverSupervisedWorkers({
      runtimeWorkersDirectory: this.options.runtimeWorkersDirectory, rootKey: this.options.rootKey, authority: this.options.authority,
      masterControlPort: this.options.masterControlPort,
      client: { ...(this.options.client ?? {}) }, mode: 'exact-admission', expectedAdmission: admission,
      clientFor: (identity, authority, clientOptions) => this.clientFor(identity, authority, clientOptions),
    });
    const actual = new Map(discovered.workers.map((worker) => [identityKey({ master_generation: worker.status.master_generation, worker_instance_id: worker.status.worker_instance_id, worker_slot: worker.status.worker_slot }), worker]));
    const complete = discovered.workers.length === admission.workers.length && admission.workers.every((item) => {
      const worker = actual.get(identityKey({ master_generation: item.master_generation, worker_instance_id: item.worker_instance_id, worker_slot: item.worker_slot }));
      if (worker === undefined) return false;
      const status = worker.status;
      return status.boot_nonce === item.boot_nonce && status.private_port === item.private_port && status.revision === admission.revision
        && status.content_hash === admission.content_hash && status.plugin_catalog_hash === admission.plugin_catalog_hash;
    });
    if (!complete) {
      if (discovered.issues.some(({ kind }) => kind === 'master_control_mismatch')) {
        return { kind: 'rejected', code: 'master_control_mismatch', workers: [], issues: discovered.issues };
      }
      return { kind: 'recovering', code: 'admission_mismatch', workers: [], issues: discovered.issues };
    }
    const workers: SupervisedConfigWorkerProcessAdapter[] = [];
    const staged: SupervisedConfigWorkerProcessAdapter[] = [];
    try {
      for (const worker of discovered.workers) {
        const identity: ConfigProcessIdentity = {
          master_generation: worker.status.master_generation, worker_instance_id: worker.status.worker_instance_id, worker_slot: worker.status.worker_slot,
        };
        const key = identityKey(identity);
        const existing = [...this.owned.keys()].find((candidate): candidate is SupervisedConfigWorkerProcessAdapter =>
          candidate instanceof SupervisedConfigWorkerProcessAdapter
          && identityKey(candidate.identity) === key && candidate.bootNonce === worker.status.boot_nonce);
        if (existing !== undefined) {
          workers.push(existing);
          continue;
        }
        const workerProcess = new SupervisedConfigWorkerProcessAdapter({
          identity, descriptorPath: worker.file, supervisionSeed: deriveWorkerSupervisionSeed(this.options.rootKey, identity.master_generation, identity.worker_instance_id, identity.worker_slot),
          client: { ...(this.options.client ?? {}), authority: this.options.authority }, pid: worker.status.pid, readyClient: worker.client,
          clientFor: (clientOptions) => this.clientFor(identity, clientOptions.authority, clientOptions),
          processIdentity: this.options.processIdentity,
        });
        workerProcess.bootNonce = worker.status.boot_nonce;
        // Stage before proving identity: a rejected initialization must disconnect this
        // adapter's discovery client too, not just the previously staged ones, and a
        // wrong or unknown capture rejects initialization before anything is registered
        // as owned.
        staged.push(workerProcess);
        await workerProcess.initialization;
        workers.push(workerProcess);
      }
    } catch (error) {
      // Ownership maps are untouched until every staged adapter proved its identity.
      for (const worker of staged) worker.disconnect();
      throw error;
    }
    // Atomic registration of the fully staged adoption set.
    for (const workerProcess of staged) {
      const key = identityKey(workerProcess.identity);
      this.identities.add(key); this.adapters.set(key, workerProcess); this.owned.set(workerProcess, { process: workerProcess });
      this.bindUnavailable(workerProcess);
      this.bindExit(workerProcess);
    }
    const serving = discovered.workers.map((worker, index) => {
      const message = worker.status.evidence.message;
      if (worker.status.revision === null || worker.status.content_hash === null
        || worker.status.plugin_catalog_hash === null || worker.status.private_port === null) {
        throw new Error('adopted worker status is not serving');
      }
      return Object.freeze({
        process: workers[index]!, revision: worker.status.revision,
        content_hash: worker.status.content_hash, plugin_catalog_hash: worker.status.plugin_catalog_hash,
        private_port: worker.status.private_port,
        publication: message !== undefined && 'publication' in message ? message.publication : null,
      }) satisfies ServingConfigWorker;
    });
    return { kind: 'adopted', workers, serving, issues: discovered.issues };
  }

  snapshot(): readonly ConfigPublicationWorkerProcess[] { return [...this.owned.keys()]; }

  owns(process: ConfigPublicationWorkerProcess): boolean { return this.owned.has(process); }

  lookupExactControlSession(identity: SupervisedWorkerAdmissionIdentity): SupervisedWorkerControlSession | null {
    const process = this.adapters.get(identityKey(identity));
    if (process === undefined || !this.owned.has(process) || !this.committed.has(process)
      || process.bootNonce !== identity.boot_nonce || process.controlState !== 'attached') return null;
    const client = [...this.clients.entries()].find(([key, entry]) =>
      key.startsWith(`${identityKey(identity)}:`) && entry.bootNonce === identity.boot_nonce)?.[1].client;
    const status = client?.cachedStatus ?? process.cachedStatus;
    if (status === null || status.phase !== 'serving' || status.frozen
      || status.master_generation !== identity.master_generation
      || status.worker_instance_id !== identity.worker_instance_id || status.worker_slot !== identity.worker_slot
      || status.boot_nonce !== identity.boot_nonce || status.private_port !== identity.private_port
      || status.revision !== identity.revision || status.content_hash !== identity.content_hash
      || status.plugin_catalog_hash !== identity.plugin_catalog_hash) return null;
    const credential = process.supervisionCredential;
    if (credential === null) return null;
    return {
      process, credential, get controlState() { return process.controlState; },
      status: () => process.status(),
      runtimeSnapshot: (signal) => process.runtimeSnapshot(signal),
    };
  }

  pids(): readonly number[] { return [...this.owned.keys()].map((process) => process.pid); }

  subscribeExit(listener: (process: ConfigPublicationWorkerProcess, evidence: WorkerExitEvidence) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  async shutdownAll(): Promise<readonly ProcessCleanupResult[]> {
    const processes = this.snapshot();
    await this.shutdownOwned();
    // Evidence is paired per process object, never re-associated by PID.
    return processes.map((process) => ({ process, exitEvidence: this.exitHistory.get(process) ?? null }));
  }

  disconnectAll(): void {
    for (const { process } of this.owned.values()) {
      // Registered workers are never OS-force-killed here, and ownership is never
      // released: a later real child exit must still converge ownership per process
      // object instead of being masked or escaped by a disconnect.
      process.disconnect();
    }
    for (const entry of this.clients.values()) entry.client.disconnect();
    this.notifyEligibilityChange();
  }

  markCommitted(processes: readonly ConfigPublicationWorkerProcess[]): void {
    let changed = false;
    for (const process of processes) {
      if (this.owned.has(process) && !this.committed.has(process)) {
        this.committed.add(process);
        changed = true;
      }
    }
    if (changed) this.notifyEligibilityChange();
  }

  disconnectProcesses(processes: readonly ConfigPublicationWorkerProcess[]): void {
    const wanted = new Set(processes);
    for (const { process } of this.owned.values()) if (wanted.has(process)) process.disconnect();
    this.notifyEligibilityChange();
  }

  async discardConfirmedUncommitted(target: AdmissionSet): Promise<void> {
    const expected = new Set(target.workers.map((worker) => JSON.stringify([
      target.master_generation, worker.worker_instance_id, worker.worker_slot, worker.boot_nonce,
    ])));
    const candidates = [...this.owned.values()].filter(({ process }) => expected.has(JSON.stringify([
      process.identity.master_generation, process.identity.worker_instance_id, process.identity.worker_slot, process.bootNonce,
    ])));
    for (const { process } of candidates) {
      if (process.origin !== 'spawned') {
        await process.terminate('graceful');
        // Adopted discard needs OS exit proof; an unproven exit keeps ownership with the
        // caller and surfaces as the existing worker_exit_unconfirmed failure.
        if (await this.waitForExactExit(process) === null) {
          throw new SupervisedConfigWorkerFactoryError('worker_exit_unconfirmed', 'confirmed uncommitted worker exit is unknown');
        }
        continue;
      }
      try { await process.terminate('graceful'); } catch { /* force below */ }
      let exit = await this.waitForExactExit(process);
      if (exit === null) {
        try { await process.terminate('force'); } catch { /* retain ownership */ }
        exit = await this.waitForExactExit(process);
      }
      if (exit === null) {
        throw new SupervisedConfigWorkerFactoryError('worker_exit_unconfirmed', 'confirmed uncommitted worker exit is unknown');
      }
    }
  }

  /** Old ingress identities must never be re-admitted after an ingress boot change. */
  async retireForIngressBootChange(request?: IngressBootWorkerCleanupRequest): Promise<IngressBootWorkerCleanupResult> {
    const exited: ConfigProcessIdentity[] = [];
    const spawnedExitUnconfirmed: ConfigProcessIdentity[] = [];
    const adoptedExitUnknown: ConfigProcessIdentity[] = [];
    if (request === undefined) return this.ingressBootCleanupResult('retryable', 'registry_unavailable', exited, spawnedExitUnconfirmed, adoptedExitUnknown);

    let protectedWorkers: Set<string>;
    let registryIdentity: string;
    try {
      ({ protectedWorkers, registryIdentity } = this.admissionRegistrySnapshot(request.registry));
    } catch {
      return this.ingressBootCleanupResult('retryable', 'registry_unavailable', exited, spawnedExitUnconfirmed, adoptedExitUnknown);
    }
    for (const { process } of [...this.owned.values()]) {
      const workerKey = this.ownedAdmissionWorkerKey(process);
      if (workerKey === null) {
        return this.ingressBootCleanupResult('retryable', 'worker_facts_unavailable', exited, spawnedExitUnconfirmed, adoptedExitUnknown);
      }
      if (protectedWorkers.has(workerKey)) continue;

      const fresh = await this.confirmUnchangedRegistry(request.getFreshRegistry, registryIdentity);
      if (fresh !== null) {
        return this.ingressBootCleanupResult('retryable', fresh, exited, spawnedExitUnconfirmed, adoptedExitUnknown);
      }
      if (process.origin !== 'spawned') {
        try { await process.terminate('graceful'); } catch { /* cleanup debt remains owned and retryable by the caller */ }
        if (await this.waitForExactExit(process) === null) adoptedExitUnknown.push(process.identity);
        else exited.push(process.identity);
        continue;
      }
      try { await process.terminate('graceful'); } catch { /* force below */ }
      let exit = await this.waitForExactExit(process);
      if (exit === null) {
        const beforeForce = await this.confirmUnchangedRegistry(request.getFreshRegistry, registryIdentity);
        if (beforeForce !== null) {
          spawnedExitUnconfirmed.push(process.identity);
          return this.ingressBootCleanupResult('retryable', beforeForce, exited, spawnedExitUnconfirmed, adoptedExitUnknown);
        }
        try { await process.terminate('force'); } catch { /* ownership is retained */ }
        exit = await this.waitForExactExit(process);
      }
      if (exit === null) {
        spawnedExitUnconfirmed.push(process.identity);
        continue;
      }
      exited.push(process.identity);
    }
    this.notifyEligibilityChange();
    return this.ingressBootCleanupResult(
      spawnedExitUnconfirmed.length === 0 ? (adoptedExitUnknown.length === 0 ? 'cleaned' : 'cleanup_debt') : 'retryable',
      spawnedExitUnconfirmed.length === 0 ? undefined : 'spawned_exit_unconfirmed',
      exited, spawnedExitUnconfirmed, adoptedExitUnknown,
    );
  }

  async cleanupAuthenticatedOrphans(registryStatus: AdmissionRegistryStatus): Promise<AuthenticatedOrphanCleanupResult> {
    const protectedIdentities = this.admissionIdentityKeys(registryStatus);
    const discovered = await discoverSupervisedWorkers({
      runtimeWorkersDirectory: this.options.runtimeWorkersDirectory,
      rootKey: this.options.rootKey,
      authority: this.options.authority,
      masterControlPort: this.options.masterControlPort,
      client: { ...(this.options.client ?? {}) },
      mode: 'orphan-inventory',
      clientFor: (identity, authority, clientOptions) => this.clientFor(identity, authority, clientOptions),
    });
    const cleaned: ConfigProcessIdentity[] = [];
    const exitUnknown: ConfigProcessIdentity[] = [];
    const issues = [...discovered.issues];
    for (const worker of discovered.workers) {
      const identity: ConfigProcessIdentity = {
        master_generation: worker.status.master_generation,
        worker_instance_id: worker.status.worker_instance_id,
        worker_slot: worker.status.worker_slot,
      };
      const workerKey = this.admissionWorkerKey(identity, worker.status.boot_nonce, worker.status.private_port,
        worker.status.revision, worker.status.content_hash, worker.status.plugin_catalog_hash);
      if (protectedIdentities.has(workerKey)) continue;
      if (this.options.confirmOrphan !== undefined) {
        try {
          const refreshed = await this.options.confirmOrphan();
          if (this.admissionIdentityKeys(refreshed).has(workerKey)) continue;
        } catch (error) {
          issues.push({ file: worker.file, kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }
      let process = [...this.owned.keys()].find((candidate): candidate is SupervisedConfigWorkerProcessAdapter =>
        candidate instanceof SupervisedConfigWorkerProcessAdapter
        && identityKey(candidate.identity) === identityKey(identity) && candidate.bootNonce === worker.status.boot_nonce);
      if (process === undefined) {
        process = new SupervisedConfigWorkerProcessAdapter({
          identity,
          descriptorPath: worker.file,
          supervisionSeed: deriveWorkerSupervisionSeed(this.options.rootKey, identity.master_generation, identity.worker_instance_id, identity.worker_slot),
          client: { ...(this.options.client ?? {}), authority: this.options.authority },
          pid: worker.status.pid,
          readyClient: worker.client,
          clientFor: (clientOptions) => this.clientFor(identity, clientOptions.authority, clientOptions),
          processIdentity: this.options.processIdentity,
        });
        process.bootNonce = worker.status.boot_nonce;
        try {
          // Orphan handling also requires exact OS ownership before registration.
          await process.initialization;
        } catch (error) {
          process.disconnect();
          issues.push({ file: worker.file, kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) });
          continue;
        }
        this.identities.add(identityKey(identity));
        if (!this.adapters.has(identityKey(identity))) this.adapters.set(identityKey(identity), process);
        this.owned.set(process, { process });
        this.bindUnavailable(process);
        this.bindExit(process);
      }
      try {
        if (process.origin === 'spawned') {
          await process.terminate('graceful').catch(() => undefined);
          let exit = await this.waitForExactExit(process);
          if (exit === null) {
            await process.terminate('force').catch(() => undefined);
            exit = await this.waitForExactExit(process);
          }
          if (exit === null) {
            exitUnknown.push(identity);
            issues.push({ file: worker.file, kind: 'unreachable', detail: 'worker exit was not confirmed' });
            continue;
          }
          cleaned.push(identity);
        } else {
          try {
            await process.terminate('graceful');
          } catch (error) {
            // Graceful shutdown may itself fail; the exact OS probe still decides the
            // outcome. The issue is kept for observability while exitUnknown keeps
            // driving admission recovery, so ownership is never dropped on a transport error.
            issues.push({ file: worker.file, kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) });
          }
          if (await this.waitForExactExit(process) !== null) {
            cleaned.push(identity);
          } else {
            // No exit proof: ownership is kept (no release, no disconnect) and the caller
            // retries through the exitUnknown channel.
            exitUnknown.push(identity);
          }
        }
      } catch (error) {
        issues.push({ file: worker.file, kind: 'unreachable', detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return { cleaned, exitUnknown, issues };
  }

  private admissionIdentityKeys(status: AdmissionRegistryStatus): Set<string> {
    const sets = [status.active, status.prepared, ...status.retired];
    return new Set(sets.flatMap((set) => set === null ? [] : parseAdmissionSet(set).workers.map((worker) => this.admissionWorkerKey({
      master_generation: worker.master_generation, worker_instance_id: worker.worker_instance_id, worker_slot: worker.worker_slot,
    }, worker.boot_nonce, worker.private_port, set.revision, set.content_hash, set.plugin_catalog_hash))));
  }

  private admissionRegistrySnapshot(status: AdmissionRegistryStatus): { readonly protectedWorkers: Set<string>; readonly registryIdentity: string } {
    if (typeof status !== 'object' || status === null || !Array.isArray(status.retired)) throw new Error('admission registry is unavailable');
    const sets = [status.active, status.prepared, ...status.retired].map((set) => set === null ? null : parseAdmissionSet(set));
    const protectedWorkers = new Set(sets.flatMap((set) => set === null ? [] : set.workers.map((worker) => this.admissionWorkerKey({
      master_generation: worker.master_generation, worker_instance_id: worker.worker_instance_id, worker_slot: worker.worker_slot,
    }, worker.boot_nonce, worker.private_port, set.revision, set.content_hash, set.plugin_catalog_hash))));
    return {
      protectedWorkers,
      registryIdentity: JSON.stringify(sets.map((set) => set === null ? null : admissionSetIdentity(set))),
    };
  }

  private async confirmUnchangedRegistry(
    getFreshRegistry: () => Promise<AdmissionRegistryStatus>,
    expectedRegistryIdentity: string,
  ): Promise<'registry_unavailable' | 'registry_changed' | null> {
    try {
      return this.admissionRegistrySnapshot(await getFreshRegistry()).registryIdentity === expectedRegistryIdentity ? null : 'registry_changed';
    } catch {
      return 'registry_unavailable';
    }
  }

  private ownedAdmissionWorkerKey(process: SupervisedConfigWorkerProcessAdapter): string | null {
    const status = process.cachedStatus;
    const credential = process.supervisionCredential;
    if (status === null || credential === null || process.bootNonce === null
      || credential.identity.process_instance_id !== process.identity.worker_instance_id
      || credential.identity.boot_nonce !== process.bootNonce
      || status.master_generation !== process.identity.master_generation
      || status.worker_instance_id !== process.identity.worker_instance_id
      || status.worker_slot !== process.identity.worker_slot || status.boot_nonce !== process.bootNonce
      || status.private_port === null || status.revision === null || status.content_hash === null || status.plugin_catalog_hash === null) return null;
    return this.admissionWorkerKey(process.identity, process.bootNonce, status.private_port,
      status.revision, status.content_hash, status.plugin_catalog_hash);
  }

  private ingressBootCleanupResult(
    kind: IngressBootWorkerCleanupResult['kind'],
    code: Extract<IngressBootWorkerCleanupResult, { readonly kind: 'retryable' }>['code'] | undefined,
    exited: readonly ConfigProcessIdentity[],
    spawnedExitUnconfirmed: readonly ConfigProcessIdentity[],
    adoptedExitUnknown: readonly ConfigProcessIdentity[],
  ): IngressBootWorkerCleanupResult {
    const exitUnknown = [...spawnedExitUnconfirmed, ...adoptedExitUnknown];
    if (kind === 'retryable') return { kind, code: code!, exited, spawnedExitUnconfirmed, adoptedExitUnknown, exitUnknown };
    return { kind, exited, spawnedExitUnconfirmed, adoptedExitUnknown, exitUnknown };
  }

  private admissionWorkerKey(
    identity: ConfigProcessIdentity,
    bootNonce: string,
    privatePort: number | null,
    revision: number | null,
    contentHash: string | null,
    pluginCatalogHash: string | null,
  ): string {
    return JSON.stringify([identityKey(identity), bootNonce, privatePort, revision, contentHash, pluginCatalogHash]);
  }

  private async waitForExactExit(process: SupervisedConfigWorkerProcessAdapter): Promise<WorkerExitEvidence | null> {
    const known = this.exitHistory.get(process);
    if (known !== undefined) return known;
    let evidence: WorkerExitEvidence | null = null;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const unsubscribe = process.subscribeExit((value) => { evidence = value; resolveExit(); });
    try { await Promise.race([exited, Bun.sleep(this.options.shutdownTimeoutMs)]); }
    finally { unsubscribe(); }
    if (evidence !== null) return evidence;
    // No child exit event (adopted workers never had one): ask the adapter for an OS-level
    // exact-exit proof. An unknown probe keeps ownership with the caller and is reported
    // through the existing unconfirmed-exit channels.
    if (typeof process.verifyExactExit === 'function') {
      try { return await process.verifyExactExit(); } catch { return null; }
    }
    return null;
  }

  subscribeUnavailable(listener: (process: SupervisedConfigWorkerProcessAdapter, evidence: WorkerUnavailableEvidence) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => { this.unavailableListeners.delete(listener); };
  }

  subscribeEligibilityChange(listener: () => void): () => void {
    this.eligibilityListeners.add(listener);
    return () => { this.eligibilityListeners.delete(listener); };
  }

  onUnavailable(listener: (process: SupervisedConfigWorkerProcessAdapter, evidence: WorkerUnavailableEvidence) => void): () => void {
    return this.subscribeUnavailable(listener);
  }

  disconnect(): void {
    for (const { process } of this.owned.values()) process.disconnect();
    for (const entry of this.clients.values()) entry.client.disconnect();
    this.clients.clear();
    this.adapters.clear();
    this.notifyEligibilityChange();
  }

  private clientFor(identity: ConfigProcessIdentity, authority: WorkerControllerClientOptions['authority'], options: WorkerControllerClientOptions): WorkerControllerClient {
    const key = `${identityKey(identity)}:${options.credential.identity.boot_nonce}:${authority.controller_epoch}:${authority.controller_id}`;
    options = { ...options, authority };
    const port = Number(new URL(options.baseUrl).port);
    const existing = this.clients.get(key);
    if (existing !== undefined) {
      if (existing.bootNonce !== options.credential.identity.boot_nonce || existing.port !== port) {
        throw new Error('supervised worker identity already has a different control client');
      }
      return existing.client;
    }
    const client = new WorkerControllerClient(options);
    this.clients.set(key, { client, bootNonce: options.credential.identity.boot_nonce, port });
    client.subscribeControlState((state) => {
      this.notifyEligibilityChange();
      if (state === 'disconnected' && this.clients.get(key)?.client === client) this.clients.delete(key);
    });
    return client;
  }

  private bindUnavailable(process: SupervisedConfigWorkerProcessAdapter): void {
    process.subscribeUnavailable((evidence) => {
      this.notifyEligibilityChange();
      for (const listener of [...this.unavailableListeners]) listener(process, evidence);
    });
  }

  private notifyEligibilityChange(): void {
    for (const listener of [...this.eligibilityListeners]) {
      try { listener(); } catch { /* eligibility observers must not affect worker supervision */ }
    }
  }

  private bindExit(process: SupervisedConfigWorkerProcessAdapter): void {
    process.subscribeExit((evidence) => {
      if (this.exitHistory.has(process)) return; // idempotent under repeated/concurrent exit delivery
      this.exitHistory.set(process, evidence);
      if (!this.owned.has(process)) return;
      this.owned.delete(process);
      this.committed.delete(process);
      if (![...this.owned.keys()].some((candidate) => identityKey(candidate.identity) === identityKey(process.identity))) {
        this.identities.delete(identityKey(process.identity));
      }
      if (this.adapters.get(identityKey(process.identity)) === process) this.adapters.delete(identityKey(process.identity));
      this.notifyEligibilityChange();
      for (const listener of [...this.exitListeners]) listener(process, evidence);
    });
  }

  async shutdownOwned(): Promise<readonly WorkerExitEvidence[]> {
    const processes = [...this.owned.values()];
    const exits: WorkerExitEvidence[] = [];
    await Promise.all(processes.map(async ({ process }) => {
      let exit: WorkerExitEvidence | null = this.exitHistory.get(process) ?? null;
      let resolveExit: (() => void) | null = null;
      const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
      const unsubscribe = process.subscribeExit((evidence) => { exit = evidence; resolveExit?.(); });
      try {
        try { await process.terminate('graceful'); } catch { /* force below */ }
        if (process.origin === 'spawned' && exit === null) {
          await Promise.race([exitPromise, Bun.sleep(this.options.shutdownTimeoutMs)]);
        }
        if (process.origin === 'spawned' && exit === null) {
          // Force fails closed by design; the fallback call is kept so ownership is
          // simply retained when no proof arrives.
          try { await process.terminate('force'); } catch { /* retain unknown exit */ }
          await Promise.race([exitPromise, Bun.sleep(this.options.shutdownTimeoutMs)]);
        }
        if (exit === null && typeof process.verifyExactExit === 'function') {
          // Adopted workers have no child exit event; fall back to the exact OS probe.
          try { exit = await process.verifyExactExit(); } catch { /* unknown exit stays unproven */ }
        }
        if (exit === null) return; // no proof: ownership and the control connection stay
        exits.push(exit);
        process.disconnect();
        this.owned.delete(process);
        this.committed.delete(process);
        this.identities.delete(identityKey(process.identity));
        this.adapters.delete(identityKey(process.identity));
      } finally {
        unsubscribe();
      }
    }));
    this.notifyEligibilityChange();
    return exits;
  }
}
