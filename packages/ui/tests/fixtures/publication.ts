import type { ConfigurationPublication, ConfigurationRuntime } from '../../src/api/config';

export function publicationFixture(patch: Partial<ConfigurationPublication> = {}): ConfigurationPublication {
  return {
    operation: { operation_id: '10000000-0000-4000-8000-000000000001', committed_revision: 8,
      state: 'degraded', result_status: 202, error_code: 'replacement_convergence_failed' },
    recovery: { recovery_id: '20000000-0000-4000-8000-000000000002', target_revision: 8,
      trigger: 'automatic', state: 'stopped', attempt_count: 6, max_attempts: 6,
      next_retry_at: null, final_reason_code: 'retry_exhausted' },
    retryable: true, serving_complete: false, serving_revision: 7, target_revision: 8, ...patch,
  };
}

export function configurationRuntimeFixture(publication = publicationFixture()): ConfigurationRuntime {
  return {
    revision: publication.target_revision, content_hash: `sha256:${'a'.repeat(64)}`,
    config: { logical_configuration: { auth: { enabled: false, tokens: [] }, routes: [], services: [], plugins: [] }, plugin_activations: [] },
    workers: [], publication,
  };
}
