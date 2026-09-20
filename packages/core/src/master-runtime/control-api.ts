import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import type { ActiveConfigurationPublication, CommitConfigurationResult, ConfigurationOperationState,
  ConfigurationResult, RepositorySnapshot } from '../config-storage';
import { ConfigRepositoryError } from '../config-storage';
import { validateMutationId } from '../config-storage/repository-validation';
import { hashConfigurationContent } from '../config-storage/content-hash';
import { isPluginName } from '../config-storage/plugin-name';
import type { ServingConfigWorker } from '../config-publication';
import { readControlJson } from './control-api-body';
import { authChanged, matchesActiveAuth, provesNextAuth } from './control-api-auth';
import type { PublicationTaskLifecycle } from './publication-task-manager';
import { logger } from '../logger';
import { serializeErrorChain } from './error-chain';
import { isLowercaseUuid } from '../config-storage/validation';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const PUT_FIELDS = new Set(['expected_revision', 'aggregate', 'mutation_id', 'kind']);
const VALIDATE_FIELDS = new Set(['aggregate']);
const EXPORT_FORMAT = 'bungee-config-snapshot';
const EXPORT_FORMAT_VERSION = 1;
const EXPORT_SCHEMA_VERSION = 2;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ConfigControlRepository {
  getSnapshot(): RepositorySnapshot;
  getActivePublication(): ActiveConfigurationPublication | null;
  getCurrentRecovery?(): import('../config-storage').ConfigurationRecovery | null;
  getRecovery?(recoveryId: string): import('../config-storage').ConfigurationRecovery | null;
  getCurrentOperationState?(): ConfigurationOperationState | null;
  getOperationState(mutationId: string): ConfigurationOperationState | null;
  commit(command: {
    readonly mutation_id: string; readonly expected_revision: number;
    readonly aggregate: ConfigurationAggregateV2; readonly kind: 'config' | 'admin_state';
    readonly created_at: number; readonly target_worker_slots: readonly number[];
  }): CommitConfigurationResult;
}

export type ConfigControlApiOptions = {
  readonly repository: ConfigControlRepository;
  readonly admission: { snapshot(): readonly ServingConfigWorker[] };
  readonly workerCount: number;
  readonly clock: { now(): number };
  readonly resolveAuthToken: (tokenExpression: string) => unknown;
  readonly parseAggregate: (value: unknown) => ConfigurationResult<ConfigurationAggregateV2>;
  readonly publicationTasks: Pick<PublicationTaskLifecycle, 'enqueue'>;
  readonly pluginControlApi?: { handle(request: Request): Promise<Response | null> };
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
  readonly onConfigurationCommitted?: (snapshot: RepositorySnapshot) => void;
  readonly serializeMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly requestManualRecovery?: (
    recoveryId: string, sourceMutationId: string, expectedRevision: number,
  ) => Promise<import('../config-storage').ConfigurationRecovery>;
  readonly isRecoveryReady?: () => boolean;
  readonly runtimePublicationEvidence?: () => {
    readonly serving_complete: boolean;
    readonly serving_revision: number | null;
  };
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

function repositoryCall<T>(operation: () => T): T {
  try { return operation(); }
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
  return matchesActiveAuth(request, snapshot.aggregate, options.resolveAuthToken);
}

async function login(request: Request, options: ConfigControlApiOptions, snapshot: RepositorySnapshot): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Token is required' }, 400);
  }
  const token = typeof body === 'object' && body !== null && !Array.isArray(body) && 'token' in body
    ? body.token
    : undefined;
  if (typeof token !== 'string' || token.trim().length === 0) {
    return json({ success: false, error: 'Token is required' }, 400);
  }
  if (snapshot.aggregate.logical_configuration.auth?.enabled !== true) return json({ success: true });
  const authenticated = matchesActiveAuth(new Request(request.url, {
    headers: { authorization: `Bearer ${token}` },
  }), snapshot.aggregate, options.resolveAuthToken);
  return authenticated
    ? json({ success: true })
    : json({ success: false, error: 'Invalid token' }, 401);
}

function verify(request: Request, snapshot: RepositorySnapshot, options: ConfigControlApiOptions): Response {
  if (matchesCurrentAuth(request, snapshot, options)) return json({ success: true });
  return request.headers.has('authorization')
    ? json({ success: false, error: 'Invalid token' }, 401)
    : json({ success: false });
}

