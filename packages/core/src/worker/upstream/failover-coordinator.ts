/**
 * Failover coordinator module
 * Manages the entire failover process with priority-based upstream selection
 */

import { sortBy } from 'lodash-es';
import type { RuntimeUpstream } from '../types';
import type { RouteConfig } from '@jeffusion/bungee-types';
import type { ExpressionContext } from '../../expression-engine';
import { PriorityGroup } from './priority-group';
import { filterByCondition } from './condition-filter';

/**
 * Failover Coordinator
 *
 * Manages the entire failover flow:
 * - Groups upstreams by priority
 * - Attempts high priority groups first, then falls back to lower priorities
 * - Tracks attempted and skipped upstreams
 * - Provides iterator interface (hasNext/selectNext)
 *
 * @example
 * ```typescript
 * const coordinator = new FailoverCoordinator(upstreams, route, 5000, context);
 *
 * while (coordinator.hasNext()) {
 *   const selection = coordinator.selectNext();
 *   if (!selection) break;
 *
 *   const { upstream, shouldTransitionToHalfOpen } = selection;
 *
 *   try {
 *     const response = await proxyRequest(...);
 *     return response; // Success
 *   } catch (error) {
 *     // Continue to next upstream
 *   }
 * }
 * ```
 */
export class FailoverCoordinator {
  private priorityGroups: Map<number, PriorityGroup>;
  private sortedPriorities: number[];
  private currentPriorityIndex: number;
  private attemptedTargets: Set<string>;
  private skippedTargets: Set<string>;
  private totalUpstreams: number;

  /**
   * Creates a new Failover Coordinator
   *
   * @param upstreams - All upstreams for this route
   * @param route - Route configuration
   * @param recoveryIntervalMs - Recovery interval in milliseconds
   * @param context - Expression context for condition evaluation (optional)
   */
  constructor(
    upstreams: RuntimeUpstream[],
    route: RouteConfig,
    recoveryIntervalMs: number,
    context?: ExpressionContext
  ) {
    // 1. Group upstreams by priority (with condition filtering)
    this.priorityGroups = this.groupByPriority(upstreams, route, recoveryIntervalMs, context);

    // 2. Sort priorities (ascending order: lower number = higher priority)
    this.sortedPriorities = sortBy(Array.from(this.priorityGroups.keys()));

    // 3. Initialize state
    this.currentPriorityIndex = 0;
    this.attemptedTargets = new Set();
    this.skippedTargets = new Set();

    // Calculate total upstreams after filtering
    let total = 0;
    this.priorityGroups.forEach(group => {
      total += group.getUpstreamCount();
    });
    this.totalUpstreams = total;
  }

  /**
   * Check if there are more upstreams to try
   *
   * @returns True if there are more upstreams available
   */
  hasNext(): boolean {
    // If all upstreams have been attempted or skipped, no more available
    if (this.attemptedTargets.size + this.skippedTargets.size >= this.totalUpstreams) {
      return false;
    }

    // Check if current or any future priority group has available upstreams
    for (let i = this.currentPriorityIndex; i < this.sortedPriorities.length; i++) {
      const priority = this.sortedPriorities[i];
      const group = this.priorityGroups.get(priority)!;

      if (group.hasAvailable(this.attemptedTargets, this.skippedTargets)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Select the next upstream to try
   *
   * Process:
   * 1. Get current priority group
   * 2. Try to select an upstream from it
   * 3. If selection fails or upstream cannot be attempted:
   *    - If cannot attempt: skip it and retry
   *    - If no more upstreams in group: move to next priority
   * 4. If selection succeeds and can attempt: mark as attempted and return
   *
   * @returns Selected upstream with transition info, or null if none available
   */
  selectNext(): {
    upstream: RuntimeUpstream;
    shouldTransitionToHalfOpen: boolean;
  } | null {
    if (!this.hasNext()) {
      return null;
    }

    // Try to select from current or next available priority group
    while (this.currentPriorityIndex < this.sortedPriorities.length) {
      const priority = this.sortedPriorities[this.currentPriorityIndex];
      const group = this.priorityGroups.get(priority)!;

      // Try to select one upstream from this priority group
      const result = group.selectOne(this.attemptedTargets, this.skippedTargets);

      if (result === null) {
        // No more upstreams in this priority group, move to next
        this.currentPriorityIndex++;
        continue;
      }

      const { upstream, canAttempt, shouldTransitionToHalfOpen } = result;

      if (!canAttempt) {
        // Cannot attempt due to recovery interval, skip and try again
        this.skippedTargets.add(upstream.target);
        // Don't increment priority index, try again from same group
        continue;
      }

      // Can attempt this upstream, mark as attempted
      this.attemptedTargets.add(upstream.target);

      return {
        upstream,
        shouldTransitionToHalfOpen
      };
    }

    // All priority groups exhausted
    return null;
  }

  /**
   * Get attempt statistics
   *
   * @returns Statistics about attempted/skipped/total upstreams
   */
  getStats(): {
    attempted: number;
    skipped: number;
    total: number;
  } {
    return {
      attempted: this.attemptedTargets.size,
      skipped: this.skippedTargets.size,
      total: this.totalUpstreams
    };
  }

  /**
   * Group upstreams by priority
   *
   * @param upstreams - All upstreams
   * @param route - Route configuration
   * @param recoveryIntervalMs - Recovery interval
   * @returns Map of priority to PriorityGroup
   */
  private groupByPriority(
    upstreams: RuntimeUpstream[],
    route: RouteConfig,
    recoveryIntervalMs: number,
    context?: ExpressionContext
  ): Map<number, PriorityGroup> {
    const groups = new Map<number, PriorityGroup>();

    // Filter out disabled upstreams
    const enabledUpstreams = upstreams.filter(u => !u.disabled);

    // Filter by condition expression (if context provided)
    let filteredUpstreams = enabledUpstreams;
    if (context) {
      filteredUpstreams = filterByCondition(enabledUpstreams, context);
    }

    filteredUpstreams.forEach(upstream => {
      const priority = upstream.priority || 1; // Default priority is 1

      if (!groups.has(priority)) {
        groups.set(priority, new PriorityGroup(priority, route, recoveryIntervalMs, context));
      }

      groups.get(priority)!.addUpstream(upstream);
    });

    return groups;
  }
}
