import type { PluginConfigOptions, Sha256Digest } from '@jeffusion/bungee-types';
import { admissionSetIdentity, type AdmissionSet } from '../ingress/admission-set';
import type { MasterIngressController } from '../ingress/master-controller';
import type { RepositorySnapshot } from '../config-storage/repository-types';
import { snapshotJsonGraph } from '../config-storage/json-preflight';
import type { PluginManifestRecord } from '../plugin-manifest-catalog/types';
import type { ControllerAuthority } from '../supervision';
import {
  createPluginControlRpcCredential,
  type PluginControlRpcCall,
  type PluginControlRpcWorker,
} from './http-protocol';
import { createPluginControlHttpServer, type PluginControlHttpServer, type PluginControlHttpSession } from './http-server';
import type { PluginControlHost, BoundControlInvocation } from './host';
import type {
  SupervisedWorkerAdmissionIdentity,
  SupervisedWorkerControlSession,
  SupervisedConfigWorkerFactory,
} from '../master-runtime/supervised-worker-factory';

export type PluginControlMasterBridgeIngress = Pick<
  MasterIngressController,
  'trustedActiveAdmissionIfFresh' | 'currentControllerAuthority'
>;

export type PluginControlMasterBridgeFactory = Pick<
  SupervisedConfigWorkerFactory,
  'lookupExactControlSession'
>;

export type PluginControlMasterBridgeRepository = {
  readonly getSnapshot: () => RepositorySnapshot;
  /** Returns the immutable configuration snapshot actually served by this worker. */
  readonly getServingSnapshot: (worker: SupervisedWorkerControlSession['process']) => RepositorySnapshot | null;
};

export type PluginControlMasterBridgeCatalog = {
  readonly hash: Sha256Digest;
  readonly records: () => readonly PluginManifestRecord[];
};

export type PluginControlMasterBridgeOptions = {
  readonly ingress: PluginControlMasterBridgeIngress;
  readonly factory: PluginControlMasterBridgeFactory;
  readonly repository: PluginControlMasterBridgeRepository;
  readonly pluginControlHost: Pick<PluginControlHost, 'status' | 'invokeRpc'>;
  readonly catalog: PluginControlMasterBridgeCatalog;
};

type ActiveRecord = {
  readonly worker: PluginControlRpcWorker;
  readonly identity: SupervisedWorkerAdmissionIdentity;
};

type ManagedBy = { readonly plugin: string; readonly contributionId: string; readonly bindingId: string };
type Endpoint = {
  readonly id: string;
  readonly is_disabled?: boolean;
  readonly managedBy?: ManagedBy;
  readonly plugins?: readonly { readonly id: string; readonly name: string; readonly enabled: boolean; readonly options?: PluginConfigOptions }[];
};

function workerKey(worker: PluginControlRpcWorker): string {
  return JSON.stringify([worker.master_generation, worker.worker_instance_id, worker.worker_slot, worker.boot_nonce]);
}

function admissionMarker(active: AdmissionSet): string { return admissionSetIdentity(active); }

function sameAuthority(left: ControllerAuthority, right: ControllerAuthority): boolean {
  return left.controller_epoch === right.controller_epoch && left.controller_id === right.controller_id;
}

function sameManagedBy(left: ManagedBy | undefined, right: ManagedBy | undefined): boolean {
  return left?.plugin === right?.plugin && left?.contributionId === right?.contributionId && left?.bindingId === right?.bindingId;
}

function endpoints(snapshot: RepositorySnapshot): readonly Endpoint[] | null {
  const result = [
    ...snapshot.aggregate.logical_configuration.services.flatMap((service) => service.endpoints),
    ...snapshot.aggregate.logical_configuration.routes.flatMap((route) =>
      'endpoints' in route && route.endpoints !== undefined ? route.endpoints : []),
  ] as readonly Endpoint[];
  const ids = new Set<string>();
  for (const endpoint of result) {
    if (ids.has(endpoint.id)) return null;
    ids.add(endpoint.id);
  }
  return result;
}

function binding(endpoint: Endpoint, managedBy: ManagedBy): { readonly options: PluginConfigOptions } | null {
  if (endpoint.is_disabled === true || !sameManagedBy(endpoint.managedBy, managedBy)) return null;
  const matches = endpoint.plugins?.filter((item) => item.id === managedBy.bindingId && item.name === managedBy.plugin && item.enabled) ?? [];
  return matches.length === 1 ? { options: matches[0]!.options ?? {} } : null;
}

