import type {
  ConfigurationAggregate,
  LogicalConfiguration,
  Sha256Digest,
} from '@jeffusion/bungee-types';
import { v4 as uuidv4 } from 'uuid';
import { api, ApiError } from './client';


export type ConfigurationSnapshot = {
  readonly config: ConfigurationAggregate;
  readonly revision: number;
  readonly content_hash: Sha256Digest;
};

type ConfigurationOperationBase = {
  readonly mutation_id: string;
  readonly request_hash: Sha256Digest;
  readonly expected_revision: number;
  readonly committed_revision: number;
  readonly kind: 'config' | 'admin_state';
  readonly target_worker_count: number;
  readonly drain_recovery_generation: number;
  readonly last_drain_recovery_previous_generation: number | null;
  readonly plugin_catalog_hash: Sha256Digest | null;
  readonly cancel_requested: boolean;
  readonly prepare_started: boolean;
  readonly created_at: number;
  readonly updated_at: number;
};

export type ConfigurationOperation = ConfigurationOperationBase & (
  | { readonly state: 'pending'; readonly result_status: null; readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'committed' | 'publishing' | 'draining'; readonly result_status: null;
      readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'converged'; readonly result_status: 200; readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'degraded'; readonly result_status: 202;
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed' | 'control_readiness_failed'; readonly error_detail: string }
  | { readonly state: 'superseded'; readonly result_status: 409;
      readonly error_code: 'revision_superseded'; readonly error_detail: string }
);

export type ConfigurationOperationWorker = {
  readonly mutation_id: string;
  readonly worker_slot: number;
  readonly target_revision: number;
  readonly drain_recovery_generation: number;
  readonly attempt_no: number;
  readonly last_begin_previous_attempt_no: number | null;
  readonly last_begin_reason: 'initial' | 'retry' | 'master_recovery' | null;
  readonly updated_at: number;
} & (
  | { readonly state: 'pending'; readonly applied_revision: null; readonly last_error: null }
  | { readonly state: 'converged'; readonly applied_revision: number; readonly last_error: null }
  | { readonly state: 'failed'; readonly applied_revision: number | null; readonly last_error: string }
);

export type ConfigurationOperationState = {
  readonly operation: ConfigurationOperation;
  readonly workers: readonly ConfigurationOperationWorker[];
};

export type ConfigurationRecovery = {
  readonly recovery_id: string;
  readonly target_revision: number;
  readonly trigger: 'automatic' | 'manual';
  readonly state: 'scheduled' | 'running' | 'succeeded' | 'stopped';
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly next_retry_at: number | null;
  readonly final_reason_code?: string | null;
};

export type ConfigurationPublication = {
  readonly operation: null | {
    readonly operation_id: string;
    readonly committed_revision: number;
    readonly state: ConfigurationOperation['state'];
    readonly result_status: number | null;
    readonly error_code: string | null;
    readonly updated_at: number;
  };
  readonly cleanup: ConfigurationCleanup | null;
  readonly recovery: ConfigurationRecovery | null;
  readonly retryable: boolean;
  readonly serving_complete: boolean;
  readonly serving_revision: number | null;
  readonly target_revision: number;
};

export type ConfigurationCleanup = {
  readonly active: boolean;
  readonly state: 'pending' | 'stopped' | 'released';
  readonly reason_code: 'exit_unknown' | 'cleanup_unknown' | 'release_unknown' | null;
  readonly pending_count: number;
  readonly exit_unknown_count: number;
  readonly failed_count: number;
  readonly unknown_count: number;
  readonly remaining_ms: number | null;
  readonly members: readonly {
    readonly slot: number;
    readonly exit_state: 'live' | 'confirmed' | 'unknown';
    readonly cleanup_state: 'success' | 'failed' | 'unknown';
    readonly remaining_ms: number | null;
  }[];
};

export type ConfigurationRuntimeHealth = {
  readonly observed_at: number;
  readonly component_recovery: readonly {
    readonly component: 'ingress' | 'config_storage' | 'plugin_state';
    readonly state: 'healthy' | 'recovering' | 'stopped' | 'unknown';
    readonly reason_code: string | null;
    readonly attempt_count: number | null;
    readonly max_attempts: number | null;
    readonly next_retry_at: number | null;
  }[];
  readonly dependencies: readonly {
    readonly component: string;
    readonly state: 'ready' | 'unavailable' | 'stopped';
    readonly fresh: boolean;
    readonly observed_at: number | null;
  }[];
};

export type ConfigurationRuntime = ConfigurationSnapshot & {
  readonly health: ConfigurationRuntimeHealth | null;
  readonly publication: ConfigurationPublication;
  readonly workers: readonly {
    readonly slot: number;
    readonly pid: number;
    readonly private_port: number;
    readonly revision: number;
    readonly content_hash: Sha256Digest;
    readonly plugin_catalog_hash: Sha256Digest;
    readonly publication: unknown;
  }[];
};

type AcceptedConfigurationOperation = ConfigurationOperationState & {
  readonly operation_id: string;
  readonly revision: number;
};

type ValidationResponse = {
  readonly valid: boolean;
  readonly errors: readonly { readonly path: string; readonly message: string }[];
};

export type ConfigurationCommitOptions = {
  /** Persistence ACK ends a save; 'converged' waits for application and is opt-in only. */
  readonly completion?: 'committed' | 'converged';
  readonly nextAuthorization?: string;
  readonly managementSetup?: unknown;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Called once before the only write. Retain this identity until the ACK is validated or the write is definitively rejected. */
  readonly onDispatch?: (mutationId: string) => void;
  /** Called with a validated ACK: saved, not necessarily applied. */
  readonly onOperation?: (state: ConfigurationOperationState) => void;
};

export class ConfigurationStaleError extends Error {
  readonly name = 'ConfigurationStaleError';
  constructor(readonly expectedRevision: number, readonly response: unknown) {
    super('The configuration changed. Reload it and review your changes before saving again.');
  }
}

export class ConfigurationValidationError extends Error {
  readonly name = 'ConfigurationValidationError';
  constructor(readonly errors: unknown) { super('Configuration validation failed'); }
}

export class ConfigurationRouteCopyProtectedError extends Error {
  readonly name = 'ConfigurationRouteCopyProtectedError';
  constructor() { super('受保护路由不能直接复制，以免副本丢失访问限制。请创建新路由并配置访问权限。'); }
}

export class ConfigurationOperationDegradedError extends Error {
  readonly name = 'ConfigurationOperationDegradedError';
  constructor(readonly operation: Extract<ConfigurationOperation, { readonly state: 'degraded' }>) {
    super(operation.error_detail);
  }
}

export class ConfigurationOperationTimeoutError extends Error {
  readonly name = 'ConfigurationOperationTimeoutError';
  constructor(readonly mutationId: string, readonly timeoutMs: number) {
    super('暂时无法确认配置是否生效，请稍后刷新状态。');
  }
}

export class ConfigurationSubmissionUnknownError extends Error {
  readonly name = 'ConfigurationSubmissionUnknownError';
  constructor(readonly mutationId: string, cause: unknown) {
    super('暂时无法确认配置是否保存成功，请先确认结果再保存，不要重复保存。', { cause });
  }
}


export class ConfigurationNextAuthorizationRequiredError extends Error {
  readonly name = 'ConfigurationNextAuthorizationRequiredError';
  constructor() { super('A new access token is required when changing authentication'); }
}



function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForConfigurationOperation(
  mutationId: string,
  options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number; readonly headers?: Headers;
    readonly onOperation?: (state: ConfigurationOperationState) => void } = {},
): Promise<ConfigurationOperationState> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = await readConfigurationOperation(mutationId, options.headers);
    options.onOperation?.(state);
    const terminal = inspectTerminal(state);
    if (terminal !== null) return terminal;
    await delay(pollIntervalMs);
  }
  throw new ConfigurationOperationTimeoutError(mutationId, timeoutMs);
}

