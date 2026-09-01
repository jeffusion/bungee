import { getToken, logout } from '$stores/auth';

const API_BASE = '/__ui/api';

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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const token = getToken();
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (!headers.has('Authorization') && token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401) {
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
  get: <T>(path: string, options?: RequestInit) => request<T>(path, options),
  post: <T>(path: string, data: unknown, options?: RequestInit) => request<T>(path, {
    ...options,
    method: 'POST',
    body: JSON.stringify(data)
  }),
  put: <T>(path: string, data: unknown, options?: RequestInit) => request<T>(path, {
    ...options,
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' })
};
