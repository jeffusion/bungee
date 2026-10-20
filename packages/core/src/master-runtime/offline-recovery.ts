import {basename, dirname, resolve, join} from 'node:path';
import {existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AsyncConfigRepository} from '../config-storage/async-config-repository';
import {PluginStateClient} from '../plugin-state/client';
import {parsePluginSecretsKey} from '../plugin-control/host';
import {resolveStorageWorkerUrls} from './process-options';
import {buildPluginManifestCatalog} from '../plugin-manifest-catalog';
import type {PluginManifestRecord} from '../plugin-manifest-catalog/types';
import {PluginPathResolver} from '../plugin-path-resolver';
import {loadImmutableControlArtifact} from '../plugin-control/artifact-loader';
import {withOfflineStorageSession} from './offline-storage-session';
import {readRecoveryAnswers, requireRecoveryTerminal} from './recovery-prompt';

function validateAction(action: unknown): asserts action is string {
  if (typeof action !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(action)
    || ['__proto__', 'constructor', 'prototype'].includes(action)) throw new Error('invalid_recovery_arguments');
}

function validatePlugin(plugin: unknown): asserts plugin is string {
  if (typeof plugin !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(plugin)) throw new Error('invalid_recovery_plugin');
}

async function withRecoveryPlugin<T>(configDbPath: string, plugin: string, operation: (context: {
  repository: AsyncConfigRepository;
  record: PluginManifestRecord;
  openState(): Promise<PluginStateClient>;
}) => Promise<T>): Promise<T> {
  const path = resolve(configDbPath);
  return withOfflineStorageSession(path, async session => {
    if (!existsSync(path)) throw new Error('recovery_configuration_not_initialized');
    const urls = resolveStorageWorkerUrls(import.meta.url);
    const material = parsePluginSecretsKey(process.env.BUNGEE_PLUGIN_SECRETS_KEY);
    const baseDir = basename(import.meta.dir) === 'master-runtime' ? dirname(import.meta.dir) : import.meta.dir;
    const catalog = await buildPluginManifestCatalog({pathResolver: new PluginPathResolver(baseDir, process.cwd())});
    const repository = await session.open(() => AsyncConfigRepository.open(path, {offline: true, compileOptions: catalog.toCompileOptions(), workerUrl: urls.configuration}));
    const aggregate = repository.getSnapshot().aggregate;
    if (aggregate.plugin_activations.some(x => !catalog.has(x.plugin_name))) throw new Error('recovery_active_plugin_not_installed');
    const selected = aggregate.plugin_activations.filter(x => catalog.get(x.plugin_name)?.manifest.management);
    if (selected.length > 1) throw new Error('multiple_management_providers');
    const record = catalog.get(plugin);
    if (!record) throw new Error('recovery_plugin_not_installed');
    return operation({repository, record,
      openState: () => session.open(() => PluginStateClient.open(join(dirname(path), 'plugin-state.db'), {workerUrl: urls.pluginState, material})),
    });
  });
}

function assertIdentityProvider(repository: AsyncConfigRepository, plugin: string, management: unknown): void {
  const selected = repository.getManagementProtection().selectedProvider;
  if (!management || (selected !== null && selected !== plugin)) throw new Error('recovery_provider_not_selected');
}

/** Structured input is reserved for plugin state; identity changes use terminal actions. */
export async function recoverOffline(configDbPath: string, input: unknown): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('invalid_recovery_input');
  const b = input as Record<string, unknown>;
  if (b.kind !== 'identity' && b.kind !== 'plugin-state') throw new Error('invalid_recovery_kind');
  if (Object.keys(b).some(k => !['kind', 'plugin', 'payload'].includes(k))) throw new Error('invalid_recovery_input');
  validatePlugin(b.plugin);
  const plugin = b.plugin;
  return withRecoveryPlugin(configDbPath, plugin, async ({repository, record, openState}) => {
    if (b.kind === 'identity') {
      assertIdentityProvider(repository, plugin, record.manifest.management);
      throw new Error('recovery_requires_interactive_action');
    }
    const module = await loadImmutableControlArtifact(record);
    const capability = module.offlineRecovery;
    if (!capability || capability.kind !== 'plugin-state') throw new Error('offline_recovery_not_supported');
    const state = await openState();
    return capability.recover(b.payload, {durableState: state.durableState(record.name)});
  });
}

/** Both databases close with an ACK before any result escapes. */
export async function recoverOfflineAction(configDbPath: string, input: {plugin: string; action: string}): Promise<unknown> {
  validatePlugin(input.plugin);
  validateAction(input.action);
  if (Object.keys(input).some(k => !['plugin', 'action'].includes(k))) throw new Error('invalid_recovery_arguments');
  requireRecoveryTerminal();
  return withRecoveryPlugin(configDbPath, input.plugin, async ({repository, record, openState}) => {
    assertIdentityProvider(repository, input.plugin, record.manifest.management);
    if (input.action === 'release-auth') {
      if (repository.getManagementProtection().selectedProvider !== input.plugin) throw new Error('recovery_provider_not_selected');
      await repository.setManagementProviderOffline(null, randomUUID(), Date.now());
      return {released: true, plugin: input.plugin};
    }
    const module = await loadImmutableControlArtifact(record);
    const capability = module.offlineRecovery;
    if (!capability || capability.kind !== 'identity') throw new Error('offline_recovery_not_supported');
    const action = Object.hasOwn(capability.actions, input.action) ? capability.actions[input.action] : undefined;
    if (!action || typeof action.run !== 'function') throw new Error('offline_recovery_action_not_supported');
    const answers = await readRecoveryAnswers(action.prompts);
    const state = await openState();
    return action.run(answers, {durableState: state.durableState(record.name), now: Date.now});
  });
}

/** Bound input before parsing; secret values travel exclusively through stdin. */
export async function readRecoveryInput(stream: AsyncIterable<Uint8Array | string>): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of stream) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 8192) throw new Error('recovery_input_too_large'); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('invalid_recovery_json'); }
}
