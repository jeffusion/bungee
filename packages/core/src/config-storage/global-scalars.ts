export const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const BODY_PARSER_LIMIT = /^([1-9][0-9]*)(b|kb|mb|gb)$/;
const BODY_SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export const DEFAULT_BODY_PARSER_LIMIT = '50mb';

export function isLogLevel(value: string): boolean {
  return LOG_LEVELS.has(value);
}

export function isBodyParserLimit(value: string): boolean {
  const match = BODY_PARSER_LIMIT.exec(value);
  if (match === null) return false;
  const numeric = match[1];
  return numeric !== undefined && Number.isSafeInteger(Number(numeric));
}

/** Uses the same size grammar as configuration validation and persistence. */
export function parseBodyParserLimit(value: string = DEFAULT_BODY_PARSER_LIMIT): number {
  if (!isBodyParserLimit(value)) throw new Error('Invalid body parser limit');
  const match = BODY_PARSER_LIMIT.exec(value)!;
  // The schema permits safe integer quantities in every unit. Saturate byte
  // counts above the exact integer range rather than introducing rounding.
  return Math.min(Number(match[1]) * BODY_SIZE_UNITS[match[2]!], Number.MAX_SAFE_INTEGER);
}
