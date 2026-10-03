import { randomUUID } from 'node:crypto';
import type { CommitConfigurationCommandV1, CommitConfigurationResult, RepositorySnapshot } from '../config-storage';
import { ConfigRepositoryError, parseNormalizeCompileAggregate } from '../config-storage';
import type { ConfigurationCompileOptions } from '../config-storage/plugin-schema';

/** Called by the master while it owns the instance locks, before starting plugins. */
export function reconcilePluginDependencies(
  repository: {
    getSnapshot(): RepositorySnapshot;
    commit(command: CommitConfigurationCommandV1): CommitConfigurationResult;
  },
  options: ConfigurationCompileOptions,
  workerCount: number,
  now: number,
  managementProviders: ReadonlySet<string>,
): RepositorySnapshot {
  const current = repository.getSnapshot();
  if (!options.pluginDependencies) return current;
  const required = options.pluginDependencies.closure(current.aggregate.plugin_activations.map(value => value.plugin_name));
  if (required.length === current.aggregate.plugin_activations.length) return current;
  const parsed = parseNormalizeCompileAggregate(current.aggregate, options);
  if (!parsed.ok) throw new ConfigRepositoryError('invalid_configuration', 'configuration dependency reconciliation failed', parsed.errors);
  const active = new Set(current.aggregate.plugin_activations.map(value => value.plugin_name));
  if (required.some(name => managementProviders.has(name) && !active.has(name))) {
    throw new ConfigRepositoryError('invalid_configuration',
      'dependency activation changes management authentication; enable the provider through management setup before upgrading');
  }
  // Use the ordinary revision/CAS transaction; never change an existing revision,
  // serving snapshot, operation identity, or a publication/recovery in progress.
  const result = repository.commit({
    mutation_id: randomUUID(), expected_revision: current.revision,
    aggregate: parsed.value, kind: 'config', created_at: now,
    target_worker_slots: Array.from({ length: workerCount }, (_, slot) => slot),
  });
  if (result.kind !== 'committed') {
    throw new ConfigRepositoryError('invalid_operation', `configuration dependency reconciliation blocked: ${result.kind}`);
  }
  return result.snapshot;
}
