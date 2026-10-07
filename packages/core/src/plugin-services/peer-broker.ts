/**
 * P4 production wiring: the authenticated control ↔ peer (worker) service
 * broker.
 *
 * This module is the only place that turns the reviewed peer building blocks
 * (WebSocket transport, signed BPC1 frames, RPC linkage, native DTO mapping,
 * canonical Host RPC runtime) into one real production chain. It owns no
 * protocol of its own: every frame is still decoded, authenticated and
 * replay-windowed by `PluginPeerRpcLink`; every call is still admitted by the
 * canonical `RpcServiceRuntime`; every lease, result and terminal still belongs
 * to the original `HostRpcAdapter`.
 *
 * Two process roles are wired here:
 *
 * - {@link ControlPeerBroker}: the `control` process serves the fixed private
 *   peer WebSocket path on the existing `master-control` listener. Its
 *   `authorize` callback is the single admission decision: it validates the
 *   claimed upgrade identity against the exact physical worker facts supplied
 *   by the trusted runtime, requires the *current* controller authority, and
 *   returns the worker's existing authenticated link. It never inspects a
 *   Cookie, never mints a credential from plugin input, and never trusts an
 *   unauthenticated caller frame.
 * - {@link WorkerPeerBroker}: the `worker` process dials that path with its own
 *   supervision-derived peer credential, binds a real client socket to its
 *   link, and registers native proxies so worker plugins can call
 *   control-provided RPC services (including during bootstrap).
 *
 * Deployment identity is derived, never configured: both sides compute the same
 * `RpcEndpointBinding` for a peer service from kernel facts (process, stable
 * instance, controller generation, plugin catalog hash, provider subject) *with
 * the same lifecycle formula the canonical adapter uses for a real
 * publication*, so the receiving kernel can compare the peer's claimed binding
 * with the endpoint it actually selected, field by field.
 *
 * Admission and lifecycle guarantees:
 * - Every inbound call is authorized against the REAL kernel-selected endpoint
 *   (provider, contract and the complete binding) inside `authorizeIncoming`;
 *   an ambient "some peer authenticated" bit is never enough.
 * - A caller plugin must be activated by the *caller peer's own* snapshot
 *   (per-peer activation facts), never by the control-side current config or by
 *   the set of installed manifests.
 * - Several eligible peers for one route are an explicit `ambiguous`; a retiring
 *   peer stops receiving new work while accepted tasks keep their handle, lease
 *   and terminal.
 * - A peer stop is only ever accepted from a real per-process exit
 *   notification plus an exact-exit re-verification; a factory-level
 *   retirement/cleanup notification is never treated as physical death, and a
 *   socket close only detaches (worker side: bounded reconnect of the same link,
 *   with sequences and pending records preserved).
 *
 * Deliberate, fail-closed scope limits of this wiring:
 * - Remote routing facts are never derived locally: each side learns the other's
 *   REAL publication metadata through a host-private, bounded, paged directory
 *   read muxed onto the same authenticated link (see `peer-directory.ts`), and a
 *   target that is absent or not ready simply stays not-ready.
 * - Only `global`-scope RPC services cross the peer channel. A `binding`-scope
 *   consumption is never registered remotely, so it resolves as unavailable
 *   instead of being routed to an arbitrary binding.
 * - Only `bootstrap` and `background` purposes are admitted inbound.
 *   `management`, `request` and `attempt` keep their existing authenticated
 *   channels; a peer can never manufacture those authorities from payload.
 * - A worker-provided service is only routed by the control process when
 *   exactly one authenticated peer currently activates its provider. With zero
 *   or several candidates the call is refused (`unavailable` / `ambiguous`)
 *   rather than picking a worker.
 */

import { isCrossProcessSelfSnapshot } from './contracts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import type { SupervisionProcessCredential } from '../supervision';
import type { PluginServiceDeclarations, PluginServiceProcess } from './contracts';
import type { CommandJournal } from './command-journal';
import type {
  HostRpcAdapter,
  HostRpcJournalRequest,
  HostRpcLeaseGrant,
  HostRpcLeaseRequest,
  HostRpcLifecycleIdentity,
  HostRpcPlacementRequest,
  HostRpcPlacementResolution,
  HostRpcRemoteCallerHandle,
  HostRpcRemoteCallerInput,
} from './host-rpc';
import { RpcServiceError, readHostRpcCalleeFrame } from './host-rpc';
import { createPluginPeerCredential, decodePluginPeerHeader, encodePluginPeerHeader, signPluginPeerPacket, verifyPluginPeerPacket, PluginPeerReplayWindow, type PluginPeerAuthority, type PluginPeerCredential } from './peer-protocol';
import { PluginPeerRpcLink, type PluginPeerRpcRequestExecution } from './peer-rpc-link';
import {
  createPluginPeerRpcProxy,
  createPluginPeerRpcRequestHandler,
  decodePeerRpcResultBody,
  encodePeerRpcCallMetadata,
  encodePeerRpcJsonBody,
  PEER_RPC_METADATA_VERSION,
  type PeerRpcCallMetadata,
  type PluginPeerRpcNativeRequest,
} from './peer-rpc-mapping';
import {
  buildChannelDirectoryPage,
  buildDirectoryPage,
  channelDirectoryRevision,
  decodePeerChannelDirectoryPage,
  decodePeerDirectoryPage,
  decodePeerDirectoryQuery,
  directoryRevision,
  isHostChannelDirectoryQuery,
  isHostDirectoryQuery,
  isReservedHostName,
  toChannelDirectoryEntries,
  toDirectoryEntries,
  PLUGIN_PEER_DIRECTORY_DEADLINE_MS,
  PLUGIN_PEER_DIRECTORY_MAJOR,
  PLUGIN_PEER_DIRECTORY_MAX_PAGES,
  PLUGIN_PEER_DIRECTORY_METHOD,
  PLUGIN_PEER_DIRECTORY_PRINCIPAL,
  PLUGIN_PEER_DIRECTORY_PROVIDER,
  PLUGIN_PEER_DIRECTORY_SERVICE,
  PLUGIN_PEER_DIRECTORY_VERSION,
  PLUGIN_PEER_CHANNEL_DIRECTORY_METHOD,
  type PeerChannelDirectoryEntry,
  type PeerDirectoryEntry,
} from './peer-directory';
import type { HostRpcPublicationView } from './host-rpc';
import {
  bindPluginPeerClientSocket,
  createPluginPeerWebSocketServer,
  PLUGIN_PEER_WS_PATH,
  type PluginPeerClientSocketBinding,
  type PluginPeerClientSocketOptions,
  type PluginPeerWebSocketLimits,
  type PluginPeerWebSocketServer,
} from './peer-websocket';
import type { RpcEndpointBinding, RpcEndpointHandle, RpcProxyExecution } from './rpc-runtime';
import type { RpcCallPurpose, RpcJson, RpcMethodDefinition } from './wire-contract';
import { PluginPeerChannelHub, type PluginChannelProviderContext, type PluginChannelRouteResolution } from './peer-channel-hub';
import type { PluginChannelLane, PluginChannelLinkPort, PluginChannelTarget } from './peer-channel-protocol';
import { decodePluginExecutorProof, type PluginExecutorProof } from './peer-executor-proof';
import { probeProcessIdentity, readKernelBootId } from '../master-runtime/process-identity';

/** Purposes the peer channel may carry inbound; everything else keeps its own authenticated channel. */
const PEER_PURPOSES: readonly RpcCallPurpose[] = Object.freeze(['bootstrap', 'background']);

/** Strict, bounded upgrade header carrying the *claimed* peer identity. Never a secret. */
export const PLUGIN_PEER_IDENTITY_HEADER = 'x-bungee-plugin-peer';
export const PLUGIN_PEER_PROOF_HEADER = 'x-bungee-plugin-peer-proof';
const UPGRADE_PROOF_TTL_MS = 5_000;
const EMPTY_BODY = new Uint8Array(0);
const EXECUTOR_PROOF_METHOD = 'executor-proof';

function isExecutorProofQuery(metadata: PeerRpcCallMetadata): boolean {
  return metadata.target.method === EXECUTOR_PROOF_METHOD && metadata.host === null
    && metadata.operationId === null && metadata.commandAction === null
    && isHostDirectoryQuery({ ...metadata, target: { ...metadata.target, method: PLUGIN_PEER_DIRECTORY_METHOD } });
}

function denyUpgrade(reason: string): null {
  try { logger.debug({ reason }, 'Plugin peer upgrade rejected'); }
  catch { /* fixed-code diagnostics are best-effort, never grant admission */ }
  return null;
}

export type PluginPeerUpgradeIdentity = Readonly<{
  readonly master_generation: string;
  readonly worker_instance_id: string;
  readonly worker_slot: number;
  readonly boot_nonce: string;
  readonly controller_epoch: number;
  readonly controller_id: string;
}>;

const UPGRADE_IDENTITY_KEYS = ['master_generation', 'worker_instance_id', 'worker_slot', 'boot_nonce', 'controller_epoch', 'controller_id'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Strict, accessor-free decode of the upgrade identity header. */
export function parsePluginPeerUpgradeIdentity(value: string | null | undefined): PluginPeerUpgradeIdentity | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== UPGRADE_IDENTITY_KEYS.length || keys.some(key => !(UPGRADE_IDENTITY_KEYS as readonly string[]).includes(key))) return null;
  const { master_generation, worker_instance_id, worker_slot, boot_nonce, controller_epoch, controller_id } = parsed;
  if (typeof master_generation !== 'string' || !UUID.test(master_generation)) return null;
  if (typeof worker_instance_id !== 'string' || !UUID.test(worker_instance_id)) return null;
  if (typeof boot_nonce !== 'string' || !UUID.test(boot_nonce)) return null;
  if (typeof controller_id !== 'string' || controller_id.length === 0 || controller_id.length > 128) return null;
  if (!Number.isSafeInteger(worker_slot) || (worker_slot as number) < 0) return null;
  if (!Number.isSafeInteger(controller_epoch) || (controller_epoch as number) < 0) return null;
  return Object.freeze({
    master_generation, worker_instance_id, boot_nonce, controller_id,
    worker_slot: worker_slot as number, controller_epoch: controller_epoch as number,
  });
}

export function encodePluginPeerUpgradeIdentity(identity: PluginPeerUpgradeIdentity): string {
  return JSON.stringify({
    master_generation: identity.master_generation,
    worker_instance_id: identity.worker_instance_id,
    worker_slot: identity.worker_slot,
    boot_nonce: identity.boot_nonce,
    controller_epoch: identity.controller_epoch,
    controller_id: identity.controller_id,
  });
}

