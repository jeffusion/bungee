import { get } from 'svelte/store';
import { csrfToken } from '$stores/auth';
import { getToken, logout, authenticationRequestGuard } from '$stores/auth';

const API_BASE = '/api';

export class ApiError extends Error {
  readonly name = 'ApiError';

  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return `Request failed with status ${status}`;
}

export type ApiRequestOptions = RequestInit & { preserveSessionOnUnauthorized?: boolean };
type ManagementAuthPolicy = { readonly provider?: string; readonly cookieOnly?: boolean };
async function request<T>(path: string, options: ApiRequestOptions = {}, base = API_BASE, managementAuth?: ManagementAuthPolicy): Promise<T> {
  const url = `${base}${path}`;
  const mayInvalidateSession = authenticationRequestGuard();
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (managementAuth?.provider !== undefined) headers.set('X-Bungee-Auth-Provider', managementAuth.provider);
  if (managementAuth?.cookieOnly || managementAuth?.provider !== undefined) {
    headers.delete('Authorization');
    headers.delete('X-CSRF-Token');
  } else if (!headers.has('Authorization') && token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const csrf = managementAuth?.cookieOnly || managementAuth?.provider !== undefined ? null : get(csrfToken);
  if (csrf && !['GET', 'HEAD'].includes(options.method ?? 'GET')) headers.set('X-CSRF-Token', csrf);

  const { preserveSessionOnUnauthorized, ...requestOptions } = options;
  const response = await fetch(url, {
    ...requestOptions,
    credentials: 'same-origin',
    headers
  });

  if (response.status === 401 && !preserveSessionOnUnauthorized && mayInvalidateSession()) {
    logout();
    if (typeof window !== 'undefined') window.location.hash = '#/login';
  }

  const data = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, data, errorMessage(data, response.status));
  }

  return data;
}

export const api = {
  get: <T>(path: string, options?: ApiRequestOptions) => request<T>(path, options),
  post: <T>(path: string, data: unknown, options?: ApiRequestOptions) => request<T>(path, {
    ...options,
    method: 'POST',
    body: JSON.stringify(data)
  }),
  put: <T>(path: string, data: unknown, options?: ApiRequestOptions) => request<T>(path, {
    ...options,
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' })
};

/** Fixed cookie-auth login transport for a selected management provider. */
export function managementLogin<T = unknown>(provider: string, input: unknown): Promise<T> {
  if (!provider.trim()) throw new Error('management_login_provider_invalid');
  return request<T>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
    preserveSessionOnUnauthorized: true,
  }, API_BASE, { provider });
}

/** Cookie-only host auth reads; plugin input cannot select an endpoint or transport. */
export function readManagementAuth<T>(endpoint: 'mode' | 'verify'): Promise<T> {
  return request<T>(`/auth/${endpoint}`, { preserveSessionOnUnauthorized: true }, API_BASE, { cookieOnly: true });
}

/** Control requests use the same optional dashboard credential policy as the SDK. */
export function requestPluginControl<T>(plugin: string, path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown, signal?: AbortSignal, options?: Pick<ApiRequestOptions, 'preserveSessionOnUnauthorized'>): Promise<T> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(plugin)
    || !/^\/[a-zA-Z0-9/_-]*(?:\?[^#\\]*)?$/.test(path)
    || path.includes('//') || path.includes('/../')) throw new Error('插件接口路径无效');
  return request<T>(`/plugins/${encodeURIComponent(plugin)}/control${path}`, {
    ...options, method, signal, ...(method === 'GET' ? {} : { body: JSON.stringify(body === undefined ? {} : body) }),
  }, '/api');
}
