import { ConfigRepositoryError } from '../config-storage/repository-types';
import type { StartupPublicationOutcome } from './coordinator-types';
import { MasterConfigPublicationError, type PublicationRecoveryDisposition } from './coordinator-types';

export type StartupRecoveryClassification =
  | { readonly kind: 'success'; readonly reason: 'target_serving' }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'deterministic'; readonly reason: Exclude<PublicationRecoveryDisposition, 'retryable' | 'fatal'> }
  | { readonly kind: 'fatal'; readonly error: unknown };

function neverDisposition(value: never): never {
  throw new TypeError(`unhandled recovery disposition: ${String(value)}`);
}

function classifyFailures(outcome: Extract<StartupPublicationOutcome, { readonly kind: 'startup_failed' }>): StartupRecoveryClassification {
  let retryable = false;
  for (const failure of outcome.failures) {
    switch (failure.recovery_disposition) {
      case 'retryable': retryable = true; break;
      case 'deterministic_worker_rejection':
        return { kind: 'deterministic', reason: 'deterministic_worker_rejection' };
      case 'deterministic_protocol_failure':
        return { kind: 'deterministic', reason: 'deterministic_protocol_failure' };
      case 'deterministic_control_failure':
        return { kind: 'deterministic', reason: 'deterministic_control_failure' };
      case 'fatal': return { kind: 'fatal', error: failure };
      default: return neverDisposition(failure.recovery_disposition);
    }
  }
  return retryable || outcome.failures.length === 0 ? { kind: 'retryable' }
    : { kind: 'retryable' };
}

export function classifyStartupOutcome(
  outcome: StartupPublicationOutcome,
  exactTarget: boolean,
): StartupRecoveryClassification {
  switch (outcome.kind) {
    case 'startup_outcome_unknown':
      return { kind: 'fatal', error: outcome.error };
    case 'startup_degraded':
      if (outcome.error_code === 'admission_outcome_unknown' || outcome.recovery_disposition === 'fatal') return { kind: 'fatal', error: outcome };
      for (const failure of outcome.failures) {
        switch (failure.recovery_disposition) {
          case 'fatal': return { kind: 'fatal', error: failure };
          case 'deterministic_worker_rejection':
            return { kind: 'deterministic', reason: 'deterministic_worker_rejection' };
          case 'deterministic_protocol_failure':
            return { kind: 'deterministic', reason: 'deterministic_protocol_failure' };
          case 'deterministic_control_failure':
            return { kind: 'deterministic', reason: 'deterministic_control_failure' };
          case 'retryable': break;
          default: return neverDisposition(failure.recovery_disposition);
        }
      }
      if (outcome.recovery_disposition === 'deterministic_control_failure') {
        return { kind: 'deterministic', reason: 'deterministic_control_failure' };
      }
      if (outcome.error_code === 'old_worker_drain_failed' && exactTarget) {
        return { kind: 'success', reason: 'target_serving' };
      }
      if (outcome.error_code === 'old_worker_drain_failed') {
        return { kind: 'fatal', error: new MasterConfigPublicationError('target_set_mismatch', 'degraded startup did not produce the exact target admission') };
      }
      return { kind: 'retryable' };
    case 'startup_ready':
      return exactTarget ? { kind: 'success', reason: 'target_serving' }
        : { kind: 'fatal', error: new MasterConfigPublicationError('target_set_mismatch', 'startup did not produce the exact target admission') };
    case 'startup_failed':
      return classifyFailures(outcome);
    default: return neverDisposition(outcome);
  }
}

export function classifyRecoveryError(error: unknown): PublicationRecoveryDisposition {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'invalid_options' || code === 'target_set_mismatch' || code === 'schema_corrupt'
    || code === 'connection_invariant' || code === 'migration_failed' || code === 'serving_snapshot_corrupt'
    || code === 'repository_failure') return 'fatal';
  if (error instanceof MasterConfigPublicationError) {
    switch (error.code) {
      case 'invalid_options':
      case 'target_set_mismatch':
        return 'fatal';
      case 'concurrent_publication':
        return 'retryable';
      default: return neverDisposition(error.code);
    }
  }
  if (error instanceof ConfigRepositoryError) {
    switch (error.code) {
      case 'schema_corrupt':
      case 'connection_invariant':
      case 'migration_failed':
      case 'serving_snapshot_corrupt':
      case 'repository_failure':
        return 'fatal';
      case 'invalid_operation':
      case 'cas_conflict':
      case 'retry_not_due':
      case 'attempts_exhausted':
      case 'stale_revision':
      case 'source_not_retryable':
      case 'idempotency_key_reused':
      case 'recovery_in_progress':
      case 'invalid_command':
      case 'invalid_configuration':
        return 'retryable';
      default: return neverDisposition(error.code);
    }
  }
  return 'retryable';
}

export function classifyControlError(error: unknown): 'retryable' | 'deterministic_control_failure' | 'fatal' {
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'invalid_options' || code === 'target_set_mismatch' || code === 'schema_corrupt'
    || code === 'connection_invariant' || code === 'migration_failed' || code === 'serving_snapshot_corrupt'
    || code === 'repository_failure') return 'fatal';
  if (code === 'not_declared' || code === 'method_not_allowed' || code === 'invalid_binding'
    || code === 'key_unavailable' || code === 'restart_required' || code === 'disposed') {
    return 'deterministic_control_failure';
  }
  return 'retryable';
}
