/**
 * Slow start utility functions
 * Gradually increases traffic to recovering upstreams to prevent overload
 */

import type { RuntimeUpstream } from '../types';
import type { RouteConfig } from '@jeffusion/bungee-shared';

/**
 * Calculate slow start weight factor for an upstream
 *
 * Slow start gradually increases the effective weight of a recently recovered
 * upstream from initialWeightFactor to 1.0 over the configured duration.
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
  upstream: RuntimeUpstream,
  route: RouteConfig
): number {
  // If slow start is not enabled, return 1.0 (full weight)
  if (!route.failover?.slowStart?.enabled) {
    return 1.0;
  }

  // If no recovery time is set, return 1.0 (not in slow start)
  if (!upstream.slowStartRecoveryTime) {
    return 1.0;
  }

  const config = route.failover.slowStart;
  const durationMs = config.durationMs ?? 30000; // Default 30 seconds
  const initialFactor = config.initialWeightFactor ?? 0.1; // Default 10%

  const elapsed = Date.now() - upstream.slowStartRecoveryTime;

  // If slow start period has passed, return 1.0 (full weight)
  if (elapsed >= durationMs) {
    // Clear slow start state
    upstream.slowStartRecoveryTime = undefined;
    upstream.slowStartWeightFactor = 1.0;
    return 1.0;
  }

  // Calculate linear progression from initialFactor to 1.0
  const progress = elapsed / durationMs;
  const factor = initialFactor + (1.0 - initialFactor) * progress;

  // Update cached factor
  upstream.slowStartWeightFactor = factor;

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
  upstream: RuntimeUpstream,
  route: RouteConfig
): number {
  const baseWeight = upstream.weight ?? 100;
  const slowStartFactor = calculateSlowStartFactor(upstream, route);
  return Math.max(1, Math.round(baseWeight * slowStartFactor));
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
  upstream: RuntimeUpstream,
  route: RouteConfig
): void {
  if (!route.failover?.slowStart?.enabled) {
    return;
  }

  upstream.slowStartRecoveryTime = Date.now();
  upstream.slowStartWeightFactor = route.failover.slowStart.initialWeightFactor ?? 0.1;
}

/**
 * Deactivate slow start for an upstream
 *
 * Should be called when an upstream becomes UNHEALTHY again
 *
 * @param upstream - Runtime upstream to deactivate slow start for
 */
export function deactivateSlowStart(upstream: RuntimeUpstream): void {
  upstream.slowStartRecoveryTime = undefined;
  upstream.slowStartWeightFactor = undefined;
}

/**
 * Check if an upstream is in slow start period
 *
 * @param upstream - Runtime upstream to check
 * @returns True if in slow start period
 */
export function isInSlowStart(upstream: RuntimeUpstream): boolean {
  return upstream.slowStartRecoveryTime !== undefined;
}

/**
 * Get slow start progress percentage
 *
 * @param upstream - Runtime upstream
 * @param route - Route configuration
 * @returns Progress percentage (0-100)
 */
export function getSlowStartProgress(
  upstream: RuntimeUpstream,
  route: RouteConfig
): number {
  if (!upstream.slowStartRecoveryTime) {
    return 100; // Not in slow start or completed
  }

  const durationMs = route.failover?.slowStart?.durationMs ?? 30000;
  const elapsed = Date.now() - upstream.slowStartRecoveryTime;
  const progress = Math.min(100, (elapsed / durationMs) * 100);

  return Math.round(progress);
}
