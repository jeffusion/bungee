import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregate, Sha256Digest } from '@jeffusion/bungee-types';
import type { ActiveConfigurationPublication, CommitConfigurationResult, ConfigurationOperationState,
  ConfigurationResult, RepositorySnapshot } from '../config-storage';
import { ConfigRepositoryError } from '../config-storage';
import { validateMutationId } from '../config-storage/repository-validation';
import { hashConfigurationContent } from '../config-storage/content-hash';
import { parseNormalizeCompileAggregate } from '../config-storage/aggregate';
import { isPluginName } from '../config-storage/plugin-name';
import type { ServingConfigWorker } from '../config-publication';
import { readControlJson } from './control-api-body';
import { type ManagementAuthentication, type ManagementTransition } from './management-auth';
import type { ManagementSubject } from '../plugin-extensions';
import type { PublicationTaskLifecycle } from './publication-task-manager';
import { logger } from '../logger';
import { serializeErrorChain } from './error-chain';
import { isLowercaseUuid } from '../config-storage/validation';
import { buildRouteBodyPlans } from './route-body-plan';
import { publicationCleanup, runtimeHealthSnapshot, type ConfigControlRuntimeHealth } from './runtime-status';
export type { ConfigControlRuntimeHealth } from './runtime-status';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const PUT_FIELDS = new Set(['expected_revision', 'aggregate', 'mutation_id', 'kind', 'managementSetup']);
const VALIDATE_FIELDS = new Set(['aggregate', 'envelope']);
const EXPORT_FORMAT = 'bungee-config-snapshot';
const EXPORT_FORMAT_VERSION = 1;
const EXPORT_SCHEMA_VERSION = 1;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ConfigControlRepository {
  getSnapshot(): RepositorySnapshot;
  refreshControlProjection?(): Promise<import('../config-storage').ControlProjection>;
  getActivePublication(): Promise<ActiveConfigurationPublication | null>;
  getCurrentRecovery?(): Promise<import('../config-storage').ConfigurationRecovery | null>;
  getRecovery?(recoveryId: string): Promise<import('../config-storage').ConfigurationRecovery | null>;
  getCurrentOperationState?(): Promise<ConfigurationOperationState | null>;
  getPublicationRetirement?(mutationId: string): Promise<import('../config-storage/retirement-store').PublicationRetirement | null>;
  getPublicationRetirementRetry?(requestId:string):Promise<import('../config-storage/retirement-store').PublicationRetirementRetry|null>;
  getOperationState(mutationId: string): Promise<ConfigurationOperationState | null>;
  commit(command: {
    readonly mutation_id: string; readonly expected_revision: number;
    readonly aggregate: ConfigurationAggregate; readonly kind: 'config' | 'admin_state';
    readonly created_at: number; readonly target_worker_slots: readonly number[];
  }): Promise<CommitConfigurationResult>;
}

export type ConfigControlApiOptions = {
  readonly updates?: { handle(request: Request): Promise<Response> };
  readonly managementProviderMetadata?: (name:string) => {name:string;loginComponent?:string;setupComponent?:string};
  readonly managementAuth?: ManagementAuthentication;
  readonly resourceCollection?: () => Promise<readonly unknown[]>;
  readonly resourceExtensions?: (keyId: string) => Promise<readonly unknown[]>;
  readonly guardDataTransition?: (active: ConfigurationAggregate, next: ConfigurationAggregate) => Promise<Response | null>;
  readonly guardManagementTransition?: (request: Request, active: ConfigurationAggregate, next: ConfigurationAggregate, setup?: unknown) => Promise<Response | null>;
  readonly validateManagementTransition?: (request: Request, active: ConfigurationAggregate, next: ConfigurationAggregate) => Promise<Response | null>;
  readonly pluginCapability?: (request: Request) => string | null;
  readonly pluginDependencies?: import('../plugin-dependencies').PluginDependencyGraph;
  readonly repository: ConfigControlRepository;
  readonly admission: { snapshot(): readonly ServingConfigWorker[] };
  readonly workerCount: number;
  readonly clock: { now(): number };
  readonly resolveAuthToken: (tokenExpression: string) => unknown;
  readonly parseAggregate: (value: unknown) => ConfigurationResult<ConfigurationAggregate>;
  readonly publicationTasks: Pick<PublicationTaskLifecycle, 'enqueue'>;
  readonly pluginControlApi?: { handle(request: Request, subject?: ManagementSubject): Promise<Response | null> };
  readonly pluginControlPreflight?: {
    readonly controlNames: ReadonlySet<string>;
    readonly status?: (name: string) => string;
    activate(name: string): Promise<unknown>;
    deactivate(name: string): Promise<void>;
  };
  readonly isMutationReady: () => boolean | ConfigControlMutationReadiness;
  readonly runtimeUpstreams?: () => Promise<Response>;
  readonly pluginCatalogApi?: {
    matches(path: string): boolean;
    handle(request: Request, snapshot: RepositorySnapshot): Promise<Response>;
  };
  readonly menuApi?: import('./menu-api').MenuApi;
  readonly statsApi?: {
    matches(path: string): boolean;
    handle(request: Request): Promise<Response>;
  };
  /** Master-owned logs/observability handler; kept separate for staged composition. */
  readonly observabilityApi?: {
    matches(path: string): boolean;
    handle(request: Request): Promise<Response>;
  };
  /** Keep Master-owned logging retention in sync with the committed snapshot. */
  readonly onConfigurationCommitted?: (snapshot: RepositorySnapshot) => Promise<void>;
  readonly mutationSettlement?: { pending: PendingCommit | null; readonly ownedRequests: WeakSet<Request> };
  readonly serializeMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly requestManualRecovery?: (
    recoveryId: string, sourceMutationId: string, expectedRevision: number,
  ) => Promise<import('../config-storage').ConfigurationRecovery>;
  readonly isRecoveryReady?: () => boolean;
  readonly isCleanupRecoveryReady?: () => boolean;
  readonly requestCleanupRecovery?: (requestId:string,mutationId:string,revision:number)=>Promise<import('../config-storage/retirement-store').PublicationRetirementRetry>;
  readonly runtimePublicationEvidence?: () => {
    readonly serving_complete: boolean;
    readonly serving_revision: number | null;
  };
  readonly runtimeHealth?: () => ConfigControlRuntimeHealth | Promise<ConfigControlRuntimeHealth>;
  readonly retirementDeadline?: (bootId: string, deadlineNs: string) => number | null;
};

export interface ConfigControlApi {
  handle(request: Request): Promise<Response | null>;
}

export type ConfigControlMutationReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string };

class RepositoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super('repository unavailable', { cause });
    this.name = 'RepositoryUnavailableError';
  }
}

async function repositoryCall<T>(operation: () => Promise<T> | T): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new RepositoryUnavailableError(error); }
}

function repositoryUnavailable(): Response {
  return json({ error: 'repository_unavailable' }, 503);
}

function safeSnapshot(options: ConfigControlApiOptions): RepositorySnapshot | Response {
  try { return options.repository.getSnapshot(); }
  catch { return repositoryUnavailable(); }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404);
}

function snapshotBody(snapshot: RepositorySnapshot): object {
  return { config: snapshot.aggregate, revision: snapshot.revision, content_hash: snapshot.content_hash };
}

function matchesCurrentAuth(
  request: Request,
  snapshot: RepositorySnapshot,
  options: ConfigControlApiOptions,
): boolean {
  return options.managementAuth?.identity(request) !== null && options.managementAuth?.identity(request) !== undefined;
}

