/**
 * Jitter utility functions
 * Adds randomness to timing intervals to prevent thundering herd problems
 */

/**
 * Add jitter to a time value
 *
 * Jitter helps prevent the "thundering herd" problem where multiple clients
 * or upstreams synchronize their actions (e.g., retry attempts, health checks)
 * at the same time, causing load spikes.
 *
 * @param baseMs - Base time in milliseconds
 * @param jitterFactor - Jitter factor (0-1), default 0.2 (20%)
 * @returns Time with jitter applied
 *
 * @example
 * ```typescript
 * // With 10000ms base and 0.2 jitter:
 * // Returns a value between 8000ms and 12000ms
 * const interval = addJitter(10000, 0.2);
 * ```
 */
export function addJitter(baseMs: number, jitterFactor: number = 0.2): number {
  // Clamp jitter factor between 0 and 1
  const factor = Math.max(0, Math.min(1, jitterFactor));

  // Calculate jitter range: baseMs ± (baseMs * jitterFactor)
  const jitterRange = baseMs * factor;
  const minMs = baseMs - jitterRange;
  const maxMs = baseMs + jitterRange;

  // Return random value in range [minMs, maxMs]
  return minMs + Math.random() * (maxMs - minMs);
}

/**
 * Add full jitter (range [0, maxMs])
 *
 * This is more aggressive jitter that distributes attempts across
 * the entire range from 0 to the maximum value.
 *
 * @param maxMs - Maximum time in milliseconds
 * @returns Random time between 0 and maxMs
 *
 * @example
 * ```typescript
 * // With 10000ms max:
 * // Returns a value between 0ms and 10000ms
 * const interval = addFullJitter(10000);
 * ```
 */
export function addFullJitter(maxMs: number): number {
  return Math.random() * maxMs;
}

/**
 * Add decorrelated jitter
 *
 * Decorrelated jitter uses the previous attempt's delay to calculate
 * the next delay, preventing synchronization patterns.
 *
 * @param baseMs - Base time in milliseconds
 * @param maxMs - Maximum time in milliseconds
 * @param previousMs - Previous attempt delay (optional)
 * @returns Time with decorrelated jitter applied
 *
 * @example
 * ```typescript
 * let delay = 1000;
 * // Each call uses previous delay to calculate next
 * delay = addDecorrelatedJitter(1000, 30000, delay);
 * ```
 */
export function addDecorrelatedJitter(
  baseMs: number,
  maxMs: number,
  previousMs?: number
): number {
  const prev = previousMs ?? baseMs;
  // Next delay is random value between base and 3x previous, capped at max
  const nextDelay = baseMs + Math.random() * (prev * 3 - baseMs);
  return Math.min(nextDelay, maxMs);
}

/**
 * Calculate exponential backoff with jitter
 *
 * Used for retry mechanisms where delays increase exponentially
 * with added jitter to prevent synchronization.
 *
 * @param attempt - Current attempt number (starts at 0)
 * @param baseMs - Base delay in milliseconds
 * @param maxMs - Maximum delay cap in milliseconds
 * @param jitterFactor - Jitter factor (0-1)
 * @returns Backoff delay with jitter
 *
 * @example
 * ```typescript
 * // Attempt 0: ~1000ms
 * // Attempt 1: ~2000ms
 * // Attempt 2: ~4000ms
 * // Attempt 3: ~8000ms (with jitter applied)
 * const delay = exponentialBackoffWithJitter(3, 1000, 30000, 0.2);
 * ```
 */
export function exponentialBackoffWithJitter(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterFactor: number = 0.2
): number {
  // Calculate exponential delay: baseMs * 2^attempt
  const exponentialDelay = baseMs * Math.pow(2, attempt);

  // Cap at maximum
  const cappedDelay = Math.min(exponentialDelay, maxMs);

  // Add jitter
  return addJitter(cappedDelay, jitterFactor);
}
