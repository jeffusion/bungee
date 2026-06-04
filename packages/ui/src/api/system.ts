import { api } from './client';
import type { SystemInfo } from '$types';

export async function getSystemInfo(): Promise<SystemInfo> {
  return api.get<SystemInfo>('/system');
}

export async function reloadSystem(): Promise<{ success: boolean; message: string }> {
  return api.post('/system/reload', {});
}

export async function restartSystem(): Promise<{ success: boolean; message: string }> {
  return api.post('/system/restart', {});
}
