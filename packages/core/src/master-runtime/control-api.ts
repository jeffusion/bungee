import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import { isManagementApiPath, normalizeManagementPath } from '../api/management-path';
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
  readonly serializeMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export interface ConfigControlApi {
  handle(request: Request): Promise<Response | null>;
  authorizeForward(request: Request): Promise<boolean | Response>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
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

async function login(request: Request, options: ConfigControlApiOptions): Promise<Response> {
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
  const snapshot = options.repository.getSnapshot();
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

function runtimeWorker(worker: ServingConfigWorker): object {
  return { slot: worker.process.slot, pid: worker.process.pid, private_port: worker.private_port,
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
  const state = options.repository.getOperationState(mutationId);
  if (state === null) return json({ error: 'operation_not_found' }, 500);
  const active = options.repository.getActivePublication();
  if (active !== null && active.operation.mutation_id === mutationId) {
    const oldWorkers = options.admission.snapshot();
    options.publicationTasks.enqueue(active, oldWorkers);
  }
  return json({ operation_id: mutationId, revision, ...state }, 202);
}

function mapCommit(result: Exclude<CommitConfigurationResult, { readonly kind: 'committed' }>, options: ConfigControlApiOptions): Response {
  switch (result.kind) {
    case 'duplicate': {
      const state = options.repository.getOperationState(result.operation.mutation_id);
      return state === null ? json({ error: 'operation_not_found' }, 500)
        : json({ operation_id: result.operation.mutation_id,
          revision: result.operation.committed_revision, ...state }, 202);
    }
    case 'stale_revision':
      return json({ error: 'stale_revision', expected_revision: result.expected_revision,
        active: snapshotBody(options.repository.getSnapshot()) }, 409);
    case 'idempotency_key_reused':
      return json({ error: 'idempotency_key_reused', mutation_id: result.mutation_id }, 409);
    case 'operation_in_progress': {
      return json({ error: 'operation_in_progress', operation_id: result.mutation_id,
        revision: result.committed_revision, state: result.state }, 409);
    }
    default: {
      const unhandled: never = result;
      return json({ error: 'unhandled_commit_result', unhandled }, 500);
    }
  }
}

async function putConfig(request: Request, options: ConfigControlApiOptions): Promise<Response> {
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
    const parsed = options.parseAggregate(envelope.aggregate);
    if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
    freezeJson(parsed.value);
    const active = options.repository.getSnapshot();
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
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

async function commitConfigurationMutation(
  request: Request,
  options: ConfigControlApiOptions,
  mutation: ConfigurationMutation,
): Promise<Response> {
  const requiresProof = requiresNextAuthProof(mutation.active, mutation.next);
  if (requiresProof && !provesNextAuth(request, mutation.next, options.resolveAuthToken)) {
    return json({ error: 'next_auth_required' }, 403);
  }
  let activated: readonly string[];
  try {
    activated = await preflightControlActivations(mutation, options);
  } catch (error) {
    logger.error({ error: serializeErrorChain(error), mutationId: mutation.mutationId, revision: mutation.expectedRevision },
      'Configuration control preflight failed');
    return json({ error: 'control_readiness_failed' }, 503);
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
    throw error;
  }
  if (result.kind !== 'committed') {
    await rollbackControlActivations(activated, options);
  }
  return result.kind === 'committed'
    ? acceptCommitted(mutation.mutationId, result.snapshot.revision, options)
    : mapCommit(result, options);
}

function unchangedMutationResponse(options: ConfigControlApiOptions, revision: number): Response {
  const publication = options.repository.getActivePublication();
  if (publication?.snapshot.revision === revision) {
    const state = options.repository.getOperationState(publication.operation.mutation_id);
    if (state === null) return json({ error: 'operation_not_found' }, 500);
    return json({
      operation_id: publication.operation.mutation_id,
      revision,
      ...state,
    }, 202);
  }
  return json({ revision, unchanged: true }, 200);
}

async function toggleUpstreamEnabled(request: Request, upstreamId: string, options: ConfigControlApiOptions): Promise<Response> {
  if (!UPSTREAM_ID.test(upstreamId)) return json({ error: 'invalid_request' }, 400);
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const parsedBody = exactObject(body.value, TOGGLE_FIELDS);
  if (parsedBody === null || typeof parsedBody.enabled !== 'boolean') return json({ error: 'invalid_request' }, 400);
  return serializeMutation(options, async () => {
    const active = options.repository.getSnapshot();
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
  pluginName: string,
  enable: boolean,
  options: ConfigControlApiOptions,
): Promise<Response> {
  if (!isPluginName(pluginName)) return json({ error: 'invalid_request' }, 400);
  return serializeMutation(options, async () => {
    const active = options.repository.getSnapshot();
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

async function importConfig(request: Request, options: ConfigControlApiOptions): Promise<Response> {
  const body = await readControlJson(request);
  if (!body.ok) return json({ error: body.error }, body.status);
  const envelope = parseSnapshotEnvelope(body.value);
  if (envelope === null) return json({ error: 'invalid_snapshot' }, 400);
  const { envelope_hash: envelopeHash, ...envelopeBase } = envelope;
  if (envelopeHash !== hashConfigurationContent(envelopeBase)) {
    return json({ error: 'invalid_snapshot' }, 400);
  }
  return serializeMutation(options, async () => {
    const parsed = options.parseAggregate(envelope.aggregate);
    if (!parsed.ok) return json({ error: 'invalid_configuration', errors: parsed.errors }, 422);
    freezeJson(parsed.value);
    if (envelope.content_hash !== hashConfigurationContent(parsed.value)) return json({ error: 'invalid_snapshot' }, 400);
    const active = options.repository.getSnapshot();
    if (!matchesCurrentAuth(request, active, options)) return json({ error: 'unauthorized' }, 401);
    const mutationId = randomUUID();
    return commitConfigurationMutation(request, options, {
      active, next: parsed.value, kind: 'config', mutationId, expectedRevision: active.revision,
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
      const path = normalizeManagementPath(new URL(request.url).pathname);
      if (path === '/api/auth/login' && request.method === 'POST') {
        return await login(request, serializedOptions);
      }
      if (path === '/api/auth/verify' && request.method === 'GET') {
        return verify(request, serializedOptions.repository.getSnapshot(), serializedOptions);
      }
      const operationMatch = /^\/api\/config\/operations\/([^/]+)$/.exec(path);
      const upstreamToggleMatch = /^\/api\/upstreams\/([^/]+)\/enabled$/.exec(path);
      const pluginToggleMatch = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(path);
      const pluginControlMatch = /^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path);
      const mutationRequest = isMutationRequest(path, request.method, upstreamToggleMatch, pluginToggleMatch);
      const managed = path === '/api/config' || path === '/api/config/runtime'
        || path === '/api/config/validate'
        || path === '/api/config/export' || path === '/api/config/import'
        || operationMatch !== null
        || upstreamToggleMatch !== null || pluginToggleMatch !== null || pluginControlMatch;
      if (!managed) return null;
      try {
        const snapshot = mutationRequest ? null : serializedOptions.repository.getSnapshot();
        if (!mutationRequest && snapshot !== null && !matchesCurrentAuth(request, snapshot, serializedOptions)) {
          return json({ error: 'unauthorized' }, 401);
        }
        if (/^\/api\/plugins\/[^/]+\/control(?:\/|$)/.test(path)
          && serializedOptions.pluginControlApi !== undefined) {
          const handled = await serializedOptions.pluginControlApi.handle(request);
          if (handled !== null) return handled;
        }
        if (path === '/api/config' && request.method === 'GET') return json(snapshotBody(snapshot!));
        if (path === '/api/config' && request.method === 'PUT') return await putConfig(request, serializedOptions);
        if (path === '/api/config/export' && request.method === 'GET') {
          const envelope = exportConfig(snapshot!, serializedOptions.clock.now());
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
          return json({ ...snapshotBody(snapshot!), workers: serializedOptions.admission.snapshot().map(runtimeWorker) });
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
          const state = serializedOptions.repository.getOperationState(mutationId);
          return state === null ? json({ error: 'operation_not_found' }, 404) : operationResponse(state);
        }
        return json({ error: 'method_not_allowed' }, 405);
      } catch (error) {
        if (error instanceof ConfigRepositoryError) {
          if (error.code === 'invalid_command') return json({ error: 'invalid_request' }, 400);
          return json({ error: error.code === 'invalid_configuration' ? 'invalid_configuration' : 'repository_unavailable' },
            error.code === 'invalid_configuration' ? 422 : 503);
        }
        throw error;
      }
    },
    async authorizeForward(request: Request): Promise<boolean | Response> {
      if (!isManagementApiPath(request)) return false;
      return matchesCurrentAuth(request, serializedOptions.repository.getSnapshot(), serializedOptions)
        ? true
        : json({ error: 'unauthorized' }, 401);
    },
  });
}