export function inspectTerminal(state: ConfigurationOperationState): ConfigurationOperationState | null {
  switch (state.operation.state) {
    case 'converged':
    case 'superseded':
      return state;
    case 'degraded':
      throw new ConfigurationOperationDegradedError(state.operation);
    case 'pending':
    case 'committed':
    case 'publishing':
    case 'draining':
      return null;
  }
}

function apiErrorBody(error: ApiError): { readonly error?: unknown; readonly errors?: unknown } {
  return typeof error.body === 'object' && error.body !== null ? error.body : {};
}


function trustedOperation(state: ConfigurationOperationState | null | undefined, mutationId: string, expectedRevision?: number): boolean {
  if (!state || typeof state !== 'object' || typeof state.operation !== 'object' || state.operation === null) return false;
  const operation = state.operation as Partial<ConfigurationOperation>;
  if (operation.mutation_id !== mutationId) return false;
  if (typeof operation.committed_revision !== 'number' || !Number.isSafeInteger(operation.committed_revision) || operation.committed_revision <= 0
    || typeof operation.expected_revision !== 'number' || !Number.isSafeInteger(operation.expected_revision) || operation.expected_revision <= 0
    || operation.committed_revision !== operation.expected_revision + 1 || !Array.isArray(state.workers)
    || (expectedRevision !== undefined && operation.expected_revision !== expectedRevision)
    || operation.result_status !== (operation.state === 'converged' ? 200 : operation.state === 'degraded' ? 202 : operation.state === 'superseded' ? 409 : null)) return false;
  return ['pending', 'committed', 'publishing', 'draining', 'converged', 'degraded', 'superseded']
    .includes(String(operation.state));
}

