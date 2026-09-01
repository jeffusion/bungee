import { api } from './client';
import type { SystemInfo } from '$types';

export async function getSystemInfo(): Promise<SystemInfo> {
  return api.get<SystemInfo>('/system');
}
