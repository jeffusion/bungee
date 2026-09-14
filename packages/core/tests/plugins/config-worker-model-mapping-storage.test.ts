import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MigrationManager } from '../../src/migrations/migration-manager';
import { cleanupProcesses, ProcessRegistry } from '../fixtures/process-cleanup';

const CORE_ROOT = resolve(import.meta.dir, '../..');
const REPO_ROOT = resolve(CORE_ROOT, '../..');
const lifecycleUrl = pathToFileURL(resolve(CORE_ROOT, 'src/config-worker/lifecycle.ts')).href;
const pluginContextUrl = pathToFileURL(resolve(CORE_ROOT, 'src/plugin-context-manager.ts')).href;
const pluginManagerUrl = pathToFileURL(resolve(CORE_ROOT, 'src/worker/state/plugin-manager.ts')).href;
const modelMappingControlUrl = pathToFileURL(resolve(CORE_ROOT, '../../plugins/model-mapping/server/control.ts')).href;
const processes = new ProcessRegistry();

afterEach(async () => cleanupProcesses(processes));

test('production config worker shares its access database with model-mapping catalog storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-config-worker-model-mapping-'));
  const dbPath = join(root, 'access.db');
  let exited: Promise<number> | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;

  try {
    expect((await new MigrationManager(dbPath).migrate()).success).toBe(true);
    const seed = new Database(dbPath);
    seed.prepare(`
      INSERT INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
      VALUES (?, ?, ?, NULL, ?)
    `).run('model-mapping', 'catalog:v1:data', JSON.stringify({
      fetchedAt: 1,
      models: [{ value: 'seed-model', label: 'Seed model', description: '', provider: 'seed' }],
    }), Date.now());
    seed.close();

    const script = `
      const { createConfigWorkerLifecycle } = await import(${JSON.stringify(lifecycleUrl)});
      const { getPluginContextManager } = await import(${JSON.stringify(pluginContextUrl)});
      const { getPluginRuntimeOrchestrator } = await import(${JSON.stringify(pluginManagerUrl)});
      const { createControl } = await import(${JSON.stringify(modelMappingControlUrl)});

      const lifecycle = createConfigWorkerLifecycle({
        transportSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      });
      const started = await lifecycle.start(
        { config_version: 4, plugins: [{ name: 'model-mapping', enabled: true }], routes: [] },
        {
          command: 'start-current-config-worker', master_generation: 'master', worker_instance_id: 'worker',
          worker_slot: 1, revision: 1, content_hash: 'sha256:${'a'.repeat(64)}',
          plugin_catalog_hash: 'sha256:${'b'.repeat(64)}', aggregate: {},
          activated_plugin_names: ['model-mapping'], publication: null,
        },
      );
      try {
        const runtime = getPluginRuntimeOrchestrator();
        if (!runtime || (getPluginContextManager() as unknown as { db: unknown }).db !== runtime.getDatabase()) {
          throw new Error('plugin context and runtime do not share the access database');
        }
        const storage = getPluginContextManager().getContext('model-mapping')?.storage;
        if (!storage) throw new Error('model-mapping control storage was not initialized');
        const controlSignal = new AbortController();
        const control = createControl({ signal: controlSignal.signal, secretStore: {}, storage });
        const getCatalog = control.api.find((entry) => entry.handler === 'getCatalog');
        const refreshCatalog = control.api.find((entry) => entry.handler === 'refreshCatalog');
        if (!getCatalog || !refreshCatalog) throw new Error('model-mapping control catalog API is incomplete');
        await control.start();
        const controlContext = {
          signal: controlSignal.signal,
          secretStore: {},
          storage,
          requestSignal: controlSignal.signal,
        };
        const response = await getCatalog.invoke({
          ...controlContext,
          request: new Request('http://localhost/catalog'),
        });
        const status = await response.json() as { source?: string; modelCount?: number; models?: Array<{ value?: string }> };
        if (response.status !== 200 || status.source !== 'stored' || status.modelCount !== 1 || status.models?.[0]?.value !== 'seed-model') {
          throw new Error('control catalog read did not use the persisted catalog');
        }
        globalThis.fetch = async () => new Response(JSON.stringify({
          openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o', limit: { context: 128000 } } } },
        }), { headers: { 'content-type': 'application/json' } });
        const refreshedResponse = await refreshCatalog.invoke({
          ...controlContext,
          request: new Request('http://localhost/catalog/refresh', { method: 'POST' }),
        });
        const refreshed = await refreshedResponse.json() as { source?: string; modelCount?: number; models?: Array<{ value?: string }> };
        if (refreshedResponse.status !== 200 || refreshed.source !== 'stored' || refreshed.modelCount !== 1 || refreshed.models?.[0]?.value !== 'gpt-4o') {
          throw new Error('control catalog refresh did not persist the fetched catalog');
        }
        await control.dispose();
      } finally {
        await lifecycle.stop(started.handle);
      }
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      cwd: REPO_ROOT,
      env: { ...process.env, BUNGEE_ACCESS_DB_PATH: dbPath },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    exited = child.exited;
    processes.registerChild(child);
    stdout = new Response(child.stdout).text();
    stderr = new Response(child.stderr).text();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let exitCode: number;
    try {
      exitCode = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('timed out waiting for config worker fixture')), 5_000);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    const [output, errors] = await Promise.all([stdout, stderr]);

    expect(exitCode, `${output}\n${errors}`).toBe(0);

    const persisted = new Database(dbPath);
    const row = persisted.prepare(`
      SELECT value FROM plugin_storage WHERE plugin_name = ? AND key = ?
    `).get('model-mapping', 'catalog:v1:data') as { value: string } | null;
    persisted.close();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.value).models[0].value).toBe('gpt-4o');
  } finally {
    await cleanupProcesses(processes);
    await Promise.all([stdout, stderr].filter((stream): stream is Promise<string> => stream !== undefined));
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
