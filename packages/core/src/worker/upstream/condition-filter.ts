/**
 * Upstream condition filter module
 * Filters upstreams based on condition expressions evaluated against request context
 */

import type { RuntimeCandidate } from '../types';
import type { ExpressionContext } from '../../expression-engine';
import { processDynamicValue } from '../../expression-engine';
import { logger } from '../../logger';

/**
 * Filters upstreams based on their condition expressions
 *
 * Rules:
 * - Upstreams without a condition are always included
 * - Upstreams with a condition are included only if the expression evaluates to truthy
 * - If condition evaluation fails, the upstream is excluded and a warning is logged
 *
 * @param upstreams - The upstreams to filter
 * @param context - The expression context containing request data
 * @returns Filtered array of upstreams that match their conditions
 *
 * @example
 * ```typescript
 * const upstreams = [
 *   { target: 'http://openai', condition: "{{ body.model === 'gpt-4' }}" },
 *   { target: 'http://anthropic', condition: "{{ body.model === 'claude-3' }}" },
 *   { target: 'http://fallback' } // no condition, always matches
 * ];
 * const context = { body: { model: 'gpt-4' }, ... };
 * const filtered = filterByCondition(upstreams, context);
 * // Returns: [{ target: 'http://openai', ... }, { target: 'http://fallback', ... }]
 * ```
 */
export function filterByCondition<T extends RuntimeCandidate>(
  upstreams: T[],
  context: ExpressionContext
): T[] {
  return upstreams.filter((upstream) => {
    // No condition means always match
    if (!upstream.condition) {
      return true;
    }

    try {
      // Use processDynamicValue to evaluate the {{ }} wrapped expression
      const result = processDynamicValue(upstream.condition, context);

      // Convert result to boolean
      const matches = Boolean(result);

      if (!matches) {
        logger.debug({
          target: upstream.target,
          condition: upstream.condition,
          result
        }, 'Upstream condition did not match');
      }

      return matches;
    } catch (error) {
      // On evaluation error, exclude the upstream and log warning
      logger.warn({
        target: upstream.target,
        condition: upstream.condition,
        error: (error as Error).message
      }, 'Upstream condition evaluation failed, excluding upstream');

      return false;
    }
  });
}
