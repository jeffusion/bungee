import { ConfigRepositoryError } from './repository-types';
import { isBodyParserLimit, isLogLevel } from './global-scalars';
import { isPluginName } from './plugin-name';
import { isLowercaseUuid } from './validation';

function corrupt(field: string): never {
  throw new ConfigRepositoryError('schema_corrupt', `${field} contains an invalid persisted value`);
}

export function requireSafeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) return corrupt(field);
  return value;
}

export function requireBooleanInteger(value: number, field: string): boolean {
  if (value !== 0 && value !== 1) return corrupt(field);
  return value === 1;
}

export function requirePositiveFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) return corrupt(field);
  return value;
}

export function requireUuid(value: string, field: string): string {
  if (!isLowercaseUuid(value)) return corrupt(field);
  return value;
}

export function requirePluginName(value: string, field: string): string {
  if (!isPluginName(value)) return corrupt(field);
  return value;
}

export function requireOptionalGlobalScalar(
  value: string | null,
  field: 'log_level' | 'body_parser_limit',
): string | undefined {
  if (value === null) return undefined;
  const valid = field === 'log_level' ? isLogLevel(value) : isBodyParserLimit(value);
  if (!valid) return corrupt(field);
  return value;
}

export function requireOneOf<const Value extends string>(
  value: string,
  allowed: readonly Value[],
  field: string,
): Value {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) return corrupt(field);
  return match;
}
