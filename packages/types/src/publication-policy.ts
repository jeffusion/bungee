export interface PublicationPolicy {
  readonly drain_start_timeout_ms: number;
  readonly drain_timeout_ms: number;
  readonly worker_exit_timeout_ms: number;
}

export const DEFAULT_PUBLICATION_POLICY: Readonly<PublicationPolicy> = Object.freeze({
  drain_start_timeout_ms: 5_000,
  drain_timeout_ms: 300_000,
  worker_exit_timeout_ms: 10_000,
});

export const MAX_PUBLICATION_TIMEOUT_MS = 2_147_483_000;

export type PublicationPolicyValidationError = {
  readonly field: keyof PublicationPolicy | 'publication';
  readonly message: string;
};

const PUBLICATION_FIELDS = [
  'drain_start_timeout_ms',
  'drain_timeout_ms',
  'worker_exit_timeout_ms',
] as const;

export function validatePublicationPolicy(value: unknown): readonly PublicationPolicyValidationError[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ field: 'publication', message: 'Expected an object' }];
  }

  const object = value as Record<string, unknown>;
  const errors: PublicationPolicyValidationError[] = [];
  for (const key of Object.keys(object)) {
    if (!(PUBLICATION_FIELDS as readonly string[]).includes(key)) {
      errors.push({ field: 'publication', message: `Unknown field: ${key}` });
    }
  }
  for (const field of PUBLICATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      errors.push({ field, message: 'Required field is missing' });
      continue;
    }
    const timeout = object[field];
    if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout)) {
      errors.push({ field, message: 'Expected a safe integer number of milliseconds' });
    } else if (timeout <= 0) {
      errors.push({ field, message: 'Must be greater than zero' });
    } else if (timeout % 1_000 !== 0) {
      errors.push({ field, message: 'Must be a whole number of seconds' });
    } else if (timeout > MAX_PUBLICATION_TIMEOUT_MS) {
      errors.push({ field, message: `Must not exceed ${MAX_PUBLICATION_TIMEOUT_MS} milliseconds` });
    }
  }
  return errors;
}

export function resolvePublicationPolicy(value?: PublicationPolicy): Readonly<PublicationPolicy> {
  if (value === undefined) return DEFAULT_PUBLICATION_POLICY;
  const errors = validatePublicationPolicy(value);
  if (errors.length !== 0) throw new TypeError(`Invalid publication policy: ${errors.map(({ field, message }) => `${field}: ${message}`).join('; ')}`);
  return value;
}
