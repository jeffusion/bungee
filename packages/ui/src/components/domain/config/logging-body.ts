export type LoggingBody = {
  readonly enabled: boolean;
  readonly max_size?: number;
  readonly retention_days?: number;
};

export type LoggingValue = {
  readonly body?: LoggingBody;
} | null | undefined;

export const LOGGING_BODY_DEFAULTS = {
  enabled: false,
  max_size: 5120,
  retention_days: 1,
} as const satisfies LoggingBody;

export function resolveLoggingBody(value: LoggingValue): LoggingBody {
  return { enabled: value?.body?.enabled ?? LOGGING_BODY_DEFAULTS.enabled,
    max_size: value?.body?.max_size ?? LOGGING_BODY_DEFAULTS.max_size,
    retention_days: value?.body?.retention_days ?? LOGGING_BODY_DEFAULTS.retention_days };
}

export function withLoggingBody(value: LoggingValue, patch: Partial<LoggingBody>) {
  const body = { enabled: value?.body?.enabled ?? false, ...value?.body, ...patch };
  if (patch.max_size === undefined && Object.hasOwn(patch, 'max_size')) delete body.max_size;
  if (patch.retention_days === undefined && Object.hasOwn(patch, 'retention_days')) delete body.retention_days;
  return { ...(value ?? {}), body };
}

export const bytesToKiB = (bytes: number | undefined) => bytes === undefined ? undefined : bytes / 1024;
export function kibToBytes(kib: number): number {
  const bytes = kib * 1024;
  if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 102400) throw new Error('invalid_body_size');
  return bytes;
}
