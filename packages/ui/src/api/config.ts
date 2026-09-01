import type {
  ConfigurationAggregateV2,
  LogicalConfigurationV2,
  Sha256Digest,
} from '@jeffusion/bungee-types';
import { v4 as uuidv4 } from 'uuid';
import { api, ApiError } from './client';
import { login, logout } from '$stores/auth';

export type ConfigurationSnapshot = {
  readonly config: ConfigurationAggregateV2;
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
  readonly created_at: number;
  readonly updated_at: number;
};

export type ConfigurationOperation = ConfigurationOperationBase & (
  | { readonly state: 'committed' | 'publishing' | 'draining'; readonly result_status: null;
      readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'converged'; readonly result_status: 200; readonly error_code: null; readonly error_detail: null }
  | { readonly state: 'degraded'; readonly result_status: 202;
      readonly error_code: 'replacement_convergence_failed' | 'old_worker_drain_failed'; readonly error_detail: string }
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

export type ConfigurationRuntime = ConfigurationSnapshot & {
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
  readonly nextAuthorization?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export class ConfigurationStaleError extends Error {
  readonly name = 'ConfigurationStaleError';
  constructor(readonly expectedRevision: number, readonly response: unknown) {
    super(`Configuration revision ${expectedRevision} is stale`);
  }
}

export class ConfigurationValidationError extends Error {
  readonly name = 'ConfigurationValidationError';
  constructor(readonly errors: unknown) { super('Configuration validation failed'); }
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
    super(`Configuration operation ${mutationId} did not converge within ${timeoutMs}ms`);
  }
}

export class ConfigurationOperationConflictError extends Error {
  readonly name = 'ConfigurationOperationConflictError';
  constructor(
    readonly operationId: string,
    readonly revision: number,
    readonly state: 'committed' | 'publishing' | 'draining',
  ) {
    super(`Configuration operation ${operationId} is ${state} at revision ${revision}`);
  }
}

export class ConfigurationOperationIdentityError extends Error {
  readonly name = 'ConfigurationOperationIdentityError';
  constructor(readonly requestedOperationId: string, readonly acceptedOperationId: string) {
    super(`Configuration operation identity mismatch: requested ${requestedOperationId}, accepted ${acceptedOperationId}`);
  }
}

export class ConfigurationNextAuthorizationRequiredError extends Error {
  readonly name = 'ConfigurationNextAuthorizationRequiredError';
  constructor() { super('A candidate authorization token is required when changing authentication'); }
}

function authChanged(current: LogicalConfigurationV2, next: LogicalConfigurationV2): boolean {
  if (current.auth?.enabled !== next.auth?.enabled) return true;
  const currentTokens = current.auth?.tokens ?? [];
  const nextTokens = next.auth?.tokens ?? [];
  return currentTokens.length !== nextTokens.length
    || currentTokens.some((token, index) => token !== nextTokens[index]);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitForConfigurationOperation(
  mutationId: string,
  options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number; readonly headers?: Headers } = {},
): Promise<ConfigurationOperationState> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = await api.get<ConfigurationOperationState>(
      `/config/operations/${mutationId}`,
      options.headers !== undefined ? { headers: options.headers } : undefined,
    );
    const terminal = inspectTerminal(state);
    if (terminal !== null) return terminal;
    await delay(pollIntervalMs);
  }
  throw new ConfigurationOperationTimeoutError(mutationId, timeoutMs);
}

export function inspectTerminal(state: ConfigurationOperationState): ConfigurationOperationState | null {
  switch (state.operation.state) {
    case 'converged':
      return state;
    case 'degraded':
      throw new ConfigurationOperationDegradedError(state.operation);
    case 'committed':
    case 'publishing':
    case 'draining':
      return null;
  }
}

function apiErrorBody(error: ApiError): { readonly error?: unknown; readonly errors?: unknown } {
  return typeof error.body === 'object' && error.body !== null ? error.body : {};
}

function operationConflict(body: unknown): ConfigurationOperationConflictError | null {
  if (typeof body !== 'object' || body === null
    || !('error' in body) || body.error !== 'operation_in_progress'
    || !('operation_id' in body) || typeof body.operation_id !== 'string'
    || !('revision' in body) || typeof body.revision !== 'number'
    || !('state' in body)
    || (body.state !== 'committed' && body.state !== 'publishing' && body.state !== 'draining')) return null;
  return new ConfigurationOperationConflictError(body.operation_id, body.revision, body.state);
}

export async function getConfigSnapshot(): Promise<ConfigurationSnapshot> {
  return await api.get<ConfigurationSnapshot>('/config');
}

export async function getConfig(): Promise<LogicalConfigurationV2> {
  return (await getConfigSnapshot()).config.logical_configuration;
}

export async function getRuntimeConfig(): Promise<ConfigurationRuntime> {
  return await api.get<ConfigurationRuntime>('/config/runtime');
}

/**
 * Builds the next-authorization headers required when a commit changes the
 * auth surface. The candidate token is returned separately and must only be
 * persisted after the operation converges.
 */
