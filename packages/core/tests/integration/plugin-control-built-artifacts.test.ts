import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadImmutableControlArtifact } from '../../src/plugin-control/artifact-loader';
import type { ControlHostContext, PluginControl } from '../../src/plugin-control/contracts';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog/catalog';
import { PluginStateClient } from '../../src/plugin-state/client';
import { createAsyncMasterStats, migrateAccessDatabaseAsync } from '../../src/master-runtime/observability-client';
import type { MasterStatsApi } from '../../src/master-runtime/master-stats';
import type { TokenStatsMeteringStorage } from '../../src/plugin.types';

test('formal token statistics and budget bundles start against the real plugin-state Worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-built-control-start-'));
  let state: PluginStateClient | undefined;
  let observations: MasterStatsApi | undefined;
  const controls: PluginControl[] = [];
  const lifetime = new AbortController();
  try {
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [resolve(import.meta.dir, '../../dist/plugins')] });
    state = await PluginStateClient.open(join(directory, 'plugin-state.db'), { initialize: true });
    const accessDatabase = join(directory, 'access.db');
    await migrateAccessDatabaseAsync(accessDatabase);
    observations = await createAsyncMasterStats(accessDatabase);
    await observations.registerObservationAdapter!('token-stats', catalog.get('token-stats')!.controlPath!);
    for (const name of ['token-stats', 'token-budget']) {
      const artifact = await loadImmutableControlArtifact(catalog.get(name)!);
      const kv = state.storage.create(name);
      const storage = name === 'token-stats'
        ? Object.freeze({ ...kv, metering: observations.observationAdapter!('token-stats') as unknown as TokenStatsMeteringStorage })
        : kv;
      const context: ControlHostContext = {
        signal: lifetime.signal, storage,
        secretStore: state.secretStores.create(name),
        durableState: state.durableState(name),
      };
      const control = artifact.createControl(context);
      controls.push(control);
      await control.start();
      const path = name === 'token-stats' ? '/stats?range=1h' : '/keys/artifact-test-key';
      const api = control.api.find(api => api.path === (name === 'token-stats' ? '/stats' : '/keys/:keyId'))!;
      const response = await api.invoke({ ...context, request: new Request(`http://localhost${path}`), requestSignal: lifetime.signal });
      expect(response.status).toBe(200);
      const body = await response.json() as { active?: boolean; data?: unknown[] };
      if (name === 'token-budget') expect(body.active).toBe(true);
      else expect(body.data).toEqual([]);
    }
  } finally {
    for (const control of controls.reverse()) await control.dispose();
    lifetime.abort();
    await observations?.close();
    await state?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
