import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MigrationManager } from '../../../src/migrations/migration-manager';
import { PluginStateClient } from '../../../src/plugin-state/client';
import { createSignedWorkerRpcServer, PLUGIN_STORAGE_RPC_PATH } from '../../../src/data-admission/rpc';
import type { PluginStorageOperation } from '../../../src/plugin-state/storage-rpc';
import { cleanupProcesses, ProcessRegistry } from '../../helpers/process-cleanup';

const CORE_ROOT = resolve(import.meta.dir, '../../..');
const REPO_ROOT = resolve(CORE_ROOT, '../..');
const lifecycleUrl = pathToFileURL(resolve(CORE_ROOT, 'src/config-worker/lifecycle.ts')).href;
const pluginContextUrl = pathToFileURL(resolve(CORE_ROOT, 'src/plugin-context-manager.ts')).href;
const pluginManagerUrl = pathToFileURL(resolve(CORE_ROOT, 'src/worker/state/plugin-manager.ts')).href;
const serviceHostUrl = pathToFileURL(resolve(CORE_ROOT, 'src/plugin-services.ts')).href;
const emptyCatalogHostUrl = pathToFileURL(resolve(CORE_ROOT, 'tests/helpers/empty-catalog-service-host.ts')).href;
const catalogIndexUrl = pathToFileURL(resolve(REPO_ROOT, 'plugins/models-dev/server/catalog.ts')).href;
const catalogViewUrl = pathToFileURL(resolve(REPO_ROOT, 'plugins/models-dev/server/local.ts')).href;
const modelMappingControlUrl = pathToFileURL(resolve(CORE_ROOT, '../../plugins/model-mapping/server/control.ts')).href;
const storageFactoryUrl = pathToFileURL(resolve(CORE_ROOT,'src/plugin-state/storage-rpc.ts')).href;
const runtimeDependenciesUrl = pathToFileURL(resolve(CORE_ROOT,'src/config-worker/runtime-dependencies.ts')).href;
const rpcUrl = pathToFileURL(resolve(CORE_ROOT,'src/data-admission/rpc.ts')).href;
const processes = new ProcessRegistry();

afterEach(async () => cleanupProcesses(processes));

