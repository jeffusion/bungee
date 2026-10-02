import type { RawResponseError } from '../../../packages/core/src/plugin-control/contracts';

const MAX_MESSAGE_CHARS = 1024;
type Redactor = (message: string) => string;

/** Copy only diagnostic scalars, never an upstream response, request, or stack. */
export function errorDiagnostic(
  value: unknown,
  source: RawResponseError['source'],
  fallback: string,
  redact?: Redactor,
): RawResponseError {
  const object = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  const clean = (value: string): string => {
    // Bound work before regex matching, and redact before applying the output limit.
    let text = value.slice(0, 16_384);
    text = redact?.(text) ?? text;
    text = text
      .replace(/\bBearer\s+[^\s,;"'<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[REDACTED]')
      .replace(/((?:authorization|access_token|refresh_token|id_token|api[_-]?key|cookie)["']?\s*[=:]\s*["']?)[^\s,;&"'<>]+/gi, '$1[REDACTED]')
      .replace(/[\x00-\x1f\x7f]+/g, ' ');
    return text.slice(0, MAX_MESSAGE_CHARS).trim();
  };
  const identifier = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const text = clean(value);
    return /^[a-zA-Z0-9_.-]{1,128}$/.test(text) ? text : undefined;
  };
  const cause = source === 'transport' && object.cause !== null && typeof object.cause === 'object'
    ? object.cause as Record<string, unknown> : {};
  const message = clean([
    typeof object.message === 'string' ? object.message : '',
    typeof cause.message === 'string' ? cause.message : '',
  ].filter(Boolean).join('; '));
  const code = identifier(object.code ?? cause.code);
  const type = identifier(source === 'transport' ? object.name ?? object.type : object.type);
  return { source, message: message || fallback, ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

export function upstreamErrorDiagnostic(value: unknown, fallback: string, redact?: Redactor): RawResponseError {
  const object = value !== null && typeof value === 'object' ? value as Record<string, any> : {};
  return errorDiagnostic(object.response?.error ?? object.error ?? object, 'upstream', fallback, redact);
}
