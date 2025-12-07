/**
 * Priority group module
 * Manages upstreams within the same priority level
 */

import type { RuntimeUpstream } from '../types';
import type { RouteConfig } from '@jeffusion/bungee-types';
import { selectUpstream } from './selector';
import { canAttemptUpstream } from './filter';

/**
 * Priority Group
 *
 * Manages all upstreams within the same priority level:
 * - Filters attempted/skipped upstreams
 * - Checks upstream availability (status + recovery interval)
 * - Delegates to weighted selector for selection
 */
export class PriorityGroup {
  private priority: number;
  private upstreams: RuntimeUpstream[];
  private route: RouteConfig;
  private recoveryIntervalMs: number;

  constructor(priority: number, route: RouteConfig, recoveryIntervalMs: number) {
    this.priority = priority;
    this.upstreams = [];
    this.route = route;
    this.recoveryIntervalMs = recoveryIntervalMs;
  }

  /**
   * Add an upstream to this priority group
   *
   * @param upstream - Upstream to add
   */
  addUpstream(upstream: RuntimeUpstream): void {
    this.upstreams.push(upstream);
  }

  /**
   * Check if there are any available upstreams in this group
   *
   * An upstream is available if:
   * - Not in the attempted set
   * - Not in the skipped set
   *
   * @param attempted - Set of attempted upstream targets
   * @param skipped - Set of skipped upstream targets
   * @returns True if at least one upstream is available
   */
  hasAvailable(attempted: Set<string>, skipped: Set<string>): boolean {
    return this.upstreams.some(
      u => !attempted.has(u.target) && !skipped.has(u.target)
    );
  }

  /**
   * Select one upstream from this priority group
   *
   * Process:
   * 1. Filter out attempted/skipped upstreams
   * 2. Call weighted selector (doesn't consider health status)
   * 3. Check if selected upstream can be attempted
   * 4. Return result with attempt information
   *
   * @param attempted - Set of attempted upstream targets
   * @param skipped - Set of skipped upstream targets
   * @returns Selected upstream with attempt info, or null if none available
   */
  selectOne(
    attempted: Set<string>,
    skipped: Set<string>
  ): {
    upstream: RuntimeUpstream;
    canAttempt: boolean;
    shouldTransitionToHalfOpen: boolean;
  } | null {
    // 1. Filter out attempted/skipped upstreams
    const available = this.upstreams.filter(
      u => !attempted.has(u.target) && !skipped.has(u.target)
    );

    if (available.length === 0) {
      return null;
    }

    // 2. Weighted random selection (doesn't consider health status)
    const selected = selectUpstream(available, this.route);

    if (!selected) {
      return null;
    }

    // 3. Check if selected upstream can be attempted
    const { canAttempt, shouldTransitionToHalfOpen } = canAttemptUpstream(
      selected,
      this.recoveryIntervalMs
    );

    return {
      upstream: selected,
      canAttempt,
      shouldTransitionToHalfOpen
    };
  }

  /**
   * Get the priority level of this group
   */
  getPriority(): number {
    return this.priority;
  }

  /**
   * Get the number of upstreams in this group
   */
  getUpstreamCount(): number {
    return this.upstreams.length;
  }
}
