import { kernelMonotonicNowNs, readKernelDeadlineClockId } from './kernel-monotonic-clock';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ConfigMasterMessage, ConfigProcessIdentity, ConfigWorkerMessage, WorkerDrainedMessage, WorkerDrainFailedMessage, WorkerDrainStartedMessage, WorkerExitDeadlineEvidence } from '../config-publication/types';
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
  ProcessIdentityMissingError,
  probeProcessIdentity,
  probeProcessInstance,
  type CapturedProcessIdentity,
  type ProcessIdentityProbe,
} from './process-identity';
import type { WorkerRuntimeSnapshot } from '../supervision';
import { recordShutdownFailure, shutdownElapsedMs } from './shutdown-diagnostics';

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
  readonly probeInstance?: (pid: number, processInstanceId: string) => Promise<ProcessIdentityProbe>;
}>;

const DEFAULT_PROCESS_IDENTITY: ProcessIdentityControl = {
  capture: (pid, processInstanceId) => captureProcessIdentity(pid, processInstanceId),
  probe: (expected) => probeProcessIdentity(expected),
  probeInstance: (pid, processInstanceId) => probeProcessInstance(pid, processInstanceId),
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
  readonly kernelBootId?: () => Promise<string>;
  readonly readDescriptor?: () => Promise<unknown>;
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
  private drainPoll: { readonly drainId: string; readonly task: Promise<void> } | null = null;
  private drainCommand: Extract<ConfigMasterMessage, { command: 'drain-worker' }> | null = null;
  private drainStatusFailureReported = false;
  private exitPublication: Promise<WorkerExitEvidence> | null = null;
  kernelBootId: string | undefined;

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
    this.kernelBootId = await (this.options.kernelBootId ?? readKernelDeadlineClockId)();
    if (this.options.readyClient !== undefined) {
      // Exact identity is captured before anything else: a wrong or unknown capture
      // rejects initialization before the ready client's control-state subscription
      // is retained.
      this.bootNonce = this.options.readyClient.credential.identity.boot_nonce;
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
        const raw = this.options.readDescriptor === undefined
          ? JSON.parse(await readFile(this.options.descriptorPath, 'utf8')) as unknown
          : await this.options.readDescriptor();
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
        if (this.origin === 'adopted' && error instanceof ProcessIdentityMissingError) {
          try {
            const terminal = await this.readTerminalDrainEvidence();
            const probe = this.identityControl.probeInstance === undefined
              ? await probeProcessInstance(this.pid, this.identity.worker_instance_id)
              : await this.identityControl.probeInstance(this.pid, this.identity.worker_instance_id);
            if (terminal !== null && (probe === 'dead' || probe === 'mismatch')) {
              this.publishExitEvidence(terminal);
              return;
            }
          } catch { /* no matching signed terminal and exact dead-process proof: keep discovery unknown */ }
        }
        await Bun.sleep(25);
      }
    }
    throw new Error(`supervised worker initialization timed out: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private publishExitEvidence(terminalDrain?: WorkerDrainedMessage | WorkerDrainFailedMessage): WorkerExitEvidence {
    this.stopped = true;
    this.client?.disconnect(false);
    const evidence: WorkerExitEvidence = { exited: true, pid: this.pid, ...(terminalDrain === undefined ? {} : { terminalDrain }) };
    this.exitEvidence = evidence;
    for (const listener of [...this.exitListeners]) listener(evidence);
    return evidence;
  }

  private emitExit(): void {
    if (this.exitEvidence !== null || this.origin !== 'spawned') return;
    this.exitPublication ??= this.readTerminalDrainEvidence().then(
      (terminal) => this.publishExitEvidence(terminal ?? undefined),
      () => this.publishExitEvidence(),
    );
  }

  private async readTerminalDrainEvidence(): Promise<WorkerDrainedMessage | WorkerDrainFailedMessage | null> {
    const raw = this.options.readDescriptor === undefined
      ? JSON.parse(await readFile(this.options.descriptorPath, 'utf8')) as unknown
      : await this.options.readDescriptor();
    const hint = parseWorkerDescriptorHint(raw);
    if (hint.master_generation !== this.identity.master_generation
      || hint.worker_instance_id !== this.identity.worker_instance_id || hint.worker_slot !== this.slot) return null;
    const credential = deriveWorkerSupervisionCredential(this.options.supervisionSeed, hint.boot_nonce);
    const descriptor = parseWorkerDescriptor(raw, credential);
    const message = descriptor.evidence.message;
    if ((message?.status !== 'worker-drained' && message?.status !== 'worker-drain-failed')
      || descriptor.evidence.kind !== (message.status === 'worker-drained' ? 'drained' : 'drain-failed')
      || descriptor.pid !== this.pid || descriptor.boot_nonce !== this.bootNonce
      || message.pid !== this.pid || message.master_generation !== this.identity.master_generation
      || message.worker_instance_id !== this.identity.worker_instance_id || message.worker_slot !== this.slot
      || message.boot_nonce !== descriptor.boot_nonce || message.boot_id !== this.kernelBootId) return null;
    const task = this.drainCommand;
    if (task !== null && (message.drain_id !== task.drain_id
      || JSON.stringify(message.policy) !== JSON.stringify(task.policy)
      || message.revision !== task.revision || message.content_hash !== task.content_hash
      || message.plugin_catalog_hash !== task.plugin_catalog_hash
      || JSON.stringify(message.publication) !== JSON.stringify(task.publication))) return null;
    return message;
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
    if (this.exitPublication !== null) return this.exitPublication;
    const startedAt = performance.now();
    const captured = this.capturedIdentity;
    if (captured === null) {
      recordShutdownFailure('worker_exit_probe', { pid: this.pid, origin: this.origin, capturedIdentity: false, lastProbe: 'not_run', probeAttempts: 0 });
      let terminal: WorkerDrainedMessage | WorkerDrainFailedMessage | null = null;
      try { terminal = await this.readTerminalDrainEvidence(); } catch { /* invalid terminal evidence is not an exit proof */ }
      let probe: ProcessIdentityProbe;
      try {
        probe = this.identityControl.probeInstance === undefined
          ? await probeProcessInstance(this.pid, this.identity.worker_instance_id)
          : await this.identityControl.probeInstance(this.pid, this.identity.worker_instance_id);
      }
      catch (error) {
        recordShutdownFailure('worker_exit_probe', { pid: this.pid, origin: this.origin, capturedIdentity: false, lastProbe: 'threw', probeAttempts: 1 }, error);
        throw error;
      }
      if (probe === 'exact') return null;
      if (probe === 'unknown') throw new Error('worker exit state could not be verified against the operating system');
      return this.publishExitEvidence(terminal ?? undefined);
    }
    let probe: ProcessIdentityProbe;
    try { probe = await this.identityControl.probe(captured); }
    catch (error) {
      recordShutdownFailure('worker_exit_probe', { pid: this.pid, origin: this.origin, capturedIdentity: true, lastProbe: 'threw', probeAttempts: 1, elapsedMs: shutdownElapsedMs(startedAt) }, error);
      throw error;
    }
    if (probe === 'dead' || probe === 'mismatch') {
      let terminal: WorkerDrainedMessage | WorkerDrainFailedMessage | null = null;
      try { terminal = await this.readTerminalDrainEvidence(); }
      catch (error) {
        recordShutdownFailure('worker_exit_probe', { pid: this.pid, origin: this.origin, lastProbe: 'unknown' }, error);
      }
      return this.publishExitEvidence(terminal ?? undefined);
    }
    recordShutdownFailure('worker_exit_probe', { pid: this.pid, origin: this.origin, capturedIdentity: true, lastProbe: probe, probeAttempts: 1, elapsedMs: shutdownElapsedMs(startedAt) });
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
  get hasDrainTask(): boolean { return this.drainCommand !== null; }

  async status(timeoutMs?: number): Promise<WorkerStatusPayload> {
    const client = await this.readyClient();
    const previous = this.lastStatus?.evidence.message;
    let boundedTimeout = timeoutMs;
    if (previous?.status === 'worker-drained' || previous?.status === 'worker-drain-failed') {
      if (previous.boot_id !== this.kernelBootId) throw new Error('worker exit boot identity is unknown or mismatched');
      const remainingNs = BigInt(previous.exit_deadline_ns) - kernelMonotonicNowNs();
      const remainingMs = remainingNs <= 0n ? 0 : Number((remainingNs + 999_999n) / 1_000_000n);
      if (remainingMs <= 0) throw new Error('worker exit deadline expired');
      boundedTimeout = boundedTimeout === undefined ? remainingMs : Math.min(boundedTimeout, remainingMs);
    }
    const status = await client.status(boundedTimeout);
    this.lastStatus = status;
    return status;
  }

  async drainStatus(timeoutMs?: number): Promise<WorkerDrainStartedMessage | WorkerDrainedMessage | WorkerDrainFailedMessage | null> {
    const startedAt = performance.now();
    let status: WorkerStatusPayload;
    try {
      status = await this.status(timeoutMs);
      this.drainStatusFailureReported = false;
    } catch (error) {
      // One sanitized record per consecutive failure distinguishes unavailable
      // control status from the separate exact-process probe during retirement.
      if (!this.drainStatusFailureReported) {
        this.drainStatusFailureReported = true;
        recordShutdownFailure('worker_drain_status', { pid: this.pid, origin: this.origin,
          elapsedMs: shutdownElapsedMs(startedAt), ...(timeoutMs === undefined ? {} : { timeoutMs }) }, error);
      }
      throw error;
    }
    if (status.evidence.kind === 'draining' && status.evidence.message?.status === 'worker-draining') {
      return status.evidence.message;
    }
    if (status.evidence.kind === 'drained' && status.evidence.message?.status === 'worker-drained') {
      if (status.evidence.message.boot_id !== this.kernelBootId) throw new Error('worker exit boot identity is unknown or mismatched');
      return status.evidence.message;
    }
    if (status.evidence.kind === 'drain-failed' && status.evidence.message?.status === 'worker-drain-failed') {
      if (status.evidence.message.boot_id !== this.kernelBootId) throw new Error('worker exit boot identity is unknown or mismatched');
      return status.evidence.message;
    }
    return null;
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
    if (message.command === 'drain-worker') this.drainCommand = message;
    const startedAt = performance.now();
    let deadline: number | undefined;
    try {
      if (message.command === 'drain-worker') {
        if (message.start_boot_id !== this.kernelBootId) throw new Error('worker start deadline boot identity is unknown or mismatched');
        const remaining = BigInt(message.start_deadline_ns) - kernelMonotonicNowNs();
        deadline = performance.now() + Number((remaining + 999_999n) / 1_000_000n);
        if (remaining <= 0n) throw new Error('worker drain start deadline expired before control dispatch');
      }
      const client = await this.readyClient();
      if (deadline !== undefined && performance.now() >= deadline) {
        this.followDrain(client, message as Extract<ConfigMasterMessage, { command: 'drain-worker' }>);
        throw new Error('worker drain start deadline expired before control dispatch');
      }
      try {
        const status = message.command === 'drain-worker' ? await client.drain(message, deadline) : await client.start(message);
        this.lastStatus = status;
        this.publish(status.evidence.message);
      } finally {
        if (message.command === 'drain-worker') this.followDrain(client, message);
      }
    } catch (error) {
      if (message.command === 'drain-worker') {
        recordShutdownFailure('worker_drain_command', { pid: this.pid, origin: this.origin,
          elapsedMs: shutdownElapsedMs(startedAt), timeoutMs: message.policy.drain_start_timeout_ms,
          deadlineExceeded: deadline !== undefined && performance.now() >= deadline,
          commandOutcome: 'failed' }, error);
      }
      throw error;
    }
  }

  private followDrain(client: WorkerControllerClient, command: Extract<ConfigMasterMessage, { command: 'drain-worker' }>): void {
    if (this.drainPoll?.drainId === command.drain_id) return;
    const task = (async () => {
      while (!this.stopped && this.exitEvidence === null) {
        try {
          const previousMessage = this.lastStatus?.evidence.message;
          const remainingMs = previousMessage?.status === 'worker-draining'
            ? previousMessage.remaining_ms : command.policy.worker_exit_timeout_ms;
          const status = await client.status(Math.max(1, Math.min(remainingMs, command.policy.worker_exit_timeout_ms)));
          this.lastStatus = status;
          const evidence = status.evidence;
          if (evidence.kind === 'drained' && evidence.message?.status === 'worker-drained'
            && evidence.message.drain_id === command.drain_id) {
            this.publish(evidence.message);
            return;
          }
          if (evidence.kind === 'drain-failed' && evidence.message?.status === 'worker-drain-failed'
            && evidence.message.drain_id === command.drain_id) {
            this.publish(evidence.message);
            return;
          }
          if (evidence.kind === 'draining' && evidence.message?.status === 'worker-draining') {
            if (evidence.message.drain_id !== command.drain_id) return;
            this.publish(evidence.message);
          }
          if (evidence.kind === 'ready' || evidence.kind === 'candidate' || evidence.kind === 'apply-failed') return;
        } catch {
          // Lost status control is unknown; continue exact-process tracking without a false exit proof.
          try { await this.verifyExactExit(); } catch { /* retain ownership on an unknown probe */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
    this.drainPoll = { drainId: command.drain_id, task };
    void task.finally(() => { if (this.drainPoll?.task === task) this.drainPoll = null; });
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

  async terminate(mode: 'graceful' | 'force', timeoutMs?: number, exitDeadline?: WorkerExitDeadlineEvidence): Promise<void> {
    if (this.stopped) return;
    if (mode === 'force') {
      // Registered workers are never OS-force-signaled: without pidfd/FFI a bare PID may
      // already belong to a replacement process, so force always fails closed and the
      // caller retains ownership. Exit proof comes from graceful shutdown plus
      // verifyExactExit, never from a signal.
      throw new Error('worker force termination is unsupported; exit proof requires graceful shutdown or OS verification');
    }
    const client = await this.readyClient();
    if (exitDeadline !== undefined && exitDeadline.boot_id !== this.kernelBootId) {
      throw new Error('worker exit boot identity is unknown or mismatched');
    }
    const remainingNs = exitDeadline === undefined ? null
      : BigInt(exitDeadline.exit_deadline_ns) - kernelMonotonicNowNs();
    const remainingByKernel = remainingNs === null ? Number.POSITIVE_INFINITY
      : remainingNs <= 0n ? 0 : Number((remainingNs + 999_999n) / 1_000_000n);
    const remainingMs = Math.min(timeoutMs ?? 5_000, remainingByKernel);
    if (remainingMs <= 0) throw new Error('worker shutdown deadline expired before control dispatch');
    await client.shutdown(remainingMs);
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
