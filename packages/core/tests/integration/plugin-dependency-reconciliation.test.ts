import { afterEach, describe, expect, test } from 'bun:test';
import { configurationRepositoryFixture } from '../helpers/config-repository';
import { ConfigRepository, hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { reconcilePluginDependencies } from '../../src/master-runtime/reconcile-plugin-dependencies';
import { createCatalogSnapshotCompiler } from '../../src/config-worker/snapshot-compiler';
import { buildPluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { cleanupCatalogRoots, manifest, tempRoot, writePlugin } from '../helpers/plugin-manifest-catalog';
import { PROCESS_IDENTITY } from '../helpers/config-publication-worker-runtime.ts';

afterEach(cleanupCatalogRoots);

async function fixture(existingManagementProvider = false) {
  const root = tempRoot();
  writePlugin(root, 'consumer', manifest('consumer', { dependencies: { intermediate: '^1.0.0' } }));
  writePlugin(root, 'intermediate', manifest('intermediate', { dependencies: { provider: '^1.0.0' } }));
  writePlugin(root, 'provider', manifest('provider', { runtimeScope: 'global' }));
  writePlugin(root, 'unrelated', manifest('unrelated'));
  writePlugin(root, 'existing-auth', manifest('existing-auth'));
  const catalog = await buildPluginManifestCatalog({ scanDirectories: [root] });
  // The old catalog did not require providers. Persist a genuine older snapshot
  // without the new compile catalog, using only isolated temporary SQLite data.
  const parsed = parseNormalizeCompileAggregate({
    logical_configuration: { plugins: [{
      id: '40000000-0000-4000-8000-000000000001', position: 1, name: 'provider', enabled: false,
    }] },
    plugin_activations: [{ plugin_name: 'consumer' }, ...(existingManagementProvider ? [{ plugin_name: 'existing-auth' }] : [])],
  });
  if (!parsed.ok) throw new Error('invalid simulation configuration');
  const dbPath = `${root}/config.db`;
  const repository = ConfigRepository.open(dbPath);
  const seeded = repository.commit({ mutation_id: 'old-catalog-config', expected_revision: 1,
    aggregate: parsed.value, kind: 'config', created_at: 100, target_worker_slots: [0, 1] });
  if (seeded.kind !== 'committed') throw new Error('simulation commit failed');
  return { repository, dbPath, catalog, seeded };
}

function settle(repository: ConfigRepository): void {
  const active = repository.getActivePublication();
  if (!active) throw new Error('missing simulation publication');
  const id = active.operation.mutation_id;
  let now = 100;
  repository.beginPublication(id, ++now);
  for (const target of active.targets) {
    repository.beginWorkerAttempt(id, target.worker_slot, 0, 'initial', ++now);
    repository.recordWorkerResult(id, target.worker_slot, {
      kind: 'converged', attempt_no: 1, applied_revision: active.snapshot.revision,
    }, ++now);
  }
  repository.markDraining(id, ++now);
  repository.finalizePublication(id, { outcome: 'converged', old_workers_exited: true }, ++now);
}

describe('master startup dependency reconciliation', () => {
  test.each([false, true])('rejects a new management dependency before committing (existing provider: %s)', async existingProvider => {
    const { repository, catalog, seeded } = await fixture(existingProvider);
    try {
      settle(repository);
      const oldOperation = repository.getCurrentOperationState();
      await expect(reconcilePluginDependencies(configurationRepositoryFixture(repository), catalog.toCompileOptions(), 2, 200,
        new Set(['provider', 'existing-auth']))).rejects.toThrow('enable the provider through management setup');
      expect(repository.getSnapshot()).toEqual(seeded.snapshot);
      expect(repository.getCurrentOperationState()).toEqual(oldOperation);
    } finally { repository.close(); }
  });
  test('upgrades old activations once, preserves history and bindings, and compiles identical worker metadata', async () => {
    const { repository, dbPath, catalog, seeded } = await fixture();
    try {
      settle(repository);
      repository.appendServingSnapshot(seeded.snapshot, catalog.hash);
      const oldOperation = repository.getOperationState('old-catalog-config');
      const next = await reconcilePluginDependencies(configurationRepositoryFixture(repository), catalog.toCompileOptions(), 2, 200, new Set());
      expect(next.revision).toBe(seeded.snapshot.revision + 1);
      expect(next.aggregate.plugin_activations).toEqual([
        { plugin_name: 'consumer' }, { plugin_name: 'intermediate' }, { plugin_name: 'provider' },
      ]);
      expect(next.aggregate.logical_configuration).toEqual(seeded.snapshot.aggregate.logical_configuration);
      expect(next.aggregate.logical_configuration.plugins[0]!.enabled).toBe(false);
      expect(next.content_hash).toBe(hashConfigurationContent(next.aggregate));
      expect(repository.getOperationState('old-catalog-config')).toEqual(oldOperation);
      expect(repository.getServingSnapshot({ revision: seeded.snapshot.revision,
        content_hash: seeded.snapshot.content_hash, plugin_catalog_hash: catalog.hash })).toEqual(seeded.snapshot);
      expect(repository.getActivePublication()?.targets.map(value => value.worker_slot)).toEqual([0, 1]);
      // Repeated startup while this new revision is pending does not write again.
      expect(await reconcilePluginDependencies(configurationRepositoryFixture(repository), catalog.toCompileOptions(), 2, 201, new Set())).toEqual(next);
      const command = { command: 'start-current-config-worker' as const, ...PROCESS_IDENTITY,
        ...next, plugin_catalog_hash: catalog.hash, publication: null,
        activated_plugin_names: next.aggregate.plugin_activations.map(value => value.plugin_name) };
      const compiled = await createCatalogSnapshotCompiler(async () => catalog)(next, command);
      expect(compiled.revision).toBe(next.revision);
      expect(compiled.content_hash).toBe(next.content_hash);
      // Opening a second repository reads persisted truth without performing a
      // startup rewrite or touching old revision hashes.
      const reopened = ConfigRepository.open(dbPath, { compileOptions: catalog.toCompileOptions() });
      try { expect(reopened.getSnapshot()).toEqual(next); } finally { reopened.close(); }
    } finally { repository.close(); }
  });

  test.each(['committed', 'publishing', 'draining'] as const)('does not overwrite an unfinished %s publication', async state => {
    const { repository, catalog, seeded } = await fixture();
    try {
      if (state !== 'committed') repository.beginPublication('old-catalog-config', 101);
      if (state === 'draining') {
        let now = 101;
        for (const slot of [0, 1]) {
          repository.beginWorkerAttempt('old-catalog-config', slot, 0, 'initial', ++now);
          repository.recordWorkerResult('old-catalog-config', slot, {
            kind: 'converged', attempt_no: 1, applied_revision: seeded.snapshot.revision,
          }, ++now);
        }
        repository.markDraining('old-catalog-config', ++now);
      }
      const oldOperation = repository.getOperationState('old-catalog-config');
      await expect(reconcilePluginDependencies(configurationRepositoryFixture(repository), catalog.toCompileOptions(), 2, 200, new Set())).rejects.toThrow('operation_in_progress');
      expect(repository.getSnapshot()).toEqual(seeded.snapshot);
      expect(repository.getOperationState('old-catalog-config')).toEqual(oldOperation);
    } finally { repository.close(); }
  });

  test('does not change the revision when the catalog has no dependency changes', async () => {
    const { repository, seeded } = await fixture();
    try {
      const options = { pluginSchemas: new Map() };
      expect(await reconcilePluginDependencies(configurationRepositoryFixture(repository), options, 2, 200, new Set())).toEqual(seeded.snapshot);
    } finally { repository.close(); }
  });

  test('does not supersede an active recovery', async () => {
    const { repository, catalog, seeded } = await fixture();
    try {
      repository.beginPublication('old-catalog-config', 101);
      let now = 101;
      for (const slot of [0, 1]) {
        repository.beginWorkerAttempt('old-catalog-config', slot, 0, 'initial', ++now);
        repository.recordWorkerResult('old-catalog-config', slot, {
          kind: 'failed', attempt_no: 1, error: 'simulated temporary failure',
        }, ++now);
      }
      repository.finalizePublication('old-catalog-config', { outcome: 'degraded',
        error_code: 'replacement_convergence_failed', error_detail: 'simulated temporary failure',
        recovery_disposition: 'retryable' }, ++now);
      const recovery = repository.getCurrentRecovery();
      expect(recovery?.state).toBe('scheduled');
      await expect(reconcilePluginDependencies(configurationRepositoryFixture(repository), catalog.toCompileOptions(), 2, 200, new Set())).rejects.toThrow('recovery_in_progress');
      expect(repository.getSnapshot()).toEqual(seeded.snapshot);
      expect(repository.getCurrentRecovery()).toEqual(recovery);
    } finally { repository.close(); }
  });

  test('rolls back every new revision row if reconciliation materialization fails', async () => {
    const { repository, catalog, dbPath, seeded } = await fixture();
    settle(repository);
    repository.close();
    const failing = ConfigRepository.open(dbPath, { compileOptions: catalog.toCompileOptions(),
      faultInjection(stage) { if (stage === 'after_materialization') throw new Error('simulated transaction failure'); } });
    try {
      await expect(reconcilePluginDependencies(configurationRepositoryFixture(failing), catalog.toCompileOptions(), 2, 200, new Set())).rejects.toThrow('configuration commit transaction failed');
      expect(failing.getSnapshot()).toEqual(seeded.snapshot);
      expect(failing.getCurrentOperationState()?.operation.state).toBe('converged');
    } finally { failing.close(); }
  });
});