async function login(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  const auth = options.managementAuth;
  if (!auth) return json({ success: false, error: 'management_uninitialized' }, 503);
  try {
    const expectedProvider = request.headers.get('x-bungee-auth-provider');
    if (expectedProvider !== null && !isPluginName(expectedProvider)) {
      return json({ success: false, error: 'invalid_authentication_provider' }, 400);
    }
    const selected = auth.selected(), current = auth.capture();
    if (expectedProvider !== null && expectedProvider !== selected) {
      return json({ success: false, error: 'authentication_provider_changed' }, 409);
    }
    const provider = auth.provider();
    if (selected !== null && !provider) return json({ success: false, error: 'management_provider_unavailable' }, 503);
    if (provider) {
      const response = await provider.login(request);
      const body = await response.json() as Record<string, unknown>;
      if (!current() || auth.selected() !== selected || auth.provider() !== provider) {
        return json({ success: false, error: 'authentication_provider_changed' }, 409);
      }
      return Response.json({ ...body, success: response.ok, mode: 'plugin' }, { status: response.status, headers: response.headers });
    }
    return json({ success: true, mode: 'anonymous' });
  } catch { return json({ success: false, error: 'management_provider_unavailable' }, 503); }
}

type LoginInteraction = 'loginOptions' | 'beginLogin' | 'completeLogin';

function loginInteraction(path: string): LoginInteraction | null {
  if (path === '/api/auth/login/options') return 'loginOptions';
  if (path === '/api/auth/login/start') return 'beginLogin';
  const callback = /^\/api\/auth\/login\/callback\/([^/]+)$/.exec(path);
  const method = decodePathSegment(callback?.[1]);
  return method && !/[\/\\]/.test(method) ? 'completeLogin' : null;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers});
}

async function handleLoginInteraction(
  request: Request, interaction: LoginInteraction, options: ConfigControlApiOptions,
  evidence: WeakMap<Request, () => boolean>,
): Promise<Response> {
  const method = interaction === 'beginLogin' ? 'POST' : 'GET';
  if (request.method !== method) return methodNotAllowed(method);
  if (interaction !== 'completeLogin' && new URL(request.url).search) return json({error:'invalid_request'},400);
  const snapshot = safeSnapshot(options);
  if (snapshot instanceof Response) return snapshot;
  const auth = options.managementAuth;
  if (!auth) return json({error:'management_uninitialized'},503);
  try {
    const selected = auth.selected();
    if (selected === null) return notFound();
    const current = auth.capture(), provider = auth.provider();
    if (!provider) return json({error:'management_provider_unavailable'},503);
    if (interaction === 'beginLogin') {
      if (request.headers.get('origin') !== auth.publicOrigin(request)) return json({error:'invalid_origin'},403);
      if (request.headers.get('x-bungee-auth-provider') !== selected) return json({error:'authentication_provider_changed'},409);
    }
    const handler = provider[interaction];
    if (!handler) return json({error:'login_interaction_not_supported'},501);
    evidence.set(request, current);
    const response = await handler.call(provider, request);
    // Do not publish cookies or redirects created by a retired selection.
    if (!current() || auth.selected() !== selected || auth.provider() !== provider) {
      return json({error:'authentication_provider_changed'},409);
    }
    return response;
  } catch { return json({error:'management_provider_unavailable'},503); }
}

async function verify(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  const auth = options.managementAuth;
  if (!auth) return json({ success: false, error: 'management_uninitialized' }, 503);
  try {
    const mode = auth.selected() === null ? 'anonymous' : 'plugin';
    const identity = await auth.authenticate(request);
    const sessionCookie = await identity?.provider?.sessionCookie?.(request);
    if (identity && (auth.identity(request) !== identity || !await auth.authorized(request,'config.read'))) return json({success:false,error:'authentication_provider_changed'},409);
    return identity ? Response.json({ success: true, mode, subject: identity.subject, capabilities: identity.subject.capabilities,
      ...(identity.provider?.csrfToken?.(request) ? { csrfToken: identity.provider.csrfToken(request) } : {}) },
      {status: 200, headers: {...JSON_HEADERS, ...(sessionCookie ? {'set-cookie': sessionCookie} : {})}})
      : json({ success: false, mode }, request.headers.has('authorization') || request.headers.has('cookie') ? 401 : 200);
  } catch { return json({ success: false, error: 'management_provider_unavailable' }, 503); }
}

async function setup(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  if (!['GET','POST'].includes(request.method)) return methodNotAllowed('GET, POST');
  if (new URL(request.url).search) return json({error:'invalid_request'},400);
  const auth = options.managementAuth;
  if (!auth) return json({error:'management_uninitialized'},503);
  try {
    const name = auth.selected(), current = auth.capture();
    if (!name) return notFound();
    const provider = auth.provider();
    if (!provider) return json({error:'management_provider_unavailable'},503);
    if (request.method === 'GET') {
      const status = await auth.setupStatus();
      return json({initialized:status === 'ready',provider:options.managementProviderMetadata?.(name) ?? {name}});
    }
    if (request.headers.get('origin') !== auth.publicOrigin(request)) return json({error:'invalid_origin'},403);
    if (request.headers.get('x-bungee-auth-provider') !== name) return json({error:'authentication_provider_changed'},409);
    const response = await provider.initialize(request);
    if (!current() || auth.selected() !== name || auth.provider() !== provider) return json({error:'authentication_provider_changed'},409);
    return response;
  } catch { return json({error:'management_provider_unavailable'},503); }
}

function exactObject(value: unknown, fields: ReadonlySet<string>): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const object = value satisfies object;
  const entries = Object.entries(object);
  return entries.every(([key]) => fields.has(key)) ? Object.fromEntries(entries) : null;
}

function decodePathSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

function operationResponse(state: ConfigurationOperationState): Response {
  return json(state, state.operation.state === 'converged' ? 200 : 202);
}

function recoveryResponse(recovery: import('../config-storage').ConfigurationRecovery): Response {
  const body = { recovery_id: recovery.recovery_id, target_revision: recovery.target_revision,
    state: recovery.state, attempt_count: recovery.attempt_count, max_attempts: recovery.max_attempts,
    next_retry_at: recovery.next_retry_at, trigger: recovery.trigger };
  return recovery.state === 'succeeded' || recovery.state === 'stopped'
    ? json({ ...body, final_reason_code: recovery.final_reason_code }, 200)
    : json(body, 202);
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405, headers: { ...JSON_HEADERS, allow },
  });
}

function runtimeWorker(worker: ServingConfigWorker): object {
  const bootNonce = worker.boot_nonce ?? (worker.process as ServingConfigWorker['process'] & { readonly bootNonce?: string }).bootNonce;
  if (typeof bootNonce !== 'string') throw new Error('runtime worker boot nonce is unavailable');
  return { master_generation: worker.process.identity.master_generation,
    worker_instance_id: worker.process.identity.worker_instance_id, boot_nonce: bootNonce,
    slot: worker.process.identity.worker_slot, pid: worker.process.pid, private_port: worker.private_port,
    revision: worker.revision, content_hash: worker.content_hash,
    plugin_catalog_hash: worker.plugin_catalog_hash, publication: worker.publication };
}

async function validateRequest(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const envelope = exactObject(body.value, VALIDATE_FIELDS);
  if (envelope === null || Object.keys(envelope).length !== 1) return json({ error: 'invalid_request' }, 400);
  const parsed = 'envelope' in envelope ? prepareImport(envelope.envelope, options) : options.parseAggregate(envelope.aggregate);
  if (parsed instanceof Response) return parsed;
  if ('ok' in parsed && !parsed.ok) return json({valid:false,errors:parsed.errors});
  const aggregate = 'aggregate' in parsed ? parsed.aggregate : parsed.value;
  const current = safeSnapshot(options);
  if (current instanceof Response) return current;
  const transition = await options.guardManagementTransition?.(request, current.aggregate, aggregate)
    ?? await options.validateManagementTransition?.(request, current.aggregate, aggregate);
  if (transition) return transition;
  return json({valid:true,errors:[], ...('envelope' in envelope ? {aggregate} : {})});
}

