import type { CommittedConfigurationSnapshotV2 } from '@jeffusion/bungee-types';
import { hashConfigurationContent } from '../config-storage/content-hash';
import { parseNormalizeCompileAggregate } from '../config-storage/aggregate';
import { compileRuntimeConfigSnapshot, type RuntimeConfigSnapshot } from '../config-storage/runtime-config';
import type { StartWorkerCommand } from '../config-publication/types';
import type { PluginManifestCatalog } from '../plugin-manifest-catalog';

export function createCatalogSnapshotCompiler(loadCatalog: () => Promise<PluginManifestCatalog>) {
  let catalogPromise: Promise<PluginManifestCatalog> | null = null;
  return async (
    snapshot: CommittedConfigurationSnapshotV2,
    command: StartWorkerCommand,
  ): Promise<RuntimeConfigSnapshot> => {
    if (catalogPromise === null) catalogPromise = Promise.resolve().then(loadCatalog);
    const catalog = await catalogPromise;
    if (catalog.hash !== command.plugin_catalog_hash) {
      throw new Error('local plugin catalog hash does not match command');
    }
    const compiled = parseNormalizeCompileAggregate(snapshot.aggregate, catalog.toCompileOptions());
    if (!compiled.ok) throw new Error('configuration aggregate validation failed');
    const activatedPluginNames = compiled.value.plugin_activations.map(({ plugin_name }) => plugin_name);
    if (command.activated_plugin_names.length !== activatedPluginNames.length
      || command.activated_plugin_names.some((name, index) => name !== activatedPluginNames[index])) {
      throw new Error('activated plugin names do not match command aggregate');
    }
    if (hashConfigurationContent(compiled.value) !== command.content_hash) {
      throw new Error('configuration content hash does not match command');
    }
    return compileRuntimeConfigSnapshot({
      revision: snapshot.revision,
      content_hash: command.content_hash,
      aggregate: compiled.value,
    });
  };
}
