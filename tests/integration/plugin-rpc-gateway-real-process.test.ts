import {pluginStateFixturePath} from '../helpers/plugin-state-fixture';
/**
 * Real production-entry plugin RPC acceptance: a REAL master plus its two supervised
 * workers (the same DaemonManager launch path as `token-stats-gateway-real-process`)
 * activate a control-plane provider plugin and a worker consumer plugin through real
 * manifests. The consumer consumes the control-provided RPC service during worker
 * bootstrap over the authenticated peer transport, then repeats an idempotent
 * local-transaction command.
 *
 * Proven here:
 *  - the bootstrap query is served by the control provider for BOTH supervised worker
 *    PIDs (real per-worker evidence, matched against `/api/config/runtime`);
 *  - the same stable operation id is not re-executed (one host atomic planner run, one
 *    stored result) and `queryResult` returns that durable result;
 *  - the journal survives a full master restart: the restarted workers read the same
 *    committed result with zero planner runs in the new control instance;
 *  - a management-only method is refused from the bootstrap frame (`wrong_purpose`);
 *  - a caller-cancelled gated query never yields a business result (`cancelled`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { once } from 'node:events';
import { captureProcessIdentity, probeProcessIdentity, probeProcessInstance } from '../../packages/core/src/master-runtime/process-identity';
import {
  cleanupGatewayFixture,
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
import { createRpcGatewayFixture, RPC_PROBE_CONSUMER, RPC_PROBE_PROVIDER } from '../helpers/plugin-rpc-gateway-fixture';
import { ensureTestPortBlockClosed } from '../helpers/test-port-block-broker';

const SERVICE_ID = '10000000-0000-4000-8000-000000000201';
const UPSTREAM_ID = '20000000-0000-4000-8000-000000000201';
const ROUTE_ID = '30000000-0000-4000-8000-000000000201';

type ProbeReport = { purpose: string | null; payload: Record<string, any> };
type ProbeState = {
  plannerRuns: number;
  shutdownActivePids: number[];
  calls: Array<{ method: string; purpose: string | null; pid: number | null }>;
  reports: ProbeReport[];
  slow: { entered: boolean; aborted: boolean };
};

type RuntimeWorker = { pid: number; worker_instance_id: string; boot_nonce: string };

describe('plugin RPC gateway real-process integration (control provider ↔ supervised workers)', () => {
  let fixture: GatewayFixture | undefined;
  let lease: PortLease | undefined;
  let master: OwnedMaster | undefined;
  const masterStartup: GatewayMasterStartupState = { attempted: false, errors: [] };

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
    fixture = await createRpcGatewayFixture();
    lease = await reservePortBlock();
    master = await startGatewayMaster(fixture, lease);
    await waitForHealth(master, lease.base, fixture);
  }, 90_000);

  afterAll(async () => {
    const evidenceFixture = fixture;
    const cleanupErrors: unknown[] = [...masterStartup.errors];
    let shutdownVerified = false;
    if (master !== undefined) {
      try {
        await stopOwnedMaster(master);
        shutdownVerified = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    let leaseReleased = !masterStartup.attempted;
    if (lease !== undefined) {
      try {
        await releasePortBlock(lease);
        leaseReleased = true;
      } catch (error) {
        quarantinePortBlock(lease);
        cleanupErrors.push(error);
      }
      lease = undefined;
    }
    const portsVerifiedClosed = !masterStartup.attempted || leaseReleased;
    if (fixture !== undefined) {
      try {
        const removed = await cleanupGatewayFixture(fixture, {
          startupAttempted: masterStartup.attempted,
          master,
          shutdownVerified,
          portsVerifiedClosed,
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

  test('a control provider serves both supervised workers and its journal survives restart', async () => {
    if (fixture === undefined || lease === undefined || master === undefined) {
      throw new Error('real-process fixture did not initialize');
    }
    const currentFixture = fixture;
    const currentLease = lease;
    const management = `http://127.0.0.1:${currentLease.base}`;

    try {
      const initial = await requestJson(`${management}/api/config`, {}, currentFixture);
      expect(initial.response.status).toBe(200);
      const initialRevision = Number((initial.body as { revision?: number }).revision);
      expect(Number.isSafeInteger(initialRevision)).toBe(true);
      expect(initialRevision).toBeGreaterThan(0);

      const aggregate = {
        plugin_activations: [
          { plugin_name: RPC_PROBE_PROVIDER },
          { plugin_name: RPC_PROBE_CONSUMER },
        ],
        logical_configuration: {
          plugins: [],
          services: [{
            id: SERVICE_ID, position: 1, name: 'rpc-probe-noop', plugins: [],
            endpoints: [{
              id: UPSTREAM_ID, position: 1, target: 'http://127.0.0.1:9/', weight: 100, priority: 1, is_disabled: false, plugins: [],
            }],
          }],
          routes: [{
            id: ROUTE_ID, position: 1, path: '/rpc-probe-noop', service_id: SERVICE_ID, plugins: [],
          }],
        },
      };
      const mutationId = randomUUID();
      const commit = await requestJson(`${management}/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: initialRevision, mutation_id: mutationId, aggregate }),
      }, currentFixture);
      expect(commit.response.status).toBe(202);
      await waitForOperation(management, mutationId, currentFixture);

      const revision = initialRevision + 1;
      const firstWorkers = await waitForWorkers(management, revision, currentFixture);
      await recordOwnedWorkers(master, firstWorkers);
      expect(firstWorkers).toHaveLength(2);
      const firstPids = firstWorkers.map((worker) => worker.pid).sort((left, right) => left - right);
      const firstInstances = firstWorkers.map((worker) => worker.worker_instance_id).sort();

      // ---- bootstrap: both workers must have used the control RPC during initialization.
      const bootstrapState = await waitForProbeState(management, currentFixture, (state) => {
        const boot = bootstrapReports(state);
        if (boot.length < 2 || new Set(boot.map((report) => report.payload.pid)).size !== 2) return false;
        if (state.plannerRuns < 1) return false;
        return boot.every((report) => report.payload.adminCode === 'wrong_purpose'
          && numberOrNull(report.payload.commandValue?.value) !== null
          && report.payload.commandValue?.value === report.payload.commandRepeat?.value
          && report.payload.commandValue?.value === report.payload.persisted?.value);
      }, 'two supervised workers did not complete the bootstrap control RPC sequence');

      const bootReports = bootstrapReports(bootstrapState);
      expect(bootReports.map((report) => report.payload.pid).sort((left, right) => left - right)).toEqual(firstPids);
      for (const report of bootReports) {
        expect(report.purpose).toBe('bootstrap');
        expect(report.payload.echoPurpose).toBe('bootstrap');
        expect(report.payload.adminCode).toBe('wrong_purpose');
        expect(report.payload.commandValue).toMatchObject({ plannerRuns: 1 });
        expect(report.payload.persisted).toEqual(report.payload.commandValue);
      }
      // CAS preparation may invoke a pure planner concurrently. Only one durable
      // mutation may commit, regardless of the number of prepared plans.
      const stateDb = new Database(pluginStateFixturePath(currentFixture.configDbPath), { readonly: true });
      try {
        expect(stateDb.query('SELECT version, value_json FROM plugin_durable_records WHERE key = ?')
          .all('rpc-probe-allocate')).toEqual([{ version: 1, value_json: '{"value":1}' }]);
      } finally { stateDb.close(); }
      const expectedCommandValue = bootReports[0]!.payload.commandValue.value as number;
      expect([...new Set(bootstrapState.calls
        .filter((call) => call.method === 'echo' && call.purpose === 'bootstrap')
        .map((call) => call.pid))]
        .sort((left, right) => (left ?? 0) - (right ?? 0))).toEqual(firstPids);

      // ---- background: a genuine (non-inherited) background-purpose round.
      const backgroundState = await waitForProbeState(management, currentFixture, (state) => {
        const background = backgroundReports(state);
        if (background.length < 2 || new Set(background.map((report) => report.payload.pid)).size !== 2) return false;
        return background.every((report) => report.purpose === 'background'
          && report.payload.pulsePurpose === 'background'
          && numberOrNull(report.payload.commandValue?.value) !== null
          && report.payload.commandValue?.value === report.payload.persisted?.value
          && report.payload.cancelCode === 'cancelled');
      }, 'workers did not complete the background control RPC sequence');
      const bgReports = backgroundReports(backgroundState);
      expect(bgReports.map((report) => report.payload.pid).sort((left, right) => left - right)).toEqual(firstPids);
      for (const report of bgReports) {
        expect(report.payload.commandValue.value).toBe(expectedCommandValue);
        expect(report.payload.persisted.value).toBe(expectedCommandValue);
        expect(report.payload.cancelCode).toBe('cancelled');
      }

      // ---- restart: the durable journal must serve the same committed result.
      // Both workers still have accepted business work when authenticated shutdown freezes authority.
      await requestJson(`${management}/api/plugins/${RPC_PROBE_PROVIDER}/control/crash`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shutdownGate: true }),
      }, currentFixture);
      const shutdownState = await waitForProbeState(management, currentFixture,
        state => firstPids.every(pid => state.shutdownActivePids.includes(pid)),
        'both workers did not have active shutdown-gated queries');
      expect(shutdownState.shutdownActivePids.sort((left, right) => left - right)).toEqual(firstPids);
      await stopOwnedMaster(master);
      master = undefined;
      await waitUntil(async () => firstPids.every((pid) => !isPidAlive(pid)), 'old serving workers did not exit', 15_000);
      await ensureTestPortBlockClosed(currentLease.block);

      master = await startGatewayMaster(currentFixture, currentLease);
      await waitForHealth(master, currentLease.base, currentFixture);
      const afterWorkers = await waitForWorkers(management, revision, currentFixture);
      await recordOwnedWorkers(master, afterWorkers);
      expect(afterWorkers).toHaveLength(2);
      expect(afterWorkers.map((worker) => worker.worker_instance_id).sort()).not.toEqual(firstInstances);
      const afterPids = afterWorkers.map((worker) => worker.pid).sort((left, right) => left - right);

      const restartState = await waitForProbeState(management, currentFixture, (state) => {
        const boot = bootstrapReports(state);
        if (boot.length < 2 || new Set(boot.map((report) => report.payload.pid)).size !== 2) return false;
        if (state.plannerRuns !== 0) return false;
        return boot.every((report) => report.payload.commandValue?.value === expectedCommandValue
          && report.payload.persisted?.value === expectedCommandValue);
      }, 'the durable command journal did not survive the master restart');

      expect(restartState.plannerRuns).toBe(0);
      const restartBoot = bootstrapReports(restartState);
      expect(restartBoot.map((report) => report.payload.pid).sort((left, right) => left - right)).toEqual(afterPids);
      for (const report of restartBoot) {
        expect(report.payload.commandValue.value).toBe(expectedCommandValue);
        expect(report.payload.persisted.value).toBe(expectedCommandValue);
      }
    } catch (error) {
      const runtime = await requestJson(`${management}/api/config/runtime`, { signal: AbortSignal.timeout(2_000) }, currentFixture)
        .then(result => result.body, () => null);
      const provider = await readProbeState(management, currentFixture);
      console.error(scrub(JSON.stringify({ event: 'rpc_probe_failure_snapshot', runtime, provider,
        workerDiagnostics: await readWorkerDiagnostics(currentFixture) }), currentFixture));
      const diagnostics = (await master?.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      throw new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${master?.child.exitCode ?? master?.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
    }
  }, 120_000);

  test('SIGKILL of an entered control callee preserves workers, releases old barriers and recovers pending external commands', async () => {
    if (!fixture || !lease || !master) throw new Error('fixture unavailable');
    const currentFixture = fixture, currentLease = lease;
    const management = `http://127.0.0.1:${lease.base}`;
    const oldMaster = master;
    let evidence: Record<string, unknown> = {};
    const evidenceRoot = join(currentFixture.root, 'crash-evidence');
    try {
      const initial = await requestJson(`${management}/api/config`, {}, currentFixture);
      const revision = (initial.body as any).revision;
      const oldWorkers = await waitForWorkers(management, revision, currentFixture);
      await recordOwnedWorkers(oldMaster, oldWorkers);
      const marker = oldMaster.child.spawnargs.find(arg => arg.startsWith('--bungee-process-identity='))?.split('=')[1];
      if (!marker || !oldMaster.child.pid) throw new Error('owned master physical marker missing');
      const identity = await captureProcessIdentity(oldMaster.child.pid, marker);
      expect(await probeProcessIdentity(identity)).toBe('exact');
      const targetWorker = oldWorkers[0]!;
      await waitForProbeState(management, currentFixture, state => backgroundReports(state).length === 2, 'background round incomplete');
      const armed = await requestJson(`${management}/api/plugins/${RPC_PROBE_PROVIDER}/control/crash`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pid: targetWorker.pid})}, currentFixture);
      expect(armed.response.status).toBe(200);
      const entered = await waitForProbeState(management, currentFixture, state => {
        const calls = (state as any).crashEntered ?? [];
        return calls.filter((call: any) => call.pid === targetWorker.pid).length === 64;
      }, 'the original worker did not occupy all 64 caller slots');
      const db = new Database(pluginStateFixturePath(currentFixture.configDbPath), {readonly: true});
      let pending: Array<{payload: string}>;
      let savedProof: any;
      try {
        pending = db.query<{payload: string}, []>(`SELECT CAST(payload AS TEXT) AS payload FROM plugin_communication_records
          WHERE namespace LIKE 'rpc.%' AND key LIKE 'j.%' AND json_valid(CAST(payload AS TEXT))
          AND json_extract(CAST(payload AS TEXT), '$.state') = 'pending'`).all();
        const proofs = db.query<{payload: string}, []>(`SELECT CAST(payload AS TEXT) AS payload FROM plugin_communication_records WHERE namespace = 'host:rpc:executors'`).all();
        savedProof = proofs.map(row => JSON.parse(row.payload)).find(proof => proof.physical.pid === identity.pid);
      } finally {db.close();}
      expect(savedProof.physical).toEqual(identity);
      expect(JSON.parse(pending[0]!.payload).source).toEqual(savedProof.source);
      expect(pending).toHaveLength(1);
      expect((entered as any).crashEntered.filter((call: any) => call.kind === 'command')).toHaveLength(1);
      evidence = {masterPid: identity.pid, workers: oldWorkers, entered: (entered as any).crashEntered, pending: pending.length, executor: savedProof};
      // Kill only the captured executor, after its REAL business handler entered.
      expect(await probeProcessIdentity(identity)).toBe('exact');
      const exited = once(oldMaster.child, 'exit');
      oldMaster.child.kill('SIGKILL'); await exited;
      expect(await probeProcessIdentity(identity)).toBe('dead');
      for (const worker of oldWorkers) expect(await probeProcessInstance(worker.pid, worker.worker_instance_id)).toBe('exact');
      master = await startGatewayMaster(currentFixture, currentLease);
      await waitForHealth(master, currentLease.base, currentFixture);
      const adopted = await waitForWorkers(management, revision, currentFixture);
      await recordOwnedWorkers(master, adopted);
      expect(adopted.map(worker => `${worker.pid}:${worker.worker_instance_id}:${worker.boot_nonce}`).sort())
        .toEqual(oldWorkers.map(worker => `${worker.pid}:${worker.worker_instance_id}:${worker.boot_nonce}`).sort());
      const recovered = await waitForProbeState(management, currentFixture, state => {
        const reports = state.reports.filter(report => report.payload.phase === 'crash-recovered');
        return reports.some(report => report.payload.pid === targetWorker.pid
          && report.payload.commandCode === 'unknown' && report.payload.persisted === 'unknown'
          && report.payload.settled === 64 && report.payload.capacity === 64);
      }, 'surviving workers did not recover all terminal barriers/capacity', 40000);
      // No accepted query or command is automatically resent to the replacement executor.
      expect((recovered as any).crashEntered).toEqual([]);
      const recoveredDb = new Database(pluginStateFixturePath(currentFixture.configDbPath), {readonly: true});
      try {
        const terminal = recoveredDb.query<{state: string}, []>(`SELECT json_extract(CAST(payload AS TEXT), '$.state') AS state
          FROM plugin_communication_records WHERE namespace LIKE 'rpc.%' AND key LIKE 'j.%'
          AND json_valid(CAST(payload AS TEXT)) AND json_extract(CAST(payload AS TEXT), '$.operationId') LIKE 'rpc-probe.crash.%'`).all();
        expect(terminal.map(row => row.state)).toEqual(['unknown']);
      } finally {recoveredDb.close();}
      const mutationId = randomUUID();
      const changed = await requestJson(`${management}/api/config`, {method: 'PUT', headers: {'content-type': 'application/json'},
        body: JSON.stringify({expected_revision: revision, mutation_id: mutationId,
          aggregate: { ...(initial.body as any).config, plugin_activations: [] }})}, currentFixture);
      expect(changed.response.status).toBe(202);
      await waitForOperation(management, mutationId, currentFixture);
      await waitForWorkers(management, revision + 1, currentFixture);
      // This joins the genuine owner lease/terminal drain; a blocked old RPC would prevent it.
      await waitUntil(async () => {
        const states = await Promise.all([...oldMaster.workers.values()].filter(worker => oldWorkers.some(old => old.pid === worker.pid))
          .map(worker => probeProcessIdentity(worker.identity!)));
        return states.every(state => state === 'dead' || state === 'mismatch');
      }, 'original worker owners failed to drain after executor exit', 15000);
      evidence = {...evidence, adopted, reports: recovered.reports.filter(report => report.payload.phase === 'crash-recovered'), drain: 'converged'};
      await mkdir(evidenceRoot, {recursive: true});
      await writeFile(`${evidenceRoot}/control-exit-recovery.json`, JSON.stringify(evidence, null, 2));
    } catch (error) {
      await mkdir(evidenceRoot, {recursive: true});
      const runtime = await requestJson(`${management}/api/config/runtime`, {signal: AbortSignal.timeout(2_000)}, currentFixture)
        .then(result => result.body, () => null);
      const failure = scrub(JSON.stringify({...evidence, fixture: currentFixture.root, runtime,
        workerDiagnostics: await readWorkerDiagnostics(currentFixture),
        error: safeGatewayError(error, currentFixture), diagnostics: await master?.diagnostics?.()}), currentFixture);
      await writeFile(`${evidenceRoot}/control-exit-failure.json`, failure);
      console.error(`rpc_control_exit_failure ${failure}`);
      throw error;
    }
  }, 120000);

  test('real protected requests prepare and settle the budget through peer Host RPC', async () => {
    if (!fixture || !lease || !master) throw new Error('fixture unavailable');
    const currentFixture = fixture, currentLease = lease;
    const management = `http://127.0.0.1:${lease.base}`;
    let upstreamCalls = 0;
    const upstream = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: async request => {
      await request.json(); upstreamCalls++;
      return Response.json({id: 'chatcmpl-budget', object: 'chat.completion', model: 'gpt-4o-mini', choices: [{index: 0, message: {role: 'assistant', content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 4, completion_tokens: 6, total_tokens: 10}});
    }});
    try {
      const initial = await requestJson(`${management}/api/config`, {}, currentFixture);
      const aggregate = {
        plugin_activations: ['token-budget', 'token-metering', 'token-stats', 'models-dev', 'key-access'].map(plugin_name => ({plugin_name})),
        logical_configuration: {plugins: [], services: [{id: SERVICE_ID, position: 1, name: 'budget-rpc', plugins: [], endpoints: [{id: UPSTREAM_ID, position: 1, target: `http://127.0.0.1:${upstream.port}/v1/`, weight: 100, priority: 1, is_disabled: false, plugins: []}]}], routes: [{id: ROUTE_ID, position: 1, path: '/budget-rpc', service_id: SERVICE_ID, plugins: []}]},
      };
      const mutationId = randomUUID();
      const changed = await requestJson(`${management}/api/config`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({expected_revision: (initial.body as any).revision, mutation_id: mutationId, aggregate})}, currentFixture);
      expect(changed.response.status).toBe(202);
      await waitForOperation(management, mutationId, currentFixture);
      await recordOwnedWorkers(master, await waitForWorkers(management, (initial.body as any).revision + 1, currentFixture));
      const issued = await requestJson(`${management}/api/plugins/key-access/control/credentials`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'Peer Budget'})}, currentFixture);
      expect(issued.response.status).toBe(201);
      const keyId = (issued.body as any).key.id, token = (issued.body as any).token;
      const binding = await requestJson(`${management}/api/plugins/key-access/control/route-key`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({keyId, routeId: ROUTE_ID})}, currentFixture);
      expect(binding.response.status).toBe(200);
      const protection = await requestJson(`${management}/api/plugins/key-access/control/routes`, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({protectedRouteIds: [ROUTE_ID]})}, currentFixture);
      expect(protection.response.status).toBe(200);
      expect((protection.body as any).protectedRouteIds).toEqual([ROUTE_ID]);
      const policyUrl = `${management}/api/plugins/token-budget/control/keys/${keyId}`;
      const policy = await requestJson(policyUrl, {method: 'PUT', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode: 'cumulative', limit: 10})}, currentFixture);
      expect(policy.response.status).toBe(200);
      const publicUrl = `http://127.0.0.1:${currentLease.block.ports[1]}/budget-rpc/chat/completions`;
      const input = {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify({model: 'gpt-4o-mini', messages: [{role: 'user', content: 'hello'}]})};
      const response = await fetch(publicUrl, input);
      const text = await response.text();
      if (response.status !== 200) throw new Error(`budget request failed status=${response.status} body=${text}; ${await master.diagnostics?.()}`);
      await waitUntil(async () => {
        const ledger = await requestJson(policyUrl, {}, currentFixture);
        return (ledger.body as any).value?.cumulative === 10 && (ledger.body as any).usage?.attempts?.[0]?.status === 'settled';
      }, 'peer budget settlement did not become durable', 10000);
      expect(upstreamCalls).toBe(1);
      const denied = await fetch(publicUrl, input);
      expect(denied.status).toBe(429); await denied.text();
      expect(upstreamCalls).toBe(1);
      // Independent transports are no longer installed on master-control.
      for (const path of ['/__bungee/internal/plugin-state/v1', '/__bungee/internal/plugin-control/v1']) {
        const old = await fetch(`http://127.0.0.1:${currentLease.block.ports[3]}${path}`, {method: 'POST', body: '{}'});
        expect(old.status).toBe(404); await old.text();
      }
    } finally {await upstream.stop(true);}
  }, 90000);
});

async function readWorkerDiagnostics(fixture: GatewayFixture) {
  // Read only this test's private descriptors. Diagnostic fields never serve as exit proof.
  const directory = join(dirname(fixture.configDbPath), 'runtime', 'workers');
  const names = (await readdir(directory).catch(() => []))
    .filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
  return await Promise.all(names.slice(0, 32).map(async name => {
    try {
      const file = Bun.file(join(directory, name));
      if (file.size > 64 * 1024) return { name, error: 'descriptor_too_large' };
      const descriptor = await file.json();
      const message = descriptor.evidence?.message;
      const started = performance.now();
      const probe = await probeProcessInstance(descriptor.pid, descriptor.worker_instance_id);
      return { name, pid: descriptor.pid, instance: descriptor.worker_instance_id,
        phase: descriptor.phase, revision: descriptor.revision, evidence: descriptor.evidence?.kind,
        status: message?.status, drainId: message?.drain_id, cleanupState: message?.cleanup_state,
        httpStopped: message?.http_stopped, drainRemainingMs: message?.remaining_ms,
        exitRemainingMs: message?.exit_remaining_ms, probe, probeElapsedMs: Math.round(performance.now() - started) };
    } catch { return { name, error: 'descriptor_unavailable' }; }
  }));
}

function bootstrapReports(state: ProbeState): ProbeReport[] {
  return state.reports.filter((report) => report.payload?.phase === 'bootstrap');
}

function backgroundReports(state: ProbeState): ProbeReport[] {
  return state.reports.filter((report) => report.payload?.phase === 'background');
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function waitForOperation(portBaseUrl: string, mutationId: string, fixture: GatewayFixture): Promise<void> {
  await waitUntil(async () => {
    const result = await requestJson(`${portBaseUrl}/api/config/operations/${mutationId}`, {}, fixture);
    const body = result.body as { operation?: { state?: string } };
    if (body.operation?.state === 'degraded' || body.operation?.state === 'failed') {
      throw new Error(`config operation ${body.operation.state}: ${scrub(result.text, fixture)}`);
    }
    return result.response.status === 200 && body.operation?.state === 'converged';
  }, `configuration mutation ${mutationId} did not converge`, 30_000);
}

async function waitForWorkers(portBaseUrl: string, expectedRevision: number, fixture: GatewayFixture): Promise<RuntimeWorker[]> {
  let workers: RuntimeWorker[] = [];
  await waitUntil(async () => {
    const result = await requestJson(`${portBaseUrl}/api/config/runtime`, {}, fixture);
    if (!result.response.ok) return false;
    const body = result.body as {
      revision?: number;
      workers?: RuntimeWorker[];
      publication?: { serving_complete?: boolean; serving_revision?: number | null };
    };
    workers = body.workers ?? [];
    return body.revision === expectedRevision && body.publication?.serving_complete === true
      && body.publication.serving_revision === expectedRevision && workers.length === 2
      && workers.every((worker) => Number.isSafeInteger(worker.pid)
        && typeof worker.worker_instance_id === 'string' && typeof worker.boot_nonce === 'string');
  }, `two workers did not serve revision ${expectedRevision}`, 30_000);
  return workers;
}

async function readProbeState(portBaseUrl: string, fixture: GatewayFixture): Promise<ProbeState | null> {
  try {
    const result = await requestJson(
      `${portBaseUrl}/api/plugins/${RPC_PROBE_PROVIDER}/control/state`,
      { signal: AbortSignal.timeout(2_000) },
      fixture,
    );
    if (!result.response.ok) return null;
    return result.body as ProbeState;
  } catch {
    return null;
  }
}

async function waitForProbeState(
  portBaseUrl: string,
  fixture: GatewayFixture,
  predicate: (state: ProbeState) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<ProbeState> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'provider control API not reachable';
  for (;;) {
    const state = await readProbeState(portBaseUrl, fixture);
    if (state !== null) {
      try {
        if (predicate(state)) return state;
        lastReason = `predicate not satisfied: ${JSON.stringify(state).slice(-4_096)}`;
      } catch (error) {
        lastReason = `predicate threw: ${safeGatewayError(error, fixture, 2_048)}`;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`${message}; ${lastReason}`);
    }
    await Bun.sleep(100);
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