async function acceptCommitted(
  mutationId: string,
  revision: number,
  options: ConfigControlApiOptions,
): Promise<Response> {
  const state = await repositoryCall(() => options.repository.getOperationState(mutationId));
  if (state === null) return json({ error: 'operation_not_found' }, 500);
  const active = await repositoryCall(() => options.repository.getActivePublication());
  if (active !== null && active.operation.mutation_id === mutationId) {
    const oldWorkers = options.admission.snapshot();
    options.publicationTasks.enqueue(active, oldWorkers);
  }
  return json({ operation_id: mutationId, revision, ...state }, 202);
}

async function mapCommit(
  result: Exclude<CommitConfigurationResult, { readonly kind: 'committed' }>,
  options: ConfigControlApiOptions,
  snapshot: RepositorySnapshot,
): Promise<Response> {
  switch (result.kind) {
    case 'duplicate': {
      const state = await repositoryCall(() => options.repository.getOperationState(result.operation.mutation_id));
      return state === null ? json({ error: 'operation_not_found' }, 500)
        : json({ operation_id: result.operation.mutation_id,
          revision: result.operation.committed_revision, ...state }, 202);
    }
    case 'stale_revision':
      return json({ error: 'stale_revision', expected_revision: result.expected_revision,
        active: snapshotBody(snapshot) }, 409);
    case 'idempotency_key_reused':
      return json({ error: 'idempotency_key_reused', mutation_id: result.mutation_id }, 409);
    case 'operation_in_progress': {
      return json({ error: 'operation_in_progress', operation_id: result.mutation_id,
        revision: result.committed_revision, state: result.state }, 409);
    }
    case 'recovery_in_progress':
      return json({ error: 'recovery_in_progress', recovery_id: result.recovery_id,
        target_revision: result.target_revision, state: result.state }, 409);
    default: {
      const unhandled: never = result;
      return json({ error: 'unhandled_commit_result', unhandled }, 500);
    }
  }
}

async function putConfig(
  request: Request, options: ConfigControlApiOptions,
): Promise<Response> {
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const envelope = exactObject(body.value, PUT_FIELDS);
  if (envelope === null || typeof envelope.expected_revision !== 'number'
    || !Number.isSafeInteger(envelope.expected_revision) || envelope.expected_revision <= 0
    || !('aggregate' in envelope)) return json({ error: 'invalid_request' }, 400);
  const expectedRevision = envelope.expected_revision;
  const mutationId = envelope.mutation_id === undefined ? randomUUID() : envelope.mutation_id;
  const kind = envelope.kind ?? 'config';
  if (typeof mutationId !== 'string' || !validateMutationId(mutationId)
    || (kind !== 'config' && kind !== 'admin_state')) return json({ error: 'invalid_request' }, 400);
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!await options.managementAuth?.recheck(request) || !matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const parsed = options.parseAggregate(envelope.aggregate);
    if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
    freezeJson(parsed.value);
    return commitConfigurationMutation(request, options, {
      active, next: parsed.value, kind, mutationId, expectedRevision, managementSetup: envelope.managementSetup,
    });
  });
}

type ConfigurationSnapshotEnvelope = {
  readonly format: 'bungee-config-snapshot';
  readonly format_version: 1;
  readonly schema_version: 1;
  readonly exported_at: number;
  readonly source_revision: number;
  readonly content_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregate;
  readonly envelope_hash: Sha256Digest;
};
type UntrustedConfigurationSnapshotEnvelope = Omit<ConfigurationSnapshotEnvelope, 'aggregate'> & {
  readonly aggregate: unknown;
};

const IMPORT_BODY_FIELDS = new Set([
  'format', 'format_version', 'schema_version', 'exported_at',
  'source_revision', 'content_hash', 'aggregate', 'envelope_hash',
]);
const IMPORT_WRAPPER_FIELDS = new Set(['expected_revision', 'mutation_id', 'envelope']);

function buildEnvelope(snapshot: RepositorySnapshot, exportedAt: number): Omit<ConfigurationSnapshotEnvelope, 'envelope_hash'> {
  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: exportedAt,
    source_revision: snapshot.revision,
    content_hash: snapshot.content_hash,
    aggregate: snapshot.aggregate,
  };
}

function exportConfig(snapshot: RepositorySnapshot, exportedAt: number): ConfigurationSnapshotEnvelope {
  const base = buildEnvelope(snapshot, exportedAt);
  return { ...base, envelope_hash: hashConfigurationContent(base) };
}

function isCanonicalSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function parseSnapshotEnvelope(value: unknown): UntrustedConfigurationSnapshotEnvelope | null {
  const envelope = exactObject(value, IMPORT_BODY_FIELDS);
  if (envelope === null
    || envelope.format !== EXPORT_FORMAT
    || envelope.format_version !== EXPORT_FORMAT_VERSION
    || envelope.schema_version !== EXPORT_SCHEMA_VERSION
    || typeof envelope.exported_at !== 'number'
    || !Number.isSafeInteger(envelope.exported_at)
    || envelope.exported_at < 0
    || typeof envelope.source_revision !== 'number'
    || !Number.isSafeInteger(envelope.source_revision)
    || envelope.source_revision <= 0
    || !isCanonicalSha256Digest(envelope.content_hash)
    || !isCanonicalSha256Digest(envelope.envelope_hash)
    || !('aggregate' in envelope)) return null;
  return {
    format: envelope.format,
    format_version: envelope.format_version,
    schema_version: envelope.schema_version,
    exported_at: envelope.exported_at,
    source_revision: envelope.source_revision,
    content_hash: envelope.content_hash,
    aggregate: envelope.aggregate,
    envelope_hash: envelope.envelope_hash,
  };
}

/** Preview and commit validate the same sealed current configuration. */
function prepareImport(value: unknown, options: ConfigControlApiOptions): Response | {
  aggregate: ConfigurationAggregate;
} {
  const envelope = parseSnapshotEnvelope(value);
  if (envelope === null) return json({ error: 'invalid_snapshot' }, 400);
  const { envelope_hash: envelopeHash, ...base } = envelope;
  if (envelopeHash !== hashConfigurationContent(base)
    || envelope.content_hash !== hashConfigurationContent(envelope.aggregate)) return json({ error: 'invalid_snapshot' }, 400);
  const exported = parseNormalizeCompileAggregate(envelope.aggregate);
  if (!exported.ok) return json({ error: 'invalid_configuration', errors: exported.errors }, 422);
  // Apply the installed catalog's dependency closure only after checking the sealed content.
  const parsed = options.parseAggregate(exported.value);
  if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
  return { aggregate: parsed.value };
}

const UPSTREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOGGLE_FIELDS = new Set(['enabled']);

function findUpstreamDisabled(aggregate: ConfigurationAggregate, upstreamId: string): boolean | null {
  for (const service of aggregate.logical_configuration.services) {
    const endpoint = service.endpoints.find((candidate) => candidate.id === upstreamId);
    if (endpoint !== undefined) return endpoint.is_disabled;
  }
  for (const route of aggregate.logical_configuration.routes) {
    if (!('endpoints' in route) || route.endpoints === undefined) continue;
    const endpoint = route.endpoints.find((candidate) => candidate.id === upstreamId);
    if (endpoint !== undefined) return endpoint.is_disabled;
  }
  return null;
}

