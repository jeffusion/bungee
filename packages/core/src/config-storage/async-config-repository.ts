import type { ConfigRepository } from './config-repository';
import type { ConfigRepositoryOptions, RepositorySnapshot, ManagementProtection, ControlProjection, CommitConfigurationCommandV1, CommitConfigurationResult } from './repository-types';
import { ConfigRepositoryError } from './repository-types';
import { validateManagementProtection } from './management-protection';
import { prepareCommitCommand } from './prepared-command';
import { freezeSnapshot, freezeProjection } from './immutable-snapshot';
import type { SupervisionState } from '../supervision/state-repository';
import { consumeControllerClaimCapability, type ControllerClaimCapability } from '../master-runtime/instance-lock';
import { ConfigurationStorageResultUnknownError, READ_METHODS,
  type StorageMethod, type StorageParameters, type StorageResult, type StorageResponse } from './storage-protocol';

export interface ConfigurationStorageWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export type AsyncConfigRepositoryOptions = Pick<ConfigRepositoryOptions, 'compileOptions' | 'offline'> & {
  readonly workerUrl?: string | URL;
  readonly maxPendingRequests?: number;
  readonly maxPendingBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onWorkerFailure?: (error: ConfigRepositoryError) => void;
  /** Injected transports are useful for deterministic failure-boundary tests. */
  readonly workerFactory?: (url: string | URL) => ConfigurationStorageWorker;
};
type Pending = {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly bytes: number;
  sent: boolean;
  readonly method: StorageMethod | 'open' | 'close';
  readonly mutationId?: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
};

/** Production client: the only synchronous reads are validated immutable projections. */
export class AsyncConfigRepository {
  private snapshot!: RepositorySnapshot;
  private managementProtection!: ManagementProtection;
  private supervision!: SupervisionState;
  private sequence = 0;
  private state: 'opening' | 'open' | 'closing' | 'closed' = 'opening';
  private readonly pending = new Map<number, Pending>();
  private closePromise: Promise<void> | null = null;
  private readonly worker: ConfigurationStorageWorker;
  private readonly maxPending: number;
  private readonly maxBytes: number;
  private readonly requestTimeout: number;
  private readonly closeTimeout: number;
  private pendingBytes = 0;
  private failure: ConfigRepositoryError | null = null;

