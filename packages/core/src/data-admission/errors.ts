/** Shared inert error contract; importing it never loads admission runtime modules. */
export class DataAdmissionError extends Error {
  readonly name = 'DataAdmissionError';
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number) { super(code); }
}

/** Plugin bundles have their own class identity; normalize their explicit error contract. */
export function normalizeAdmissionError(error: unknown): DataAdmissionError | null {
  if (error instanceof DataAdmissionError) return error;
  if (!(error instanceof Error) || error.name !== 'DataAdmissionError') return null;
  const value = error as Error & {status?: unknown; code?: unknown; retryAfter?: unknown};
  if (typeof value.status !== 'number' || ![401,403,409,422,429,503].includes(value.status)
    || typeof value.code !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value.code)
    || (value.retryAfter !== undefined && (typeof value.retryAfter !== 'number' || !Number.isFinite(value.retryAfter) || value.retryAfter < 0))) return null;
  return new DataAdmissionError(value.status,value.code,value.retryAfter as number | undefined);
}