function withUpstreamDisabledState(
  aggregate: ConfigurationAggregate,
  upstreamId: string,
  disabled: boolean,
): ConfigurationAggregate | null {
  let changed = false;
  const services = aggregate.logical_configuration.services.map((service) => {
    if (!service.endpoints.some((endpoint) => endpoint.id === upstreamId)) return service;
    changed = true;
    return {
      ...service,
      endpoints: service.endpoints.map((endpoint) => (
        endpoint.id === upstreamId ? { ...endpoint, is_disabled: disabled } : endpoint
      )),
    };
  });
  const routes = aggregate.logical_configuration.routes.map((route) => {
    if (!('endpoints' in route) || route.endpoints === undefined) return route;
    if (!route.endpoints.some((endpoint) => endpoint.id === upstreamId)) return route;
    changed = true;
    return {
      ...route,
      endpoints: route.endpoints.map((endpoint) => (
        endpoint.id === upstreamId ? { ...endpoint, is_disabled: disabled } : endpoint
      )),
    };
  });
  if (!changed) return null;
  return { ...aggregate, logical_configuration: { ...aggregate.logical_configuration, services, routes } };
}

type ConfigurationMutation = {
  readonly active: RepositorySnapshot;
  readonly next: ConfigurationAggregate;
  readonly kind: 'config' | 'admin_state';
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly managementSetup?: unknown;
};

async function rollbackControlActivations(
  activated: readonly string[],
  options: ConfigControlApiOptions,
): Promise<readonly unknown[]> {
  if (options.pluginControlPreflight === undefined) return [];
  const errors: unknown[] = [];
  for (const name of [...activated].reverse()) {
    try { await options.pluginControlPreflight.deactivate(name); } catch (error) { errors.push(error); }
  }
  return errors;
}

async function preflightControlActivations(
  mutation: ConfigurationMutation,
  options: ConfigControlApiOptions,
): Promise<readonly string[]> {
  const preflight = options.pluginControlPreflight;
  if (preflight === undefined) return [];
  const active = new Set(mutation.active.aggregate.plugin_activations.map(({ plugin_name }) => plugin_name));
  const activated: string[] = [];
  try {
    for (const { plugin_name: name } of mutation.next.plugin_activations) {
      if (active.has(name) || !preflight.controlNames.has(name)) continue;
      const statusBefore = preflight.status?.(name);
      await preflight.activate(name);
      if (statusBefore !== 'ready' && statusBefore !== 'starting') activated.push(name);
    }
    return activated;
  } catch (error) {
    const rollbackErrors = await rollbackControlActivations(activated, options);
    throw rollbackErrors.length === 0
      ? error
      : new AggregateError([error, ...rollbackErrors], 'control preflight rollback failed');
  }
}

function serializeMutation<T>(options: ConfigControlApiOptions, operation: () => Promise<T>): Promise<T> {
  return options.serializeMutation === undefined ? operation() : options.serializeMutation(operation);
}

const RETRY_FIELDS = new Set(['request_id', 'expected_revision']);

function recoveryIdentityMatches(
  recovery: import('../config-storage').ConfigurationRecovery,
  sourceMutationId: string,
  expectedRevision: number,
): boolean {
  return recovery.trigger === 'manual'
    && recovery.source_mutation_id === sourceMutationId
    && recovery.target_revision === expectedRevision;
}

function retryRepositoryError(error: ConfigRepositoryError): Response {
  switch (error.code) {
    case 'stale_revision': return json({ error: 'revision_conflict' }, 409);
    case 'source_not_retryable': return json({ error: 'recovery_not_retryable' }, 409);
    case 'recovery_in_progress': {
      const recovery = error.recovery;
      if (recovery === undefined || !isLowercaseUuid(recovery.recovery_id)
        || !Number.isSafeInteger(recovery.target_revision) || recovery.target_revision <= 0
        || (recovery.state !== 'scheduled' && recovery.state !== 'running')) {
        return json({ error: 'repository_error' }, 500);
      }
      return json({ error: 'recovery_in_progress', recovery_id: recovery.recovery_id,
        target_revision: recovery.target_revision, state: recovery.state }, 409);
    }
    case 'idempotency_key_reused': return json({ error: 'idempotency_key_reused' }, 409);
    case 'cas_conflict':
    case 'invalid_operation': return json({ error: 'recovery_conflict' }, 409);
    default: return json({ error: 'repository_error' }, 500);
  }
}

function runtimeOperation(state: ConfigurationOperationState | null): object | null {
  if (state === null) return null;
  const operation = state.operation;
  return { operation_id: operation.mutation_id, committed_revision: operation.committed_revision,
    state: operation.state, result_status: operation.result_status, error_code: operation.error_code,
    updated_at: operation.updated_at };
}

function runtimeRecovery(recovery: import('../config-storage').ConfigurationRecovery | null): object | null {
  if (recovery === null) return null;
  return { recovery_id: recovery.recovery_id, target_revision: recovery.target_revision,
    trigger: recovery.trigger, state: recovery.state, attempt_count: recovery.attempt_count,
    max_attempts: recovery.max_attempts, next_retry_at: recovery.next_retry_at,
    final_reason_code: recovery.final_reason_code };
}

async function retryOperation(
  request: Request, sourceMutationId: string, options: ConfigControlApiOptions,
): Promise<Response> {
  if (!validateMutationId(sourceMutationId)) {
    return json({ error: 'invalid_request' }, 400);
  }
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const envelope = exactObject(body.value, RETRY_FIELDS);
  if (envelope === null || Object.keys(envelope).length !== RETRY_FIELDS.size
    || typeof envelope.request_id !== 'string' || !isLowercaseUuid(envelope.request_id)
    || typeof envelope.expected_revision !== 'number'
    || !Number.isSafeInteger(envelope.expected_revision) || envelope.expected_revision <= 0) {
    return json({ error: 'invalid_request' }, 400);
  }
  const requestId = envelope.request_id;
  const expectedRevision = envelope.expected_revision;
  try {
    return await serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!await options.managementAuth?.recheck(request) || !matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const existing = await repositoryCall(() => options.repository.getRecovery?.(requestId) ?? null);
    if (existing !== null) {
      return recoveryIdentityMatches(existing, sourceMutationId, expectedRevision)
        ? recoveryResponse(existing)
        : json({ error: 'idempotency_key_reused' }, 409);
    }
    const cleanupRequest = await repositoryCall(()=>options.repository.getPublicationRetirementRetry?.(requestId)??null);
    if(cleanupRequest!==null) return cleanupRequest.source_mutation_id===sourceMutationId && cleanupRequest.target_revision===expectedRevision
      ? json(cleanupRequest,202) : json({error:'idempotency_key_reused'},409);

    const state = await repositoryCall(() => options.repository.getOperationState(sourceMutationId));
    if (state === null) return json({ error: 'operation_not_found' }, 404);
    const operation = state.operation;
    if(operation.state==='draining') {
      if(operation.committed_revision!==expectedRevision||active.revision!==expectedRevision) return json({error:'revision_conflict'},409);
      const retirement=await repositoryCall(()=>options.repository.getPublicationRetirement?.(sourceMutationId)??null);
      if(retirement?.state!=='stopped') return json({error:'recovery_not_retryable'},409);
      if(options.isCleanupRecoveryReady?.()!==true||!options.requestCleanupRecovery) return json({error:'recovery_unavailable'},503);
      return json(await options.requestCleanupRecovery(requestId,sourceMutationId,expectedRevision),202);
    }
    if (operation.state !== 'degraded') return json({ error: 'operation_not_degraded' }, 409);
    if (operation.committed_revision !== expectedRevision || active.revision !== expectedRevision) {
      return json({ error: 'revision_conflict' }, 409);
    }
    if (operation.error_code === 'old_worker_drain_failed') {
      return json({ error: 'recovery_not_retryable' }, 409);
    }
    if (operation.error_code !== 'replacement_convergence_failed'
      && operation.error_code !== 'control_readiness_failed') {
      return json({ error: 'recovery_not_retryable' }, 409);
    }
    const currentRecovery = await repositoryCall(() => options.repository.getCurrentRecovery?.() ?? null);
    if (currentRecovery === null) return json({ error: 'recovery_not_retryable' }, 409);
    if (currentRecovery.state === 'scheduled' || currentRecovery.state === 'running') {
      return json({ error: 'recovery_in_progress', recovery_id: currentRecovery.recovery_id,
        target_revision: currentRecovery.target_revision, state: currentRecovery.state }, 409);
    }
    if (currentRecovery.state === 'succeeded') return json({ error: 'recovery_not_retryable' }, 409);
    if (currentRecovery.target_revision !== expectedRevision
      || currentRecovery.source_mutation_id !== sourceMutationId) {
      return json({ error: 'recovery_not_retryable' }, 409);
    }
    let ready = false;
    try { ready = options.isRecoveryReady?.() === true; } catch { ready = false; }
    if (!ready) return json({ error: 'recovery_unavailable' }, 503);
    if (options.requestManualRecovery === undefined) return json({ error: 'repository_error' }, 500);
    try {
      const recovery = await options.requestManualRecovery!(requestId, sourceMutationId, expectedRevision);
      return recoveryResponse(recovery);
    } catch (error) {
      if (error instanceof ConfigRepositoryError) return retryRepositoryError(error);
      return json({ error: 'repository_error' }, 500);
    }
    });
  } catch (error) {
    if (error instanceof RepositoryUnavailableError) return repositoryUnavailable();
    if (error instanceof ConfigRepositoryError) return retryRepositoryError(error);
    return json({ error: 'repository_error' }, 500);
  }
}