function requiresNextAuthProof(
  active: RepositorySnapshot,
  next: ConfigurationAggregateV2,
): boolean {
  return authChanged(active.aggregate, next);
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
  if (envelope === null || !('aggregate' in envelope)) return json({ error: 'invalid_request' }, 400);
  const parsed = options.parseAggregate(envelope.aggregate);
  return parsed.ok ? json({ valid: true, errors: [] }) : json({ valid: false, errors: parsed.errors });
}

function acceptCommitted(
  mutationId: string,
  revision: number,
  options: ConfigControlApiOptions,
): Response {
  const state = repositoryCall(() => options.repository.getOperationState(mutationId));
  if (state === null) return json({ error: 'operation_not_found' }, 500);
  const active = repositoryCall(() => options.repository.getActivePublication());
  if (active !== null && active.operation.mutation_id === mutationId) {
    const oldWorkers = options.admission.snapshot();
    options.publicationTasks.enqueue(active, oldWorkers);
  }
  return json({ operation_id: mutationId, revision, ...state }, 202);
}

function mapCommit(
  result: Exclude<CommitConfigurationResult, { readonly kind: 'committed' }>,
  options: ConfigControlApiOptions,
  snapshot: RepositorySnapshot,
): Response {
  switch (result.kind) {
    case 'duplicate': {
      const state = repositoryCall(() => options.repository.getOperationState(result.operation.mutation_id));
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
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const parsed = options.parseAggregate(envelope.aggregate);
    if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
    freezeJson(parsed.value);
    return commitConfigurationMutation(request, options, {
      active, next: parsed.value, kind, mutationId, expectedRevision,
    });
  });
}