export function trustedConfigurationOperation(state: ConfigurationOperationState | null | undefined, mutationId: string, expectedRevision?: number): state is ConfigurationOperationState {
  return trustedOperation(state, mutationId, expectedRevision);
}

function trustedAccepted<T extends AcceptedConfigurationOperation>(accepted: T | null | undefined, mutationId: string, expectedRevision?: number): accepted is T {
  return !!accepted && accepted.operation_id === mutationId && trustedOperation(accepted, mutationId, expectedRevision)
    && accepted.revision === accepted.operation.committed_revision;
}

/** Any outcome not proven by this exact identity stays unknown and keeps the mutation ID. */
async function resolveUnknown(mutationId: string, pollHeaders: Headers | undefined, cause: unknown, expectedRevision?: number): Promise<AcceptedConfigurationOperation> {
  try {
    const state = await getConfigurationOperation(mutationId, pollHeaders);
    if (!trustedOperation(state, mutationId, expectedRevision)) throw new ConfigurationSubmissionUnknownError(mutationId, cause);
    return { ...state, operation_id: mutationId, revision: state.operation.committed_revision };
  } catch (error) {
    if (error instanceof ConfigurationSubmissionUnknownError) throw error;
    throw new ConfigurationSubmissionUnknownError(mutationId, cause);
  }
}

const preCommitServerCodes = new Set(['control_recovering', 'control_readiness_failed']);

/** True only when the server proved the write was not committed. */
export function isDefinitiveConfigurationRejection(error: unknown): boolean {
  if (error instanceof ConfigurationStaleError || error instanceof ConfigurationValidationError
    || error instanceof ConfigurationOperationDegradedError || error instanceof ConfigurationRouteCopyProtectedError) return true;
  if (!(error instanceof ApiError)) return false;
  if (error.status >= 500) {
    const code = apiErrorBody(error).error;
    return typeof code === 'string' && preCommitServerCodes.has(code);
  }
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 425;
}

export async function getConfigSnapshot(headers?: Headers): Promise<ConfigurationSnapshot> {
  return await api.get<ConfigurationSnapshot>('/config', headers ? { headers, preserveSessionOnUnauthorized: true } : undefined);
}

export async function getConfig(): Promise<LogicalConfiguration> {
  return (await getConfigSnapshot()).config.logical_configuration;
}

export async function getRuntimeConfig(signal?: AbortSignal, headers?: Headers, timeoutMs = 8000): Promise<ConfigurationRuntime> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      api.get<ConfigurationRuntime>('/config/runtime', { signal: controller.signal, headers, preserveSessionOnUnauthorized: !!headers }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { abort(); reject(new Error('runtime_timeout')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer!); signal?.removeEventListener('abort', abort); }
}