function isMutationRequest(
  path: string,
  method: string,
  upstreamToggleMatch: RegExpExecArray | null,
  pluginToggleMatch: RegExpExecArray | null,
): boolean {
  return (path === '/api/config' && method === 'PUT')
    || (path === '/api/config/import' && method === 'POST')
    || (upstreamToggleMatch !== null && (method === 'POST' || method === 'PUT'))
    || (pluginToggleMatch !== null && method === 'POST');
}

async function mutationReadinessResponse(options: ConfigControlApiOptions): Promise<Response | null> {
  const recovery = await repositoryCall(() => options.repository.getCurrentRecovery?.());
  if (recovery !== null && recovery !== undefined && (recovery.state === 'scheduled' || recovery.state === 'running')) {
    return json({ error: 'recovery_in_progress', recovery_id: recovery.recovery_id,
      target_revision: recovery.target_revision, state: recovery.state }, 409);
  }
  let readiness: ReturnType<ConfigControlApiOptions['isMutationReady']> = true;
  try {
    readiness = options.isMutationReady();
  } catch {
    readiness = false;
  }
  if (typeof readiness === 'boolean') return readiness ? null : json({ error: 'control_recovering' }, 503);
  return readiness.ready ? null : json({ error: 'control_recovering', reason: readiness.reason }, 503);
}

async function commitConfigurationMutation(
  request: Request,
  options: ConfigControlApiOptions,
  mutation: ConfigurationMutation,
): Promise<Response> {
  const protectionGuard = await options.validateManagementTransition?.(request, mutation.active.aggregate, mutation.next);
  if (protectionGuard) return protectionGuard;
  if (mutation.active.revision !== mutation.expectedRevision) {
    const result = await commitProtectedMutation(request, mutation, [], options);
    return result.kind === 'committed'
      ? acceptCommitted(mutation.mutationId, result.snapshot.revision, options)
      : mapCommit(result, options, options.repository.getSnapshot());
  }
  const dataGuard = await options.guardDataTransition?.(mutation.active.aggregate, mutation.next);
  if (dataGuard) return dataGuard;
  const initialReadiness = await mutationReadinessResponse(options);
  if (initialReadiness !== null) return initialReadiness;
  let activated: readonly string[];
  try {
    activated = await preflightControlActivations(mutation, options);
  } catch (error) {
    logger.error({ error: serializeErrorChain(error), mutationId: mutation.mutationId, revision: mutation.expectedRevision },
      'Configuration control preflight failed');
    return json({ error: 'control_readiness_failed' }, 503);
  }
  const guard = await options.guardManagementTransition?.(request, mutation.active.aggregate, mutation.next, mutation.managementSetup);
  if (guard) { await rollbackControlActivations(activated, options); return guard; }
  const freshResult = safeSnapshot(options);
  if (freshResult instanceof Response) {
    const rollbackErrors = await rollbackControlActivations(activated, options);
    if (rollbackErrors.length > 0) {
      logger.error({ errors: rollbackErrors.map(serializeErrorChain), mutationId: mutation.mutationId },
        'Configuration control preflight rollback failed during recovery');
    }
    return freshResult;
  }
  const auth = options.managementAuth;
  if (!auth || !await auth.recheck(request) || !matchesCurrentAuth(request, freshResult, options)) {
    await rollbackControlActivations(activated, options);
    return json({ error: 'unauthorized' }, 401);
  }
  const capability = /^\/api\/plugins\/[^/]+\/(enable|disable)$/.test(new URL(request.url).pathname)
    ? 'plugins.toggle' : 'config.write';
  if (!await auth.authorized(request, capability)
    || (auth.selected(mutation.active.aggregate) !== auth.selected(mutation.next)
      && !await auth.authorized(request, 'auth.mode'))) {
    await rollbackControlActivations(activated, options);
    return json({ error: 'forbidden' }, 403);
  }
  if (freshResult.revision !== mutation.expectedRevision) {
    await rollbackControlActivations(activated, options);
    return json({ error: 'stale_revision', expected_revision: freshResult.revision,
      active: snapshotBody(freshResult) }, 409);
  }
  const postPreflightReadiness = await mutationReadinessResponse(options);
  if (postPreflightReadiness !== null) {
    const rollbackErrors = await rollbackControlActivations(activated, options);
    if (rollbackErrors.length > 0) {
      logger.error({ errors: rollbackErrors.map(serializeErrorChain), mutationId: mutation.mutationId },
        'Configuration control preflight rollback failed during recovery');
    }
    return postPreflightReadiness;
  }
  const finalDataGuard = await options.guardDataTransition?.(freshResult.aggregate, mutation.next);
  if (finalDataGuard) { await rollbackControlActivations(activated, options); return finalDataGuard; }
  if (!await auth.recheck(request) || !await auth.authorized(request, capability)) {
    await rollbackControlActivations(activated, options);
    return json({error:'unauthorized'},401);
  }
  await auth.validateWrite(request);
  const finalTransition = await options.validateManagementTransition?.(request, freshResult.aggregate, mutation.next);
  if (finalTransition) {
    await rollbackControlActivations(activated, options);
    return finalTransition;
  }
  const result = await commitProtectedMutation(request, mutation, activated, options);
  if (result.kind === 'committed') return acceptCommitted(mutation.mutationId, result.snapshot.revision, options);
  return mapCommit(result, options, options.repository.getSnapshot());
}

type CommitCommand = Parameters<ConfigControlRepository['commit']>[0];
type PendingCommit = {readonly command: CommitCommand; readonly activated: readonly string[]; readonly transition: ManagementTransition | null};

