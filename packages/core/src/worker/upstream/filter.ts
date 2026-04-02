/**
 * Upstream filter module
 * Filters upstreams based on health status and recovery intervals
 */

import type { RuntimeUpstream } from '../types';
import { addJitter } from '../utils/jitter';

// Maximum recovery interval cap (24 hours)
const MAX_RECOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Calculate exponential backoff interval based on recovery attempt count
 * Formula: baseInterval * (2 ^ attemptCount) with jitter
 * Capped at MAX_RECOVERY_INTERVAL_MS to prevent excessive delays
 */
function calculateBackoffInterval(baseIntervalMs: number, attemptCount: number): number {
  const backoffMultiplier = Math.pow(2, attemptCount);
  const intervalWithBackoff = baseIntervalMs * backoffMultiplier;
  const cappedInterval = Math.min(intervalWithBackoff, MAX_RECOVERY_INTERVAL_MS);
  return addJitter(cappedInterval, 0.2);
}

/**
 * Checks if an upstream can be attempted based on its status and recovery interval
 *
 * Rules:
 * - HEALTHY: Always can be attempted
 * - HALF_OPEN: Always can be attempted (already in recovery test mode)
 * - UNHEALTHY: Check if exponential backoff recovery interval has elapsed
 *
 * Recovery interval uses exponential backoff:
 * - 1st attempt: baseInterval * 2^0 = baseInterval (default 5s)
 * - 2nd attempt: baseInterval * 2^1 = baseInterval * 2 (default 10s)
 * - 3rd attempt: baseInterval * 2^2 = baseInterval * 4 (default 20s)
 * - And so on, capped at MAX_RECOVERY_INTERVAL_MS (5 minutes)
 *
 * @param upstream - The upstream to check
 * @param recoveryIntervalMs - Base recovery interval in milliseconds
 * @returns Object indicating if upstream can be attempted and if it should transition to HALF_OPEN
 *
 * @example
 * ```typescript
 * const { canAttempt, shouldTransitionToHalfOpen } = canAttemptUpstream(upstream, 5000);
 * if (!canAttempt) {
 *   // Skip this upstream
 * } else if (shouldTransitionToHalfOpen) {
 *   upstream.status = 'HALF_OPEN';
 * }
 * ```
 */
export function canAttemptUpstream(
  upstream: RuntimeUpstream,
  recoveryIntervalMs: number
): { canAttempt: boolean; shouldTransitionToHalfOpen: boolean } {
  // HEALTHY upstreams can always be attempted
  if (upstream.status === 'HEALTHY') {
    return { canAttempt: true, shouldTransitionToHalfOpen: false };
  }

  // HALF_OPEN upstreams are already in recovery test mode
  if (upstream.status === 'HALF_OPEN') {
    return { canAttempt: true, shouldTransitionToHalfOpen: false };
  }

  // UNHEALTHY upstreams: check if exponential backoff recovery interval has elapsed
  if (upstream.status === 'UNHEALTHY' && upstream.lastFailureTime !== undefined) {
    const elapsed = Date.now() - upstream.lastFailureTime;
    const jitteredInterval = calculateBackoffInterval(
      recoveryIntervalMs,
      upstream.recoveryAttemptCount
    );

    if (elapsed >= jitteredInterval) {
      // Recovery interval met, can attempt and should transition to HALF_OPEN
      return { canAttempt: true, shouldTransitionToHalfOpen: true };
    }
  }

  // UNHEALTHY and recovery interval not met
  return { canAttempt: false, shouldTransitionToHalfOpen: false };
}
