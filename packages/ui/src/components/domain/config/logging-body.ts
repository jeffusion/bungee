export type LoggingBody = {
  readonly enabled: boolean;
  readonly max_size?: number;
  readonly retention_days?: number;
};

export type LoggingValue = {
  readonly body?: LoggingBody;
  readonly [key: string]: unknown;
} | null;

export const LOGGING_BODY_DEFAULTS = {
  enabled: false,
  max_size: 5120,
  retention_days: 1,
} as const satisfies LoggingBody;

export function resolveLoggingBody(value: LoggingValue): LoggingBody {
  return { ...LOGGING_BODY_DEFAULTS, ...value?.body };
}

export function withLoggingBody(value: LoggingValue, patch: Partial<LoggingBody>): LoggingValue {
  return { ...(value ?? {}), body: { ...resolveLoggingBody(value), ...patch } };
}
