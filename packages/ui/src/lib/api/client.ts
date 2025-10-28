import { getToken, logout } from '../stores/auth';

const API_BASE = '/__ui/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path}`;

  // 1. 读取 token 并添加到 Authorization header
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>)
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  // 2. 处理 401 错误：清除 token 并重定向到登录页面
  if (response.status === 401) {
    logout(); // 清除本地 token
    window.location.hash = '#/login'; // 重定向到登录页面
    throw new Error('Unauthorized: Please login');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data: any) => request<T>(path, {
    method: 'POST',
    body: JSON.stringify(data)
  }),
  put: <T>(path: string, data: any) => request<T>(path, {
    method: 'PUT',
    body: JSON.stringify(data)
  }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' })
};
