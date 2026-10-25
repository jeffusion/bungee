/**
 * models-dev catalog integration through a controlled local HTTP directory.
 *
 * The real built control/worker artifacts, the real downloader + JSON parsing and the
 * real snapshot publication are exercised, but the configured catalog source is a
 * local HTTP server owned by this file: no request may leave to the public models.dev
 * endpoint. The existing manual entry `tests/manual/plugin-business-browser-acceptance.ts`
 * remains the public real-source acceptance; controlled data here does not prove it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SQLitePluginStorage } from '../../packages/core/src/plugin-storage';
import { MODELS_DEV_SOURCE_URL } from '../../plugins/models-dev/contract';
import { MODELS_DEV_SETTINGS_KEY } from '../../plugins/models-dev/server/store';
import { pluginStateFixturePath } from '../helpers/plugin-state-fixture';
import { prepareCatalogVersionProbe } from '../helpers/token-stats-fixture';
import {
  cleanupGatewayFixture,
  createGatewayFixture,
  quarantinePortBlock,
  recordOwnedWorkers,
  releasePortBlock,
  requestJson,
  reservePortBlock,
  safeGatewayError,
  scrub,
  startTrackedGatewayMaster,
  stopOwnedMaster,
  waitForHealth,
  waitUntil,
  type GatewayFixture,
  type GatewayMasterStartupState,
  type OwnedMaster,
  type PortLease,
} from '../helpers/gateway-runtime';
import { ensureTestPortBlockClosed } from '../helpers/test-port-block-broker';

const SERVICE_ID = '10000000-0000-4000-8000-0000000000aa';
const UPSTREAM_ID = '20000000-0000-4000-8000-0000000000aa';
const ROUTE_ID = '30000000-0000-4000-8000-0000000000aa';
const CATALOG_READY_ROUTE_ID = '30000000-0000-4000-8000-0000000000ac';

/** Explicit activation of the whole chain; each required dependency is activated too. */
const ACTIVATIONS = [
  { plugin_name: 'models-dev' },
  { plugin_name: 'token-metering' },
  { plugin_name: 'token-stats' },
  { plugin_name: 'model-mapping' },
  { plugin_name: 'catalog-version-probe' },
];

const ALIAS_SOURCE = 'fixture-client-model';
/** Controlled catalog example with input 1.4, output 4.4, cache_read 0.26 (USD / 1M). */
const CANONICAL_TARGET = { provider: 'zai', model: 'glm-5.3' };
const EXPECTED_CANONICAL_COST = 4.89e-5;
/** Model absent from the catalog: no alias and no automatic price may exist. */
const UNKNOWN_MODEL = 'unlisted-acceptance-model';
const CONTROLLED_PROVIDER_COUNT = 3;
const CONTROLLED_MODEL_COUNT = 4;

/** Controlled catalog: a priced provider, one without `api`, and a second priced provider. */
const CONTROLLED_CATALOG = {
  zai: {
    id: 'zai', name: 'Z.AI', api: 'https://api.z.ai/api/paas/v4',
    models: {
      'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', cost: { input: 1.4, output: 4.4, cache_read: 0.26 } },
      'glm-5.3-air': { id: 'glm-5.3-air', name: 'GLM-5.3 Air', cost: { input: 0.7, output: 2.2 } },
    },
  },
  'local-gateway': {
    // No `api`: the catalog must keep this provider instead of trimming it.
    id: 'local-gateway', name: 'Local Gateway',
    models: {
      'local-model': { id: 'local-model', name: 'Local Model' },
    },
  },
  anthropic: {
    id: 'anthropic', name: 'Anthropic', api: 'https://api.anthropic.com',
    models: {
      'claude-fixture': { id: 'claude-fixture', name: 'Claude Fixture', cost: { input: 3, output: 15, cache_read: 0.3 } },
    },
  },
};