function prepareNextAuthorization(
  snapshot: ConfigurationSnapshot,
  aggregate: ConfigurationAggregateV2,
  options: ConfigurationCommitOptions,
): { readonly headers: Headers; readonly pollHeaders: Headers; readonly nextToken?: string } {
  const headers = new Headers();
  const pollHeaders = new Headers();
  if (authChanged(snapshot.config.logical_configuration, aggregate.logical_configuration)
    && aggregate.logical_configuration.auth?.enabled === true) {
    const candidate = options.nextAuthorization;
    if (!candidate) throw new ConfigurationNextAuthorizationRequiredError();
    const nextToken = candidate.startsWith('Bearer ') ? candidate.slice('Bearer '.length) : candidate;
    const authorization = candidate.startsWith('Bearer ') ? candidate : `Bearer ${candidate}`;
    headers.set('X-Bungee-Next-Authorization', authorization);
    pollHeaders.set('Authorization', authorization);
    return { headers, pollHeaders, nextToken };
  }
  return { headers, pollHeaders };
}

export async function commitConfiguration(
  snapshot: ConfigurationSnapshot,
  aggregate: ConfigurationAggregateV2,
  options: ConfigurationCommitOptions = {},
): Promise<ConfigurationOperationState> {
  const mutationId = uuidv4();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const { headers, pollHeaders, nextToken } = prepareNextAuthorization(snapshot, aggregate, options);

  let accepted: AcceptedConfigurationOperation;
  try {
    accepted = await api.put<AcceptedConfigurationOperation>('/config', {
      expected_revision: snapshot.revision,
      aggregate,
      mutation_id: mutationId,
    }, { headers });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const body = apiErrorBody(error);
    const conflict = operationConflict(error.body);
    if (conflict !== null) throw conflict;
    if (error.status === 409) throw new ConfigurationStaleError(snapshot.revision, error.body);
    if (error.status === 422) throw new ConfigurationValidationError(body.errors);
    throw error;
  }

  if (accepted.operation_id !== mutationId) {
    throw new ConfigurationOperationIdentityError(mutationId, accepted.operation_id);
  }

  const terminal = inspectTerminal(accepted) ?? await waitForConfigurationOperation(mutationId, {
    timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    headers: pollHeaders,
  });
  if (nextToken !== undefined) login(nextToken);
  else if (authChanged(snapshot.config.logical_configuration, aggregate.logical_configuration)
    && aggregate.logical_configuration.auth?.enabled !== true) logout();
  return terminal;
}

export type ConfigurationImportEnvelope = {
  readonly aggregate: ConfigurationAggregateV2;
  readonly [key: string]: unknown;
};

type AcceptedImportOperation = ConfigurationOperationState & {
  readonly operation_id: string;
  readonly revision: number;
};

export async function importConfig(
  snapshot: ConfigurationSnapshot,
  envelope: ConfigurationImportEnvelope,
  options: ConfigurationCommitOptions = {},
): Promise<ConfigurationOperationState> {
  const { headers, pollHeaders, nextToken } = prepareNextAuthorization(snapshot, envelope.aggregate, options);

  let accepted: AcceptedImportOperation;
  try {
    accepted = await api.post<AcceptedImportOperation>('/config/import', envelope, { headers });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const conflict = operationConflict(error.body);
    if (conflict !== null) throw conflict;
    throw error;
  }

  const terminal = inspectTerminal(accepted) ?? await waitForConfigurationOperation(accepted.operation_id, {
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    headers: pollHeaders,
  });
  if (nextToken !== undefined) login(nextToken);
  else if (authChanged(snapshot.config.logical_configuration, envelope.aggregate.logical_configuration)
    && envelope.aggregate.logical_configuration.auth?.enabled !== true) logout();
  return terminal;
}

export async function commitLogicalConfiguration(
  snapshot: ConfigurationSnapshot,
  logicalConfiguration: LogicalConfigurationV2,
  options?: ConfigurationCommitOptions,
): Promise<ConfigurationOperationState> {
  return await commitConfiguration(snapshot, {
    ...snapshot.config,
    logical_configuration: logicalConfiguration,
  }, options);
}

export async function updateConfig(
  snapshot: ConfigurationSnapshot,
  config: LogicalConfigurationV2,
  options?: ConfigurationCommitOptions,
): Promise<{ readonly success: true; readonly message: string }> {
  await commitLogicalConfiguration(snapshot, config, options);
  return { success: true, message: 'converged' };
}

export async function validateConfig(
  snapshot: ConfigurationSnapshot,
  config: LogicalConfigurationV2,
): Promise<{ readonly valid: boolean; readonly error?: string }> {
  const result = await api.post<ValidationResponse>('/config/validate', {
    aggregate: { ...snapshot.config, logical_configuration: config },
  });
  return result.errors.length === 0
    ? { valid: result.valid }
    : { valid: result.valid, error: result.errors.map(({ path, message }) => `${path || 'config'}: ${message}`).join('; ') };
}
