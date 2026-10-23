/**
 * Slow start utility functions
 * Gradually increases traffic to recovering upstreams to prevent overload
 */

import type { RuntimeUpstream, RuntimeCandidate } from '../types';
import type { EffectiveRouteConfig } from '../types';

/**
 * Calculate slow start weight factor for an upstream
 *
 * Slow start gradually increases the effective weight of a recently recovered
 * upstream from initial_weight_factor to 1.0 over the configured duration.
 *
 * @param upstream - Runtime upstream to calculate weight for
 * @param route - Route configuration
 * @returns Effective weight factor (0-1)
 *
 * @example
 * ```typescript
 * // With 30s slow start duration:
 * // t=0s:  factor=0.1 (10% of normal weight)
 * // t=15s: factor=0.55 (55% of normal weight)
 * // t=30s: factor=1.0 (100% of normal weight)
 * const factor = calculateSlowStartFactor(upstream, route);
 * const effectiveWeight = upstream.weight * factor;
 * ```
 */
export function calculateSlowStartFactor(
  upstream: RuntimeCandidate,
  route: EffectiveRouteConfig
): number {
  // If slow start is not enabled, return 1.0 (full weight)
  if (!route.failover?.slow_start?.enabled) {
    return 1.0;
  }

  // If no recovery time is set, return 1.0 (not in slow start)
  if (!upstream.slow_start_recovery_time) {
    return 1.0;
  }

  const config = route.failover.slow_start;
  const duration_ms = config.duration_ms ?? 30000; // Default 30 seconds
  const initialFactor = config.initial_weight_factor ?? 0.1; // Default 10%

  const elapsed = Date.now() - upstream.slow_start_recovery_time;

  // If slow start period has passed, return 1.0 (full weight)
  if (elapsed >= duration_ms) {
    // Clear slow start state
    upstream.slow_start_recovery_time = undefined;
    upstream.slow_start_weight_factor = 1.0;
    return 1.0;
  }

  // Calculate linear progression from initialFactor to 1.0
  const progress = elapsed / duration_ms;
  const factor = initialFactor + (1.0 - initialFactor) * progress;

  // Update cached factor
  upstream.slow_start_weight_factor = factor;

  return factor;
}

/**
 * Get effective weight for an upstream considering slow start
 *
 * @param upstream - Runtime upstream
 * @param route - Route configuration
 * @returns Effective weight
 */
export function getEffectiveWeight(
  upstream: RuntimeCandidate,
  route: EffectiveRouteConfig
): number {
  const baseWeight = upstream.weight ?? 100;
  const slow_startFactor = calculateSlowStartFactor(upstream, route);
  return Math.max(1, Math.round(baseWeight * slow_startFactor));
}

/**
 * Activate slow start for an upstream
 *
 * Should be called when an upstream transitions from UNHEALTHY to HEALTHY
 *
 * @param upstream - Runtime upstream to activate slow start for
 * @param route - Route configuration
 */
export function activateSlowStart(
  upstream: RuntimeCandidate,
  route: EffectiveRouteConfig
): void {
  if (!route.failover?.slow_start?.enabled) {
    return;
  }

  upstream.slow_start_recovery_time = Date.now();
  upstream.slow_start_weight_factor = route.failover.slow_start.initial_weight_factor ?? 0.1;
}

/**
 * Deactivate slow start for an upstream
 *
 * Should be called when an upstream becomes UNHEALTHY again
 *
 * @param upstream - Runtime upstream to deactivate slow start for
 */
export function deactivateSlowStart(upstream: RuntimeCandidate): void {
  upstream.slow_start_recovery_time = undefined;
  upstream.slow_start_weight_factor = undefined;
}

/**
 * Check if an upstream is in slow start period
 *
 * @param upstream - Runtime upstream to check
 * @returns True if in slow start period
 */
export function isInSlowStart(upstream: RuntimeCandidate): boolean {
  return upstream.slow_start_recovery_time !== undefined;
}

/**
 * Get slow start progress percentage
 *
 * @param upstream - Runtime upstream
 * @param route - Route configuration
 * @returns Progress percentage (0-100)
 */
export function getSlowStartProgress(
  upstream: RuntimeCandidate,
  route: EffectiveRouteConfig
): number {
  if (!upstream.slow_start_recovery_time) {
    return 100; // Not in slow start or completed
  }

  const duration_ms = route.failover?.slow_start?.duration_ms ?? 30000;
  const elapsed = Date.now() - upstream.slow_start_recovery_time;
  const progress = Math.min(100, (elapsed / duration_ms) * 100);

  return Math.round(progress);
}
