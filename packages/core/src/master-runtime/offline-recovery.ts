import { basename, dirname, resolve, join } from 'node:path';
import { AsyncConfigRepository } from '../config-storage/async-config-repository';
import { PluginStateClient } from '../plugin-state/client';
import { parsePluginSecretsKey } from '../plugin-control/host';
import { resolveStorageWorkerUrls } from './process-options';
import { buildPluginManifestCatalog } from '../plugin-manifest-catalog';
import { PluginPathResolver } from '../plugin-path-resolver';
import { loadImmutableControlArtifact } from '../plugin-control/artifact-loader';
import { withOfflineStorageSession } from './offline-storage-session';

/** Local stopped-instance operation. No HTTP route and no raw database plugin capability. */
export async function recoverOffline(configDbPath: string, input: unknown): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('invalid_recovery_input');
  const b = input as Record<string, unknown>;
  if (b.kind !== 'identity' && b.kind !== 'plugin-state') throw new Error('invalid_recovery_kind');
  const fields = ['kind', 'plugin', 'payload'];
  if (Object.keys(b).some(k => !fields.includes(k))) throw new Error('invalid_recovery_input');
  const path = resolve(configDbPath);
  return withOfflineStorageSession(path, async session => {
    const urls = resolveStorageWorkerUrls(import.meta.url);
    const material = parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY);
    const baseDir = basename(import.meta.dir) === 'master-runtime' ? dirname(import.meta.dir) : import.meta.dir;
    const catalog = await buildPluginManifestCatalog({pathResolver: new PluginPathResolver(baseDir, process.cwd())});
    const repository = await session.open(() => AsyncConfigRepository.open(path, {compileOptions: catalog.toCompileOptions(), workerUrl: urls.configuration}));
      const aggregate = repository.getSnapshot().aggregate;
      if (aggregate.plugin_activations.some(x => !catalog.has(x.plugin_name))) throw new Error('recovery_active_plugin_not_installed');
      const selected = aggregate.plugin_activations.filter(x => catalog.get(x.plugin_name)?.manifest.management);
      if (selected.length > 1) throw new Error('multiple_management_providers');
      if (typeof b.plugin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(b.plugin)) throw new Error('invalid_recovery_plugin');
      const record = catalog.get(b.plugin);
      if (!record) throw new Error('recovery_plugin_not_installed');
      if (b.kind === 'identity' && (!record.manifest.management || (selected.length && selected[0]?.plugin_name !== b.plugin))) throw new Error('recovery_provider_not_selected');
      const module = await loadImmutableControlArtifact(record);
      const capability = module.offlineRecovery;
      if (!capability || capability.kind !== b.kind) throw new Error('offline_recovery_not_supported');
      const state = await session.open(() => PluginStateClient.open(join(dirname(path), 'plugin-state.db'), {workerUrl: urls.pluginState, material}));
      return capability.recover(b.payload, {durableState: state.durableState(record.name)});
  });
}

/** Bound input before parsing; secret values travel exclusively through stdin. */
export async function readRecoveryInput(stream: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 8192) throw new Error('recovery_input_too_large'); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_recovery_json'); }
}
