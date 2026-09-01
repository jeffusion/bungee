import type { ConfigurationAggregateV2, Sha256Digest } from '@jeffusion/bungee-types';
import canonicalize from 'canonicalize';
import { snapshotJsonGraph } from './json-preflight';

export class ConfigurationHashError extends Error {
  readonly name = 'ConfigurationHashError';

  constructor(readonly cause: unknown) {
    super('RFC 8785 canonicalization failed', { cause });
  }
}

export function canonicalJson(value: unknown): string {
  try {
    const result = canonicalize(snapshotJsonGraph(value));
    if (result === undefined) throw new TypeError('canonicalize returned undefined');
    return result;
  } catch (error) {
    throw new ConfigurationHashError(error);
  }
}

export function hashConfigurationContent(value: unknown): Sha256Digest {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const hex = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return `sha256:${hex}`;
}

export type ConfigurationRequestIdentity = {
  readonly kind: 'config' | 'admin_state';
  readonly expected_revision: number;
  readonly aggregate: ConfigurationAggregateV2;
  readonly target_worker_slots: readonly number[];
};

export function hashConfigurationRequest(identity: ConfigurationRequestIdentity): Sha256Digest {
  return hashConfigurationContent({
    kind: identity.kind,
    expected_revision: identity.expected_revision,
    aggregate: identity.aggregate,
    target_worker_slots: [...identity.target_worker_slots].sort((left, right) => left - right),
  });
}
