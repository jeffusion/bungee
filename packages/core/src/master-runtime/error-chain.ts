const MAX_DEPTH = 5;
const MAX_ERRORS = 8;
const MAX_TEXT = 512;
const SENSITIVE_KEYS = '(?:access_token|refresh_token|accessToken|refreshToken|authorization|api_key|apiKey|password|cookie|set-cookie)';
const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?<![A-Za-z0-9_-])(?:["']${SENSITIVE_KEYS}["']|${SENSITIVE_KEYS})\\s*[:=]\\s*)` +
  `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s&,;}]+)`,
  'gi',
);

export type SafeErrorChain = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: SafeErrorChain;
  readonly errors?: readonly SafeErrorChain[];
};

function redact(value: string): string {
  return value.slice(0, MAX_TEXT)
    .replace(/\bBearer\s+[^\s"'&,;}]+/gi, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (_match, prefix: string, rawValue: string) => {
      const quote = rawValue[0] === rawValue.at(-1) && (rawValue[0] === '"' || rawValue[0] === "'")
        ? rawValue[0] : '';
      return `${prefix}${quote}[REDACTED]${quote}`;
    });
}

function safeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]{1,64}$/i.test(value)) return undefined;
  return value;
}

function serialize(value: unknown, depth: number, seen: Set<unknown>): SafeErrorChain {
  if (depth >= MAX_DEPTH || seen.has(value)) {
    return { name: 'Error', message: '[truncated]' };
  }
  seen.add(value);
  if (value instanceof Error) {
    const result: { name: string; message: string; code?: string; stack?: string; cause?: SafeErrorChain; errors?: readonly SafeErrorChain[] } = {
      name: redact(value.name || 'Error'),
      message: redact(value.message),
    };
    const code = safeCode((value as Error & { readonly code?: unknown }).code);
    if (code !== undefined) result.code = code;
    if (value.stack !== undefined) result.stack = redact(value.stack);
    const cause = (value as Error & { readonly cause?: unknown }).cause;
    if (cause !== undefined) result.cause = serialize(cause, depth + 1, seen);
    if (value instanceof AggregateError) {
      result.errors = value.errors.slice(0, MAX_ERRORS).map((error) => serialize(error, depth + 1, seen));
    }
    return result;
  }
  return { name: 'Error', message: redact(typeof value === 'string' ? value : String(value)) };
}

export function serializeErrorChain(value: unknown): SafeErrorChain {
  return serialize(value, 0, new Set());
}
