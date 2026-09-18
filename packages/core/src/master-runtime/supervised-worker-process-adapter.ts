import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ConfigMasterMessage, ConfigProcessIdentity, ConfigWorkerMessage } from '../config-publication/types';
import type { ConfigWorkerRuntimeMessage } from '../config-publication/worker-runtime-contract';
import type { ConfigPublicationWorkerProcess, WorkerExitEvidence } from '../config-publication/coordinator-types';
import {
  deriveWorkerSupervisionCredential,
  parseWorkerDescriptor,
  type WorkerSupervisionSeed,
  type SupervisionProcessCredential,
} from '../supervision';
import { parseWorkerDescriptorHint } from './supervised-worker-discovery';
import { WorkerControllerClient, type WorkerControllerClientOptions, type WorkerStatusPayload } from './supervised-worker-client';
import {
  captureProcessIdentity,
  probeProcessIdentity,
  type CapturedProcessIdentity,
  type ProcessIdentityProbe,
} from './process-identity';
import type { WorkerRuntimeSnapshot } from '../supervision';

export type WorkerUnavailableEvidence = { readonly kind: 'unavailable'; readonly pid: number };

/**
 * Injectable OS-level exact-process operations. Production uses the real
 * capture/probe from ./process-identity; unit tests replace these so fake
 * children never touch the operating system. There is deliberately no
 * terminate: registered workers are never OS-force-signaled.
 */
export type ProcessIdentityControl = Readonly<{
  readonly capture: (pid: number, processInstanceId: string) => Promise<CapturedProcessIdentity>;
  readonly probe: (expected: CapturedProcessIdentity) => Promise<ProcessIdentityProbe>;
}>;

const DEFAULT_PROCESS_IDENTITY: ProcessIdentityControl = {
  capture: (pid, processInstanceId) => captureProcessIdentity(pid, processInstanceId),
  probe: (expected) => probeProcessIdentity(expected),
};

export type SupervisedConfigWorkerProcessAdapterOptions = {
  readonly identity: ConfigProcessIdentity;
  readonly descriptorPath: string;
  readonly supervisionSeed: WorkerSupervisionSeed;
  readonly client: Omit<WorkerControllerClientOptions, 'baseUrl' | 'credential'>;
  readonly child?: ChildProcess;
  readonly pid?: number;
  readonly readyClient?: WorkerControllerClient;
  readonly clientFor?: (options: WorkerControllerClientOptions) => WorkerControllerClient;
  readonly initializationTimeoutMs?: number;
  readonly processIdentity?: ProcessIdentityControl;
};

function isWorkerCommand(message: ConfigMasterMessage): message is Exclude<ConfigMasterMessage, { readonly status: string }> {
  return 'command' in message && (message.command === 'start-config-worker' || message.command === 'start-current-config-worker' || message.command === 'drain-worker');
}

export class SupervisedConfigWorkerProcessAdapter implements ConfigPublicationWorkerProcess {
  readonly slot: number;
  readonly identity: ConfigProcessIdentity;
  readonly pid: number;
  readonly origin: 'spawned' | 'adopted';
  readonly initialization: Promise<void>;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly exitListeners = new Set<(evidence: WorkerExitEvidence) => void>();
  private readonly unavailableListeners = new Set<(evidence: WorkerUnavailableEvidence) => void>();
  private client: WorkerControllerClient | null = null;
  private lastStatus: WorkerStatusPayload | null = null;
  bootNonce: string | null = null;
  private clientStateUnsubscribe: (() => void) | null = null;
  private exitEvidence: WorkerExitEvidence | null = null;
  private capturedIdentity: CapturedProcessIdentity | null = null;
  private readonly identityControl: ProcessIdentityControl;
  private stopped = false;

