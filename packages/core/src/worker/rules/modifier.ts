/**
 * Request/Response modification rules module
 * Handles body and header modification based on configuration rules
 */

import { mergeWith, isArray, forEach } from 'lodash-es';
import { logger } from '../../logger';
import { processDynamicValue, type ExpressionContext } from '../../expression-engine';
import type { ModificationRules } from '@jeffusion/bungee-shared';

/**
 * Deep merges two ModificationRules objects
 *
 * Arrays are merged by combining and deduplicating elements.
 * This is useful for combining route-level and upstream-level rules.
 *
 * @param base - Base rules (usually route-level)
 * @param override - Override rules (usually upstream-level)
 * @returns Merged ModificationRules
 *
 * @example
 * ```typescript
 * const routeRules = {
 *   headers: { add: { 'X-Route': 'value1' } },
 *   body: { add: { field1: 'value1' } }
 * };
 * const upstreamRules = {
 *   headers: { add: { 'X-Upstream': 'value2' } },
 *   body: { add: { field2: 'value2' } }
 * };
 * const merged = deepMergeRules(routeRules, upstreamRules);
 * // Result: Both route and upstream rules are combined
 * ```
 */
export function deepMergeRules(
  base: ModificationRules,
  override: ModificationRules
): ModificationRules {
  const customizer = (objValue: any, srcValue: any) => {
    if (isArray(objValue)) {
      // Merge arrays and remove duplicates
      return [...new Set([...objValue, ...srcValue])];
    }
  };
  return mergeWith({}, base, override, customizer);
}

/**
 * Applies body modification rules to a request/response body
 *
 * Supports four types of modifications:
 * - **add**: Adds new fields (unconditional)
 * - **replace**: Replaces existing fields
 * - **default**: Sets field only if undefined
 * - **remove**: Removes fields (unless added/replaced in same rule)
 *
 * **Processing order**: add → replace → default → remove
 *
 * **Special features:**
 * - Dynamic value processing (expressions like `${env.API_KEY}`)
 * - Multi-event support (returns array if `__multi_events` present)
 * - Deep clone to prevent mutation of original body
 *
 * @param body - Original body object
 * @param rules - Modification rules to apply
 * @param context - Expression context for dynamic values
 * @param requestLog - Request log for debugging
 * @returns Modified body (or array of bodies if multi-event)
 *
 * @example
 * ```typescript
 * const body = { user: 'john', age: 30 };
 * const rules = {
 *   add: { timestamp: '${Date.now()}' },
 *   replace: { age: 31 },
 *   remove: ['user']
 * };
 * const context = { env: process.env };
 * const result = await applyBodyRules(body, rules, context, requestLog);
 * // Result: { age: 31, timestamp: 1234567890 }
 * ```
 */
export async function applyBodyRules(
  body: Record<string, any>,
  rules: ModificationRules['body'],
  context: ExpressionContext,
  requestLog: any
): Promise<Record<string, any>> {
  // Use structuredClone for deep copy to prevent mutation of original body
  let modifiedBody = structuredClone(body);
  logger.debug(
    { request: requestLog, phase: 'before', body: modifiedBody },
    "Body before applying rules"
  );

  if (rules) {
    const processAndSet = (key: string, value: any, action: 'add' | 'replace' | 'default') => {
      try {
        const processedValue = processDynamicValue(value, context);

        // Only exclude undefined (JSON doesn't support it), keep all other values
        if (processedValue !== undefined) {
          modifiedBody[key] = processedValue;
          logger.debug(
            { request: requestLog, body: { key, value: processedValue } },
            `Applied body '${action}' rule`
          );
        } else {
          logger.debug(
            { request: requestLog, body: { key } },
            `Skipped body '${action}' rule (undefined result)`
          );
        }
      } catch (err) {
        logger.error(
          { request: requestLog, body: { key }, err },
          `Failed to process body '${action}' rule`
        );
      }
    };

    // Add rules: unconditionally add fields
    if (rules.add) {
      forEach(rules.add, (value, key) => {
        processAndSet(key, value, 'add');
      });
    }

    // Replace rules: replace existing fields
    if (rules.replace) {
      forEach(rules.replace, (value, key) => {
        if (key in modifiedBody || (rules.add && key in rules.add)) {
          processAndSet(key, value, 'replace');
        }
      });
    }

    // Default rules: set field only if undefined
    if (rules.default) {
      forEach(rules.default, (value, key) => {
        if (modifiedBody[key] === undefined) {
          processAndSet(key, value, 'default');
        }
      });
    }

    // Remove rules: remove fields (unless added/replaced)
    if (rules.remove) {
      for (const key of rules.remove) {
        const wasAdded = rules.add && key in rules.add;
        const wasReplaced = rules.replace && key in rules.replace;
        if (!wasAdded && !wasReplaced) {
          delete modifiedBody[key];
          logger.debug({ request: requestLog, body: { key } }, 'Removed body field');
        }
      }
    }
  }

  // Check for multi-event support
  if (modifiedBody.__multi_events && Array.isArray(modifiedBody.__multi_events)) {
    logger.debug(
      { request: requestLog, eventCount: modifiedBody.__multi_events.length },
      "Returning multiple events"
    );
    return modifiedBody.__multi_events;
  }

  logger.debug(
    { request: requestLog, phase: 'after', body: modifiedBody },
    "Body after applying rules"
  );
  return modifiedBody;
}