function supersededOperationState(body: unknown, mutationId: string): ConfigurationOperationState | null {
  if (typeof body !== 'object' || body === null) return null;
  const operation = (body as { operation?: unknown }).operation;
  if (typeof operation !== 'object' || operation === null) return null;
  const value = operation as Record<string, unknown>;
  if (value.mutation_id !== mutationId || value.state !== 'superseded'
    || value.result_status !== 409 || value.error_code !== 'revision_superseded') return null;
  const workers = (body as { workers?: unknown }).workers;
  return { operation: operation as ConfigurationOperation, workers: Array.isArray(workers) ? workers as ConfigurationOperationWorker[] : [] };
}

async function readConfigurationOperation(mutationId: string, headers?: Headers): Promise<ConfigurationOperationState> {
  try {
    return await api.get(`/config/operations/${encodeURIComponent(mutationId)}`, { headers, preserveSessionOnUnauthorized: true });
  } catch (error) {
    // A superseded terminal is reported as 409. Recognize it only when the body
    // proves this exact identity; anything else stays a read error.
    if (error instanceof ApiError) {
      const state = supersededOperationState(error.body, mutationId);
      if (state !== null) return state;
    }
    throw error;
  }
}

export function getConfigurationOperation(mutationId: string, headers?: Headers): Promise<ConfigurationOperationState> {
  return readConfigurationOperation(mutationId, headers);
}

export function validateAggregate(aggregate: ConfigurationAggregate): Promise<ValidationResponse> {
  return api.post('/config/validate', { aggregate });
}

export type ConfigurationCleanupRetry = {readonly request_id:string;readonly source_mutation_id:string;readonly target_revision:number;readonly status:'accepted'};
export function retryConfigurationPublication(operationId: string, requestId: string, expectedRevision: number): Promise<ConfigurationRecovery|ConfigurationCleanupRetry> {
  return api.post<ConfigurationRecovery|ConfigurationCleanupRetry>(`/config/operations/${encodeURIComponent(operationId)}/retry`, {
    request_id: requestId,
    expected_revision: expectedRevision,
  });
}

/**
 * Builds the next-authorization headers required when a commit changes the
 * auth surface. The candidate token is returned separately and must only be
 * persisted after the operation converges.
 */
function prepareNextAuthorization(
  _snapshot: ConfigurationSnapshot,
  _aggregate: ConfigurationAggregate,
  options: ConfigurationCommitOptions,
): { readonly headers: Headers; readonly pollHeaders: Headers } {
  const headers = new Headers(), pollHeaders = new Headers();
  if (options.nextAuthorization) {
    const candidate = options.nextAuthorization.startsWith('Bearer ') ? options.nextAuthorization : `Bearer ${options.nextAuthorization}`;
    headers.set('X-Bungee-Next-Authorization', candidate);
    // A reconciled read after a lost response must use the candidate credential that the write proved.
    pollHeaders.set('Authorization', candidate);
  }
  return { headers, pollHeaders };
}

export async function commitConfiguration(
  snapshot: ConfigurationSnapshot,
  aggregate: ConfigurationAggregate,
  options: ConfigurationCommitOptions = {},
): Promise<ConfigurationOperationState> {
  const mutationId = uuidv4();
  const { headers, pollHeaders } = prepareNextAuthorization(snapshot, aggregate, options);
  return submitConfigurationOperation(mutationId, () => api.put<AcceptedConfigurationOperation>('/config', {
    expected_revision: snapshot.revision,
    aggregate,
    ...(options.managementSetup ? {managementSetup:options.managementSetup} : {}),
    mutation_id: mutationId,
  }, { headers }), options, pollHeaders, snapshot.revision);
}

export function duplicateConfigurationRoute(path: string, options: ConfigurationCommitOptions = {}): Promise<ConfigurationOperationState> {
  const mutationId = uuidv4();
  return submitConfigurationOperation(mutationId, () => api.post<AcceptedConfigurationOperation>('/routes/duplicate', {
    path, mutation_id: mutationId,
  }), options);
}