  constructor(private readonly options: SupervisedConfigWorkerProcessAdapterOptions) {
    this.identity = options.identity;
    this.slot = options.identity.worker_slot;
    this.origin = options.child === undefined ? 'adopted' : 'spawned';
    this.pid = options.child?.pid ?? options.pid ?? 0;
    this.identityControl = options.processIdentity ?? DEFAULT_PROCESS_IDENTITY;
    if (this.origin === 'spawned' && this.pid <= 0) throw new Error('supervised child has no PID');
    if (options.child !== undefined) {
      options.child.once('exit', () => this.emitExit());
      options.child.once('error', () => undefined);
    }
    this.initialization = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.options.readyClient !== undefined) {
      // Exact identity is captured before anything else: a wrong or unknown capture
      // rejects initialization before the ready client's control-state subscription
      // is retained.
      this.capturedIdentity = await this.identityControl.capture(this.pid, this.identity.worker_instance_id);
      this.client = this.options.readyClient;
      this.bootNonce = this.client.credential.identity.boot_nonce;
      this.lastStatus = this.client.cachedStatus;
      this.clientStateUnsubscribe = this.client.subscribeControlState((state) => {
        if (state === 'unavailable' || state === 'recovering') {
          const evidence: WorkerUnavailableEvidence = { kind: 'unavailable', pid: this.pid };
          for (const listener of [...this.unavailableListeners]) listener(evidence);
        }
      });
      return;
    }
    const timeoutMs = this.options.initializationTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (this.stopped) throw new Error('supervised worker exited during initialization');
      try {
        const raw = JSON.parse(await readFile(this.options.descriptorPath, 'utf8')) as unknown;
        const hint = parseWorkerDescriptorHint(raw);
        if (hint.master_generation !== this.identity.master_generation || hint.worker_instance_id !== this.identity.worker_instance_id
          || hint.worker_slot !== this.identity.worker_slot) throw new Error('worker descriptor identity mismatch');
        const credential = deriveWorkerSupervisionCredential(this.options.supervisionSeed, hint.boot_nonce);
        const descriptor = parseWorkerDescriptor(raw, credential);
        this.bootNonce = descriptor.boot_nonce;
        if (descriptor.control_port !== hint.control_port || descriptor.pid !== this.pid && this.origin === 'spawned') throw new Error('worker descriptor process mismatch');
        if (this.capturedIdentity === null) {
          // Exact OS identity must be captured before control attach succeeds. A freshly
          // exec'd child may not expose its marker argv yet, so transient capture failures
          // retry within the same initialization deadline; a wrong or unknown identity
          // never reaches attach and therefore never becomes ready.
          this.capturedIdentity = await this.identityControl.capture(this.pid, this.identity.worker_instance_id);
        }
        if (this.client === null) {
          const clientOptions: WorkerControllerClientOptions = { ...this.options.client, baseUrl: `http://127.0.0.1:${descriptor.control_port}`, credential };
          this.client = this.options.clientFor?.(clientOptions) ?? new WorkerControllerClient(clientOptions);
          this.clientStateUnsubscribe = this.client.subscribeControlState((state) => {
            if (state === 'unavailable' || state === 'recovering') {
              const evidence: WorkerUnavailableEvidence = { kind: 'unavailable', pid: this.pid };
              for (const listener of [...this.unavailableListeners]) listener(evidence);
            }
          });
        }
        this.lastStatus = await this.client.attach();
        return;
      } catch (error) {
        lastError = error;
        await Bun.sleep(25);
      }
    }
    throw new Error(`supervised worker initialization timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private publishExitEvidence(): WorkerExitEvidence {
    this.stopped = true;
    this.client?.disconnect(false);
    const evidence: WorkerExitEvidence = { exited: true, pid: this.pid };
    this.exitEvidence = evidence;
    for (const listener of [...this.exitListeners]) listener(evidence);
    return evidence;
  }

  private emitExit(): void {
    if (this.exitEvidence !== null || this.origin !== 'spawned') return;
    this.publishExitEvidence();
  }

  /** Exact OS identity captured during initialization; null until capture succeeds. */
  get capturedProcessIdentity(): CapturedProcessIdentity | null { return this.capturedIdentity; }

  /**
   * OS-level exit proof. A child exit event still counts as spawned proof; otherwise the
   * saved exact identity is probed: dead or mismatch proves the owned instance is gone
   * (evidence is published to exit listeners), exact means the process is still alive,
   * and unknown throws a sanitized error while the caller retains ownership.
   */
  async verifyExactExit(): Promise<WorkerExitEvidence | null> {
    if (this.exitEvidence !== null) return this.exitEvidence;
    const captured = this.capturedIdentity;
    if (captured === null) return null;
    const probe = await this.identityControl.probe(captured);
    if (probe === 'dead' || probe === 'mismatch') return this.publishExitEvidence();
    if (probe === 'exact') return null;
    throw new Error('worker exit state could not be verified against the operating system');
  }

  private async readyClient(): Promise<WorkerControllerClient> {
    if (this.stopped) throw new Error('supervised worker adapter is disconnected');
    await this.initialization;
    if (this.client === null) throw new Error('supervised worker client is unavailable');
    return this.client;
  }

  get controlState(): WorkerControllerClient['state'] { return this.client?.state ?? 'detached'; }
  get supervisionCredential(): SupervisionProcessCredential | null { return this.client?.credential ?? null; }
  get cachedStatus(): WorkerStatusPayload | null { return this.lastStatus; }

  async status(): Promise<WorkerStatusPayload> {
    const status = await (await this.readyClient()).status();
    this.lastStatus = status;
    return status;
  }

  async runtimeSnapshot(signal?: AbortSignal): Promise<WorkerRuntimeSnapshot> {
    if (this.stopped || signal?.aborted) throw new Error('supervised worker adapter is disconnected');
    const deadline = Date.now() + 750;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('deadline'), 750);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('worker runtime snapshot timed out')), { once: true }));
    const operation = (async () => {
      const client = await this.readyClient();
      if (this.stopped || controller.signal.aborted) throw new Error('worker runtime snapshot timed out');
      return client.runtimeSnapshot(controller.signal, deadline);
    })();
    try { return await Promise.race([operation, timeout]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void operation.catch(() => undefined);
    }
  }

  private publish(message: ConfigWorkerRuntimeMessage | undefined): void {
    if (message === undefined) return;
    for (const listener of [...this.messageListeners]) listener(message);
  }

  async send(message: ConfigMasterMessage): Promise<void> {
    if (!isWorkerCommand(message)) throw new Error('supervised worker control message is unsupported');
    const client = await this.readyClient();
    const status = message.command === 'drain-worker' ? await client.drain(message) : await client.start(message);
    this.lastStatus = status;
    this.publish(status.evidence.message);
  }

  subscribeMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  subscribeExit(listener: (evidence: WorkerExitEvidence) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitEvidence !== null) listener(this.exitEvidence);
    return () => { this.exitListeners.delete(listener); };
  }

  subscribeUnavailable(listener: (evidence: WorkerUnavailableEvidence) => void): () => void {
    this.unavailableListeners.add(listener);
    return () => { this.unavailableListeners.delete(listener); };
  }

  onUnavailable(listener: (evidence: WorkerUnavailableEvidence) => void): () => void {
    return this.subscribeUnavailable(listener);
  }

  async terminate(mode: 'graceful' | 'force'): Promise<void> {
    if (this.stopped) return;
    if (mode === 'force') {
      // Registered workers are never OS-force-signaled: without pidfd/FFI a bare PID may
      // already belong to a replacement process, so force always fails closed and the
      // caller retains ownership. Exit proof comes from graceful shutdown plus
      // verifyExactExit, never from a signal.
      throw new Error('worker force termination is unsupported; exit proof requires graceful shutdown or OS verification');
    }
    const client = await this.readyClient();
    await client.shutdown();
  }

  disconnect(): void {
    const alreadyStopped = this.stopped;
    this.stopped = true;
    this.clientStateUnsubscribe?.();
    this.clientStateUnsubscribe = null;
    this.client?.disconnect();
    // Capture failed before the discovery client became this.client: release it as well,
    // exactly once, so a failed adoption never leaks the discovery control connection.
    if (!alreadyStopped && this.client === null) this.options.readyClient?.disconnect();
  }
}
