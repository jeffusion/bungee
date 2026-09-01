import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { hashConfigurationContent, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createPublicListener, WorkerAdmissionRegistry } from '../../src/public-listener';
import { PluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';
import { servingWorker } from '../fixtures/public-listener';
import {
  cleanupCatalogRoots,
  tempRoot,
  writePlugin,
} from '../unit/plugin-manifest-catalog-fixtures';

const workerEntry = resolve(import.meta.dir, '../../src/main.ts');
const identity = {
  master_generation: '92000000-0000-4000-8000-000000000001',
  worker_instance_id: '93000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};

afterAll(cleanupCatalogRoots);

function message(child: ChildProcess, status: string): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${status}`)), 20_000);
    const onMessage = (value: unknown) => {
      if (value !== null && typeof value === 'object' && 'status' in value && value.status === status) {
        finish(undefined, value);
      }
    };
    const onExit = () => finish(new Error(`worker exited before ${status}`));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolveMessage(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function send(child: ChildProcess, value: object): Promise<void> {
  return new Promise((resolveSend, reject) => {
    child.send(value, (error) => error ? reject(error) : resolveSend());
  });
}

function exit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolveExit) => child.once('exit', resolveExit));
}

describe('public listener with a real config worker', () => {
  test('restores public host and URL before condition routing and preserves query and body', async () => {
    // Given
    const root = tempRoot();
    const pluginName = 'public-listener-proof';
    writePlugin(root, pluginName, undefined, `export default class PublicListenerProof {
      static name = '${pluginName}';
      static version = '1.0.0';
      static async createHandler() { return { pluginName: '${pluginName}', register() {} }; }
    }`);
    const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      return Response.json({
        path: new URL(request.url).pathname,
        query: new URL(request.url).search,
        body: await request.text(),
      });
    } });
    if (upstream.port === undefined) throw new Error('echo upstream did not expose its port');
    const aggregateResult = parseNormalizeCompileAggregate({
      logical_configuration: {
        services: [{
          id: '94000000-0000-4000-8000-000000000001',
          position: 1,
          name: 'conditional-echo',
          endpoints: [{
            id: '95000000-0000-4000-8000-000000000001',
            position: 1,
            target: `http://127.0.0.1:${upstream.port}`,
            condition: '{{ url.host === "public.example" }}',
          }],
        }],
        routes: [{
          id: '96000000-0000-4000-8000-000000000001',
          position: 1,
          path: '/echo',
          service_id: '94000000-0000-4000-8000-000000000001',
          plugins: [{
            id: '97000000-0000-4000-8000-000000000001',
            position: 1,
            name: pluginName,
            enabled: true,
          }],
        }],
        plugins: [],
      },
      plugin_activations: [{ plugin_name: pluginName }],
    }, catalog.toCompileOptions());
    if (!aggregateResult.ok) throw new Error(JSON.stringify(aggregateResult.errors));
    const aggregate: ConfigurationAggregateV2 = aggregateResult.value;
    const child = spawn(process.execPath, [workerEntry], {
      cwd: root,
      env: {
        ...process.env,
        PLUGINS_DIR: root,
        BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
        BUNGEE_ROLE: 'worker',
        BUNGEE_MASTER_GENERATION: identity.master_generation,
        BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id,
        BUNGEE_WORKER_SLOT: '0',
        BUNGEE_MASTER_PID: String(process.pid),
        BUNGEE_HEARTBEAT_TIMEOUT_MS: '10000',
        BUNGEE_SHUTDOWN_TIMEOUT_MS: '1000',
        BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
        BUNGEE_ACCESS_DB_PATH: `${root}/logs/access.db`,
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let listener: ReturnType<typeof createPublicListener> | null = null;
    try {
      const readyMessage = message(child, 'config-ready');
      await send(child, { command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: 1 });
      await send(child, {
        command: 'start-current-config-worker',
        ...identity,
        revision: 1,
        content_hash: hashConfigurationContent(aggregate),
        plugin_catalog_hash: catalog.hash,
        aggregate,
        activated_plugin_names: Object.freeze(aggregate.plugin_activations.map(({ plugin_name }) => plugin_name)),
        publication: null,
      });
      const ready = await readyMessage;
      if (typeof ready.private_port !== 'number') throw new Error('config worker did not report its private port');
      const registry = new WorkerAdmissionRegistry();
      registry.prepare([servingWorker(0, ready.private_port)]).commit();
      listener = createPublicListener({ admission: registry, transportSecret: TEST_WORKER_TRANSPORT_SECRET,
        hostname: '127.0.0.1', port: 0 });
      listener.start();
      if (listener.port === null) throw new Error('public listener did not expose its port');

      // When
      const response = await fetch(`http://127.0.0.1:${listener.port}/echo?value=42`, {
        method: 'POST',
        headers: { host: 'public.example', 'content-type': 'text/plain' },
        body: 'payload',
      });

      // Then
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ path: '/echo', query: '?value=42', body: 'payload' });
    } finally {
      await listener?.stop();
      upstream.stop(true);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = exit(child);
        child.disconnect();
        await exited;
      }
    }
  }, 30_000);
});