type CatalogStatus = {
  source: string;
  state: string;
  version: number | null;
  providerCount: number;
  modelCount: number;
  lastError: string | null;
};
type ProvidersPayload = { providers: Array<{ provider: string; api: string | null; modelCount: number }> };
type CatalogModels = { models: Array<{ provider: string; model: string; name: string }>; total: number };
type MappingCatalog = { source: string; modelCount: number; matchedCount: number };
type Stats = { upstreamAttempts: number; totalInputTokens: number; estimatedCostUsd: number | null };
type ClientModels = { models: string[]; total: number; page: number; pageSize: number };
type MappingsPayload = { mappings: Array<{ source: string; provider: string; model: string }> };
type RuntimeWorker = { pid: number; worker_instance_id: string; boot_nonce: string };

let localCatalogUrl: string | undefined;
let catalogRequests = 0;

/** Real local HTTP source; every unexpected request is rejected, never answered. */
function startControlledCatalogSource(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.pathname !== '/api.json' || url.search !== '') {
        return new Response('unexpected catalog request', { status: 404 });
      }
      if (request.headers.get('accept') !== 'application/json') {
        return new Response('unexpected accept header', { status: 406 });
      }
      catalogRequests += 1;
      return Response.json(CONTROLLED_CATALOG);
    },
  });
  if (server.port === undefined) throw new Error('controlled catalog source did not bind');
  localCatalogUrl = `http://127.0.0.1:${server.port}/api.json`;
  return server;
}

/** Generated control entry: delegates to the REAL createControl and only injects fetch. */
function controlledControlEntry(localUrl: string): string {
  return `import { createControl as createRealControl } from './control.js';
const CATALOG_SOURCE = ${JSON.stringify(MODELS_DEV_SOURCE_URL)};
const LOCAL_CATALOG = ${JSON.stringify(localUrl)};
const realFetch = globalThis.fetch;
export function createControl(context, options) {
  return createRealControl(context, {
    ...options,
    fetch: async (input, init) => {
      if (typeof input !== 'string') throw new Error('unexpected models-dev fetch input');
      const method = (init && init.method ? init.method : 'GET').toUpperCase();
      const headers = new Headers(init && init.headers);
      if (input !== CATALOG_SOURCE || method !== 'GET' || headers.get('accept') !== 'application/json') {
        throw new Error('unexpected models-dev catalog request: ' + method + ' ' + input);
      }
      return realFetch(LOCAL_CATALOG, {
        ...(init && init.signal ? { signal: init.signal } : {}),
        headers: { accept: 'application/json' },
      });
    },
  });
}
export default { createControl };
`;
}