function safeInactive(): Error { return new Error('plugin control bridge inactive'); }

export class PluginControlMasterHttpBridge {
  private readonly server: PluginControlHttpServer;
  private readonly active = new Map<string, ActiveRecord>();
  private readonly sessions = new Map<string, SupervisedWorkerControlSession>();
  private activeMarker: string | null = null;
  private disposed = false;

  constructor(private readonly options: PluginControlMasterBridgeOptions) {
    this.server = createPluginControlHttpServer({
      resolveCredential: (worker) => this.resolveCredential(worker),
      execute: (call, signal) => this.execute(call, signal),
    });
  }

  handle(request: Request): Promise<Response> { return this.server.handle(request); }

  syncActiveAdmission(): void {
    if (this.disposed) return;
    const next = new Map<string, ActiveRecord>();
    const nextSessions = new Map<string, SupervisedWorkerControlSession>();
    const active = this.options.ingress.trustedActiveAdmissionIfFresh();
    this.activeMarker = active === null ? null : admissionMarker(active);
    if (active !== null) {
      for (const item of active.workers) {
        const worker = {
          master_generation: item.master_generation,
          worker_instance_id: item.worker_instance_id,
          worker_slot: item.worker_slot,
          boot_nonce: item.boot_nonce,
        } satisfies PluginControlRpcWorker;
        const identity = {
          ...worker, private_port: item.private_port, revision: active.revision,
          content_hash: active.content_hash, plugin_catalog_hash: active.plugin_catalog_hash,
        } satisfies SupervisedWorkerAdmissionIdentity;
        const session = this.options.factory.lookupExactControlSession(identity);
        if (session === null || session.controlState !== 'attached') continue;
        const key = workerKey(worker);
        next.set(key, { worker, identity });
        nextSessions.set(key, session);
      }
    }
    this.active.clear();
    for (const [key, record] of next) this.active.set(key, record);
    this.sessions.clear();
    for (const [key, session] of nextSessions) this.sessions.set(key, session);
    this.server.pruneGuards(next.values().map(({ worker }) => worker));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active.clear();
    this.sessions.clear();
    this.activeMarker = null;
    this.server.dispose();
  }

  private resolveCredential(worker: PluginControlRpcWorker): PluginControlHttpSession | null {
    if (this.disposed) return null;
    const active = this.options.ingress.trustedActiveAdmissionIfFresh();
    if (active === null || this.activeMarker !== admissionMarker(active)) return null;
    const record = this.active.get(workerKey(worker));
    if (record === undefined || record.identity.master_generation !== active.master_generation
      || record.identity.revision !== active.revision || record.identity.content_hash !== active.content_hash
      || record.identity.plugin_catalog_hash !== active.plugin_catalog_hash) return null;
    const session = this.options.factory.lookupExactControlSession(record.identity);
    if (session === null || session.controlState !== 'attached') return null;
    try {
      const authority = this.options.ingress.currentControllerAuthority();
      const credential = createPluginControlRpcCredential(session.credential, worker);
      this.sessions.set(workerKey(worker), session);
      return { credential, authority };
    } catch {
      return null;
    }
  }

  private isCurrent(worker: PluginControlRpcWorker, session: SupervisedWorkerControlSession): boolean {
    if (this.disposed || session.controlState !== 'attached') return false;
    const active = this.options.ingress.trustedActiveAdmissionIfFresh();
    if (active === null || this.activeMarker !== admissionMarker(active)) return false;
    const record = this.active.get(workerKey(worker));
    if (record === undefined || record.identity.master_generation !== active.master_generation
      || record.identity.revision !== active.revision || record.identity.content_hash !== active.content_hash
      || record.identity.plugin_catalog_hash !== active.plugin_catalog_hash) return false;
    const current = this.sessions.get(workerKey(worker));
    if (current?.process !== session.process) return false;
    const exact = this.options.factory.lookupExactControlSession(record.identity);
    return exact?.process === session.process;
  }

