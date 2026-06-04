import { api } from './client';
import type { AppConfig, ValidationResult } from '$types';

export async function getConfig(): Promise<AppConfig> {
  return api.get<AppConfig>('/config');
}

export async function updateConfig(config: AppConfig): Promise<{ success: boolean; message: string }> {
  return api.put('/config', config);
}

export async function validateConfig(config: AppConfig): Promise<ValidationResult> {
  return api.post('/config/validate', config);
}