async function submitConfigurationOperation(
  mutationId: string,
  submit: () => Promise<AcceptedConfigurationOperation>,
  options: ConfigurationCommitOptions,
  pollHeaders?: Headers,
  expectedRevision?: number,
): Promise<ConfigurationOperationState> {
  options.onDispatch?.(mutationId);
  let accepted: AcceptedConfigurationOperation | null = null;
  try {
    accepted = await submit();
  } catch (error) {
    if (isDefinitiveConfigurationRejection(error)) {
      if (error instanceof ApiError) {
        const body = apiErrorBody(error);
        if (body.error === 'route_copy_protected') throw new ConfigurationRouteCopyProtectedError();
        if (error.status === 409 && expectedRevision !== undefined) throw new ConfigurationStaleError(expectedRevision, error.body);
        if (error.status === 422) throw new ConfigurationValidationError(body.errors);
      }
      throw error;
    }
    // The write may have committed before its response was lost or unconfirmed. Only the
    // original identity can prove the outcome; never accept another ID or resubmit.
    accepted = await resolveUnknown(mutationId, pollHeaders, error, expectedRevision);
  }

  // A 2xx with a malformed or foreign identity is not an ACK. Reconcile this ID once;
  // anything still unproven keeps the marker for an explicit unknown result.
  const confirmed = trustedAccepted(accepted, mutationId, expectedRevision)
    ? accepted
    : await resolveUnknown(mutationId, pollHeaders, new Error('untrusted_ack'), expectedRevision);

  options.onOperation?.(confirmed);
  if (options.completion === 'committed') return confirmed;
  const terminal = inspectTerminal(confirmed) ?? await waitForConfigurationOperation(mutationId, {
    timeoutMs: options.timeoutMs ?? 15_000,
    pollIntervalMs: options.pollIntervalMs,
    headers: pollHeaders,
    onOperation: options.onOperation,
  });
  return terminal;
}

export type ConfigurationImportEnvelope = {
  readonly aggregate: ConfigurationAggregate;
  readonly [key: string]: unknown;
};

export type ConfigurationImportPreview = {
  readonly valid: true;
  readonly errors: readonly [];
  readonly aggregate: ConfigurationAggregate;
};

/** Preview the same normalized configuration that the sealed import will commit. */
export function validateImport(envelope: ConfigurationImportEnvelope): Promise<ConfigurationImportPreview> {
  return api.post('/config/validate', { envelope });
}

type AcceptedImportOperation = ConfigurationOperationState & {
  readonly operation_id: string;
  readonly revision: number;
};

export async function importConfig(
  snapshot: ConfigurationSnapshot,
  envelope: ConfigurationImportEnvelope,
  options: ConfigurationCommitOptions = {},
): Promise<ConfigurationOperationState> {
  const { headers, pollHeaders } = prepareNextAuthorization(snapshot, envelope.aggregate, options);
  // Same UUID-v4 wire contract on LAN HTTP, where native randomUUID may be unavailable.
  const mutationId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : uuidv4();
  return submitConfigurationOperation(mutationId, () => api.post<AcceptedImportOperation>('/config/import', {
    expected_revision: snapshot.revision, mutation_id: mutationId, envelope, ...(options.managementSetup?{managementSetup:options.managementSetup}:{}),
  }, { headers }), options, pollHeaders, snapshot.revision);
}

export async function commitLogicalConfiguration(
  snapshot: ConfigurationSnapshot,
  logicalConfiguration: LogicalConfiguration,
  options?: ConfigurationCommitOptions,
): Promise<ConfigurationOperationState> {
  return await commitConfiguration(snapshot, {
    ...snapshot.config,
    logical_configuration: logicalConfiguration,
  }, options);
}

export async function updateConfig(
  snapshot: ConfigurationSnapshot,
  config: LogicalConfiguration,
  options?: ConfigurationCommitOptions,
): Promise<{ readonly success: true; readonly message: string }> {
  await commitLogicalConfiguration(snapshot, config, options);
  return { success: true, message: 'converged' };
}

export async function validateConfig(
  snapshot: ConfigurationSnapshot,
  config: LogicalConfiguration,
): Promise<{ readonly valid: boolean; readonly error?: string }> {
  const result = await api.post<ValidationResponse>('/config/validate', {
    aggregate: { ...snapshot.config, logical_configuration: config },
  });
  return result.errors.length === 0
    ? { valid: result.valid }
    : { valid: result.valid, error: result.errors.map(({ path, message }) => `${path || 'config'}: ${message}`).join('; ') };
}
