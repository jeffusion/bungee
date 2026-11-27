import { RE2JS } from 're2js';

export const MAX_REDACTION_RULES = 32;
export const MAX_REDACTION_FIELD_LENGTH = 4096;
export const DEFAULT_REDACTION_REPLACEMENT = '[REDACTED]';

export type RedactionRule = { type: 'literal' | 'regex'; pattern: string; replacement?: string };
type CompiledRule = { matcher: RE2JS; replacement: string };
type RuleError = 'invalidType' | 'invalidPattern' | 'invalidReplacement' | 'invalidRule';

function compileRule(value: unknown): CompiledRule | RuleError {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['type', 'pattern', 'replacement'].includes(key))) return 'invalidRule';
  const { type, pattern, replacement = DEFAULT_REDACTION_REPLACEMENT } = value as Partial<RedactionRule>;
  if (type !== 'literal' && type !== 'regex') return 'invalidType';
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_REDACTION_FIELD_LENGTH) return 'invalidPattern';
  if (typeof replacement !== 'string' || replacement.length > MAX_REDACTION_FIELD_LENGTH) return 'invalidReplacement';
  try {
    return { matcher: RE2JS.compile(type === 'literal' ? RE2JS.quote(pattern) : pattern), replacement };
  } catch {
    return 'invalidPattern';
  }
}

export function validateRedactionRule(value: unknown): RuleError | null {
  const result = compileRule(value);
  return typeof result === 'string' ? result : null;
}

export function compileRedactionRules(input: unknown): CompiledRule[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_REDACTION_RULES) return null;
  const rules: CompiledRule[] = [];
  for (const value of input) {
    const rule = compileRule(value);
    if (typeof rule === 'string') return null;
    rules.push(rule);
  }
  return rules;
}
