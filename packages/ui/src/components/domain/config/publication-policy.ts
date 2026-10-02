import { resolvePublicationPolicy, validatePublicationPolicy, MAX_PUBLICATION_TIMEOUT_MS, type PublicationPolicy } from '@jeffusion/bungee-types';

export const publicationFields = ['drain_start_timeout_ms', 'drain_timeout_ms', 'worker_exit_timeout_ms'] as const;
export type PublicationField = typeof publicationFields[number];
export type PublicationInputs = Record<PublicationField, string>;
export type PublicationInputError = 'required' | 'positiveInteger' | 'maximum' | 'server';
export type PublicationErrors = Partial<Record<PublicationField, PublicationInputError>>;
export const maxPublicationSeconds = MAX_PUBLICATION_TIMEOUT_MS / 1000;

export function publicationInputs(policy?: PublicationPolicy): PublicationInputs {
  const resolved = resolvePublicationPolicy(policy);
  return Object.fromEntries(publicationFields.map(field => [field, String(resolved[field] / 1000)])) as PublicationInputs;
}

/** Keep the entered text separate from the valid, millisecond-based draft. */
export function parsePublicationInputs(inputs: PublicationInputs): { policy: PublicationPolicy | null; errors: PublicationErrors } {
  const errors: PublicationErrors = {};
  const policy = {} as Record<PublicationField, number>;
  for (const field of publicationFields) {
    const raw = inputs[field];
    const seconds = Number(raw);
    if (raw === '') errors[field] = 'required';
    else if (!/^\d+$/.test(raw)) errors[field] = 'positiveInteger';
    policy[field] = seconds * 1000;
  }
  // Numeric bounds and timer safety come exclusively from the shared validator;
  // the UI checks only the seconds text representation and translates errors.
  for (const error of validatePublicationPolicy(policy)) {
    if (error.field === 'publication') {
      for (const field of publicationFields) errors[field] ??= 'server';
    } else {
      errors[error.field] ??= error.message.startsWith('Must not exceed')
        || error.message === 'Expected a safe integer number of milliseconds' ? 'maximum' : 'positiveInteger';
    }
  }
  return { policy: Object.keys(errors).length ? null : policy, errors };
}

/** Associate backend validation paths with fields without displaying raw paths. */
export function publicationServerErrors(errors: unknown): PublicationErrors {
  const result: PublicationErrors = {};
  if (!Array.isArray(errors)) return result;
  for (const error of errors) {
    if (!error || typeof error.path !== 'string') continue;
    const path = error.path.replace(/^\/?aggregate[./]/, '').replaceAll('/', '.');
    const reason: PublicationInputError = error.message === 'Required field is missing' ? 'required'
      : ['Must be greater than zero', 'Must be a whole number of seconds', 'Expected a safe integer number of milliseconds'].includes(error.message) ? 'positiveInteger'
      : error.message === `Must not exceed ${MAX_PUBLICATION_TIMEOUT_MS} milliseconds` ? 'maximum' : 'server';
    for (const field of publicationFields) {
      if (path === `logical_configuration.publication.${field}` || path === `publication.${field}`
        || path === 'logical_configuration.publication' || path === 'publication') result[field] = reason;
    }
  }
  return result;
}