/** The HTTP upgrade proves possession before it can reserve an existing link. */
export function encodePluginPeerUpgradeProof(
  identity: PluginPeerUpgradeIdentity, credential: SupervisionProcessCredential, sequence: number,
): string {
  return encodePluginPeerHeader(signPluginPeerPacket({
    direction: 'peer-to-control', authority: {
      controller_epoch: identity.controller_epoch, controller_id: identity.controller_id,
    }, sequence, request_id: randomUUID(), lane: 'rpc', kind: 'request',
    deadline_at: Date.now() + UPGRADE_PROOF_TTL_MS,
    context: { op: 'websocket-upgrade', path: PLUGIN_PEER_WS_PATH, identity: { ...identity } },
  }, EMPTY_BODY, createPluginPeerCredential(credential)).header);
}

/** Kernel facts that fully determine one side's deployment identity for a peer service. */
export interface PluginPeerKernelFacts {
  readonly process: PluginServiceProcess;
  readonly instance: string;
  readonly generation: number;
  readonly catalog: string;
}

/**
 * Canonical owner identity for one plugin instance inside a peer process.
 *
 * Each owner activation has a distinct endpoint, even within the same process.
 * Peers learn the actual binding from the publication directory, never by
 * reconstructing it from a plugin name and an old process generation.
 */
export function pluginPeerLifecycleIdentity(
  facts: PluginPeerKernelFacts,
  plugin: string,
  scopeKey: string = 'global',
): HostRpcLifecycleIdentity {
  return Object.freeze({
    endpoint: `peer:${facts.process}:${randomUUID()}`,
    instance: facts.instance,
    generation: Math.max(1, facts.generation),
    catalog: facts.catalog,
    subject: scopeKey === 'global' ? plugin : `${plugin}@${scopeKey}`,
  });
}

/** Full field-by-field binding equality; never a subset comparison. */
export function sameBinding(left: RpcEndpointBinding, right: RpcEndpointBinding): boolean {
  return left.endpoint === right.endpoint && left.process === right.process
    && left.instance === right.instance && left.generation === right.generation
    && left.catalog === right.catalog && left.scope === right.scope && left.subject === right.subject;
}

/* -------------------------------------------------------------------------- */
/* Host-private publication directory (over the authenticated peer link)       */
/* -------------------------------------------------------------------------- */

/** The sender's own facts; the reserved query binding is legal telemetry, not a remote fact. */
function directoryQueryMetadata(facts: PluginPeerKernelFacts, method = PLUGIN_PEER_DIRECTORY_METHOD): RpcJson {
  return encodePeerRpcCallMetadata({
    version: PEER_RPC_METADATA_VERSION,
    target: {
      provider: PLUGIN_PEER_DIRECTORY_PROVIDER, service: PLUGIN_PEER_DIRECTORY_SERVICE,
      major: PLUGIN_PEER_DIRECTORY_MAJOR, method,
    },
    binding: {
      endpoint: `peer-directory:${facts.process}:${facts.instance}`, process: facts.process,
      instance: facts.instance, generation: Math.max(1, facts.generation), catalog: facts.catalog,
      scope: 'global', subject: PLUGIN_PEER_DIRECTORY_PRINCIPAL,
    },
    caller: { subject: PLUGIN_PEER_DIRECTORY_PRINCIPAL, scope: 'global' },
    purpose: 'background', operationId: null, commandAction: null, host: null,
  });
}

/**
 * Same reserved host-private read as the RPC directory, but for the peer's
 * channel (stream/snapshot/event) publications: the same link, the same
 * principal, a different `method` on the same reserved service.
 */
function channelDirectoryQueryMetadata(facts: PluginPeerKernelFacts): RpcJson {
  return encodePeerRpcCallMetadata({
    version: PEER_RPC_METADATA_VERSION,
    target: {
      provider: PLUGIN_PEER_DIRECTORY_PROVIDER, service: PLUGIN_PEER_DIRECTORY_SERVICE,
      major: PLUGIN_PEER_DIRECTORY_MAJOR, method: PLUGIN_PEER_CHANNEL_DIRECTORY_METHOD,
    },
    binding: {
      endpoint: `peer-directory:${facts.process}:${facts.instance}`, process: facts.process,
      instance: facts.instance, generation: Math.max(1, facts.generation), catalog: facts.catalog,
      scope: 'global', subject: PLUGIN_PEER_DIRECTORY_PRINCIPAL,
    },
    caller: { subject: PLUGIN_PEER_DIRECTORY_PRINCIPAL, scope: 'global' },
    purpose: 'background', operationId: null, commandAction: null, host: null,
  });
}

async function loadPeerChannelDirectory(
  link: PluginPeerRpcLink,
  facts: PluginPeerKernelFacts,
): Promise<readonly PeerChannelDirectoryEntry[] | null> {
  const metadata = channelDirectoryQueryMetadata(facts);
  for (let attempt = 0; attempt < 2; attempt++) {
    const collected: PeerChannelDirectoryEntry[] = [];
    let revision: string | null = null;
    let total = 0;
    let consistent = true;
    let cursor = 0;
    for (let page = 0; page < PLUGIN_PEER_DIRECTORY_MAX_PAGES; page++) {
      let call: PluginPeerRpcRequestExecution | null;
      try {
        call = link.request(metadata, encodePeerRpcJsonBody({ version: PLUGIN_PEER_DIRECTORY_VERSION, cursor }), {
          deadlineAt: Date.now() + PLUGIN_PEER_DIRECTORY_DEADLINE_MS,
        });
      } catch { consistent = false; break; }
      if (call === null || typeof call !== 'object') { consistent = false; break; }
      void call.terminal.catch(() => undefined);
      let bytes: Uint8Array;
      try { bytes = await call.result; } catch { consistent = false; break; }
      let decoded: ReturnType<typeof decodePeerRpcResultBody>;
      try { decoded = decodePeerRpcResultBody(bytes); } catch { consistent = false; break; }
      if (!decoded.ok) { consistent = false; break; }
      const decodedPage = decodePeerChannelDirectoryPage(decoded.value);
      if (decodedPage === null) { consistent = false; break; }
      if (revision === null) { revision = decodedPage.revision; total = decodedPage.total; }
      else if (revision !== decodedPage.revision || total !== decodedPage.total) { consistent = false; break; }
      collected.push(...decodedPage.entries);
      if (!decodedPage.more) break;
      cursor = decodedPage.cursor + decodedPage.entries.length;
    }
    if (consistent && revision !== null && collected.length === total && channelDirectoryRevision(collected) === revision) {
      return Object.freeze(collected);
    }
  }
  return null;
}

/**
 * Reads the peer's host-private publication directory over its authenticated
 * link, page by page, and returns only a snapshot that is self-consistent
 * (every page carries the same revision and the entries hash back to it).
 * `null` means "no trustworthy directory right now": the caller must keep its
 * previous routes untouched rather than guess.
 */
async function loadPeerDirectory(
  link: PluginPeerRpcLink,
  facts: PluginPeerKernelFacts,
): Promise<readonly PeerDirectoryEntry[] | null> {
  const metadata = directoryQueryMetadata(facts);
  for (let attempt = 0; attempt < 2; attempt++) {
    const collected: PeerDirectoryEntry[] = [];
    let revision: string | null = null;
    let total = 0;
    let consistent = true;
    let cursor = 0;
    for (let page = 0; page < PLUGIN_PEER_DIRECTORY_MAX_PAGES; page++) {
      let call: PluginPeerRpcRequestExecution | null;
      try {
        call = link.request(metadata, encodePeerRpcJsonBody({ version: PLUGIN_PEER_DIRECTORY_VERSION, cursor }), {
          deadlineAt: Date.now() + PLUGIN_PEER_DIRECTORY_DEADLINE_MS,
        });
      } catch { consistent = false; break; }
      if (call === null || typeof call !== 'object') { consistent = false; break; }
      // The answer body is read; the independent terminal is consumed so a
      // refused/abandoned directory read can never surface as an unhandled one.
      void call.terminal.catch(() => undefined);
      let bytes: Uint8Array;
      try { bytes = await call.result; } catch { consistent = false; break; }
      let decoded: ReturnType<typeof decodePeerRpcResultBody>;
      try { decoded = decodePeerRpcResultBody(bytes); } catch { consistent = false; break; }
      if (!decoded.ok) { consistent = false; break; }
      const decodedPage = decodePeerDirectoryPage(decoded.value);
      if (decodedPage === null) { consistent = false; break; }
      if (revision === null) { revision = decodedPage.revision; total = decodedPage.total; }
      else if (revision !== decodedPage.revision || total !== decodedPage.total) { consistent = false; break; }
      collected.push(...decodedPage.entries);
      if (!decodedPage.more) break;
      cursor = decodedPage.cursor + decodedPage.entries.length;
    }
    if (consistent && revision !== null && collected.length === total && directoryRevision(collected) === revision) {
      return Object.freeze(collected);
    }
  }
  return null;
}

/**
 * Answers one host-private directory query from this process's REAL publication
 * view. Returns `null` for a malformed query, which the mux reports as a
 * no-dispatch rejection; a plugin can never reach this branch (the reserved
 * principal/target are host-minted and rejected on the normal path).
 */
function directoryAnswer(
  services: PluginPeerServiceHost,
  process: PluginServiceProcess,
  input: unknown,
): RpcJson | null {
  const query = decodePeerDirectoryQuery(input);
  if (query === null) return null;
  const view: readonly HostRpcPublicationView[] = services.rpc?.publicationView() ?? [];
  const entries = toDirectoryEntries(view, process);
  const page = buildDirectoryPage(entries, directoryRevision(entries), query.cursor);
  return page === null ? null : page.page as unknown as RpcJson;
}

/** Encodes one channel directory page from this process's real channel registrations. */
function channelDirectoryExecution(hub: PluginPeerChannelHub, input: unknown): RpcProxyExecution | null {
  const query = decodePeerDirectoryQuery(input);
  if (query === null) return null;
  const entries = toChannelDirectoryEntries(hub.publicationView());
  const page = buildChannelDirectoryPage(entries, channelDirectoryRevision(entries), query.cursor);
  if (page === null) return null;
  return Object.freeze({ result: Promise.resolve(page.page as unknown as RpcJson), terminal: Promise.resolve() });
}

/** Encodes a directory page as the mux's synchronous native execution pair. */
function directoryExecution(services: PluginPeerServiceHost, process: PluginServiceProcess, input: unknown): RpcProxyExecution | null {
  const page = directoryAnswer(services, process, input);
  if (page === null) return null;
  return Object.freeze({ result: Promise.resolve(page), terminal: Promise.resolve() });
}

/**
 * Bounded coalesced refresh of the peer directory. One timer serves every peer
 * and every route; it is unref'd so it can never hold a process open, and it is
 * cancelled on dispose/retire.
 */