async function settleProtectedCommit(pending: PendingCommit, result: CommitConfigurationResult, options: ConfigControlApiOptions): Promise<void> {
  // A transition cannot reopen on a cached pair after an uncertain storage boundary.
  if (pending.transition && !options.repository.refreshControlProjection) throw new RepositoryUnavailableError(new Error('control_projection_refresh_unavailable'));
  // Refresh the current pair even for duplicate: its operation can refer to a historical revision.
  await repositoryCall(() => options.repository.refreshControlProjection?.());
  const current = options.repository.getSnapshot();
  const retained = new Set(current.aggregate.plugin_activations.map(value => value.plugin_name));
  const rollbackErrors = await rollbackControlActivations(pending.activated.filter(name => !retained.has(name)), options);
  if (rollbackErrors.length) throw new AggregateError(rollbackErrors, 'control preflight rollback failed');
  if (pending.transition) options.managementAuth!.completeTransition(pending.transition);
  options.mutationSettlement!.pending = null;
  if (result.kind === 'committed' || result.kind === 'duplicate') await options.onConfigurationCommitted?.(current);
}

async function commitProtectedMutation(request: Request, mutation: ConfigurationMutation, activated: readonly string[], options: ConfigControlApiOptions): Promise<CommitConfigurationResult> {
  const auth = options.managementAuth;
  const changing = auth?.selected() === null && auth.selected(mutation.next) !== null;
  if (changing) {
    try { auth!.provider(auth!.selected(mutation.next)); }
    catch { await rollbackControlActivations(activated, options); throw new RepositoryUnavailableError(new Error('management_provider_unavailable')); }
  }
  const command = Object.freeze({mutation_id:mutation.mutationId, expected_revision:mutation.expectedRevision,
    aggregate:mutation.next, kind:mutation.kind, created_at:options.clock.now(),
    target_worker_slots:Object.freeze(Array.from({length:options.workerCount}, (_, slot) => slot))});
  options.mutationSettlement!.ownedRequests.add(request);
  let pending: PendingCommit = {command, activated, transition:changing ? auth!.beginTransition(mutation.mutationId) : null};
  let result: CommitConfigurationResult;
  try { result = await options.repository.commit(command); }
  catch (error) {
    if (!(error instanceof ConfigRepositoryError) || error.code === 'result_unknown') {
      // Only internal reconciliation can use this exact command. Public authentication stays closed.
      if (!pending.transition && auth) pending = {...pending, transition:auth.beginTransition(mutation.mutationId)};
      options.mutationSettlement!.pending = pending;
    } else {
      await rollbackControlActivations(activated, options);
      if (pending.transition) auth!.completeTransition(pending.transition);
    }
    if (error instanceof ConfigRepositoryError) throw error;
    throw new RepositoryUnavailableError(error);
  }
  // A failed refresh after an acknowledged commit is also unresolved until the current pair can be confirmed.
  options.mutationSettlement!.pending = pending;
  await settleProtectedCommit(pending, result, options);
  return result;
}

async function reconcilePendingCommit(options: ConfigControlApiOptions): Promise<void> {
  const pending = options.mutationSettlement?.pending;
  if (!pending) return;
  const result = await repositoryCall(() => options.repository.commit(pending.command));
  await settleProtectedCommit(pending, result, options);
  if (result.kind === 'committed' || result.kind === 'duplicate') {
    await acceptCommitted(pending.command.mutation_id, result.kind === 'committed' ? result.snapshot.revision : result.operation.committed_revision, options);
  }
}

async function unchangedMutationResponse(options: ConfigControlApiOptions, revision: number): Promise<Response> {
  const publication = await repositoryCall(() => options.repository.getActivePublication());
  if (publication?.snapshot.revision === revision) {
    const state = await repositoryCall(() => options.repository.getOperationState(publication.operation.mutation_id));
    if (state === null) return json({ error: 'operation_not_found' }, 500);
    return json({
      operation_id: publication.operation.mutation_id,
      revision,
      ...state,
    }, 202);
  }
  return json({ revision, unchanged: true }, 200);
}

async function toggleUpstreamEnabled(
  request: Request, upstreamId: string, options: ConfigControlApiOptions,
): Promise<Response> {
  if (!UPSTREAM_ID.test(upstreamId)) return json({ error: 'invalid_request' }, 400);
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const parsedBody = exactObject(body.value, TOGGLE_FIELDS);
  if (parsedBody === null || typeof parsedBody.enabled !== 'boolean') return json({ error: 'invalid_request' }, 400);
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!await options.managementAuth?.recheck(request) || !matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const disabled = !parsedBody.enabled;
    const current = findUpstreamDisabled(active.aggregate, upstreamId);
    if (current === null) return json({ error: 'upstream_not_found' }, 404);
    if (current === disabled) return unchangedMutationResponse(options, active.revision);
    const next = withUpstreamDisabledState(active.aggregate, upstreamId, disabled);
    if (next === null) return json({ error: 'upstream_not_found' }, 404);
    return commitConfigurationMutation(request, options, {
      active, next, kind: 'admin_state', mutationId: randomUUID(), expectedRevision: active.revision,
    });
  });
}

async function togglePluginActivation(
  request: Request,
  pluginName: string, enable: boolean, options: ConfigControlApiOptions,
): Promise<Response> {
  if (!isPluginName(pluginName)) return json({ error: 'invalid_request' }, 400);
  const raw = request.body ? await readControlJson(request) : { ok: true as const, value: {} };
  if (!raw.ok) return json({ error: raw.error }, raw.status);
  const envelope = exactObject(raw.value, new Set(['expected_revision','mutation_id','managementSetup']));
  if (!envelope || (envelope.expected_revision !== undefined && !Number.isSafeInteger(envelope.expected_revision))
    || (envelope.mutation_id !== undefined && (typeof envelope.mutation_id !== 'string' || !validateMutationId(envelope.mutation_id)))) return json({ error: 'invalid_request' }, 400);
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!await options.managementAuth?.recheck(request) || !matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const activations = active.aggregate.plugin_activations;
    const activated = activations.some((activation) => activation.plugin_name === pluginName);
    if (!options.pluginDependencies && activated === enable) return unchangedMutationResponse(options, active.revision);
    let nextActivations: ConfigurationAggregate['plugin_activations'];
    if (options.pluginDependencies) {
      const { updatePluginActivations } = await import('../plugin-dependencies');
      try {
        nextActivations = updatePluginActivations(
          options.pluginDependencies, activations.map(({ plugin_name }) => plugin_name), pluginName, enable,
        ).map(plugin_name => ({ plugin_name }));
      } catch (error) {
        return json({ error: 'invalid_configuration', message: error instanceof Error ? error.message : String(error) }, 422);
      }
    } else {
      nextActivations = enable
        ? [...activations, { plugin_name: pluginName }]
          .sort((left, right) => left.plugin_name.localeCompare(right.plugin_name))
        : activations.filter((activation) => activation.plugin_name !== pluginName);
    }
    if (nextActivations.length === activations.length && nextActivations.every(
      (value, index) => value.plugin_name === activations[index]?.plugin_name,
    )) return unchangedMutationResponse(options, active.revision);
    const next: ConfigurationAggregate = { ...active.aggregate, plugin_activations: nextActivations };
    return commitConfigurationMutation(request, options, {
      active, next, managementSetup: envelope.managementSetup, kind: 'config', mutationId: typeof envelope.mutation_id === 'string' ? envelope.mutation_id : randomUUID(), expectedRevision: typeof envelope.expected_revision === 'number' ? envelope.expected_revision : active.revision,
    });
  });
}