/** Point the copied built plugin's control entry at the generated wrapper. */
async function prepareControlledPlugin(pluginsPath: string): Promise<void> {
  if (localCatalogUrl === undefined) throw new Error('controlled catalog source did not start');
  const pluginPath = join(pluginsPath, 'models-dev');
  const manifestPath = join(pluginPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { control?: { entry?: string } };
  if (manifest.control === undefined) throw new Error('built models-dev manifest has no control entry');
  await writeFile(join(pluginPath, 'control-fixture.js'), controlledControlEntry(localCatalogUrl));
  manifest.control.entry = 'control-fixture.js';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await prepareCatalogVersionProbe(pluginsPath);
}

describe('models-dev catalog real-process integration (controlled local HTTP source)', () => {
  let fixture: GatewayFixture | undefined;
  let lease: PortLease | undefined;
  let master: OwnedMaster | undefined;
  const masterStartup: GatewayMasterStartupState = { attempted: false, errors: [] };
  let catalogSource: ReturnType<typeof Bun.serve> | undefined;
  let upstream: ReturnType<typeof Bun.serve> | undefined;

  async function startGatewayMaster(currentFixture: GatewayFixture, currentLease: PortLease): Promise<OwnedMaster> {
    try {
      master = await startTrackedGatewayMaster(masterStartup, currentFixture, currentLease);
      return master;
    } catch (error) {
      master = masterStartup.master;
      throw error;
    }
  }

  beforeAll(async () => {
    catalogSource = startControlledCatalogSource();
    try {
      fixture = await createGatewayFixture({
        prefix: 'models-dev-gateway',
        plugins: ['models-dev', 'token-metering', 'token-stats', 'model-mapping'],
        preparePlugins: prepareControlledPlugin,
      });
      // Disable automatic refresh before the control process starts: no source request
      // may race the initial empty observation, and the explicit refresh below is the
      // only download. The setting survives the restart.
      const db = new Database(pluginStateFixturePath(fixture.configDbPath));
      try {
        const settings = new SQLitePluginStorage(db, 'models-dev');
        await settings.set(MODELS_DEV_SETTINGS_KEY, { autoRefresh: false, intervalHours: 24, timeoutSeconds: 30 });
      } finally { db.close(); }
      // Technical upstream fixture: it exists only to prove the real proxy+metering
      // chain. It is NOT a commerce credential and its responses are NOT real billing.
      upstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          if (new URL(request.url).pathname !== '/v1/chat/completions' || request.method !== 'POST') {
            return Response.json({ error: 'fixture_not_found' }, { status: 404 });
          }
          await request.json();
          return Response.json({
            id: 'chain-fixture', object: 'chat.completion', model: 'chain-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: 'chain fixture' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24, prompt_tokens_details: { cached_tokens: 5 } },
          }, { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      if (upstream.port === undefined) throw new Error('local chain fixture did not bind');
      // Bind the upstream first so port-block probing excludes its live port; otherwise
      // port:0 can reuse a just-released gateway supervision port.
      lease = await reservePortBlock();
      master = await startGatewayMaster(fixture, lease);
      await waitForHealth(master, lease.base, fixture);
    } catch (error) {
      try { await catalogSource.stop(true); } catch { /* startup error below is the primary evidence */ }
      catalogSource = undefined;
      throw error;
    }
  }, 90_000);

  afterAll(async () => {
    const evidenceFixture = fixture;
    const cleanupErrors: unknown[] = [...masterStartup.errors];
    let shutdownVerified = false;
    if (master !== undefined) {
      try { await stopOwnedMaster(master); shutdownVerified = true; }
      catch (error) { cleanupErrors.push(error); }
    }
    let upstreamClosed = !masterStartup.attempted;
    try { if (upstream !== undefined) { await upstream.stop(true); upstreamClosed = true; } }
    catch (error) { cleanupErrors.push(error); }
    upstream = undefined;
    let leaseReleased = !masterStartup.attempted;
    if (lease !== undefined) {
      try { await releasePortBlock(lease); leaseReleased = true; }
      catch (error) { quarantinePortBlock(lease); cleanupErrors.push(error); }
      lease = undefined;
    }
    const portsVerifiedClosed = !masterStartup.attempted || (upstreamClosed && leaseReleased);
    if (fixture !== undefined) {
      try {
        const removed = await cleanupGatewayFixture(fixture, {
          startupAttempted: masterStartup.attempted, master, shutdownVerified, portsVerifiedClosed,
        });
        if (!removed) cleanupErrors.push(new Error(`startup, process ownership, or port closure is unverified; preserving fixture and logs at ${fixture.root}`));
      } catch (error) { cleanupErrors.push(error); }
      fixture = undefined;
    }
    try { if (catalogSource !== undefined) { await catalogSource.stop(true); } }
    catch (error) { cleanupErrors.push(error); }
    catalogSource = undefined;
    if (cleanupErrors.length) {
      const summaries = cleanupErrors.map((error) => evidenceFixture === undefined
        ? error instanceof Error ? error.message : 'unknown cleanup error'
        : safeGatewayError(error, evidenceFixture, 4_096));
      throw new Error(`gateway startup/cleanup failures: ${summaries.join('\n').slice(-24_576)}`);
    }
  }, 45_000);

  test('empty catalog keeps the proxy metering best-effort with unknown price; after both workers apply the refreshed catalog the alias prices proxied attempts', async () => {
    if (fixture === undefined || lease === undefined || upstream?.port === undefined || master === undefined) {
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const upstreamPort = upstream.port;
    const management = `http://127.0.0.1:${currentLease.base}`;
    const proxy = `http://127.0.0.1:${currentLease.block.ports[1]}`;

    try {
      const initial = await requestJson(`${management}/api/config`, {}, currentFixture);
      expect(initial.response.status).toBe(200);
      const baseRevision = (initial.body as { revision: number }).revision;
      expect(Number.isSafeInteger(baseRevision)).toBe(true);

      const aggregate = {
        plugin_activations: ACTIVATIONS,
        logical_configuration: {
          plugins: [],
          services: [{
            id: SERVICE_ID, position: 1, name: 'models-dev-chain-service', plugins: [],
            endpoints: [{
              id: UPSTREAM_ID, position: 1, target: `http://127.0.0.1:${upstreamPort}`,
              weight: 100, priority: 1, is_disabled: false, plugins: [],
            }],
          }],
          routes: [{
            id: ROUTE_ID, position: 1, path: '/v1/chat/completions', service_references: [{ id: crypto.randomUUID(), position: 0, service_id: SERVICE_ID, weight: 100, priority: 1, is_disabled: false }], plugins: [],
          }, {
            id: CATALOG_READY_ROUTE_ID, position: 2, path: '/catalog-fixture-ready', service_references: [{ id: crypto.randomUUID(), position: 0, service_id: SERVICE_ID, weight: 100, priority: 1, is_disabled: false }], plugins: [],
          }],
        },
      };
      const mutationId = randomUUID();
      const commit = await requestJson(`${management}/api/config`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: baseRevision, mutation_id: mutationId, aggregate }),
      }, currentFixture);
      expect(commit.response.status).toBe(202);
      await waitForOperation(management, mutationId, currentFixture);
      const workers = await waitForWorkers(management, baseRevision + 1, currentFixture);
      await recordOwnedWorkers(master!, workers);
      expect(workers).toHaveLength(2);

      // First boot: the service is published, the catalog is empty (no download yet),
      // and consumers see it as a real consumer of the same control-local service.
      const empty = await getCatalogStatus(management, currentFixture);
      expect(empty).toMatchObject({ state: 'empty', version: null, providerCount: 0, modelCount: 0, source: MODELS_DEV_SOURCE_URL, lastError: null });
      const mappingEmpty = await getMappingCatalog(management, currentFixture);
      expect(mappingEmpty).toMatchObject({ source: 'catalog', modelCount: 0 });

      // Proxy still serves and meters best-effort; price is unknown, never 0.
      await postChat(proxy, currentFixture, ALIAS_SOURCE);
      await waitUntil(async () => (await getStats(management, currentFixture)).upstreamAttempts >= 1,
        'the observation worker did not commit the first metered attempt', 10_000);
      const emptyStats = await getStats(management, currentFixture);
      expect(emptyStats).toMatchObject({ upstreamAttempts: 1, totalInputTokens: 17 });
      expect(emptyStats.estimatedCostUsd).toBeNull();

      // No aliases yet; the shared catalog is empty and nothing may fabricate a price.
      expect((await getMappings(management, currentFixture)).mappings).toEqual([]);

      // Refresh from the configured source exactly once, through the plugin API.
      const accepted = await requestJson(`${management}/api/plugins/models-dev/control/catalog/refresh`, { method: 'POST' }, currentFixture);
      expect(accepted.response.status).toBe(202);
      const ready = await waitForReadyCatalog(management, currentFixture);
      expect(ready.state).toBe('ready');
      expect(ready.version).toBe(1);
      expect(ready.source).toBe(MODELS_DEV_SOURCE_URL);
      expect(ready.lastError).toBeNull();
      expect(ready.providerCount).toBe(CONTROLLED_PROVIDER_COUNT);
      expect(ready.modelCount).toBe(CONTROLLED_MODEL_COUNT);
      // Automatic refresh is disabled, so the single explicit refresh above is the only
      // download of this run; a local shortcut payload never counts.
      expect(catalogRequests).toBe(1);

      // `provider.api` is preserved and providers without one survive; nothing is
      // trimmed to a price whitelist.
      const providers = await getProviders(management, currentFixture);
      expect(providers.providers.map(({ provider, api, modelCount }) => ({ provider, api, modelCount }))).toEqual([
        { provider: 'anthropic', api: 'https://api.anthropic.com', modelCount: 1 },
        { provider: 'local-gateway', api: null, modelCount: 1 },
        { provider: 'zai', api: 'https://api.z.ai/api/paas/v4', modelCount: 2 },
      ]);
      const models = await getCatalogModels(management, currentFixture, 'glm-5.3', 'zai');
      expect(models.total).toBe(2);
      expect(models.models).toContainEqual(expect.objectContaining({ provider: 'zai', model: 'glm-5.3', name: 'GLM-5.3' }));
      const mappingReady = await getMappingCatalog(management, currentFixture);
      expect(mappingReady).toMatchObject({ source: 'catalog', modelCount: CONTROLLED_MODEL_COUNT, matchedCount: CONTROLLED_MODEL_COUNT });

      // Control readiness alone does not prove either worker consumed the snapshot.
      // Each serving PID must report its own catalog view ready at this version
      // before the alias is written.
      await waitForBothWorkersCatalogReady(proxy, currentFixture, workers, ready.version!);

      // Write the alias through the control API (validated against the shared
      // catalog, explicit priority).
      const alias = { source: ALIAS_SOURCE, ...CANONICAL_TARGET };
      const putMapping = await requestJson(`${management}/api/plugins/token-stats/control/pricing/mappings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([alias]),
      }, currentFixture);
      expect(putMapping.response.status, scrub(putMapping.text, currentFixture)).toBe(200);
      expect((await getMappings(management, currentFixture)).mappings).toEqual([alias]);

      // Both workers already applied this catalog version; the explicit alias then
      // prices real proxied attempts (bounded polling with real traffic).
      const pricedStats = await postUntilPriced(management, proxy, currentFixture, ALIAS_SOURCE);
      expect(pricedStats.estimatedCostUsd).not.toBeNull();
      expect(pricedStats.estimatedCostUsd!).toBeGreaterThan(0);
      expect(pricedStats.estimatedCostUsd).toBeCloseTo(EXPECTED_CANONICAL_COST, 9);
      expect(pricedStats.upstreamAttempts).toBeGreaterThanOrEqual(2);

      // An unaliased model that the catalog cannot resolve stays unknown and never
      // adds a guessed or zero cost.
      await postChat(proxy, currentFixture, UNKNOWN_MODEL);
      await waitUntil(async () => (await getStats(management, currentFixture)).upstreamAttempts >= pricedStats.upstreamAttempts + 1,
        'the observation worker did not commit the unknown-price attempt', 10_000);
      const afterUnknown = await getStats(management, currentFixture);
      expect(afterUnknown.upstreamAttempts).toBeGreaterThanOrEqual(pricedStats.upstreamAttempts + 1);
      expect(afterUnknown.estimatedCostUsd).toBeCloseTo(pricedStats.estimatedCostUsd!, 12);

      // Client model search path: real distinct attempt records, original case kept,
      // no synthetic rows, independent of any stats range/Top-N.
      const searched = await getClientModels(management, currentFixture, ALIAS_SOURCE);
      expect(searched).toMatchObject({ total: 1, models: [ALIAS_SOURCE] });
      const upper = await getClientModels(management, currentFixture, ALIAS_SOURCE.toUpperCase());
      expect(upper.models).toEqual([ALIAS_SOURCE]);
      const all = await getClientModels(management, currentFixture, '');
      expect(all.models).toEqual(expect.arrayContaining([ALIAS_SOURCE, UNKNOWN_MODEL]));
      expect(all.total).toBe(new Set(all.models).size);

      // Restart: the catalog is readable from durable persistence at the same version,
      // the source stays unique, and mappings/stats survive.
      const oldPids = workers.map(worker => worker.pid);
      await stopOwnedMaster(master!);
      master = undefined;
      await waitUntil(async () => oldPids.every(pid => !isPidAlive(pid)), 'old serving workers did not exit', 15_000);
      await ensureTestPortBlockClosed(currentLease.block);
      master = await startGatewayMaster(currentFixture, currentLease);
      await waitForHealth(master, currentLease.base, currentFixture);
      const afterRestart = await waitForWorkers(management, baseRevision + 1, currentFixture);
      await recordOwnedWorkers(master, afterRestart);
      const restored = await getCatalogStatus(management, currentFixture);
      expect(restored).toMatchObject({ state: 'ready', version: ready.version, source: MODELS_DEV_SOURCE_URL, lastError: null });
      expect(restored.providerCount).toBe(ready.providerCount);
      // Restart restores the durable snapshot; it must not download the source again.
      expect(catalogRequests).toBe(1);
      expect((await getMappings(management, currentFixture)).mappings).toEqual([alias]);
      const restoredStats = await getStats(management, currentFixture);
      expect(restoredStats.upstreamAttempts).toBeGreaterThanOrEqual(afterUnknown.upstreamAttempts);
    } catch (error) {
      const diagnostics = (await master?.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      throw new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${master?.child.exitCode ?? master?.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
    }
  }, 180_000);
});

async function waitForOperation(management: string, mutationId: string, fixture: GatewayFixture): Promise<void> {
  await waitUntil(async () => {
    const result = await requestJson(`${management}/api/config/operations/${mutationId}`, {}, fixture);
    const body = result.body as { operation?: { state?: string } };
    if (body.operation?.state === 'degraded' || body.operation?.state === 'failed') {
      throw new Error(`config operation ${body.operation.state}: ${scrub(result.text, fixture)}`);
    }
    return result.response.status === 200 && body.operation?.state === 'converged';
  }, `configuration mutation ${mutationId} did not converge`, 30_000);
}

async function waitForWorkers(management: string, expectedRevision: number, fixture: GatewayFixture): Promise<RuntimeWorker[]> {
  let workers: RuntimeWorker[] = [];
  await waitUntil(async () => {
    const result = await requestJson(`${management}/api/config/runtime`, {}, fixture);
    if (!result.response.ok) return false;
    const body = result.body as {
      revision?: number; workers?: RuntimeWorker[];
      publication?: { serving_complete?: boolean; serving_revision?: number | null };
    };
    workers = body.workers ?? [];
    return body.revision === expectedRevision && body.publication?.serving_complete === true
      && body.publication.serving_revision === expectedRevision && workers.length === 2
      && workers.every(worker => Number.isSafeInteger(worker.pid)
        && typeof worker.worker_instance_id === 'string' && typeof worker.boot_nonce === 'string');
  }, `two workers did not serve revision ${expectedRevision}`, 30_000);
  return workers;
}

async function getCatalogStatus(management: string, fixture: GatewayFixture): Promise<CatalogStatus> {
  const result = await requestJson(`${management}/api/plugins/models-dev/control/catalog/status`, {}, fixture);
  if (!result.response.ok) throw new Error(`models-dev status returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  return result.body as CatalogStatus;
}

async function waitForReadyCatalog(management: string, fixture: GatewayFixture): Promise<CatalogStatus> {
  let last: CatalogStatus | undefined;
  await waitUntil(async () => {
    last = await getCatalogStatus(management, fixture);
    return last.state === 'ready' && typeof last.version === 'number' && last.version >= 1
      && last.providerCount > 0 && last.modelCount > 0;
  }, 'models-dev catalog did not become ready from the controlled source', 60_000);
  return last!;
}

/** Read-only probe: every serving PID must report its own catalog view ready at version. */
async function waitForBothWorkersCatalogReady(
  proxy: string,
  fixture: GatewayFixture,
  workers: readonly RuntimeWorker[],
  version: number,
): Promise<void> {
  const observed = new Set<number>();
  await waitUntil(async () => {
    const result = await requestJson(`${proxy}/catalog-fixture-ready`, {}, fixture);
    if (!result.response.ok) return false;
    const body = result.body as { pid?: number; version?: number; state?: string };
    if (body.version === version && body.state === 'ready' && Number.isSafeInteger(body.pid)
      && workers.some(worker => worker.pid === body.pid)) observed.add(body.pid!);
    return workers.every(worker => observed.has(worker.pid));
  }, `both workers did not apply catalog version ${version}`, 30_000);
}

async function getCatalogModels(management: string, fixture: GatewayFixture, search: string, provider?: string): Promise<CatalogModels> {
  const params = new URLSearchParams();
  if (search.length > 0) params.set('search', search);
  if (provider !== undefined) params.set('provider', provider);
  const query = params.size > 0 ? `?${params.toString()}` : '';
  const result = await requestJson(`${management}/api/plugins/models-dev/control/catalog/models${query}`, { signal: AbortSignal.timeout(10_000) }, fixture);
  if (!result.response.ok) throw new Error(`models-dev models returned ${result.response.status}`);
  return result.body as CatalogModels;
}

async function getProviders(management: string, fixture: GatewayFixture): Promise<ProvidersPayload> {
  const result = await requestJson(`${management}/api/plugins/models-dev/control/catalog/providers`, { signal: AbortSignal.timeout(10_000) }, fixture);
  if (!result.response.ok) throw new Error(`models-dev providers returned ${result.response.status}`);
  return result.body as ProvidersPayload;
}

async function getMappingCatalog(management: string, fixture: GatewayFixture): Promise<MappingCatalog> {
  const result = await requestJson(`${management}/api/plugins/model-mapping/control/catalog`, {}, fixture);
  if (!result.response.ok) throw new Error(`model-mapping catalog returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  return result.body as MappingCatalog;
}

async function getStats(management: string, fixture: GatewayFixture): Promise<Stats> {
  const result = await requestJson(`${management}/api/plugins/token-stats/control/stats?range=1h&groupBy=model`, { signal: AbortSignal.timeout(10_000) }, fixture);
  if (!result.response.ok) throw new Error(`token-stats stats returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  return result.body as Stats;
}

async function getMappings(management: string, fixture: GatewayFixture): Promise<MappingsPayload> {
  const result = await requestJson(`${management}/api/plugins/token-stats/control/pricing/mappings`, {}, fixture);
  if (!result.response.ok) throw new Error(`token-stats mappings returned ${result.response.status}`);
  return result.body as MappingsPayload;
}

async function getClientModels(management: string, fixture: GatewayFixture, search: string): Promise<ClientModels> {
  const query = search.length === 0 ? '' : `?search=${encodeURIComponent(search)}`;
  const result = await requestJson(`${management}/api/plugins/token-stats/control/models${query}`, {}, fixture);
  if (!result.response.ok) throw new Error(`token-stats models returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  return result.body as ClientModels;
}

async function postChat(proxy: string, fixture: GatewayFixture, model: string): Promise<void> {
  const attempts = (): number => {
    const database = new Database(fixture.accessDbPath, { readonly: true });
    try { return database.query<{count:number}, []>('SELECT COUNT(*) AS count FROM token_stats_attempts').get()!.count; }
    finally { database.close(); }
  };
  const before = attempts();
  const result = await requestJson(`${proxy}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'chain fixture request' }] }),
  }, fixture);
  if (result.response.status !== 200) throw new Error(`gateway POST returned ${result.response.status}: ${scrub(result.text, fixture)}`);
  expect(result.body).toMatchObject({ usage: { prompt_tokens: 17, completion_tokens: 7 } });
  // Response completion and observer persistence are independent. All later
  // aggregate assertions must begin after this real attempt has been committed.
  await waitUntil(async () => attempts() >= before + 1, 'the observation worker did not persist the proxied attempt', 10_000);
}

/** Real proxy traffic every second until the alias is priced by a reconciled worker. */
async function postUntilPriced(management: string, proxy: string, fixture: GatewayFixture, model: string): Promise<Stats> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    await postChat(proxy, fixture, model);
    const stats = await getStats(management, fixture);
    if (stats.estimatedCostUsd !== null) return stats;
    if (Date.now() >= deadline) throw new Error(`alias was never priced by a reconciled worker: ${JSON.stringify(stats)}`);
    await Bun.sleep(1_000);
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
