import { api } from './client';

export type CircuitState = 'HEALTHY' | 'UNHEALTHY' | 'HALF_OPEN' | 'MIXED' | 'UNKNOWN';

export interface RuntimeUpstream {
  state_key: string;
  upstream_id: string;
  circuit_state: CircuitState;
  active_request_count: number | null;
  /** Maximum observed timestamp; completeness is independent of whether it is null. */
  last_used_time: number | null;
  last_used_complete: boolean;
  last_failure_time: number | null;
  last_failure_complete: boolean;
  workers: readonly Record<string, unknown>[];
}

interface RuntimeEnvelope {
  schema: 'bungee-runtime-upstreams-v1';
  generated_at: number;
  admission: Record<string, unknown> | null;
  workers: { observed: readonly Record<string, unknown>[]; missing: readonly Record<string, unknown>[] };
}

export type RuntimeUpstreamsResponse = RuntimeEnvelope & (
  | { availability: 'complete' | 'partial'; reason: null; upstreams: RuntimeUpstream[] }
  | { availability: 'unknown' | 'overflow'; reason: string; upstreams: [] }
);

export function getRuntimeUpstreams(): Promise<RuntimeUpstreamsResponse> {
  return api.get<RuntimeUpstreamsResponse>('/runtime/upstreams');
}

export function findRuntimeUpstream(response: RuntimeUpstreamsResponse | null, stateKey: string, id?: string): RuntimeUpstream | undefined {
  if (!id || !response || response.availability === 'unknown' || response.availability === 'overflow') return undefined;
  return response.upstreams.find(upstream => upstream.state_key === stateKey && upstream.upstream_id === id);
}

export function runtimeAvailabilityKey(response: RuntimeUpstreamsResponse | null): string {
  if (!response) return 'runtime.unavailable';
  if (response.availability === 'unknown' && response.reason === 'no_fresh_active_admission') return 'runtime.noAdmission';
  return `runtime.${response.availability}`;
}

export const runtimeStatus = {
  HEALTHY: { dot: 'ok', badge: 'active', key: 'upstreamsModal.statusHealthy' },
  UNHEALTHY: { dot: 'danger', badge: 'fault', key: 'upstreamsModal.statusUnhealthy' },
  HALF_OPEN: { dot: 'warn', badge: 'standby', key: 'upstreamsModal.statusHalfOpen' },
  MIXED: { dot: 'warn', badge: 'standby', key: 'runtime.mixed' },
  UNKNOWN: { dot: 'idle', badge: 'muted', key: 'upstreamsModal.statusUnknown' },
} as const;
