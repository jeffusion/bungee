import {pluginStateFixturePath} from './support/plugin-state-fixture';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { SQLitePluginStorage } from '../packages/core/src/plugin-storage';
import { MODELS_DEV_SOURCE_URL } from '../plugins/models-dev/contract';
import { MODELS_DEV_SETTINGS_KEY } from '../plugins/models-dev/server/store';
import {
  cleanupGatewayFixture,
  createModelsDevGatewayFixture,
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
} from './support/models-dev-gateway';
import { ensureTestPortBlockClosed } from './support/test-port-block-broker';

const SERVICE_ID = '10000000-0000-4000-8000-0000000000aa';
const UPSTREAM_ID = '20000000-0000-4000-8000-0000000000aa';
const ROUTE_ID = '30000000-0000-4000-8000-0000000000aa';
const ORDINARY_ROUTE_ID = '30000000-0000-4000-8000-0000000000ab';

/** Explicit activation of the whole chain; each required dependency is activated too. */
const ACTIVATIONS = [
  { plugin_name: 'models-dev' },
  { plugin_name: 'token-metering' },
  { plugin_name: 'token-stats' },
  { plugin_name: 'model-mapping' },
];

/** Explicit client-model alias source; the target is chosen from the REAL catalog. */
const ALIAS_SOURCE = 'fixture-client-model';
/** Canonical real example (zai/glm-5.3): input 1.4, output 4.4, cache_read 0.26 (USD / 1M). */
const CANONICAL_TARGET = { provider: 'zai', model: 'glm-5.3' };
const EXPECTED_CANONICAL_COST = 4.89e-5;

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