test('production config worker uses signed isolated storage while model-mapping reads the sole models-dev catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bungee-config-worker-model-mapping-'));
  const dbPath = join(root, 'access.db');
  const statePath = join(root,'plugin-state.db');
  const transportSecret = Buffer.alloc(32,9).toString('base64url');
  const masterGeneration = '10000000-0000-4000-8000-000000000001';
  const workerIdentity = {role:'worker' as const,master_generation:masterGeneration,process_instance_id:'20000000-0000-4000-8000-000000000001',boot_nonce:'30000000-0000-4000-8000-000000000001',worker_slot:1};
  const serverIdentity = {role:'ingress' as const,process_instance_id:masterGeneration,boot_nonce:masterGeneration};
  let state: PluginStateClient | undefined;
  let bridge: Bun.Server<undefined> | undefined;
  let storageCalls = 0;
  let exited: Promise<number> | undefined;
  let stdout: Promise<string> | undefined;
  let stderr: Promise<string> | undefined;

  try {
    expect((await new MigrationManager(dbPath).migrate()).success).toBe(true);
    state = await PluginStateClient.open(statePath,{initialize:true});
    await state.storage.create('model-mapping').set('catalog:v1:data', {
      fetchedAt: 1,
      models: [{ value: 'seed-model', label: 'Seed model', description: '', provider: 'seed' }],
    });
    const activated = new Set(['model-mapping','models-dev']);
    const signed = createSignedWorkerRpcServer({transportSecret,identity:serverIdentity,
      authorizeWorker:worker=>Object.entries(workerIdentity).every(([key,value])=>worker[key as keyof typeof worker]===value) ? 'active' : 'unknown',
      handle:async(operation,payload)=>{
        const value=payload as {namespace:string;operation:PluginStorageOperation;args:unknown[]};
        if(operation!=='storage' || !activated.has(value.namespace))throw new Error('plugin_storage_namespace_forbidden');
        storageCalls++;
        return state!.storageOperation(value.namespace,value.operation,value.args);
      }});
    bridge=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>new URL(request.url).pathname===PLUGIN_STORAGE_RPC_PATH ? signed(request) : new Response(null,{status:404})});

    const script = `
      const { createConfigWorkerLifecycle } = await import(${JSON.stringify(lifecycleUrl)});
      const { getPluginContextManager } = await import(${JSON.stringify(pluginContextUrl)});
      const { getPluginRuntimeOrchestrator } = await import(${JSON.stringify(pluginManagerUrl)});
      const { createControl } = await import(${JSON.stringify(modelMappingControlUrl)});
      const { PluginServiceHost } = await import(${JSON.stringify(serviceHostUrl)});
      const { emptyCatalogServiceHost } = await import(${JSON.stringify(emptyCatalogHostUrl)});
      const { buildCatalogIndex } = await import(${JSON.stringify(catalogIndexUrl)});
      const { CatalogView, catalogServiceOf } = await import(${JSON.stringify(catalogViewUrl)});
      const {createRemotePluginStorageFactory} = await import(${JSON.stringify(storageFactoryUrl)});
      const {setWorkerPluginStorageFactory} = await import(${JSON.stringify(runtimeDependenciesUrl)});
      const {createSignedWorkerRpcClient} = await import(${JSON.stringify(rpcUrl)});
      const storageRpc=createSignedWorkerRpcClient({transportSecret:${JSON.stringify(transportSecret)},worker:${JSON.stringify(workerIdentity)},expectedServer:${JSON.stringify(serverIdentity)},url:${JSON.stringify(`http://127.0.0.1:${bridge.port}${PLUGIN_STORAGE_RPC_PATH}`)},retry:false});
      setWorkerPluginStorageFactory(createRemotePluginStorageFactory((namespace,operation,args)=>storageRpc('storage',{namespace,operation,args})));

      const lifecycle = createConfigWorkerLifecycle({
        transportSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        services: emptyCatalogServiceHost(),
      });
      const started = await lifecycle.start(
        { config_version: 4, plugins: [{ name: 'model-mapping', enabled: true }, { name: 'models-dev', enabled: true }], routes: [] },
        {
          command: 'start-current-config-worker', master_generation: 'master', worker_instance_id: 'worker',
          worker_slot: 1, revision: 1, content_hash: 'sha256:${'a'.repeat(64)}',
          plugin_catalog_hash: 'sha256:${'b'.repeat(64)}', aggregate: {},
          activated_plugin_names: ['model-mapping', 'models-dev'], publication: null,
        },
      );
      try {
        const runtime = getPluginRuntimeOrchestrator();
        if (!runtime || 'getDatabase' in runtime || 'db' in getPluginContextManager()) {
          throw new Error('plugin runtime exposed a database instead of the signed storage capability');
        }
        const storage = getPluginContextManager().getContext('model-mapping')?.storage;
        if (!storage) throw new Error('model-mapping control storage was not initialized');
        // The old private cache must not become a second catalog source.
        const legacy = await storage.get('catalog:v1:data');
        if (!legacy || legacy.models?.[0]?.value !== 'seed-model') throw new Error('isolated signed storage was not initialized');
        const serviceHost = new PluginServiceHost('control');
        const provider = serviceHost.createContext('models-dev');
        const view = new CatalogView();
        provider.publish('models-dev.catalog.v1', 1, catalogServiceOf(view));
        serviceHost.markReady('models-dev');
        const services = serviceHost.createContext('model-mapping', 'global', { 'models-dev': '^1.0.0' });
        const controlSignal = new AbortController();
        const host = { signal: controlSignal.signal, secretStore: {}, storage, services };
        const control = createControl(host);
        const getCatalog = control.api.find((entry) => entry.handler === 'getCatalog');
        if (!getCatalog || control.api.some(entry => entry.handler === 'refreshCatalog')) throw new Error('model-mapping must expose a read-only catalog adapter');
        await control.start();
        const read = async () => {
          const response = await getCatalog.invoke({ ...host, request: new Request('http://localhost/catalog'), requestSignal: controlSignal.signal });
          if (response.status !== 200) throw new Error('catalog read failed');
          return response.json();
        };
        const empty = await read();
        if (empty.source !== 'catalog' || empty.modelCount !== 0 || empty.models.length !== 0) throw new Error('legacy mapping cache was used as a catalog fallback');
        view.apply(buildCatalogIndex({ version: 1, fetchedAt: 1, catalog: {
          openai: { id: 'openai', models: { 'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' } } },
        } }));
        const current = await read();
        if (current.source !== 'catalog' || current.modelCount !== 1 || current.models?.[0]?.value !== 'gpt-4o') throw new Error('control did not consume the models-dev view');
        await control.dispose();
        await serviceHost.dispose('model-mapping', 'global', services);
        await serviceHost.dispose('models-dev', 'global', provider);
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

    expect(storageCalls).toBeGreaterThan(0);
    const access = new Database(dbPath,{readonly:true});
    try {expect(access.query("SELECT name FROM sqlite_schema WHERE type='table' AND name='plugin_storage'").get()).toBeNull();}finally{access.close(true);}
    const persisted = new Database(statePath,{readonly:true});
    const row = persisted.query(`
      SELECT value FROM plugin_storage WHERE plugin_name = ? AND key = ?
    `).get('model-mapping', 'catalog:v1:data') as { value: string } | null;
    persisted.close(true);
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.value).models[0].value).toBe('seed-model');
  } finally {
    await cleanupProcesses(processes);
    await Promise.all([stdout, stderr].filter((stream): stream is Promise<string> => stream !== undefined));
    await bridge?.stop(true);
    await state?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
