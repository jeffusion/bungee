import type { AuthConfig } from '$types';

export function toggleAuth(value: AuthConfig | undefined, enabled: boolean): AuthConfig {
  return { ...value, enabled, tokens: [...(value?.tokens ?? [])] };
}
