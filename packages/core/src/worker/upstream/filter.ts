/**
 * Upstream filter module
 * Filters upstreams based on health status and recovery intervals
 */

import type { RuntimeUpstream } from '../types';
import { addJitter } from '../utils/jitter';

/**
 * Checks if an upstream can be attempted based on its status and recovery interval
 *
 * Rules:
 * - HEALTHY: Always can be attempted
 * - HALF_OPEN: Always can be attempted (already in recovery test mode)
 * - UNHEALTHY: Check if recovery interval has elapsed
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

  // UNHEALTHY upstreams: check if recovery interval has elapsed
  if (upstream.status === 'UNHEALTHY' && upstream.lastFailureTime !== undefined) {
    const elapsed = Date.now() - upstream.lastFailureTime;
    const jitteredInterval = addJitter(recoveryIntervalMs, 0.2);

    if (elapsed >= jitteredInterval) {
      // Recovery interval met, can attempt and should transition to HALF_OPEN
      return { canAttempt: true, shouldTransitionToHalfOpen: true };
    }
  }

  // UNHEALTHY and recovery interval not met
  return { canAttempt: false, shouldTransitionToHalfOpen: false };
}