class DirectoryRefreshLoop {
  #timer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  constructor(private readonly action: () => Promise<void>, private readonly intervalMs: number) {}
  start(): void {
    if (this.#timer !== null) return;
    const timer = setInterval(() => { void this.trigger(); }, this.intervalMs);
    timer.unref?.();
    this.#timer = timer;
  }
  /** One coalesced run: overlapping calls share the in-flight refresh. */
  async trigger(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try { await this.action(); } catch { /* a failed refresh keeps the last snapshot */ } finally { this.#running = false; }
  }
  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

const SEP = '\0';

function routeKey(provider: string, service: string, major: number, scopeKey: string): string {
  return [provider, service, String(major), scopeKey].join(SEP);
}

/**
 * Ambient marker for exactly one authenticated inbound peer dispatch. It carries
 * the decoded call metadata so the kernel's `authorizeIncoming` can compare the
 * *actual* selected endpoint binding against what the peer claimed, instead of
 * trusting an ambient "some peer authenticated" bit.
 */
type InboundFrame = { readonly ownerKey: string; readonly metadata: PeerRpcCallMetadata };

const INBOUND_FRAME = new AsyncLocalStorage<InboundFrame>();

/** The host surface the broker needs; `PluginServiceHost` satisfies it structurally. */
export interface PluginPeerServiceHost {
  readonly rpc?: HostRpcAdapter;
  serviceDeclarations(): ReadonlyMap<string, PluginServiceDeclarations>;
  runPeerInvocation?<T>(purpose: 'request' | 'attempt', callee: unknown, run: () => T): T;
}

type RouteContract = { readonly id: string; readonly version: number; readonly methods: Record<string, RpcMethodDefinition> };

interface RemoteCallerInput {
  readonly consumerPlugin: string;
  readonly scope?: string;
  readonly declarations?: PluginServiceDeclarations;
  /**
   * Process in which the *caller* (the consuming instance) runs. A consumption
   * declaration's `process` names the consumer's own process, and the canonical
   * adapter matches it against the caller owner's process.
   */
  readonly callerProcess: PluginServiceProcess;
  readonly facts: PluginPeerKernelFacts;
  readonly consumes: readonly NonNullable<PluginServiceDeclarations['consumes']>[number][];
  /** Sees the REAL kernel-selected endpoint; must verify it fully, never an ambient bit. */
  readonly authorize: NonNullable<HostRpcRemoteCallerInput['authorizeIncoming']>;
  readonly leaseFor: (request: HostRpcLeaseRequest) => HostRpcLeaseGrant;
}

function remoteCallerFor(adapter: HostRpcAdapter, input: RemoteCallerInput): HostRpcRemoteCallerHandle {
  const dependencies: Record<string, string> = {};
  for (const service of input.consumes) {
    dependencies[service.plugin] = '*';
  }
  return adapter.createRemoteCaller({
    token: Object.freeze({}),
    plugin: input.consumerPlugin,
    scope: input.scope ?? 'global',
    declarations: Object.freeze({...input.declarations, consumes: Object.freeze([...input.consumes])}),
    dependencies: Object.freeze(dependencies),
    lifecycle: pluginPeerLifecycleIdentity(input.facts, input.consumerPlugin, input.scope ?? 'global'),
    getLifecycleState: () => Object.freeze({ ready: true, retiring: false, revoked: false }),
    acquireLease: input.leaseFor,
    resolveInvocationContext: () => null,
    process: input.callerProcess,
    authorizeIncoming: input.authorize,
  });
}

/** True only for a global-scope RPC consumption the peer actually declared for this exact target. */
export function declaresPeerConsumption(
  declarations: PluginServiceDeclarations | undefined,
  callerProcess: PluginServiceProcess,
  metadata: PeerRpcCallMetadata,
): boolean {
  return (declarations?.consumes ?? []).some(service =>
    service.plugin === metadata.target.provider && service.id === metadata.target.service
    && service.version === metadata.target.major && service.process === callerProcess
    && (service.kind ?? 'local') === 'rpc' && (service.scope ?? 'global') === 'global');
}

/** RPC consumptions that run in `callerProcess`, declared by one plugin. */
function peerConsumptions(
  declarations: PluginServiceDeclarations | undefined,
  callerProcess: PluginServiceProcess,
): readonly NonNullable<PluginServiceDeclarations['consumes']>[number][] {
  return (declarations?.consumes ?? []).filter(service =>
    service.process === callerProcess && (service.kind ?? 'local') === 'rpc' && (service.scope ?? 'global') === 'global');
}

/** Lane name → the manifest service `kind` literal it is declared as. */
const CHANNEL_DECL_KIND: Record<PluginChannelLane, string> = Object.freeze({
  event: 'events', snapshot: 'snapshot', stream: 'stream',
});

const CHANNEL_LANES: readonly PluginChannelLane[] = Object.freeze(['event', 'snapshot', 'stream']);

/**
 * True only when the peer's consumer plugin really declared a global-scope
 * consumption of this exact channel target in its own process. A manifest of the
 * provider, an activation, or an ambient "some peer authenticated" bit never
 * substitutes for it.
 */
function declaresChannelConsumption(
  declarations: PluginServiceDeclarations | undefined,
  callerProcess: PluginServiceProcess,
  lane: PluginChannelLane,
  target: PluginChannelTarget,
  callerScope: string,
  providerProcess: PluginServiceProcess,
  callerPlugin: string,
): boolean {
  // Channel routing is global-scope only: a binding-scope caller or a
  // binding-scope declaration is never a cross-process channel target.
  if (callerScope !== 'global') return false;
  const kind = CHANNEL_DECL_KIND[lane];
  return (declarations?.consumes ?? []).some(service =>
    service.plugin === target.provider && service.id === target.service
    && service.version === target.major && service.process === callerProcess
    && (service.kind ?? 'local') === kind && (service.scope ?? 'global') === 'global'
    && (target.provider !== callerPlugin || (isCrossProcessSelfSnapshot(callerPlugin, service, declarations!)
      && callerProcess !== providerProcess && declarations!.provides!.some(publication => publication.id === target.service
        && publication.version === target.major && publication.kind === 'snapshot' && publication.process === providerProcess))));
}

/** Directory key for one channel publication target. */
function channelRouteKey(target: PluginChannelTarget): string {
  return [target.provider, target.service, String(target.major)].join(SEP);
}

/** The kernel publication this receiver must answer for: a peer target, never a foreign instance. */
function bindingIs(metadata: PeerRpcCallMetadata, process: PluginServiceProcess): boolean {
  const binding = metadata.binding;
  return binding.process === process
    && binding.scope === 'global'
    && binding.subject === metadata.target.provider;
}

/* -------------------------------------------------------------------------- */
/* Control process                                                             */
/* -------------------------------------------------------------------------- */

/** Exact pinned first start target of one physical peer instance, when it received one. */
export type ControlPeerConfigurationTarget = Readonly<{
  readonly revision: number;
  readonly content_hash: string;
  readonly plugin_catalog_hash: string;
}>;

/**
 * Trusted, peer-scoped session facts for exactly one physical worker identity.
 * Every field comes from that peer's *own* physical session/serving snapshot;
 * nothing here is derived from the current control-side configuration or from
 * the set of installed manifests.
 */
export type ControlPeerSession = Readonly<{
  /** Host-private supervision credential of this exact physical worker instance. */
  readonly credential: SupervisionProcessCredential;
  /**
   * Plugins actually activated by THIS peer's exact published snapshot. A
   * manifest slot, an installed artifact or another worker's activation never
   * makes a service routable here.
   */
  readonly activatedPlugins: readonly string[];
  /** The peer's pinned first start target, or `null` when it never accepted one. */
  readonly configurationTarget: ControlPeerConfigurationTarget | null;
  /**
   * Real per-process exit subscription (the physical child-exit notification).
   * A factory-level retirement/cleanup notification is NOT an exit proof and
   * must never be supplied here.
   */
  readonly onExit?: (listener: () => void) => () => void;
  /**
   * Exact-exit re-verification for this same identity. `true` is a real proof,
   * `false`/`null`/a rejected promise is unproven and never becomes a stop.
   */
  readonly verifyExit?: () => Promise<boolean>;
}>;

export interface ControlPeerBrokerOptions {
  readonly services: PluginPeerServiceHost;
  /** Stable control instance id (the published master generation); known late. */
  readonly instance: () => string;
  /** Current controller authority; `null` before the supervision lease exists. */
  readonly authority: () => PluginPeerAuthority | null;
  /** Current plugin catalog hash of the serving snapshot. */
  readonly catalog: () => string;
  /**
   * Trusted physical-session lookup for the exact claimed worker identity. It
   * must return that peer's own facts (see {@link ControlPeerSession}) or `null`.
   */
  readonly resolvePeer: (identity: {
    readonly master_generation: string;
    readonly worker_slot: number;
    readonly worker_instance_id: string;
    readonly boot_nonce: string;
  }) => ControlPeerSession | null;
  /** Mandatory per-call authority projection for request/attempt traffic. */
  readonly projectInvocation?: (worker: {master_generation: string; worker_instance_id: string; worker_slot: number; boot_nonce: string}, metadata: PeerRpcCallMetadata, signal: AbortSignal) => Promise<unknown>;
  readonly resolveJournal?: (request: HostRpcJournalRequest) => CommandJournal | null;
  /** Captured from THIS control process before plugin activation, never peer/plugin input. */
  readonly executorProof?: () => PluginExecutorProof | null;
  readonly allowedOrigins?: readonly string[];
  readonly limits?: PluginPeerWebSocketLimits;
}

type ControlPeerRecord = {
  readonly ownerKey: string;
  readonly workerInstanceId: string;
  readonly workerIdentity: {master_generation: string; worker_instance_id: string; worker_slot: number; boot_nonce: string};
  readonly bootNonce: string;
  readonly catalog: string;
  readonly generation: number;
  readonly credential: PluginPeerCredential;
  readonly upgradeReplay: PluginPeerReplayWindow;
  readonly link: PluginPeerRpcLink;
  readonly callers: Map<string, HostRpcRemoteCallerHandle>;
  readonly routes: Map<string, RpcEndpointHandle>;
  /** Plugins activated by this peer's own exact serving snapshot. */
  readonly activatedPlugins: ReadonlySet<string>;
  readonly configurationTarget: ControlPeerConfigurationTarget | null;
  /**
   * Real publication directory learned from this peer's own host over the peer
   * link. Routing only ever uses entries from here — never a manifest
   * declaration, never a locally derived binding.
   */
  readonly directory: Map<string, PeerDirectoryEntry>;
  directoryRevision: string | null;
  directoryLoaded: boolean;
  /** The peer's REAL channel (stream/snapshot/event) publications. */
  readonly channelDirectory: Map<string, PeerChannelDirectoryEntry>;
  channelDirectoryRevision: string | null;
  channelDirectoryLoaded: boolean;
  unsubscribeExit: (() => void) | null;
  leases: number;
  retiring: boolean;
  stopped: boolean;
};

type PendingRoute = {
  readonly key: string;
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scopeKey: string;
  readonly contract: RouteContract;
};

export class ControlPeerBroker {
  readonly websocket: PluginPeerWebSocketServer;
  /** Host communication lane hub (event/snapshot/stream) over the same links. */
  readonly channels: PluginPeerChannelHub;
  readonly #options: ControlPeerBrokerOptions;
  readonly #peers = new Map<string, ControlPeerRecord>();
  /** Declared remote consumptions waiting for exactly one eligible activated peer. */
  readonly #pending = new Map<string, PendingRoute>();
  #disposed = false;

  readonly #directoryLoop: DirectoryRefreshLoop;

  constructor(options: ControlPeerBrokerOptions) {
    this.#options = options;
    // One bounded, coalesced refresh serves every peer: a worker's publication
    // set changes as its plugins (re)initialize, and routing must follow the
    // REAL directory instead of a one-shot snapshot.
    this.#directoryLoop = new DirectoryRefreshLoop(() => this.#refreshDirectories(), 1_000);
    this.channels = new PluginPeerChannelHub({
      process: 'control',
      peerProcess: 'worker',
      resolveRoute: (target, lane) => this.#resolveChannelRoute(target, lane),
      authorizeInbound: (request) => this.#authorizeChannelInbound(request),
      beginProviderOperation: (plugin, context) => this.#channelProviderLease?.(plugin, context) ?? null,
    });
    this.websocket = createPluginPeerWebSocketServer({
      authorize: (request) => this.#authorize(request),
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  }

  #channelProviderLease: ((plugin: string, context: PluginChannelProviderContext) => (() => void) | null) | null = null;

  /**
   * Host-only: the exact provider-side Host lease factory. Wired by the master
   * composition once the canonical service host exists, so a peer-originated
   * lane task holds the providing owner's real lease.
   */
  setChannelProviderLease(resolver: (plugin: string, context: PluginChannelProviderContext) => (() => void) | null): void {
    this.#channelProviderLease = resolver;
  }

  /**
   * Resolves one channel target to exactly one peer that really publishes it.
   * Several eligible peers are `ambiguous` (never "pick one"); none is
   * `unavailable`. A same-process publication is preferred by the hub itself.
   */
  #resolveChannelRoute(target: PluginChannelTarget, lane: PluginChannelLane): PluginChannelRouteResolution {
    const key = channelRouteKey(target);
    const matches = [...this.#peers.values()].filter((record) => {
      if (record.stopped || record.retiring) return false;
      const entry = record.channelDirectory.get(key);
      return entry !== undefined && entry.ready && entry.kind === lane;
    });
    if (matches.length > 1) return { kind: 'ambiguous' };
    if (matches.length === 0) return { kind: 'unavailable' };
    return { kind: 'remote', link: matches[0]!.link };
  }

  /** Channel admission: same real peer facts as RPC, plus the declared lane consumption. */
  #authorizeChannelInbound(input: {
    readonly lane: PluginChannelLane;
    readonly target: PluginChannelTarget;
    readonly caller: string;
    readonly callerScope: string;
    readonly providerProcess: PluginServiceProcess;
    readonly local: boolean;
    readonly link: PluginChannelLinkPort | null;
    readonly continuation: boolean;
  }): boolean {
    if (this.#disposed) return false;
    if (input.local) {
      // Same-process channel call: the provider lives in this control process, but
      // the caller must still declare the exact lane consumption here.
      if (input.providerProcess !== 'control') return false;
      return declaresChannelConsumption(this.#options.services.serviceDeclarations().get(input.caller), 'control', input.lane, input.target, input.callerScope, input.providerProcess, input.caller);
    }
    if (input.providerProcess !== 'control' || input.link === null) return false;
    const record = [...this.#peers.values()].find(candidate => candidate.link === input.link);
    if (record === undefined || record.stopped) return false;
    // A retiring peer stops NEW channel work but its already-accepted transfers,
    // subscriptions and snapshot sessions keep their exact continuation frames.
    if (record.retiring && !input.continuation) return false;
    // The caller plugin must be activated by THIS peer's own serving snapshot.
    if (!record.activatedPlugins.has(input.caller)) return false;
    return declaresChannelConsumption(this.#options.services.serviceDeclarations().get(input.caller), 'worker', input.lane, input.target, input.callerScope, input.providerProcess, input.caller);
  }

  /**
   * Host placement authority for one call. Only a declared remote consumption
   * can leave this process; several eligible peers are an explicit `ambiguous`
   * (never "pick one"), exactly one peer answers with its real registered
   * endpoint, and a peer that is retiring/stopped stops receiving NEW calls
   * while every already-accepted task keeps its own handle and terminal.
   */
  readonly placementResolver = (request: HostRpcPlacementRequest): HostRpcPlacementResolution => {
    if (request.scope !== 'global') return null;
    const key = routeKey(request.provider, request.service, request.major, 'global');
    if (!this.#pending.has(key)) return null;
    // Only a peer whose OWN real directory says it offers this exact service and
    // is ready can answer; a manifest declaration never counts.
    const candidates = this.#candidates(key, request.provider);
    if (candidates.length > 1) return { kind: 'ambiguous' };
    if (candidates.length === 0) return null;
    const handle = candidates[0]!.routes.get(key);
    return handle === undefined ? null : { kind: 'endpoint', endpoint: handle };
  };

  /**
   * Registers (or defers) the native proxy for one declared remote consumption.
   * Called before the canonical adapter resolves a consume/invoke route, so the
   * route directory is filled from the consumer's own contract.
   */
  readonly ensureRemoteRoute = (input: {
    readonly plugin: string;
    readonly scope: string;
    readonly provider: string;
    readonly contract: RouteContract;
  }): void => {
    if (this.#disposed) return;
    const declaration = (this.#options.services.serviceDeclarations().get(input.provider)?.provides ?? []).find(service =>
      service.id === input.contract.id && service.version === input.contract.version
      && (service.kind ?? 'local') === 'rpc' && service.process === 'worker' && (service.scope ?? 'global') === 'global');
    if (declaration === undefined) return;
    const key = routeKey(input.provider, input.contract.id, input.contract.version, 'global');
    this.#pending.set(key, {
      key, provider: input.provider, service: input.contract.id, major: input.contract.version, scopeKey: 'global',
      contract: input.contract,
    });
    this.#reconcileKey(key);
  };

  /**
   * The exact ready directory entry a peer's own host published for this route,
   * or `null`. This is the only source of remote routing facts; activations,
   * manifests and locally derived bindings never substitute for it.
   */
  #readyEntry(record: ControlPeerRecord, key: string, provider: string): PeerDirectoryEntry | null {
    const entry = record.directory.get(key);
    if (entry === undefined || !entry.ready) return null;
    if (entry.provider !== provider || entry.scope !== 'global') return null;
    return entry;
  }

  /**
   * Peers that really OFFER this exact service right now: their own directory
   * says so and marks it ready, and the peer is connected and not retiring.
   */
  #candidates(key: string, provider: string): ControlPeerRecord[] {
    return [...this.#peers.values()].filter(record =>
      !record.stopped && !record.retiring && this.#readyEntry(record, key, provider) !== null);
  }

  #reconcileAll(): void {
    for (const key of this.#pending.keys()) this.#reconcileKey(key);
  }

  /** The control side's own kernel facts, used as the reserved query's telemetry. */
  #controlFacts(): PluginPeerKernelFacts | null {
    const instance = this.#options.instance();
    const authority = this.#options.authority();
    const catalog = this.#options.catalog();
    if (instance === '' || authority === null || typeof catalog !== 'string' || catalog.length === 0) return null;
    return Object.freeze({
      process: 'control' as const, instance,
      generation: Math.max(1, authority.controller_epoch), catalog,
    });
  }

  /**
   * Learns every connected peer's real publication directory over its own
   * authenticated link and re-reconciles routes when anything changed. An
   * unreadable directory keeps the previous snapshot (never a guess); the loop
   * is bounded and coalesced by {@link DirectoryRefreshLoop}.
   */
  async #refreshDirectories(): Promise<void> {
    if (this.#disposed) return;
    const facts = this.#controlFacts();
    if (facts === null) return;
    let changed = false;
    for (const record of [...this.#peers.values()]) {
      if (record.stopped) continue;
      const entries = await loadPeerDirectory(record.link, facts);
      if (entries === null) continue;
      const revision = directoryRevision(entries);
      if (record.directoryRevision !== revision) {
        record.directory.clear();
        for (const entry of entries) {
          record.directory.set(routeKey(entry.provider, entry.service, entry.major, entry.scopeKey), entry);
        }
        record.directoryRevision = revision;
        record.directoryLoaded = true;
        changed = true;
      } else {
        record.directoryLoaded = true;
      }
      // The channel directory is a separate page set on the same link; a peer
      // that publishes no channels simply reports an empty page.
      const channelEntries = await loadPeerChannelDirectory(record.link, facts);
      if (channelEntries === null) continue;
      const channelRevision = channelDirectoryRevision(channelEntries);
      if (record.channelDirectoryRevision === channelRevision) { record.channelDirectoryLoaded = true; continue; }
      record.channelDirectory.clear();
      for (const entry of channelEntries) record.channelDirectory.set(channelRouteKey(entry), entry);
      record.channelDirectoryRevision = channelRevision;
      record.channelDirectoryLoaded = true;
    }
    if (changed) this.#reconcileAll();
  }

  /**
   * Reconciles exactly one declared remote route against the current peers:
   * several eligible peers are an explicit ambiguity (every route is dropped,
   * the call is refused), exactly one peer owns it, none leaves it unavailable.
   * Revoking a route only stops NEW admissions; an accepted task keeps its own
   * handle, lease and terminal barrier.
   */
  #reconcileKey(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined || this.#disposed) return;
    const candidates = this.#candidates(key, pending.provider);
    for (const record of [...this.#peers.values()]) {
      if (record.routes.has(key) && (candidates.length !== 1 || candidates[0] !== record)) this.#revokeRoute(record, key);
    }
    if (candidates.length !== 1) return;
    const record = candidates[0]!;
    const entry = this.#readyEntry(record, key, pending.provider);
    // No ready real publication means NOT READY: no route is fabricated.
    if (entry === null) return;
    const runtime = this.#options.services.rpc?.runtime;
    if (runtime === undefined) return;
    const existing = record.routes.get(key);
    if (existing !== undefined) {
      const info = runtime.endpointInfo(existing);
      if (info !== null && sameBinding(info.binding, entry.binding)) return;
      // The peer re-published a different real endpoint: follow the metadata.
      this.#revokeRoute(record, key);
    }
    try {
      const handle = runtime.registerProxy({
        provider: pending.provider,
        // The peer's REAL published binding, exactly as its own host reported it.
        binding: entry.binding,
        contract: pending.contract,
        execute: createPluginPeerRpcProxy(pending.provider, record.link, () => null),
      });
      runtime.markReady(handle);
      record.routes.set(key, handle);
    } catch { /* a refused registration stays unavailable; never guessed */ }
  }

  #revokeRoute(record: ControlPeerRecord, key: string): void {
    const handle = record.routes.get(key);
    if (handle === undefined) return;
    record.routes.delete(key);
    try { this.#options.services.rpc?.runtime.revoke(handle); } catch { /* host-owned */ }
  }

  #ownerKey(identity: PluginPeerUpgradeIdentity): string {
    return [identity.master_generation, identity.worker_instance_id, identity.boot_nonce].join(SEP);
  }

  #authorize(request: Request): PluginPeerRpcLink | null {
    if (this.#disposed) return denyUpgrade('disposed');
    const identity = parsePluginPeerUpgradeIdentity(request.headers.get(PLUGIN_PEER_IDENTITY_HEADER));
    if (identity === null) return denyUpgrade('identity');
    const authority = this.#options.authority();
    if (authority === null) return denyUpgrade('authority-unavailable');
    if (authority.controller_epoch !== identity.controller_epoch || authority.controller_id !== identity.controller_id) return denyUpgrade('authority');
    const instance = this.#options.instance();
    if (instance === '' || identity.master_generation !== instance) return denyUpgrade('instance');
    const session = this.#options.resolvePeer({
      master_generation: identity.master_generation,
      worker_slot: identity.worker_slot,
      worker_instance_id: identity.worker_instance_id,
      boot_nonce: identity.boot_nonce,
    });
    if (session === null) return denyUpgrade('physical-session');
    const credential = createPluginPeerCredential(session.credential);
    let proof: ReturnType<typeof decodePluginPeerHeader>;
    try {
      const encoded = request.headers.get(PLUGIN_PEER_PROOF_HEADER);
      if (encoded === null) return denyUpgrade('missing-proof');
      proof = decodePluginPeerHeader(encoded);
      verifyPluginPeerPacket(proof, EMPTY_BODY, credential, { direction: 'peer-to-control', authority });
      const now = Date.now();
      if (proof.kind !== 'request' || proof.lane !== 'rpc' || proof.deadline_at === null
        || proof.deadline_at <= now || proof.deadline_at > now + UPGRADE_PROOF_TTL_MS) return denyUpgrade('proof-expiry');
      if (!isRecord(proof.context) || proof.context.op !== 'websocket-upgrade'
        || proof.context.path !== PLUGIN_PEER_WS_PATH || !isRecord(proof.context.identity)) return denyUpgrade('proof-domain');
      if (encodePluginPeerUpgradeIdentity(proof.context.identity as unknown as PluginPeerUpgradeIdentity)
        !== encodePluginPeerUpgradeIdentity(identity)) return denyUpgrade('proof-identity');
    } catch { return denyUpgrade('proof-signature'); }
    if (credential.identity.role !== 'worker'
      || credential.identity.process_instance_id !== identity.worker_instance_id
      || credential.identity.boot_nonce !== identity.boot_nonce) return denyUpgrade('credential-identity');
    let record = this.#peers.get(this.#ownerKey(identity));
    if (record === undefined) record = this.#createPeer(identity, credential, authority, session);
    // Retirement keeps this exact authenticated link for outstanding request
    // settlement and terminals. Its inbound admission still rejects new work.
    if (record.stopped) return denyUpgrade('retired');
    try { record.upgradeReplay.accept(proof.sequence); } catch { return denyUpgrade('replay'); }
    return record.link;
  }

  #createPeer(
    identity: PluginPeerUpgradeIdentity,
    credential: PluginPeerCredential,
    authority: PluginPeerAuthority,
    session: ControlPeerSession,
  ): ControlPeerRecord {
    const ownerKey = this.#ownerKey(identity);
    // Two concurrent upgrades for the same exact identity must share one link.
    const raced = this.#peers.get(ownerKey);
    if (raced !== undefined) return raced;
    const record: ControlPeerRecord = {
      ownerKey,
      workerInstanceId: identity.worker_instance_id,
      workerIdentity: {master_generation: identity.master_generation, worker_instance_id: identity.worker_instance_id, worker_slot: identity.worker_slot, boot_nonce: identity.boot_nonce},
      bootNonce: identity.boot_nonce,
      // Worker-provided publications carry the peer's OWN catalog; its pinned
      // start target is that exact fact. The control catalog is only the
      // fallback for a peer that never accepted a start command (and therefore
      // activates nothing and is never a routing candidate).
      catalog: session.configurationTarget?.plugin_catalog_hash ?? this.#options.catalog(),
      generation: Math.max(1, authority.controller_epoch),
      credential,
      upgradeReplay: new PluginPeerReplayWindow(),
      link: undefined as unknown as PluginPeerRpcLink,
      callers: new Map(),
      routes: new Map(),
      activatedPlugins: new Set(session.activatedPlugins),
      configurationTarget: session.configurationTarget,
      directory: new Map(),
      directoryRevision: null,
      directoryLoaded: false,
      channelDirectory: new Map(),
      channelDirectoryRevision: null,
      channelDirectoryLoaded: false,
      unsubscribeExit: null,
      leases: 0,
      retiring: false,
      stopped: false,
    };
    const link = new PluginPeerRpcLink({
      credential,
      authority,
      outgoingDirection: 'control-to-peer',
      onRequest: createPluginPeerRpcRequestHandler((metadata, request, call) =>
        INBOUND_FRAME.run({ ownerKey, metadata }, () => this.#dispatchInbound(record, metadata, request, call))),
    });
    (record as { link: PluginPeerRpcLink }).link = link;
    // Lane frames (event/snapshot/stream) ride this same authenticated link; the
    // hub's provider registrations are process-level, so one handler per lane.
    const laneHandler = this.channels.handlerFor(link);
    for (const lane of CHANNEL_LANES) link.registerLaneHandler(lane, laneHandler);
    // Real per-process exit subscription, then an exact-exit re-verification.
    // A factory-level retirement/cleanup notification is never used: a crashed
    // worker without cleanup is exactly the case this must still catch.
    if (session.onExit !== undefined) {
      try { record.unsubscribeExit = session.onExit(() => { void this.#onPeerExit(record, session); }); }
      catch { record.unsubscribeExit = null; }
    }
    this.#peers.set(ownerKey, record);
    // A newly authorized peer may complete (or make ambiguous) declared routes
    // once its real directory is loaded; that load starts immediately.
    this.#reconcileAll();
    this.#directoryLoop.start();
    void this.#directoryLoop.trigger();
    return record;
  }

  /** Verified physical exit only; an unproven exit proof never fabricates a stop. */
  async #onPeerExit(record: ControlPeerRecord, session: ControlPeerSession): Promise<void> {
    if (record.stopped || this.#disposed) return;
    let verified: boolean | null = null;
    try { verified = session.verifyExit === undefined ? null : await session.verifyExit(); }
    catch { verified = null; }
    if (verified !== true) {
      // The process may be gone but the exact proof is absent: retire admission
      // and keep every accepted task's barrier instead of faking a terminal.
      this.retirePeer({ worker_instance_id: record.workerInstanceId, boot_nonce: record.bootNonce });
      return;
    }
    await this.confirmPeerStopped({ worker_instance_id: record.workerInstanceId, boot_nonce: record.bootNonce });
  }

  #caller(record: ControlPeerRecord, consumerPlugin: string, scope = 'global'): HostRpcRemoteCallerHandle | null {
    const key = `${consumerPlugin}\0${scope}`;
    const existing = record.callers.get(key);
    if (existing !== undefined) return existing;
    // The remote consumer runs in the worker process, so its consumption
    // declarations name `worker` as their process.
    const consumes = peerConsumptions(this.#options.services.serviceDeclarations().get(consumerPlugin), 'worker');
    if (consumes.length === 0) return null;
    const facts: PluginPeerKernelFacts = Object.freeze({
      process: 'worker', instance: record.workerInstanceId,
      generation: record.generation, catalog: record.catalog,
    });
    const adapter = this.#options.services.rpc;
    if (adapter === undefined) return null;
    let handle: HostRpcRemoteCallerHandle;
    try {
      handle = remoteCallerFor(adapter, {
        consumerPlugin, scope, declarations: this.#options.services.serviceDeclarations().get(consumerPlugin), callerProcess: 'worker', facts, consumes,
        authorize: (request, endpoint) => {
          const frame = INBOUND_FRAME.getStore();
          if (frame === undefined || frame.ownerKey !== record.ownerKey) return false;
          if (record.stopped || (record.retiring && request.purpose !== 'attempt' && request.purpose !== 'request')) return false;
          if (this.#disposed) return false;
          // The peer's claim is compared with the endpoint the kernel ACTUALLY
          // selected for this call: provider, contract and the complete binding
          // (endpoint/process/instance/generation/catalog/scope/subject).
          if (endpoint.provider !== request.target.provider) return false;
          if (endpoint.contract.id !== request.target.service) return false;
          if (endpoint.contract.version !== request.target.major) return false;
          return sameBinding(endpoint.binding, frame.metadata.binding);
        },
        leaseFor: (leaseRequest: HostRpcLeaseRequest) => {
          if (record.stopped) throw new RpcServiceError('revoked');
          if (record.retiring && leaseRequest.purpose !== 'request' && leaseRequest.purpose !== 'attempt') {
            throw new RpcServiceError('retired');
          }
          record.leases += 1;
          let released = false;
          return { release: () => { if (released) return; released = true; record.leases -= 1; } };
        },
      });
    } catch { return null; }
    record.callers.set(key, handle);
    return handle;
  }

  #dispatchInbound(record: ControlPeerRecord, metadata: PeerRpcCallMetadata, request: PluginPeerRpcNativeRequest, _call: unknown): RpcProxyExecution | null {
    if (record.stopped || this.#disposed) return null;
    if (PEER_PURPOSES.includes(metadata.purpose)) {
      if (isExecutorProofQuery(metadata) && request.input === null) {
        return { result: Promise.resolve(this.#options.executorProof?.() as unknown as RpcJson ?? null), terminal: Promise.resolve() };
      }
      if (isHostDirectoryQuery(metadata)) return directoryExecution(this.#options.services, 'control', request.input);
      if (isHostChannelDirectoryQuery(metadata)) return channelDirectoryExecution(this.channels, request.input);
      if (metadata.caller.scope !== 'global' || metadata.caller.subject.includes('@') || metadata.host !== null || record.retiring) return null;
      return this.#invokeIncoming(record, metadata, request, metadata.caller.subject, 'global');
    }
    if (metadata.purpose !== 'attempt' && metadata.purpose !== 'request') return null;
    if (!this.#options.projectInvocation || !this.#options.services.runPeerInvocation) return null;
    const separator = metadata.caller.subject.indexOf('@');
    const plugin = separator < 0 ? metadata.caller.subject : metadata.caller.subject.slice(0, separator);
    const scope = separator < 0 ? 'global' : metadata.caller.subject.slice(separator + 1);
    if ((scope === 'global') !== (metadata.caller.scope === 'global')) return null;
    // Authorization is async; terminal waits for BOTH projection and the real
    // native task. Caller cancellation cannot impersonate business completion.
    let terminalResolve!: () => void;
    let terminalReject!: (error: unknown) => void;
    const terminal = new Promise<void>((resolve, reject) => {terminalResolve = resolve; terminalReject = reject;});
    let dispatched = false;
    const result = (async () => {
      const worker = record.workerIdentity;
      const callee = await this.#options.projectInvocation!(worker, metadata, request.signal!);
      if (callee === null || callee === undefined) throw new RpcServiceError('unauthorized');
      const pair = this.#options.services.runPeerInvocation!(metadata.purpose as 'request' | 'attempt', callee, () => this.#invokeIncoming(record, metadata, request, plugin, scope));
      if (!pair) throw new RpcServiceError('unauthorized');
      dispatched = true;
      pair.terminal.then(terminalResolve, terminalReject);
      return pair.result;
    })();
    // Failed authority projection dispatched nothing. Once native dispatch
    // succeeds, ONLY its terminal may resolve our barrier.
    result.catch(() => {if (!dispatched) terminalResolve();});
    return {result, terminal};
  }

  #invokeIncoming(record: ControlPeerRecord, metadata: PeerRpcCallMetadata, request: PluginPeerRpcNativeRequest, plugin: string, scope: string): RpcProxyExecution | null {
    if (!bindingIs(metadata, 'control') || isReservedHostName(metadata.target.provider) || isReservedHostName(plugin)) return null;
    if (!record.activatedPlugins.has(plugin)) return null;
    if (!declaresPeerConsumption(this.#options.services.serviceDeclarations().get(plugin), 'worker', metadata)) return null;
    const caller = this.#caller(record, plugin, scope);
    if (!caller) return null;
    try {const tracked = caller.invokeTracked(request); return {result: tracked.result, terminal: tracked.terminal};}
    catch {return null;}
  }

  #find(identity: { readonly worker_instance_id: string; readonly boot_nonce?: string }): ControlPeerRecord | undefined {
    return [...this.#peers.values()].find(candidate =>
      candidate.workerInstanceId === identity.worker_instance_id
      && (identity.boot_nonce === undefined || candidate.bootNonce === identity.boot_nonce));
  }

  /**
   * Retirement: stop admitting new peer work and stop selecting this peer for
   * NEW calls (its routes are re-reconciled, and may move to another exactly-one
   * eligible peer). Every already-accepted task keeps its lease, handle and
   * terminal barrier.
   */
  retirePeer(identity: { readonly worker_instance_id: string; readonly boot_nonce?: string }): void {
    const record = this.#find(identity);
    if (record === undefined) return;
    record.retiring = true;
    // Keep the shared link available for projected existing request leases.
    this.#reconcileAll();
  }

  /** Live peer identities (for retirement/exit bookkeeping). */
  peers(): readonly { readonly worker_instance_id: string; readonly boot_nonce: string }[] {
    return [...this.#peers.values()].map(record => Object.freeze({
      worker_instance_id: record.workerInstanceId, boot_nonce: record.bootNonce,
    }));
  }

  /**
   * Trusted physical-exit proof only. Releases the peer's outbound barriers,
   * revokes its proxy endpoints and drops its remote callers. Never called for a
   * socket close, which only detaches the transport.
   */
  async confirmPeerStopped(identity: { readonly worker_instance_id: string; readonly boot_nonce?: string }): Promise<void> {
    const record = this.#find(identity);
    if (record === undefined) return;
    record.stopped = true;
    const unsubscribeExit = record.unsubscribeExit;
    record.unsubscribeExit = null;
    if (unsubscribeExit !== null) { try { unsubscribeExit(); } catch { /* host-owned */ } }
    for (const key of [...record.routes.keys()]) this.#revokeRoute(record, key);
    try { record.link.confirmRemoteStopped(); } catch { /* host-owned proof */ }
    const callers = [...record.callers.values()];
    record.callers.clear();
    for (const caller of callers) { try { await caller.dispose(); } catch { /* bounded drain */ } }
    this.#peers.delete(record.ownerKey);
    this.#reconcileAll();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#directoryLoop.stop();
    this.#pending.clear();
    for (const record of [...this.#peers.values()]) {
      // Disposal is NOT physical-exit evidence. Keep the exact link and its
      // accepted-task barriers until the physical process really terminates.
      this.retirePeer({ worker_instance_id: record.workerInstanceId, boot_nonce: record.bootNonce });
    }
    try { await this.websocket.stop(); } catch { /* the listener's bounded stop owns the forced path */ }
  }
}

/* -------------------------------------------------------------------------- */
/* Worker process                                                              */
/* -------------------------------------------------------------------------- */

export interface WorkerPeerBrokerOptions {
  readonly services: PluginPeerServiceHost;
  /** This worker's real supervision credential; never a plugin-supplied value. */
  readonly credential: SupervisionProcessCredential;
  readonly masterGeneration: string;
  readonly workerInstanceId: string;
  readonly bootNonce: string;
  readonly workerSlot: number;
  readonly masterControlPort: () => number;
  /** Plugin catalog hash of the applied start command; `null` before it is known. */
  readonly catalog: () => string | null;
  readonly authority: () => PluginPeerAuthority | null;
  readonly subscribeAuthority?: (listener: () => void) => () => void;
  /**
   * Plugins activated by the applied start command of the *control* peer, when
   * known. Inbound callers are additionally required to be activated here; when
   * omitted only the declared consumption is checked (never a control-side
   * guess about what the worker runs).
   */
  readonly activatedPlugins?: () => readonly string[];
  readonly connect?: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
  readonly limits?: PluginPeerClientSocketOptions;
  /** Bounded autonomous reconnect policy for a plain socket close. */
  readonly reconnect?: {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly schedule?: (delayMs: number, run: () => void) => { cancel: () => void };
  };
}

/** Bounded, cancelable wait for the authenticated transport. */
export interface WorkerPeerReadyOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
}

export class WorkerPeerBrokerError extends Error {
  readonly name = 'WorkerPeerBrokerError';
  constructor(readonly code: 'not_ready' | 'retired' | 'disposed' | 'cancelled', message: string) {
    super(message);
  }
}

type WorkerRoute = {
  readonly provider: string;
  readonly service: string;
  readonly major: number;
  readonly scopeKey: string;
  readonly contract: RouteContract;
  handle: RpcEndpointHandle | null;
};

/** Bun/undici style WebSocket factory; kept behind one cast because DOM typings omit it. */
function defaultPeerSocket(url: string, headers: Readonly<Record<string, string>>): WebSocket {
  const Factory = WebSocket as unknown as new (target: string, options: { headers: Readonly<Record<string, string>> }) => WebSocket;
  return new Factory(url, { headers });
}

export class WorkerPeerBroker {
  readonly #options: WorkerPeerBrokerOptions;
  /** Host communication lane hub (event/snapshot/stream) over the worker link. */
  readonly channels: PluginPeerChannelHub;
  readonly #routes = new Map<string, WorkerRoute>();
  #link: PluginPeerRpcLink | null = null;
  #authorityKey: string | null = null;
  #facts: PluginPeerKernelFacts | null = null;
  #binding: PluginPeerClientSocketBinding | null = null;
  #callers: Map<string, HostRpcRemoteCallerHandle> = new Map();
  #unsubscribe: (() => void) | null = null;
  /**
   * Links whose control authority has been replaced. They keep every pending
   * task and its real terminal barrier (nothing is faked); the transport is
   * detached, and the link is only released once it has nothing pending.
   */
  #supersededLinks: PluginPeerRpcLink[] = [];
  /**
   * The control process's REAL publication directory, learned over the peer
   * link. Routes are only ever registered from a ready entry here.
   */
  #directory = new Map<string, PeerDirectoryEntry>();
  #directoryRevision: string | null = null;
  #directoryLoaded = false;
  readonly #directoryLoop: DirectoryRefreshLoop;
  readonly #executorLoop: DirectoryRefreshLoop;
  readonly #executorProofs = new Map<PluginPeerRpcLink, PluginExecutorProof>();
  #started = false;
  #disposed = false;
  #retired = false;
  #upgradeSequence = 0;
  #reconnectAttempts = 0;
  #reconnectTimer: { cancel: () => void } | null = null;
  /** True while an intentional close/rebind is in progress, so it never counts as a fault. */
  #closingIntentionally = false;

  constructor(options: WorkerPeerBrokerOptions) {
    this.#options = options;
    this.#directoryLoop = new DirectoryRefreshLoop(() => this.#loadDirectory(), 1_000);
    // Runs through retirement: a drain may be waiting on exactly this dead executor.
    this.#executorLoop = new DirectoryRefreshLoop(() => this.#verifyExecutors(), 1_000);
    this.channels = new PluginPeerChannelHub({
      process: 'worker',
      peerProcess: 'control',
      resolveRoute: (target, lane) => this.#resolveChannelRoute(target, lane),
      authorizeInbound: (request) => this.#authorizeChannelInbound(request),
      beginProviderOperation: (plugin, context) => this.#channelProviderLease?.(plugin, context) ?? null,
    });
  }

  #channelProviderLease: ((plugin: string, context: PluginChannelProviderContext) => (() => void) | null) | null = null;

  /** Host-only: the exact provider-side Host lease factory (wired by the worker entry). */
  setChannelProviderLease(resolver: (plugin: string, context: PluginChannelProviderContext) => (() => void) | null): void {
    this.#channelProviderLease = resolver;
  }

  /** The control peer is the only remote channel target of a worker process. */
  #resolveChannelRoute(target: PluginChannelTarget, lane: PluginChannelLane): PluginChannelRouteResolution {
    void target; void lane;
    const link = this.#binding?.attached === true ? this.#link : null;
    return link === null ? { kind: 'unavailable' } : { kind: 'remote', link };
  }

  /** Channel admission for a control-process consumer against its declared lane consumption. */
  #authorizeChannelInbound(input: {
    readonly lane: PluginChannelLane;
    readonly target: PluginChannelTarget;
    readonly caller: string;
    readonly callerScope: string;
    readonly providerProcess: PluginServiceProcess;
    readonly local: boolean;
    readonly link: PluginChannelLinkPort | null;
    readonly continuation: boolean;
  }): boolean {
    if (this.#disposed) return false;
    // A draining worker refuses NEW channel work but keeps every accepted
    // transfer/subscription/session continuation (finish/ACK/chunk/release).
    if (this.#retired && !input.continuation) return false;
    if (input.local) {
      // Same-process channel call inside the worker: the provider is in this
      // process and the caller must still declare the exact lane consumption.
      if (input.providerProcess !== 'worker') return false;
      return declaresChannelConsumption(this.#options.services.serviceDeclarations().get(input.caller), 'worker', input.lane, input.target, input.callerScope, input.providerProcess, input.caller);
    }
    if (input.providerProcess !== 'worker' || input.link === null) return false;
    // A superseded link drains accepted work but admits no new channel request.
    if (this.#link !== input.link) return false;
    const activated = this.#options.activatedPlugins?.();
    if (activated !== undefined && !activated.includes(input.caller)) return false;
    return declaresChannelConsumption(this.#options.services.serviceDeclarations().get(input.caller), 'control', input.lane, input.target, input.callerScope, input.providerProcess, input.caller);
  }

  get status(): { readonly attached: boolean; readonly authority: string | null; readonly retired: boolean; readonly reconnectAttempts: number } {
    return Object.freeze({
      attached: this.#binding?.attached ?? false,
      authority: this.#authorityKey,
      retired: this.#retired,
      reconnectAttempts: this.#reconnectAttempts,
    });
  }

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    this.#executorLoop.start();
    if (this.#options.subscribeAuthority !== undefined) {
      this.#unsubscribe = this.#options.subscribeAuthority(() => this.#reconcile());
    }
    this.#reconcile();
  }

  /**
   * Re-evaluates the link from the current authority/catalog facts. Called when
   * a fact that became available after the first attempt changes (for example
   * the applied start target).
   */
  refresh(): void {
    if (this.#disposed) return;
    this.#reconcile();
  }

  /**
   * Retires admission without touching accepted work: no new inbound
   * bootstrap/background call is admitted, while existing request settlement
   * routes, leases and terminal barriers are preserved. Wired by the
   * worker's real drain admission point.
   */
  retire(): void {
    if (this.#disposed || this.#retired) return;
    this.#retired = true;
    this.#directoryLoop.stop();
    // Owner admission rejects new work; existing request RPCs still settle.

  }

  /**
   * This worker's own kernel facts, used as the reserved directory query's
   * telemetry; `null` until the applied start target is known.
   */
  #selfFacts(): PluginPeerKernelFacts | null {
    const catalog = this.#options.catalog();
    const authority = this.#options.authority();
    if (catalog === null || authority === null) return null;
    return Object.freeze({
      process: 'worker' as const, instance: this.#options.workerInstanceId,
      generation: Math.max(1, authority.controller_epoch), catalog,
    });
  }

  /**
   * Learns control's real publication directory over the authenticated link and
   * re-materializes routes when it changed. A failed/unreadable load keeps the
   * previous snapshot (never a guess), and a reconnect simply reloads — it never
   * retries an already-issued CALL.
   */
  async #loadDirectory(): Promise<void> {
    if (this.#disposed || this.#retired) return;
    const link = this.#link;
    const facts = this.#selfFacts();
    if (link === null || facts === null) return;
    if (this.#binding === null || !this.#binding.attached) return;
    if (!this.#executorProofs.has(link)) {
      const metadata = directoryQueryMetadata(facts, EXECUTOR_PROOF_METHOD);
      const call = link.request(metadata, encodePeerRpcJsonBody(null), { deadlineAt: Date.now() + PLUGIN_PEER_DIRECTORY_DEADLINE_MS });
      void call.terminal.catch(() => undefined);
      try {
        const result = decodePeerRpcResultBody(await call.result);
        const proof = result.ok ? decodePluginExecutorProof(result.value) : null;
        const expected = this.#facts;
        // The authenticated response belongs to this exact link lifetime. A later
        // directory/proof must never authorize release of another controller's calls.
        if (proof !== null && this.#link === link && expected !== null
          && proof.source.instance === expected.instance && proof.source.generation === expected.generation
          && proof.source.catalog === expected.catalog) this.#executorProofs.set(link, proof);
      } catch { /* Missing or corrupt identity is not exit evidence. */ }
    }
    const entries = await loadPeerDirectory(link, facts);
    if (entries === null || this.#disposed || this.#link !== link) return;
    const revision = directoryRevision(entries);
    if (this.#directoryRevision === revision) { this.#directoryLoaded = true; return; }
    const next = new Map<string, PeerDirectoryEntry>();
    for (const entry of entries) next.set(routeKey(entry.provider, entry.service, entry.major, entry.scopeKey), entry);
    this.#directory = next;
    this.#directoryRevision = revision;
    this.#directoryLoaded = true;
    this.#materialize();
  }

  /**
   * Real, bounded, cancelable wait until control's directory has actually been
   * loaded over the authenticated transport. Bootstrap awaits this instead of a
   * socket that merely opened.
   */
  async waitUntilDirectoryLoaded(options: WorkerPeerReadyOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollMs = options.pollMs ?? 10;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WorkerPeerBrokerError('not_ready', 'peer directory wait timeout is invalid');
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#disposed) throw new WorkerPeerBrokerError('disposed', 'peer broker is disposed');
      if (this.#retired) throw new WorkerPeerBrokerError('retired', 'peer broker is retired');
      const attached = this.#binding?.attached === true;
      if (attached) this.#directoryLoop.start();
      if (attached && this.#directoryLoaded) return;
      if (signal?.aborted === true) throw new WorkerPeerBrokerError('cancelled', 'peer directory wait was cancelled');
      if (Date.now() >= deadline) throw new WorkerPeerBrokerError('not_ready', 'peer directory did not become ready');
      // The load completes from the event loop, so the wait yields.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve(); else reject(error);
        };
        const timer = setTimeout(() => finish(), pollMs);
        timer.unref?.();
        const onAbort = () => finish(new WorkerPeerBrokerError('cancelled', 'peer directory wait was cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /**
   * Detaches the current transport without claiming any remote task ended.
   * In-flight tasks keep their terminal barrier; a plain close schedules the
   * bounded reconnect loop instead of destroying the link.
   */
  disconnectTransport(): void {
    const binding = this.#binding;
    if (binding !== null) {
      this.#closingIntentionally = true;
      try { binding.close(); } catch { /* socket already gone */ } finally { this.#closingIntentionally = false; }
    }
  }

  /**
   * Bounded, cancelable wait for the REAL authenticated transport: the
   * production entry awaits this before initializing plugins, instead of hoping
   * that a scan delay made the socket ready.
   */
  async waitUntilReady(options: WorkerPeerReadyOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const pollMs = options.pollMs ?? 10;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new WorkerPeerBrokerError('not_ready', 'peer wait timeout is invalid');
    const signal = options.signal;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.#disposed) throw new WorkerPeerBrokerError('disposed', 'peer broker is disposed');
      if (this.#retired) throw new WorkerPeerBrokerError('retired', 'peer broker is retired');
      if (this.#binding?.attached === true) return;
      if (signal?.aborted === true) throw new WorkerPeerBrokerError('cancelled', 'peer wait was cancelled');
      if (Date.now() >= deadline) throw new WorkerPeerBrokerError('not_ready', 'peer transport did not become ready');
      // The socket attaches from the event loop, so the wait yields.
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error === undefined) resolve(); else reject(error);
        };
        const timer = setTimeout(() => finish(), pollMs);
        timer.unref?.();
        const onAbort = () => finish(new WorkerPeerBrokerError('cancelled', 'peer wait was cancelled'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  /** Host placement authority: a registered control endpoint for a global RPC target. */
  readonly placementResolver = (request: HostRpcPlacementRequest): HostRpcPlacementResolution => {
    if (request.scope !== 'global' || (this.#retired && request.purpose !== undefined && request.purpose !== 'attempt' && request.purpose !== 'request')) return null;
    const route = this.#routes.get(routeKey(request.provider, request.service, request.major, 'global'));
    return route?.handle ? { kind: 'endpoint', endpoint: route.handle } : null;
  };

  /** Registers the native proxy for one declared control-process consumption. */
  readonly ensureRemoteRoute = (input: {
    readonly plugin: string;
    readonly scope: string;
    readonly provider: string;
    readonly contract: RouteContract;
  }): void => {
    if (this.#disposed) return;
    const declaration = (this.#options.services.serviceDeclarations().get(input.provider)?.provides ?? []).find(service =>
      service.id === input.contract.id && service.version === input.contract.version
      && (service.kind ?? 'local') === 'rpc' && service.process === 'control' && (service.scope ?? 'global') === 'global');
    if (declaration === undefined) return;
    const key = routeKey(input.provider, input.contract.id, input.contract.version, 'global');
    if (!this.#routes.has(key)) {
      this.#routes.set(key, {
        provider: input.provider, service: input.contract.id, major: input.contract.version, scopeKey: 'global',
        contract: input.contract, handle: null,
      });
    }
    this.#materialize();
  };

  #reconcile(): void {
    if (this.#disposed) return;
    const authority = this.#options.authority();
    const catalog = this.#options.catalog();
    const port = this.#options.masterControlPort();
    if (authority === null) {
      // Retirement already refuses new work. Keep its existing authenticated
      // transport for accepted-task terminals; never open an unleased connection.
      if (this.#retired) return;
      // No leased authority right now: PAUSE the transport only. The link and
      // every pending task/terminal barrier stay exactly as they are; nothing is
      // faked terminated and nothing is destroyed.
      this.disconnectTransport();
      this.#releaseSuperseded();
      return;
    }
    if (catalog === null || !Number.isSafeInteger(port) || port <= 0) {
      // A fact needed to address control is still missing: keep the link and
      // every pending task/terminal barrier, only detach the transport.
      this.disconnectTransport();
      return;
    }
    const authorityKey = `${authority.controller_epoch}:${authority.controller_id}`;
    if (this.#link !== null && this.#authorityKey === authorityKey) {
      // Same control instance: keep the link (its pending tasks and terminal
      // barriers stay intact) and only re-bind a transport that really closed.
      if (this.#binding === null || this.#binding.closed) this.#connect(this.#link, authority, port);
      this.#materialize();
      this.#releaseSuperseded();
      return;
    }
    // A draining worker may only reattach its existing same-authority link.
    // It never creates a new control lifetime during retirement.
    if (this.#retired) return;
    // Authority changed (or first start): the old link cannot address the new
    // control instance, but its accepted tasks are NOT terminated — it is
    // superseded, kept until it really has nothing pending, and then released.
    if (this.#link !== null) {
      const superseded = this.#link;
      this.#cancelReconnect();
      this.disconnectTransport();
      this.#supersededLinks.push(superseded);
      this.#link = null;
      this.#authorityKey = null;
      this.#facts = null;
      // A different control instance publishes its own directory: the previous
      // one is stale, so it is dropped and must be re-learned before any route
      // is considered ready again.
      this.#directory = new Map();
      this.#directoryRevision = null;
      this.#directoryLoaded = false;
      // The final `#materialize()` below runs against the NEW link with this
      // empty directory, so every stale route is revoked instead of keeping a
      // claim on the superseded transport.
    }
    const link = new PluginPeerRpcLink({
      credential: createPluginPeerCredential(this.#options.credential),
      authority,
      outgoingDirection: 'peer-to-control',
      onRequest: createPluginPeerRpcRequestHandler((metadata, request, call) =>
        INBOUND_FRAME.run({ ownerKey: 'control', metadata }, () => this.#dispatchInbound(metadata, request, call))),
    });
    const laneHandler = this.channels.handlerFor(link);
    for (const lane of CHANNEL_LANES) link.registerLaneHandler(lane, laneHandler);
    this.#link = link;
    this.#authorityKey = authorityKey;
    // A replacement controller gets its own bounded connection budget. Failed
    // dials to the dead executor must not prevent its successor's admission.
    this.#reconnectAttempts = 0;
    this.#facts = Object.freeze({
      process: 'control', instance: this.#options.masterGeneration,
      generation: Math.max(1, authority.controller_epoch), catalog,
    });
    this.#connect(link, authority, port);
    this.#materialize();
    this.#releaseSuperseded();
  }

  /** Superseded links are released only once they really have nothing pending. */
  #releaseSuperseded(): void {
    for (const link of [...this.#supersededLinks]) {
      let status: ReturnType<PluginPeerRpcLink['status']>;
      try { status = link.status(); } catch { continue; }
      if (status.outboundPending > 0 || status.inboundActive > 0) continue;
      this.#supersededLinks = this.#supersededLinks.filter(candidate => candidate !== link);
      this.#executorProofs.delete(link);
      try { link.dispose(); } catch { /* already released */ }
    }
  }

  /** Only a complete authenticated identity plus positive OS evidence releases barriers. */
  async #verifyExecutors(): Promise<void> {
    if (this.#disposed) return;
    if (this.#executorProofs.size === 0) { this.#releaseSuperseded(); return; }
    const boot = await readKernelBootId();
    for (const [link, proof] of [...this.#executorProofs]) {
      const state = proof.boot !== boot ? 'dead' : await probeProcessIdentity(proof.physical);
      if (this.#disposed || (state !== 'dead' && state !== 'mismatch')) continue;
      if (this.#executorProofs.get(link) !== proof) continue;
      link.confirmRemoteStopped();
      this.#executorProofs.delete(link);
    }
    this.#releaseSuperseded();
  }

  /**
   * Bounded autonomous reconnect for a plain socket close: the SAME link is
   * re-bound, so its sequence and pending records are never reset. The timer is
   * unref'd and always cancelable so no shutdown is held open by it.
   */
  #scheduleReconnect(): void {
    if (this.#disposed || this.#closingIntentionally) return;
    if (this.#reconnectTimer !== null) return;
    const policy = this.#options.reconnect;
    const maxAttempts = policy?.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) return;
    if (this.#reconnectAttempts >= maxAttempts) return;
    const baseDelayMs = policy?.baseDelayMs ?? 50;
    const maxDelayMs = policy?.maxDelayMs ?? 2_000;
    const delayMs = Math.min(Math.max(maxDelayMs, 1), Math.max(baseDelayMs, 1) * 2 ** this.#reconnectAttempts);
    this.#reconnectAttempts += 1;
    const run = () => { this.#reconnectTimer = null; this.#reconcile(); };
    if (policy?.schedule !== undefined) { this.#reconnectTimer = policy.schedule(delayMs, run); return; }
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    this.#reconnectTimer = { cancel: () => clearTimeout(timer) };
  }

  /** Opens one real client socket for an existing link and binds it to the link. */
  #connect(link: PluginPeerRpcLink, authority: PluginPeerAuthority, port: number): void {
    const identity: PluginPeerUpgradeIdentity = {
      master_generation: this.#options.masterGeneration,
      worker_instance_id: this.#options.workerInstanceId,
      worker_slot: this.#options.workerSlot,
      boot_nonce: this.#options.bootNonce,
      controller_epoch: authority.controller_epoch,
      controller_id: authority.controller_id,
    };
    const url = `ws://127.0.0.1:${port}${PLUGIN_PEER_WS_PATH}`;
    const headers = Object.freeze({
      [PLUGIN_PEER_IDENTITY_HEADER]: encodePluginPeerUpgradeIdentity(identity),
      [PLUGIN_PEER_PROOF_HEADER]: encodePluginPeerUpgradeProof(identity, this.#options.credential, ++this.#upgradeSequence),
    });
    this.#cancelReconnect();
    let socket: WebSocket;
    try {
      socket = this.#options.connect !== undefined ? this.#options.connect(url, headers) : defaultPeerSocket(url, headers);
    } catch {
      return;
    }
    let binding: PluginPeerClientSocketBinding;
    try {
      binding = bindPluginPeerClientSocket(link, socket, this.#options.limits ?? {});
    } catch {
      try { socket.close(); } catch { /* socket already gone */ }
      this.#scheduleReconnect();
      return;
    }
    this.#binding = binding;
    const onOpen = () => {
      if (this.#binding !== binding) return;
      this.#reconnectAttempts = 0;
      // A fresh/reconnected transport reloads control's real directory (a read,
      // never a retry of an already-issued CALL).
      if (!this.#retired) {
        this.#directoryLoop.start();
        void this.#loadDirectory();
      }
    };
    const onClose = () => {
      // Only the transport that currently owns the link may trigger a rebind.
      if (this.#binding !== binding) return;
      this.#binding = null;
      this.#scheduleReconnect();
    };
    try {
      socket.addEventListener('open', onOpen);
      socket.addEventListener('close', onClose);
    } catch { /* a hostile socket without addEventListener never got this far */ }
  }

  #cancelReconnect(): void {
    const timer = this.#reconnectTimer;
    this.#reconnectTimer = null;
    if (timer !== null) { try { timer.cancel(); } catch { /* already fired */ } }
  }

  /**
   * Inbound caller of one control-process plugin that consumes worker-provided
   * services. Created on demand: the declaration graph is only complete once the
   * plugin runtime applied its configuration, which is after the link exists.
   */
  #callerFor(consumerPlugin: string): HostRpcRemoteCallerHandle | null {
    const existing = this.#callers.get(consumerPlugin);
    if (existing !== undefined) return existing;
    const facts = this.#facts;
    const adapter = this.#options.services.rpc;
    if (facts === null || adapter === undefined) return null;
    const consumes = peerConsumptions(this.#options.services.serviceDeclarations().get(consumerPlugin), 'control');
    if (consumes.length === 0) return null;
    try {
      const handle = remoteCallerFor(adapter, {
        consumerPlugin, callerProcess: 'control', facts, consumes,
        authorize: (request, endpoint) => {
          const frame = INBOUND_FRAME.getStore();
          if (frame === undefined || frame.ownerKey !== 'control') return false;
          if (this.#disposed || this.#retired) return false;
          // Compare the peer's claim with the endpoint the kernel ACTUALLY
          // selected: provider, contract and the complete binding.
          if (endpoint.provider !== request.target.provider) return false;
          if (endpoint.contract.id !== request.target.service) return false;
          if (endpoint.contract.version !== request.target.major) return false;
          return sameBinding(endpoint.binding, frame.metadata.binding);
        },
        leaseFor: () => {
          if (this.#disposed) throw new RpcServiceError('revoked');
          return { release: () => undefined };
        },
      });
      this.#callers.set(consumerPlugin, handle);
      return handle;
    } catch { return null; }
  }

  #dispatchInbound(
    metadata: PeerRpcCallMetadata,
    request: PluginPeerRpcNativeRequest,
    _call: unknown,
  ): RpcProxyExecution | null {
    // A draining worker admits no new bootstrap/background work; accepted tasks
    // keep their leases and terminals.
    if (this.#disposed || this.#retired) return null;
    if (!PEER_PURPOSES.includes(metadata.purpose)) return null;
    // Host-private read of this worker's own publication directory (the control
    // side learns which worker services really exist and are ready). Muxed
    // before any plugin path; returns metadata only, never a handle.
    if (isHostDirectoryQuery(metadata)) {
      return directoryExecution(this.#options.services, 'worker', request.input);
    }
    if (isHostChannelDirectoryQuery(metadata)) {
      return channelDirectoryExecution(this.channels, request.input);
    }
    if (!bindingIs(metadata, 'worker')) return null;
    if (isReservedHostName(metadata.target.provider) || isReservedHostName(metadata.caller.subject)) return null;
    if (metadata.caller.subject.includes('@')) return null;
    const declarations = this.#options.services.serviceDeclarations().get(metadata.caller.subject);
    if (declarations === undefined) return null;
    if (!declaresPeerConsumption(declarations, 'control', metadata)) return null;
    // When the applied control activation set is known, the caller must really
    // be activated there; the exact callee binding is verified against the
    // kernel-selected endpoint inside the remote caller's authorizeIncoming.
    const activated = this.#options.activatedPlugins?.();
    if (activated !== undefined && !activated.includes(metadata.caller.subject)) return null;
    const caller = this.#callerFor(metadata.caller.subject);
    if (caller === null) return null;
    try {
      const tracked = caller.invokeTracked(request);
      return Object.freeze({ result: tracked.result, terminal: tracked.terminal });
    } catch {
      return null;
    }
  }

  /**
   * (Re)registers every declared control route strictly from the learned real
   * publication metadata. A target that is absent or not ready stays NOT READY
   * (no route), and a route whose real binding changed is re-registered instead
   * of keeping a stale claim.
   */
  #materialize(): void {
    if (this.#disposed || this.#retired) return;
    const link = this.#link;
    const runtime = this.#options.services.rpc?.runtime;
    if (link === null || runtime === undefined) return;
    for (const route of this.#routes.values()) {
      const key = routeKey(route.provider, route.service, route.major, 'global');
      const entry = this.#directory.get(key);
      const ready = entry !== undefined && entry.ready && entry.scope === 'global'
        && entry.provider === route.provider && entry.service === route.service && entry.major === route.major;
      if (!ready) {
        if (route.handle !== null) {
          try { runtime.revoke(route.handle); } catch { /* host-owned */ }
          route.handle = null;
        }
        continue;
      }
      if (route.handle !== null) {
        const current = runtime.endpointInfo(route.handle);
        if (current !== null && sameBinding(current.binding, entry.binding)) continue;
        // The remote published a different endpoint: re-register from the fresh
        // metadata; an old binding is never kept to bypass validation.
        try { runtime.revoke(route.handle); } catch { /* host-owned */ }
        route.handle = null;
      }
      try {
        const handle = runtime.registerProxy({
          provider: route.provider,
          binding: entry.binding,
          contract: route.contract,
          execute: createPluginPeerRpcProxy(route.provider, link, (context, callee) => {
            if (context.purpose !== 'attempt' && context.purpose !== 'request') return null;
            return readHostRpcCalleeFrame(callee) as RpcJson;
          }),
        });
        runtime.markReady(handle);
        route.handle = handle;
      } catch { /* a refused registration stays unavailable; never guessed */ }
    }
  }

  #teardownLink(): void {
    const binding = this.#binding;
    this.#binding = null;
    if (binding !== null) { try { binding.close(); } catch { /* socket already gone */ } }
    const link = this.#link;
    this.#link = null;
    this.#authorityKey = null;
    this.#facts = null;
    const runtime = this.#options.services.rpc?.runtime;
    for (const route of this.#routes.values()) {
      if (route.handle === null) continue;
      runtime?.revoke(route.handle);
      route.handle = null;
    }
    const callers = this.#callers;
    this.#callers = new Map();
    for (const caller of callers.values()) void caller.dispose().catch(() => undefined);
    if (link !== null) { try { link.dispose(); } catch { /* link already released */ } }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#cancelReconnect();
    this.#directoryLoop.stop();
    this.#executorLoop.stop();
    this.#executorProofs.clear();
    // Process shutdown is a real local end of the channel: every pending call is
    // settled with the link's own honest 'closed' terminal (never a faked
    // remote death), and superseded links are released in order.
    for (const link of this.#supersededLinks) { try { link.dispose(); } catch { /* already released */ } }
    this.#supersededLinks = [];
    this.#teardownLink();
    this.#routes.clear();
  }
}
