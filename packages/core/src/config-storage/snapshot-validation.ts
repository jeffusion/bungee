import { parseNormalizeCompileAggregate } from './aggregate';
import type { ConfigurationCompileOptions } from './plugin-schema';
import type { RepositorySnapshot } from './repository-types';
import { ConfigRepositoryError } from './repository-types';

export function validateSnapshotWithPlugins(
  snapshot: RepositorySnapshot,
  options: ConfigurationCompileOptions,
): RepositorySnapshot {
  const result = parseNormalizeCompileAggregate(snapshot.aggregate, options);
  if (!result.ok) {
    throw new ConfigRepositoryError('invalid_configuration', 'configuration plugin options are invalid', result.errors);
  }
  return { ...snapshot, aggregate: result.value };
}
