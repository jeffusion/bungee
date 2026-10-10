import type { ModelsDevCapabilities, ModelsDevReasoningEffortValue, ModelsDevReasoningOption } from '../contract';

export type ParsedReasoningOptions = Pick<ModelsDevCapabilities, 'reasoningOptions' | 'reasoningOptionsStatus'>;

const EFFORT_VALUES = new Set<unknown>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default']);
const MISSING: ParsedReasoningOptions = Object.freeze({ reasoningOptions: null, reasoningOptionsStatus: 'missing' });
const INVALID: ParsedReasoningOptions = Object.freeze({ reasoningOptions: null, reasoningOptionsStatus: 'invalid' });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function budget(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum;
}

/**
 * Mirrors the strict ReasoningOption union in models.dev/packages/core/src/schema.ts.
 * Validation happens while building the snapshot index. Invalid metadata is isolated
 * from the rest of the model and yields a fixed status, never raw diagnostic content.
 */
export function parseReasoningOptions(value: unknown): ParsedReasoningOptions {
  if (value === undefined) return MISSING;
  if (!Array.isArray(value)) return INVALID;
  const options: ModelsDevReasoningOption[] = [];
  for (const option of value) {
    if (!record(option)) return INVALID;
    if (option.type === 'toggle') {
      if (!onlyKeys(option, ['type'])) return INVALID;
      options.push(Object.freeze({ type: 'toggle' }));
    } else if (option.type === 'effort') {
      if (!onlyKeys(option, ['type', 'values']) || !Array.isArray(option.values)) return INVALID;
      const values: ModelsDevReasoningEffortValue[] = [];
      for (const raw of option.values) {
        // Upstream accepts the authored string "null" and canonicalizes it to null.
        const effort = raw === 'null' ? null : raw;
        if (effort !== null && !EFFORT_VALUES.has(effort)) return INVALID;
        values.push(effort as ModelsDevReasoningEffortValue);
      }
      options.push(Object.freeze({ type: 'effort', values: Object.freeze(values) }));
    } else if (option.type === 'budget_tokens') {
      if (!onlyKeys(option, ['type', 'min', 'max'])
        || (option.min !== undefined && !budget(option.min, -1))
        || (option.max !== undefined && !budget(option.max, 0))) return INVALID;
      const min = option.min as number | undefined;
      const max = option.max as number | undefined;
      if (min !== undefined && max !== undefined && min > max) return INVALID;
      options.push(Object.freeze({ type: 'budget_tokens',
        ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }),
      }));
    } else return INVALID;
  }
  return Object.freeze({ reasoningOptions: Object.freeze(options), reasoningOptionsStatus: 'known' });
}