  private constructor(private readonly options: AsyncConfigRepositoryOptions) {
    this.maxPending = options.maxPendingRequests ?? 128;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1 || this.maxPending > 4096) {
      throw new ConfigRepositoryError('invalid_command', 'storage queue limit is invalid');
    }
    const bounded=(value:number|undefined,fallback:number,max:number)=>{const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ConfigRepositoryError('invalid_command','storage limit is invalid');return n;};
    this.maxBytes=bounded(options.maxPendingBytes,8*1024*1024,64*1024*1024);
    this.requestTimeout=bounded(options.requestTimeoutMs,30000,300000);
    this.closeTimeout=bounded(options.closeTimeoutMs,10000,300000);
    const url = options.workerUrl ?? new URL('./storage-worker.ts', import.meta.url);
    this.worker = options.workerFactory ? options.workerFactory(url) : new Worker(url, { name: 'configuration-storage' });
    this.worker.addEventListener('message', (event: MessageEvent<StorageResponse>) => this.receive(event.data));
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      event.preventDefault?.();
      this.fail();
      this.worker.terminate();
    });
    this.worker.addEventListener('close', () => {if(this.state!=='closed')this.fail();});
  }

  static async open(dbPath: string, options: AsyncConfigRepositoryOptions = {}): Promise<AsyncConfigRepository> {
    const client = new AsyncConfigRepository(options);
    try {
      const startup = await client.send('open', [dbPath, { offline: options.offline === true, managementProviders: [...(options.compileOptions?.managementProviders ?? [])] }]) as {
        snapshot: RepositorySnapshot; supervision: SupervisionState; managementProtection: ManagementProtection;
      };
      client.installControlProjection(startup);
      client.supervision = freezeProjection(startup.supervision);
      client.state = 'open';
      return client;
    } catch (error) {
      client.fail();
      client.worker.terminate();
      throw error;
    }
  }

  getSnapshot(): RepositorySnapshot { return this.snapshot; }
  getManagementProtection(): ManagementProtection { return this.managementProtection; }
  getControlProjection(): ControlProjection { return { snapshot: this.snapshot, managementProtection: this.managementProtection }; }

  private installControlProjection(projection: ControlProjection): ControlProjection {
    validateManagementProtection(projection.managementProtection);
    const snapshot = freezeSnapshot(projection.snapshot);
    const managementProtection = freezeProjection(projection.managementProtection);
    if (managementProtection.required && !snapshot.aggregate.plugin_activations.some(activation => activation.plugin_name === managementProtection.selectedProvider)) {
      throw new ConfigRepositoryError('schema_corrupt', 'protected management provider is absent from the configuration projection');
    }
    if (!this.snapshot || snapshot.revision >= this.snapshot.revision) {
      this.snapshot = snapshot;
      this.managementProtection = managementProtection;
    }
    return this.getControlProjection();
  }

  async refreshControlProjection(): Promise<ControlProjection> {
    return this.installControlProjection(await this.rpc('getControlProjection'));
  }

  async setManagementProviderOffline(provider: string | null, operationId: string, now: number): Promise<ControlProjection> {
    return this.installControlProjection(await this.rpc('setManagementProviderOffline', provider, operationId, now));
  }
  getSupervisionState(): SupervisionState { return this.supervision; }

  async commit(command: CommitConfigurationCommandV1): Promise<CommitConfigurationResult> {
    const prepared = prepareCommitCommand(command, this.options.compileOptions);
    const result = await this.rpc('commitPrepared', prepared);
    if (result.kind === 'committed' || result.kind === 'duplicate') {
      try { await this.refreshControlProjection(); }
      catch { throw new ConfigurationStorageResultUnknownError('commitPrepared', prepared.mutationId); }
    }
    return result.kind === 'committed' ? { ...result, snapshot: freezeSnapshot(result.snapshot) } : result;
  }

  async claimControllerWithCapability(
    capability: ControllerClaimCapability, controllerId: string, updatedAt: number,
  ): Promise<SupervisionState> {
    const result = await consumeControllerClaimCapability(capability,
      () => this.rpc('claimController', controllerId, updatedAt));
    this.supervision = freezeProjection(result);
    return this.supervision;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.failure) return Promise.reject(this.failure);
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'closing';
    this.rejectPending();
    this.closePromise = this.send('close', []).then(() => {
      this.state='closed';this.worker.terminate();
    },error=>{this.fail();this.worker.terminate();throw error;});
    return this.closePromise;
  }

  private rpc<M extends StorageMethod>(method: M, ...args: StorageParameters<M>): Promise<StorageResult<M>> {
    if (this.state !== 'open') return Promise.reject(new ConfigRepositoryError('repository_failure', 'configuration storage is closed'));
    return this.send(method, args) as Promise<StorageResult<M>>;
  }

  private send(method: Pending['method'], args: readonly unknown[]): Promise<unknown> {
    let bytes:number;try{bytes=Buffer.byteLength(JSON.stringify(args)??'');}catch{return Promise.reject(new ConfigRepositoryError('invalid_command','storage request is not serializable'));}
    if (method !== 'close' && (this.pending.size >= this.maxPending || bytes > this.maxBytes-this.pendingBytes)) {
      return Promise.reject(new ConfigRepositoryError('queue_full', 'configuration storage queue is full'));
    }
    const id = ++this.sequence;
    if (!Number.isSafeInteger(id)) return Promise.reject(new ConfigRepositoryError('repository_failure', 'storage request IDs exhausted'));
    const mutationId = method === 'commitPrepared' ? (args[0] as { mutationId: string }).mutationId
      : method === 'setManagementProviderOffline' ? args[1] as string : undefined;
    return new Promise((resolve, reject) => {
      const timer=setTimeout(()=>{this.fail(new ConfigRepositoryError('repository_failure', `configuration storage ${method==='close'?'close':'request'} deadline exceeded`));this.worker.terminate();},method==='close'?this.closeTimeout:this.requestTimeout);
      const request:Pending={ method, mutationId, resolve, reject, timer, bytes, sent:false };
      this.pending.set(id, request);this.pendingBytes+=bytes;
      try { this.worker.postMessage({ id, method, args }); request.sent=true; }
      catch {
        this.pending.delete(id);clearTimeout(timer);this.pendingBytes-=bytes;
        reject(new ConfigRepositoryError('repository_failure', 'configuration storage request could not be sent'));
      }
    });
  }

  private receive(response: StorageResponse): void {
    if (!response || !Number.isSafeInteger(response.id) || typeof response.ok !== 'boolean'
      || (!response.ok && (!response.error || typeof response.error.code !== 'string'
        || typeof response.error.message !== 'string'))) {
      this.fail(); this.worker.terminate(); return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);clearTimeout(request.timer);this.pendingBytes-=request.bytes;
    if (response.ok) request.resolve(response.result);
    else request.reject(new ConfigRepositoryError(response.error.code, response.error.message, undefined, response.error.recovery));
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      const writing = request.sent && request.method !== 'open' && request.method !== 'close' && !READ_METHODS.has(request.method);
      request.reject(writing
        ? new ConfigurationStorageResultUnknownError(request.method as StorageMethod, request.mutationId)
        : this.failure ?? new ConfigRepositoryError('repository_failure', 'configuration storage worker exited or closed'));
    }
    this.pending.clear();this.pendingBytes=0;
  }

  private fail(error = new ConfigRepositoryError('repository_failure','configuration storage worker exited')): void {
    if(this.failure)return;
    this.failure=error;
    const unexpected=this.state!=='closed';
    this.state='closed';this.rejectPending();
    if(unexpected){try{this.options.onWorkerFailure?.(error);}catch{/* Notification cannot strand callers. */}}
  }

  getMenuLayout(...args: Parameters<ConfigRepository['getMenuLayout']>): Promise<ReturnType<ConfigRepository['getMenuLayout']>> {
    return this.rpc('getMenuLayout', ...args);
  }
  putMenuLayout(...args: Parameters<ConfigRepository['putMenuLayout']>): Promise<ReturnType<ConfigRepository['putMenuLayout']>> {
    return this.rpc('putMenuLayout', ...args);
  }

  appendServingSnapshot(...args: Parameters<ConfigRepository['appendServingSnapshot']>): Promise<ReturnType<ConfigRepository['appendServingSnapshot']>> {
    return this.rpc('appendServingSnapshot', ...args);
  }
  async getServingSnapshot(...args: Parameters<ConfigRepository['getServingSnapshot']>): Promise<ReturnType<ConfigRepository['getServingSnapshot']>> {
    const result = await this.rpc('getServingSnapshot', ...args);
    return result === null ? null : freezeSnapshot(result);
  }
  async getActivePublication(...args: Parameters<ConfigRepository['getActivePublication']>): Promise<ReturnType<ConfigRepository['getActivePublication']>> {
    const result = await this.rpc('getActivePublication', ...args);
    return result === null ? null : freezeProjection(result);
  }
  getOperation(...args: Parameters<ConfigRepository['getOperation']>): Promise<ReturnType<ConfigRepository['getOperation']>> {
    return this.rpc('getOperation', ...args);
  }
  getOperationState(...args: Parameters<ConfigRepository['getOperationState']>): Promise<ReturnType<ConfigRepository['getOperationState']>> {
    return this.rpc('getOperationState', ...args);
  }
  getCurrentOperationState(...args: Parameters<ConfigRepository['getCurrentOperationState']>): Promise<ReturnType<ConfigRepository['getCurrentOperationState']>> {
    return this.rpc('getCurrentOperationState', ...args);
  }
  getRecovery(...args: Parameters<ConfigRepository['getRecovery']>): Promise<ReturnType<ConfigRepository['getRecovery']>> {
    return this.rpc('getRecovery', ...args);
  }
  getCurrentRecovery(...args: Parameters<ConfigRepository['getCurrentRecovery']>): Promise<ReturnType<ConfigRepository['getCurrentRecovery']>> {
    return this.rpc('getCurrentRecovery', ...args);
  }
  getLatestRecovery(...args: Parameters<ConfigRepository['getLatestRecovery']>): Promise<ReturnType<ConfigRepository['getLatestRecovery']>> {
    return this.rpc('getLatestRecovery', ...args);
  }
  createManualRecovery(...args: Parameters<ConfigRepository['createManualRecovery']>): Promise<ReturnType<ConfigRepository['createManualRecovery']>> {
    return this.rpc('createManualRecovery', ...args);
  }
  claimRecoveryAttempt(...args: Parameters<ConfigRepository['claimRecoveryAttempt']>): Promise<ReturnType<ConfigRepository['claimRecoveryAttempt']>> {
    return this.rpc('claimRecoveryAttempt', ...args);
  }
  scheduleRecoveryRetry(...args: Parameters<ConfigRepository['scheduleRecoveryRetry']>): Promise<ReturnType<ConfigRepository['scheduleRecoveryRetry']>> {
    return this.rpc('scheduleRecoveryRetry', ...args);
  }
  succeedRecovery(...args: Parameters<ConfigRepository['succeedRecovery']>): Promise<ReturnType<ConfigRepository['succeedRecovery']>> {
    return this.rpc('succeedRecovery', ...args);
  }
  stopRecovery(...args: Parameters<ConfigRepository['stopRecovery']>): Promise<ReturnType<ConfigRepository['stopRecovery']>> {
    return this.rpc('stopRecovery', ...args);
  }
  requeueRecovery(...args: Parameters<ConfigRepository['requeueRecovery']>): Promise<ReturnType<ConfigRepository['requeueRecovery']>> {
    return this.rpc('requeueRecovery', ...args);
  }
  beginPublication(...args: Parameters<ConfigRepository['beginPublication']>): Promise<ReturnType<ConfigRepository['beginPublication']>> {
    return this.rpc('beginPublication', ...args);
  }
  beginWorkerAttempt(...args: Parameters<ConfigRepository['beginWorkerAttempt']>): Promise<ReturnType<ConfigRepository['beginWorkerAttempt']>> {
    return this.rpc('beginWorkerAttempt', ...args);
  }
  beginDrainingRecovery(...args: Parameters<ConfigRepository['beginDrainingRecovery']>): Promise<ReturnType<ConfigRepository['beginDrainingRecovery']>> {
    return this.rpc('beginDrainingRecovery', ...args);
  }
  recordWorkerResult(...args: Parameters<ConfigRepository['recordWorkerResult']>): Promise<ReturnType<ConfigRepository['recordWorkerResult']>> {
    return this.rpc('recordWorkerResult', ...args);
  }
  finalizePublication(...args: Parameters<ConfigRepository['finalizePublication']>): Promise<ReturnType<ConfigRepository['finalizePublication']>> {
    return this.rpc('finalizePublication', ...args);
  }
  markDraining(...args: Parameters<ConfigRepository['markDraining']>): Promise<ReturnType<ConfigRepository['markDraining']>> {
    return this.rpc('markDraining', ...args);
  }
  verify(...args: Parameters<ConfigRepository['verify']>): Promise<ReturnType<ConfigRepository['verify']>> {
    return this.rpc('verify', ...args);
  }
  getPublicationServingSet(...args: Parameters<ConfigRepository['getPublicationServingSet']>): Promise<ReturnType<ConfigRepository['getPublicationServingSet']>> { return this.rpc('getPublicationServingSet', ...args); }
  freezePublicationServingSet(...args: Parameters<ConfigRepository['freezePublicationServingSet']>): Promise<ReturnType<ConfigRepository['freezePublicationServingSet']>> { return this.rpc('freezePublicationServingSet', ...args); }
  confirmPublicationServingMemberExit(...args: Parameters<ConfigRepository['confirmPublicationServingMemberExit']>): Promise<ReturnType<ConfigRepository['confirmPublicationServingMemberExit']>> { return this.rpc('confirmPublicationServingMemberExit', ...args); }
  getRetirementDescriptorCleanupState(workerInstanceId: string): Promise<'absent' | 'pending' | 'terminal'> { return this.rpc('getRetirementDescriptorCleanupState', workerInstanceId); }
  getRetiredWorkerInstanceIds(): Promise<readonly string[]> { return this.rpc('getRetiredWorkerInstanceIds'); }
  getPublicationRetirement(...args: Parameters<ConfigRepository['getPublicationRetirement']>): Promise<ReturnType<ConfigRepository['getPublicationRetirement']>> {
    return this.rpc('getPublicationRetirement', ...args);
  }
  freezePublicationRetirement(...args: Parameters<ConfigRepository['freezePublicationRetirement']>): Promise<ReturnType<ConfigRepository['freezePublicationRetirement']>> {
    return this.rpc('freezePublicationRetirement', ...args);
  }
  recordPublicationRetirementEvidence(...args: Parameters<ConfigRepository['recordPublicationRetirementEvidence']>): Promise<ReturnType<ConfigRepository['recordPublicationRetirementEvidence']>> {
    return this.rpc('recordPublicationRetirementEvidence', ...args);
  }
  stopPublicationRetirement(...args: Parameters<ConfigRepository['stopPublicationRetirement']>): Promise<ReturnType<ConfigRepository['stopPublicationRetirement']>> {
    return this.rpc('stopPublicationRetirement', ...args);
  }
  retryPublicationRetirement(...args: Parameters<ConfigRepository['retryPublicationRetirement']>): Promise<ReturnType<ConfigRepository['retryPublicationRetirement']>> {
    return this.rpc('retryPublicationRetirement', ...args);
  }
  freezePublicationRetirementDrainStart(...args:Parameters<ConfigRepository['freezePublicationRetirementDrainStart']>):Promise<ReturnType<ConfigRepository['freezePublicationRetirementDrainStart']>> {
    return this.rpc('freezePublicationRetirementDrainStart',...args);
  }
  getPublicationRetirementRetry(...args:Parameters<ConfigRepository['getPublicationRetirementRetry']>):Promise<ReturnType<ConfigRepository['getPublicationRetirementRetry']>> {
    return this.rpc('getPublicationRetirementRetry',...args);
  }
  requestPublicationRetirementRetry(...args:Parameters<ConfigRepository['requestPublicationRetirementRetry']>):Promise<ReturnType<ConfigRepository['requestPublicationRetirementRetry']>> {
    return this.rpc('requestPublicationRetirementRetry',...args);
  }
  markPublicationRetirementReleased(...args: Parameters<ConfigRepository['markPublicationRetirementReleased']>): Promise<ReturnType<ConfigRepository['markPublicationRetirementReleased']>> {
    return this.rpc('markPublicationRetirementReleased', ...args);
  }
  getRuntimeRecoveryBudget(...args: Parameters<ConfigRepository['getRuntimeRecoveryBudget']>): Promise<ReturnType<ConfigRepository['getRuntimeRecoveryBudget']>> {
    return this.rpc('getRuntimeRecoveryBudget', ...args);
  }
  consumeRuntimeRecoveryRestartTicket(...args: Parameters<ConfigRepository['consumeRuntimeRecoveryRestartTicket']>): Promise<ReturnType<ConfigRepository['consumeRuntimeRecoveryRestartTicket']>> {
    return this.rpc('consumeRuntimeRecoveryRestartTicket', ...args);
  }
  getRuntimeRecoveryStartupGate(...args: Parameters<ConfigRepository['getRuntimeRecoveryStartupGate']>): Promise<ReturnType<ConfigRepository['getRuntimeRecoveryStartupGate']>> {
    return this.rpc('getRuntimeRecoveryStartupGate', ...args);
  }
  observeRuntimeRecoveryHealth(...args: Parameters<ConfigRepository['observeRuntimeRecoveryHealth']>): Promise<ReturnType<ConfigRepository['observeRuntimeRecoveryHealth']>> {
    return this.rpc('observeRuntimeRecoveryHealth', ...args);
  }
}