describe('models-dev catalog real-process integration (explicit chain activation)', () => {
  let fixture: GatewayFixture | undefined;
  let lease: PortLease | undefined;
  let master: OwnedMaster | undefined;
  const masterStartup: GatewayMasterStartupState = { attempted: false, errors: [] };
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
    fixture = await createModelsDevGatewayFixture();
    lease = await reservePortBlock();
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
    master = await startGatewayMaster(fixture, lease);
    await waitForHealth(master, lease.base, fixture);
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
    if (cleanupErrors.length) {
      const summaries = cleanupErrors.map((error) => evidenceFixture === undefined
        ? error instanceof Error ? error.message : 'unknown cleanup error'
        : safeGatewayError(error, evidenceFixture, 4_096));
      throw new Error(`gateway startup/cleanup failures: ${summaries.join('\n').slice(-24_576)}`);
    }
  }, 45_000);

  test('empty catalog keeps the proxy metering best-effort with unknown price, then the real catalog prices aliases in both workers', async () => {
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

      // Persist models-dev settings (no auto download) through a separate connection,
      // exactly as the control owner would. No alias yet: the first attempt must be
      // metered best-effort with an UNKNOWN price.
      const db = new Database(pluginStateFixturePath(currentFixture.configDbPath));
      try {
        const settings = new SQLitePluginStorage(db, 'models-dev');
        await settings.set(MODELS_DEV_SETTINGS_KEY, { autoRefresh: false, intervalHours: 24, timeoutSeconds: 30 });
      } finally { db.close(); }

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
            id: ROUTE_ID, position: 1, path: '/v1/chat/completions', service_id: SERVICE_ID, plugins: [],
          }, {
            id: ORDINARY_ROUTE_ID, position: 2, path: '/ordinary', service_id: SERVICE_ID, plugins: [],
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
      await postChat(proxy, currentFixture, 'fixture-client-model');
      await waitUntil(async () => (await getStats(management, currentFixture)).upstreamAttempts >= 1,
        'the observation worker did not commit the first metered attempt', 10_000);
      const emptyStats = await getStats(management, currentFixture);
      expect(emptyStats).toMatchObject({ upstreamAttempts: 1, totalInputTokens: 17 });
      expect(emptyStats.estimatedCostUsd).toBeNull();

      // No aliases yet; the shared catalog is empty and nothing may fabricate a price.
      expect((await getMappings(management, currentFixture)).mappings).toEqual([]);

      // Refresh from the REAL models.dev source exactly once, through the plugin API.
      const accepted = await requestJson(`${management}/api/plugins/models-dev/control/catalog/refresh`, { method: 'POST' }, currentFixture);
      expect(accepted.response.status).toBe(202);
      const ready = await waitForReadyCatalog(management, currentFixture);
      expect(ready.state).toBe('ready');
      expect(ready.version).toBe(1);
      expect(ready.providerCount).toBeGreaterThan(150);
      expect(ready.modelCount).toBeGreaterThan(5_000);
      expect(ready.lastError).toBeNull();

      // Real catalog preserves `provider.api` and keeps providers without one; it is
      // never trimmed to a price whitelist.
      const providers = await getProviders(management, currentFixture);
      expect(providers.providers.filter(provider => typeof provider.api === 'string' && provider.api.startsWith('https://')).length).toBeGreaterThan(100);
      expect(providers.providers.some(provider => provider.api === null)).toBe(true);
      const mappingReady = await getMappingCatalog(management, currentFixture);
      expect(mappingReady.modelCount).toBeGreaterThan(5_000);

      // Choose a REAL alias target from the fetched catalog and write the alias through
      // the control API (validated against the shared catalog, explicit priority).
      const target = await chooseAliasTarget(management, currentFixture);
      const alias = { source: ALIAS_SOURCE, provider: target.provider, model: target.model };
      const putMapping = await requestJson(`${management}/api/plugins/token-stats/control/pricing/mappings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify([alias]),
      }, currentFixture);
      expect(putMapping.response.status, scrub(putMapping.text, currentFixture)).toBe(200);
      expect((await getMappings(management, currentFixture)).mappings).toEqual([alias]);

      // Both workers reconcile their own private catalog view; the explicit alias then
      // prices real proxied attempts (bounded polling with real traffic).
      const pricedStats = await postUntilPriced(management, proxy, currentFixture, ALIAS_SOURCE);
      expect(pricedStats.estimatedCostUsd).not.toBeNull();
      expect(pricedStats.estimatedCostUsd!).toBeGreaterThan(0);
      if (target.provider === CANONICAL_TARGET.provider && target.model === CANONICAL_TARGET.model) {
        expect(pricedStats.estimatedCostUsd).toBeCloseTo(EXPECTED_CANONICAL_COST, 9);
      }
      expect(pricedStats.upstreamAttempts).toBeGreaterThanOrEqual(2);

      // An unaliased model on an unprovable localhost URL stays unknown and never adds
      // a guessed or zero cost.
      await postChat(proxy, currentFixture, 'glm-5.3');
      await waitUntil(async () => (await getStats(management, currentFixture)).upstreamAttempts >= pricedStats.upstreamAttempts + 1,
        'the observation worker did not commit the unknown-price attempt', 10_000);
      const afterUnknown = await getStats(management, currentFixture);
      expect(afterUnknown.upstreamAttempts).toBeGreaterThanOrEqual(pricedStats.upstreamAttempts + 1);
      expect(afterUnknown.estimatedCostUsd).toBeCloseTo(pricedStats.estimatedCostUsd!, 12);

      // Client model search path: real distinct attempt records, original case kept,
      // no synthetic rows, independent of any stats range/Top-N.
      const searched = await getClientModels(management, currentFixture, 'fixture-client-model');
      expect(searched).toMatchObject({ total: 1, models: ['fixture-client-model'] });
      const upper = await getClientModels(management, currentFixture, 'FIXTURE-CLIENT-MODEL');
      expect(upper.models).toEqual(['fixture-client-model']);
      const all = await getClientModels(management, currentFixture, '');
      expect(all.models).toEqual(expect.arrayContaining(['fixture-client-model', 'glm-5.3']));
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
      expect(restored).toMatchObject({ state: 'ready', version: 1, source: MODELS_DEV_SOURCE_URL, lastError: null });
      expect(restored.providerCount).toBeGreaterThan(150);
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
      && last.providerCount > 150 && last.modelCount > 5_000;
  }, 'models-dev catalog did not become ready from the real source', 60_000);
  return last!;
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

/** Prefer the canonical real example; otherwise the first model of an https-api provider. */
async function chooseAliasTarget(management: string, fixture: GatewayFixture): Promise<{ provider: string; model: string }> {
  const canonical = await getCatalogModels(management, fixture, CANONICAL_TARGET.model, CANONICAL_TARGET.provider);
  const hit = canonical.models.find(model => model.provider === CANONICAL_TARGET.provider && model.model === CANONICAL_TARGET.model);
  if (hit !== undefined) return { provider: hit.provider, model: hit.model };
  const providers = await getProviders(management, fixture);
  for (const provider of providers.providers) {
    if (typeof provider.api !== 'string' || !provider.api.startsWith('https://')) continue;
    const page = await getCatalogModels(management, fixture, '', provider.provider);
    if (page.models.length > 0) return { provider: page.models[0]!.provider, model: page.models[0]!.model };
  }
  throw new Error('the real catalog exposed no usable alias target');
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