type ConfigurationSnapshotEnvelope = {
  readonly format: 'bungee-config-snapshot';
  readonly format_version: 1;
  readonly schema_version: 2;
  readonly exported_at: number;
  readonly source_revision: number;
  readonly content_hash: Sha256Digest;
  readonly aggregate: ConfigurationAggregateV2;
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

const UPSTREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOGGLE_FIELDS = new Set(['enabled']);

function findUpstreamDisabled(aggregate: ConfigurationAggregateV2, upstreamId: string): boolean | null {
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
  aggregate: ConfigurationAggregateV2,
  upstreamId: string,
  disabled: boolean,
): ConfigurationAggregateV2 | null {
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
  readonly next: ConfigurationAggregateV2;
  readonly kind: 'config' | 'admin_state';
  readonly mutationId: string;
  readonly expectedRevision: number;
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
    state: operation.state, result_status: operation.result_status, error_code: operation.error_code };
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
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const existing = repositoryCall(() => options.repository.getRecovery?.(requestId) ?? null);
    if (existing !== null) {
      return recoveryIdentityMatches(existing, sourceMutationId, expectedRevision)
        ? recoveryResponse(existing)
        : json({ error: 'idempotency_key_reused' }, 409);
    }

    const state = repositoryCall(() => options.repository.getOperationState(sourceMutationId));
    if (state === null) return json({ error: 'operation_not_found' }, 404);
    const operation = state.operation;
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
    const currentRecovery = repositoryCall(() => options.repository.getCurrentRecovery?.() ?? null);
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

function mutationReadinessResponse(options: ConfigControlApiOptions): Response | null {
  const recovery = repositoryCall(() => options.repository.getCurrentRecovery?.());
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
  if (mutation.active.revision !== mutation.expectedRevision) {
    let result: CommitConfigurationResult;
    try {
      result = options.repository.commit(Object.freeze({
        mutation_id: mutation.mutationId,
        expected_revision: mutation.expectedRevision,
        aggregate: mutation.next,
        kind: mutation.kind,
        created_at: options.clock.now(),
        target_worker_slots: Object.freeze(Array.from({ length: options.workerCount }, (_, slot) => slot)),
      }));
    } catch (error) {
      if (error instanceof ConfigRepositoryError) throw error;
      throw new RepositoryUnavailableError(error);
    }
    if (result.kind === 'committed') {
      options.onConfigurationCommitted?.(result.snapshot);
      return acceptCommitted(mutation.mutationId, result.snapshot.revision, options);
    }
    return mapCommit(result, options, mutation.active);
  }
  const requiresProof = requiresNextAuthProof(mutation.active, mutation.next);
  if (requiresProof && !provesNextAuth(request, mutation.next, options.resolveAuthToken)) {
    return json({ error: 'next_auth_required' }, 403);
  }
  const initialReadiness = mutationReadinessResponse(options);
  if (initialReadiness !== null) return initialReadiness;
  let activated: readonly string[];
  try {
    activated = await preflightControlActivations(mutation, options);
  } catch (error) {
    logger.error({ error: serializeErrorChain(error), mutationId: mutation.mutationId, revision: mutation.expectedRevision },
      'Configuration control preflight failed');
    return json({ error: 'control_readiness_failed' }, 503);
  }
  const freshResult = safeSnapshot(options);
  if (freshResult instanceof Response) {
    const rollbackErrors = await rollbackControlActivations(activated, options);
    if (rollbackErrors.length > 0) {
      logger.error({ errors: rollbackErrors.map(serializeErrorChain), mutationId: mutation.mutationId },
        'Configuration control preflight rollback failed during recovery');
    }
    return freshResult;
  }
  if (!matchesCurrentAuth(request, freshResult, options)
    || (requiresNextAuthProof(freshResult, mutation.next)
      && !provesNextAuth(request, mutation.next, options.resolveAuthToken))) {
    await rollbackControlActivations(activated, options);
    return json({ error: 'unauthorized' }, 401);
  }
  if (freshResult.revision !== mutation.expectedRevision) {
    await rollbackControlActivations(activated, options);
    return json({ error: 'stale_revision', expected_revision: freshResult.revision,
      active: snapshotBody(freshResult) }, 409);
  }
  const postPreflightReadiness = mutationReadinessResponse(options);
  if (postPreflightReadiness !== null) {
    const rollbackErrors = await rollbackControlActivations(activated, options);
    if (rollbackErrors.length > 0) {
      logger.error({ errors: rollbackErrors.map(serializeErrorChain), mutationId: mutation.mutationId },
        'Configuration control preflight rollback failed during recovery');
    }
    return postPreflightReadiness;
  }
  let result: CommitConfigurationResult;
  try {
    result = options.repository.commit(Object.freeze({
      mutation_id: mutation.mutationId,
      expected_revision: mutation.expectedRevision,
      aggregate: mutation.next,
      kind: mutation.kind,
      created_at: options.clock.now(),
      target_worker_slots: Object.freeze(Array.from({ length: options.workerCount }, (_, slot) => slot)),
    }));
  } catch (error) {
    await rollbackControlActivations(activated, options);
    if (error instanceof ConfigRepositoryError) throw error;
    throw new RepositoryUnavailableError(error);
  }
  if (result.kind !== 'committed') {
    await rollbackControlActivations(activated, options);
  }
  if (result.kind === 'committed') {
    options.onConfigurationCommitted?.(result.snapshot);
    return acceptCommitted(mutation.mutationId, result.snapshot.revision, options);
  }
  return mapCommit(result, options, mutation.active);
}

function unchangedMutationResponse(options: ConfigControlApiOptions, revision: number): Response {
  const publication = repositoryCall(() => options.repository.getActivePublication());
  if (publication?.snapshot.revision === revision) {
    const state = repositoryCall(() => options.repository.getOperationState(publication.operation.mutation_id));
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
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
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
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const activations = active.aggregate.plugin_activations;
    const activated = activations.some((activation) => activation.plugin_name === pluginName);
    if (activated === enable) return unchangedMutationResponse(options, active.revision);
    const nextActivations = enable
      ? [...activations, { plugin_name: pluginName }]
        .sort((left, right) => (left.plugin_name < right.plugin_name ? -1 : left.plugin_name > right.plugin_name ? 1 : 0))
      : activations.filter((activation) => activation.plugin_name !== pluginName);
    const next: ConfigurationAggregateV2 = { ...active.aggregate, plugin_activations: nextActivations };
    return commitConfigurationMutation(request, options, {
      active, next, kind: 'config', mutationId: randomUUID(), expectedRevision: active.revision,
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
  const envelope = parseSnapshotEnvelope(wrapper.envelope);
  if (envelope === null) return json({ error: 'invalid_snapshot' }, 400);
  const { envelope_hash: envelopeHash, ...envelopeBase } = envelope;
  if (envelopeHash !== hashConfigurationContent(envelopeBase)) {
    return json({ error: 'invalid_snapshot' }, 400);
  }
  return serializeMutation(options, async () => {
    const activeResult = safeSnapshot(options);
    if (activeResult instanceof Response) return activeResult;
    const active = activeResult;
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const parsed = options.parseAggregate(envelope.aggregate);
    if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
    freezeJson(parsed.value);
    if (envelope.content_hash !== hashConfigurationContent(parsed.value)) return json({ error: 'invalid_snapshot' }, 400);
    return commitConfigurationMutation(request, options, {
      active, next: parsed.value, kind: 'config', mutationId, expectedRevision,
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
    serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
      const current = mutationTail.then(operation);
      mutationTail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
  return Object.freeze({
    async handle(request: Request): Promise<Response | null> {
      const path = new URL(request.url).pathname;
      if (path === '/api/auth/login' && request.method === 'POST') {
        const snapshot = safeSnapshot(serializedOptions);
        return snapshot instanceof Response ? snapshot : await login(request, serializedOptions, snapshot);
      }
      if (path === '/api/auth/verify' && request.method === 'GET') {
        const snapshot = safeSnapshot(serializedOptions);
        return snapshot instanceof Response ? snapshot : verify(request, snapshot, serializedOptions);
      }
      const operationMatch = /^\/api\/config\/operations\/([^/]+)$/.exec(path);
      const retryMatch = /^\/api\/config\/operations\/([^/]+)\/retry$/.exec(path);
      const upstreamToggleMatch = /^\/api\/upstreams\/([^/]+)\/enabled$/.exec(path);
      const pluginToggleMatch = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(path);
      const pluginControlMatch = /^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path);
      const statsRequest = serializedOptions.statsApi?.matches(path) === true;
      const observabilityRequest = serializedOptions.observabilityApi?.matches(path) === true;
      const pluginCatalogRequest = serializedOptions.pluginCatalogApi?.matches(path) === true;
      const mutationRequest = isMutationRequest(path, request.method, upstreamToggleMatch, pluginToggleMatch);
      const managed = path === '/api/config' || path === '/api/config/runtime' || path === '/api/runtime/upstreams'
        || path === '/api/config/validate'
        || path === '/api/config/export' || path === '/api/config/import'
        || operationMatch !== null || retryMatch !== null
        || upstreamToggleMatch !== null || pluginToggleMatch !== null || pluginControlMatch || statsRequest
        || pluginCatalogRequest;
      const managedWithObservability = managed || observabilityRequest;
      if (!managedWithObservability) return path === '/api' || path.startsWith('/api/') ? notFound() : null;
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
        if (statsRequest) return serializedOptions.statsApi!.handle(request);
        if (observabilityRequest) return serializedOptions.observabilityApi!.handle(request);
        if (pluginCatalogRequest) return serializedOptions.pluginCatalogApi!.handle(request, snapshot);
        if (/^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path)
          && serializedOptions.pluginControlApi !== undefined) {
          const handled = await serializedOptions.pluginControlApi.handle(request);
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
          const currentOperation = repositoryCall(() => serializedOptions.repository.getCurrentOperationState?.() ?? null);
          const currentRecovery = repositoryCall(() => serializedOptions.repository.getCurrentRecovery?.() ?? null);
          const evidence = serializedOptions.runtimePublicationEvidence?.()
            ?? { serving_complete: false, serving_revision: null };
          return json({ config: snapshot.aggregate, revision: snapshot.revision, content_hash: snapshot.content_hash,
            workers: serializedOptions.admission.snapshot().map(runtimeWorker),
            publication: {
              operation: runtimeOperation(currentOperation),
              recovery: runtimeRecovery(currentRecovery),
              retryable: currentOperation?.operation.state === 'degraded'
                && (currentOperation.operation.error_code === 'replacement_convergence_failed'
                  || currentOperation.operation.error_code === 'control_readiness_failed')
                && currentRecovery?.state === 'stopped'
                && currentRecovery.target_revision === snapshot.revision
                && evidence.serving_complete === false,
              serving_complete: evidence.serving_complete,
              serving_revision: evidence.serving_revision,
              target_revision: snapshot!.revision,
            },
          });
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
          const state = repositoryCall(() => serializedOptions.repository.getOperationState(mutationId));
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
          if (error.code === 'invalid_command') return json({ error: 'invalid_request' }, 400);
          return json({ error: error.code === 'invalid_configuration' ? 'invalid_configuration' : 'repository_unavailable' },
            error.code === 'invalid_configuration' ? 422 : 503);
        }
        throw error;
      }
    },
  });
}
