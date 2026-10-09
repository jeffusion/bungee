export interface DataAdmissionErrorDetails { message?: string; param?: string }
function safeDetails(details?: DataAdmissionErrorDetails): DataAdmissionErrorDetails | undefined {
  if (!details) return undefined;
  const message = typeof details.message === 'string' && details.message.length <= 512 && !/[\x00-\x1f\x7f]/.test(details.message) ? details.message : undefined;
  const param = typeof details.param === 'string' && details.param.length <= 256 && /^[a-zA-Z_$][\w.$\[\]-]*$/.test(details.param) ? details.param : undefined;
  return message === undefined && param === undefined ? undefined : Object.freeze({message, param});
}
/** Shared inert error contract; importing it never loads admission runtime modules. */
export class DataAdmissionError extends Error {
  readonly name = 'DataAdmissionError';
  readonly details?: DataAdmissionErrorDetails;
  constructor(readonly status: number, readonly code: string, readonly retryAfter?: number, details?: DataAdmissionErrorDetails) {
    super(code); this.details = safeDetails(details);
  }
}

/** Plugin bundles have their own class identity; normalize their explicit error contract. */
export function normalizeAdmissionError(error: unknown): DataAdmissionError | null {
  if (error instanceof DataAdmissionError) return error;
  if (!(error instanceof Error) || error.name !== 'DataAdmissionError') return null;
  const value = error as Error & {status?: unknown; code?: unknown; retryAfter?: unknown; details?: DataAdmissionErrorDetails};
  if (typeof value.status !== 'number' || ![401,403,409,422,429,503].includes(value.status)
    || typeof value.code !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value.code)
    || (value.retryAfter !== undefined && (typeof value.retryAfter !== 'number' || !Number.isFinite(value.retryAfter) || value.retryAfter < 0))) return null;
  return new DataAdmissionError(value.status,value.code,value.retryAfter as number | undefined,value.details);
}