  private async execute(call: PluginControlRpcCall, signal: AbortSignal): Promise<unknown> {
    const session = this.sessions.get(workerKey(call.worker));
    if (session === undefined || !this.isCurrent(call.worker, session)) throw safeInactive();
    let status;
    try { status = await session.status(); } catch { throw safeInactive(); }
    if (!this.isCurrent(call.worker, session) || signal.aborted || status.phase !== 'serving' || status.frozen
      || status.master_generation !== call.worker.master_generation || status.worker_instance_id !== call.worker.worker_instance_id
      || status.worker_slot !== call.worker.worker_slot || status.boot_nonce !== call.worker.boot_nonce
      || status.revision !== call.body.revision || status.content_hash !== this.active.get(this.activeKeyFor(call.worker))?.identity.content_hash
      || status.plugin_catalog_hash !== this.active.get(this.activeKeyFor(call.worker))?.identity.plugin_catalog_hash
      || status.private_port !== this.active.get(this.activeKeyFor(call.worker))?.identity.private_port) throw safeInactive();
    const ready = status.evidence.kind === 'ready' ? status.evidence.message : undefined;
    if (ready === undefined || ready.status !== 'config-ready'
      || ready.master_generation !== status.master_generation || ready.worker_instance_id !== status.worker_instance_id
      || ready.worker_slot !== status.worker_slot || ready.boot_nonce !== status.boot_nonce || ready.pid !== status.pid
      || ready.revision !== status.revision || ready.content_hash !== status.content_hash
      || ready.plugin_catalog_hash !== status.plugin_catalog_hash || ready.private_port !== status.private_port) throw safeInactive();
    if (!sameAuthority(status.authority, this.options.ingress.currentControllerAuthority())) throw safeInactive();

    const record = this.active.get(this.activeKeyFor(call.worker));
    if (record === undefined || record.identity.revision !== call.body.revision) throw safeInactive();
    let current: RepositorySnapshot;
    let serving: RepositorySnapshot | null;
    try {
      current = this.options.repository.getSnapshot();
      serving = this.options.repository.getServingSnapshot(session.process);
    } catch {
      throw safeInactive();
    }
    if (serving === null || serving.revision !== call.body.revision
      || serving.content_hash !== record.identity.content_hash || current.revision < call.body.revision
      || current.aggregate === undefined || this.options.catalog.hash !== record.identity.plugin_catalog_hash) throw safeInactive();
    const currentEndpoints = endpoints(current);
    const servingEndpoints = endpoints(serving);
    if (currentEndpoints === null || servingEndpoints === null) throw safeInactive();
    const currentEndpoint = currentEndpoints.find((endpoint) => endpoint.id === call.body.endpoint_id);
    const servingEndpoint = servingEndpoints.find((endpoint) => endpoint.id === call.body.endpoint_id);
    if (currentEndpoint === undefined || servingEndpoint === undefined || currentEndpoint.id !== servingEndpoint.id
      || currentEndpoint.managedBy === undefined || !sameManagedBy(currentEndpoint.managedBy, servingEndpoint.managedBy)) throw safeInactive();
    const managedBy = currentEndpoint.managedBy;
    const currentBinding = binding(currentEndpoint, managedBy);
    const servingBinding = binding(servingEndpoint, managedBy);
    if (currentBinding === null || servingBinding === null
      || !current.aggregate.plugin_activations.some(({ plugin_name }) => plugin_name === managedBy.plugin)
      || this.options.pluginControlHost.status(managedBy.plugin) !== 'ready') throw safeInactive();
    const manifest = this.options.catalog.records().find(({ name }) => name === managedBy.plugin)?.manifest;
    if (manifest?.control?.rpc.some(({ name }) => name === call.body.method) !== true) throw safeInactive();
    if (!this.isCurrent(call.worker, session) || signal.aborted) throw safeInactive();
    const invocation: BoundControlInvocation = {
      pluginName: managedBy.plugin,
      binding: {
        plugin: managedBy.plugin, contributionId: managedBy.contributionId, bindingId: managedBy.bindingId,
        bindingOptions: snapshotJsonGraph(servingBinding.options) as PluginConfigOptions,
      },
      attempt: {
        attemptId: call.body.attempt_id, clientStreaming: false, signal,
        boundClient: { call: async () => { throw new Error('nested control calls are unavailable'); } },
      },
    };
    const result = await this.options.pluginControlHost.invokeRpc(managedBy.plugin, call.body.method, call.body.payload, invocation);
    if (!this.isCurrent(call.worker, session) || signal.aborted) throw safeInactive();
    return result;
  }

  private activeKeyFor(worker: PluginControlRpcWorker): string {
    return workerKey(worker);
  }
}

export function createPluginControlMasterHttpBridge(options: PluginControlMasterBridgeOptions): PluginControlMasterHttpBridge {
  return new PluginControlMasterHttpBridge(options);
}