async function importConfig(
  request: Request, options: ConfigControlApiOptions,
): Promise<Response> {
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const wrapper = exactObject(body.value, IMPORT_WRAPPER_FIELDS);
  if (wrapper === null || typeof wrapper.expected_revision !== 'number'
    || !Number.isSafeInteger(wrapper.expected_revision) || wrapper.expected_revision <= 0
    || typeof wrapper.mutation_id !== 'string' || !validateMutationId(wrapper.mutation_id)
    || !('envelope' in wrapper)) return json({ error: 'invalid_request' }, 400);
  const expectedRevision = wrapper.expected_revision;
  const mutationId = wrapper.mutation_id;
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!await options.managementAuth?.recheck(request) || !matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const prepared = prepareImport(wrapper.envelope, options);
    if (prepared instanceof Response) return prepared;
    freezeJson(prepared.aggregate);
    return commitConfigurationMutation(request, options, {
      active, next: prepared.aggregate, kind: 'config', mutationId, expectedRevision,
    });
  });
}

export function createConfigControlApi(options: ConfigControlApiOptions): ConfigControlApi {
  if (!Number.isSafeInteger(options.workerCount) || options.workerCount <= 0) {
    throw new TypeError('workerCount must be a positive safe integer');
  }
  let mutationTail = Promise.resolve();
  const serializedOptions: ConfigControlApiOptions = {
    ...options,
    mutationSettlement: {pending:null,ownedRequests:new WeakSet()},
    serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
      const current = mutationTail.then(operation);
      mutationTail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  const admitted = new WeakSet<Request>();
  const loginEvidence = new WeakMap<Request, () => boolean>();
  const api: ConfigControlApi = {
    async handle(request: Request): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      if (serializedOptions.mutationSettlement!.pending) {
        try { await serializeMutation(serializedOptions, () => reconcilePendingCommit(serializedOptions)); }
        catch { return json({error:'result_unknown',mutation_id:serializedOptions.mutationSettlement!.pending?.command.mutation_id},503); }
      }
      const interaction = loginInteraction(path);
      if (interaction) return handleLoginInteraction(request, interaction, serializedOptions, loginEvidence);
      if (path === '/api/auth/login' && request.method === 'POST') {
        const snapshot = safeSnapshot(serializedOptions);
        return snapshot instanceof Response ? snapshot : await login(request, serializedOptions);
      }
      if (path === '/api/auth/verify' && request.method === 'GET') {
        const snapshot = safeSnapshot(serializedOptions);
        return snapshot instanceof Response ? snapshot : verify(request, serializedOptions);
      }
      if (path === '/api/auth/setup') return setup(request, serializedOptions);
      if (path === '/api/auth/mode' && request.method === 'GET') {
        try {
          const auth = serializedOptions.managementAuth;
          if (!auth) return json({error:'management_uninitialized'},503);
          const name = auth.selected(), status = await auth.setupStatus();
          return json({mode:name ? 'plugin' : 'anonymous', initialized:status === 'ready', publicOrigin:auth.publicOrigin(request),
            ...(name ? {provider:serializedOptions.managementProviderMetadata?.(name) ?? {name}} : {})});
        } catch { return json({error:'management_provider_unavailable'},503); }
      }
      const operationMatch = /^\/api\/config\/operations\/([^/]+)$/.exec(path);
      const retryMatch = /^\/api\/config\/operations\/([^/]+)\/retry$/.exec(path);
      const upstreamToggleMatch = /^\/api\/upstreams\/([^/]+)\/enabled$/.exec(path);
      const pluginToggleMatch = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(path);
      const pluginControlMatch = /^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path);
      const menuRequest = serializedOptions.menuApi?.matches(path) === true;
      const statsRequest = serializedOptions.statsApi?.matches(path) === true;
      const observabilityRequest = serializedOptions.observabilityApi?.matches(path) === true;
      const pluginCatalogRequest = serializedOptions.pluginCatalogApi?.matches(path) === true;
      const updatesRequest = serializedOptions.updates !== undefined && ['/api/system/updates', '/api/system/updates/check', '/api/system/updates/confirm'].includes(path);
      const mutationRequest = isMutationRequest(path, request.method, upstreamToggleMatch, pluginToggleMatch);
      const managed = path === '/api/auth/setup' || path === '/api/config' || path === '/api/config/runtime' || path === '/api/runtime/upstreams' || path === '/api/runtime/routes'
        || path === '/api/config/validate'
        || path === '/api/config/export' || path === '/api/config/import'
        || operationMatch !== null || retryMatch !== null
        || upstreamToggleMatch !== null || pluginToggleMatch !== null || pluginControlMatch || statsRequest
        || pluginCatalogRequest || path === '/api/resources/api-key' || /^\/api\/resources\/api-key\/[^/]+\/extensions$/.test(path) || path === '/api/auth/logout';
      const managedWithObservability = managed || observabilityRequest || menuRequest || updatesRequest;
      if (!managedWithObservability) return path === '/api' || path.startsWith('/api/') ? notFound() : null;
      try {
        const identity = await serializedOptions.managementAuth?.authenticate(request);
        if (!identity) return json({ error: 'unauthorized' }, 401);
        const writing = !['GET','HEAD','OPTIONS'].includes(request.method);
        const capability = pluginControlMatch ? serializedOptions.pluginCapability?.(request) ?? null
          : path === '/api/auth/logout' ? 'self.logout'
          : path.startsWith('/api/resources/api-key') ? 'keys.read'
          : pluginToggleMatch ? 'plugins.toggle'
          : pluginCatalogRequest ? 'plugins.read'
          : statsRequest || observabilityRequest ? (writing ? 'config.write' : 'logs.read')
          : writing ? 'config.write' : 'config.read';
        if (!capability && pluginControlMatch) return notFound();
        if (!capability || !await serializedOptions.managementAuth!.authorized(request, capability)) return json({ error: 'forbidden' }, 403);
        if (writing) await serializedOptions.managementAuth!.validateWrite(request);
        admitted.add(request);
      } catch (error) { const invalid = error instanceof Error && ['invalid_csrf','invalid_origin','csrf_validation_unavailable'].includes(error.message); return json({ error: invalid ? 'invalid_csrf' : 'management_provider_unavailable' }, invalid ? 403 : 503); }
      let snapshot: RepositorySnapshot;
      if (mutationRequest) {
        const initial = safeSnapshot(serializedOptions);
        if (initial instanceof Response) return initial;
        snapshot = initial;
        if (!matchesCurrentAuth(request, snapshot, serializedOptions)) {
          return json({ error: 'unauthorized' }, 401);
        }
      } else {
        const current = safeSnapshot(serializedOptions);
        if (current instanceof Response) return current;
        snapshot = current;
      }
      try {
        if (!mutationRequest && !matchesCurrentAuth(request, snapshot, serializedOptions)) {
          return json({ error: 'unauthorized' }, 401);
        }
        if (updatesRequest) return await serializedOptions.updates!.handle(request);
        if (path === '/api/auth/logout' && request.method === 'POST') {
          const provider = serializedOptions.managementAuth?.provider();
          return provider ? await provider.logout(request) : json({ success: true });
        }
        if (path.startsWith('/api/resources/api-key')) return await resourcesApi(request, serializedOptions);
        if (menuRequest) {
          const initialIdentity = serializedOptions.managementAuth!.identity(request)!;
          const handle = () => {
            const current = safeSnapshot(serializedOptions);
            if (current instanceof Response) return Promise.resolve(current);
            return serializedOptions.menuApi!.handle(request, current, async () => {
              if (!await serializedOptions.managementAuth!.recheck(request)) return false;
              const fresh = serializedOptions.managementAuth!.identity(request);
              return fresh?.provider === initialIdentity.provider
                && fresh.subject.id === initialIdentity.subject.id
                && fresh.subject.provider === initialIdentity.subject.provider
                && await serializedOptions.managementAuth!.authorized(request, 'config.write');
            });
          };
          return request.method === 'PUT' ? await serializeMutation(serializedOptions, handle) : await handle();
        }
        if (statsRequest) return await serializedOptions.statsApi!.handle(request);
        if (observabilityRequest) return await serializedOptions.observabilityApi!.handle(request);
        if (pluginCatalogRequest) return serializedOptions.pluginCatalogApi!.handle(request, snapshot);
        if (/^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path)
          && serializedOptions.pluginControlApi !== undefined) {
          const name = decodePathSegment(path.split('/')[3]);
          if (!snapshot.aggregate.plugin_activations.some(value => value.plugin_name === name)) return json({error:'plugin_inactive'},503);
          const handled = await serializedOptions.pluginControlApi.handle(request, serializedOptions.managementAuth?.identity(request)?.subject);
          if (handled !== null) return handled;
        }
        if (path === '/api/config' && request.method === 'GET') return json(snapshotBody(snapshot));
        if (path === '/api/config' && request.method === 'PUT') return await putConfig(request, serializedOptions);
        if (path === '/api/config/export' && request.method === 'GET') {
          const envelope = exportConfig(snapshot, serializedOptions.clock.now());
          return new Response(JSON.stringify(envelope), {
            headers: {
              ...JSON_HEADERS,
              'content-disposition': `attachment; filename="bungee-config-rev${envelope.source_revision}.json"`,
            },
          });
        }
        if (path === '/api/config/import' && request.method === 'POST') {
          return await importConfig(request, serializedOptions);
        }
        if (path === '/api/config/runtime' && request.method === 'GET') {
          const currentOperation = await repositoryCall(() => serializedOptions.repository.getCurrentOperationState?.() ?? null);
          const currentRecovery = await repositoryCall(() => serializedOptions.repository.getCurrentRecovery?.() ?? null);
          const retirement = currentOperation === null ? null : await repositoryCall(() =>
            serializedOptions.repository.getPublicationRetirement?.(currentOperation.operation.mutation_id) ?? null);
          const health = runtimeHealthSnapshot(await serializedOptions.runtimeHealth?.() ?? null);
          const evidence = serializedOptions.runtimePublicationEvidence?.()
            ?? { serving_complete: false, serving_revision: null };
          return json({ config: snapshot.aggregate, revision: snapshot.revision, content_hash: snapshot.content_hash,
            workers: serializedOptions.admission.snapshot().map(runtimeWorker),
            health,
            publication: {
              operation: runtimeOperation(currentOperation),
              cleanup: publicationCleanup(retirement, serializedOptions.retirementDeadline),
              recovery: runtimeRecovery(currentRecovery),
              retryable: (currentOperation?.operation.state==='draining' && retirement?.state==='stopped') || (currentOperation?.operation.state === 'degraded'
                && (currentOperation.operation.error_code === 'replacement_convergence_failed'
                  || currentOperation.operation.error_code === 'control_readiness_failed')
                && currentRecovery?.state === 'stopped'
                && currentRecovery.target_revision === snapshot.revision
                && evidence.serving_complete === false),
              serving_complete: evidence.serving_complete,
              serving_revision: evidence.serving_revision,
              target_revision: snapshot!.revision,
            },
          });
        }
        if (path === '/api/runtime/routes' && request.method === 'GET') {
          return json({ schema: 'bungee-route-body-plan-v1', source: 'committed_configuration',
            revision: snapshot.revision, content_hash: snapshot.content_hash,
            publication: serializedOptions.runtimePublicationEvidence?.() ?? { serving_complete: false, serving_revision: null },
            routes: buildRouteBodyPlans(snapshot.aggregate) });
        }
        if (path === '/api/runtime/upstreams' && request.method === 'GET') {
          return serializedOptions.runtimeUpstreams === undefined
            ? json({ error: 'runtime_unavailable' }, 503)
            : await serializedOptions.runtimeUpstreams();
        }
        if (path === '/api/config/validate' && request.method === 'POST') return await validateRequest(request, serializedOptions);
        if (upstreamToggleMatch !== null) {
          const upstreamId = decodePathSegment(upstreamToggleMatch[1]);
          if (upstreamId === null) return json({ error: 'invalid_request' }, 400);
          if (request.method === 'POST' || request.method === 'PUT') {
            return await toggleUpstreamEnabled(request, upstreamId, serializedOptions);
          }
          return json({ error: 'method_not_allowed' }, 405);
        }
        if (pluginToggleMatch !== null) {
          const pluginName = decodePathSegment(pluginToggleMatch[1]);
          if (pluginName === null) return json({ error: 'invalid_request' }, 400);
          if (request.method === 'POST') {
            return await togglePluginActivation(
              request, pluginName, pluginToggleMatch[2] === 'enable', serializedOptions,
            );
          }
          return json({ error: 'method_not_allowed' }, 405);
        }
        if (operationMatch !== null && request.method === 'GET') {
          const mutationId = operationMatch[1];
          if (mutationId === undefined || !validateMutationId(mutationId)) return json({ error: 'invalid_request' }, 400);
          const state = await repositoryCall(() => serializedOptions.repository.getOperationState(mutationId));
          return state === null ? json({ error: 'operation_not_found' }, 404) : operationResponse(state);
        }
        if (retryMatch !== null) {
          const sourceMutationId = retryMatch[1];
          if (sourceMutationId === undefined || !validateMutationId(sourceMutationId)) {
            return json({ error: 'invalid_request' }, 400);
          }
          if (request.method !== 'POST') return methodNotAllowed('POST');
          return await retryOperation(request, sourceMutationId, serializedOptions);
        }
        return json({ error: 'method_not_allowed' }, 405);
      } catch (error) {
        if (error instanceof RepositoryUnavailableError) return repositoryUnavailable();
        if (error instanceof ConfigRepositoryError) {
          if (error.code === 'result_unknown') return json({ error: 'result_unknown',
            mutation_id: 'mutationId' in error ? error.mutationId : undefined }, 503);
          if (error.code === 'invalid_command') return json({ error: 'invalid_request' }, 400);
          return json({ error: error.code === 'invalid_configuration' ? 'invalid_configuration' : 'repository_unavailable' },
            error.code === 'invalid_configuration' ? 422 : 503);
        }
        throw error;
      }
    },
  };
  return Object.freeze({async handle(request: Request): Promise<Response | null> {
    const response = await api.handle(request);
    const currentLogin = loginEvidence.get(request);
    if (currentLogin) {
      try { if (!currentLogin()) return noStore(json({error:'authentication_provider_changed'},409)); }
      catch { return noStore(json({error:'management_provider_unavailable'},503)); }
    }
    if (admitted.has(request) && !serializedOptions.mutationSettlement!.ownedRequests.has(request)) {
      try { if (!serializedOptions.managementAuth?.identity(request)) return json({error:'unauthorized'},401); }
      catch { return json({error:'management_provider_unavailable'},503); }
    }
    return response && new URL(request.url).pathname.startsWith('/api/auth/login/') ? noStore(response) : response;
  }});
}

async function resourcesApi(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const path = new URL(request.url).pathname;
  try {
    const keys = await options.resourceCollection?.() ?? [];
    if (path === '/api/resources/api-key') return json({keys});
    const match = /^\/api\/resources\/api-key\/([^/]+)\/extensions$/.exec(path);
    const id = decodePathSegment(match?.[1]);
    if (!id) return json({error:'invalid_request'},400);
    if (!keys.some(key => key !== null && typeof key === 'object' && 'id' in key && key.id === id)) return json({error:'key_not_found'},404);
    return json({extensions: await options.resourceExtensions?.(id) ?? []});
  } catch { return json({error:'resource_unavailable'},503); }
}
