export const LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const BODY_PARSER_LIMIT = /^([1-9][0-9]*)(b|kb|mb|gb)$/;

export function isLogLevel(value: string): boolean {
  return LOG_LEVELS.has(value);
}

export function isBodyParserLimit(value: string): boolean {
  const match = BODY_PARSER_LIMIT.exec(value);
  if (match === null) return false;
  const numeric = match[1];
  return numeric !== undefined && Number.isSafeInteger(Number(numeric));
}
