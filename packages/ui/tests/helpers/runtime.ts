import type { CircuitState, RuntimeUpstream, RuntimeUpstreamsResponse } from '../../src/api/runtime';

export function runtimeRecord(circuit_state: CircuitState = 'HEALTHY', patch: Partial<RuntimeUpstream> = {}): RuntimeUpstream {
  return { state_key: 'service', upstream_id: 'endpoint-id', circuit_state, active_request_count: 0,
    last_used_time: null, last_used_complete: true, last_failure_time: null, last_failure_complete: true,
    workers: [], ...patch };
}

export function runtimeResponse(upstreams: RuntimeUpstream[] = [runtimeRecord()]): Extract<RuntimeUpstreamsResponse, { availability: 'complete' | 'partial' }> {
  return { schema: 'bungee-runtime-upstreams-v1', generated_at: 1000, availability: 'complete', reason: null,
    admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams };
}

export function unavailableRuntime(reason = 'no_fresh_active_admission'): RuntimeUpstreamsResponse {
  return { ...runtimeResponse([]), availability: 'unknown', reason, admission: null, upstreams: [] };
}
