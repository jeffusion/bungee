/**
 * Real production-entry plugin communication acceptance: a REAL master plus its two
 * supervised workers (the same DaemonManager launch path as
 * `plugin-rpc-gateway-real-process`) activate a control-plane provider plugin and a
 * worker consumer plugin through real manifests. The consumer drives all three P5
 * lanes over the authenticated peer transport:
 *
 *  - a read stream far larger than the 64 KiB RPC envelope (size + digest verified);
 *  - a write stream the provider verifies and commits;
 *  - a multi-megabyte versioned snapshot through the HOST-MANAGED view, observed to
 *    be updated, plus an explicit failure for a provider with no snapshot;
 *  - durable events replayed from the log, a per-consumer ACK/checkpoint with
 *    future/regressed ack refusal, publishing that continues after every ack, and a
 *    bounded-retention gap;
 *  - a transient notification topic;
 *  - a same-process consume (control loopback) and a control->worker consume.
 *
 * Every observation is returned to the provider over the RPC peer path and asserted
 * here against the provider's own control API; nothing is mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
import { CHANNEL_PROBE_CONSUMER, CHANNEL_PROBE_CROSS, CHANNEL_PROBE_PROVIDER, createChannelGatewayFixture } from '../helpers/plugin-communication-fixture';
import {
  CHANNEL_ACK_EVENTS,
  CHANNEL_DUPLEX_FAIL_WRITE_SIZE,
  CHANNEL_DUPLEX_HALF_READ_SIZE,
  CHANNEL_DUPLEX_HALF_WRITE_SIZE,
  CHANNEL_DUPLEX_READ_SIZE,
  CHANNEL_DUPLEX_WRITE_SIZE,
  CHANNEL_FAIL_UPLOAD_SIZE,
  CHANNEL_GAP_RETENTION,
  CHANNEL_OBJECT_SIZE,
  CHANNEL_RELIABLE_EVENTS,
  CHANNEL_SNAPSHOT_SIZE,
  CHANNEL_UPLOAD_SIZE,
} from '../fixtures/plugin-communication-probe/channel-probe-provider/control';

const SERVICE_ID = '10000000-0000-4000-8000-000000000301';
const UPSTREAM_ID = '20000000-0000-4000-8000-000000000301';
const ROUTE_ID = '30000000-0000-4000-8000-000000000301';

type ChannelReport = Record<string, any>;
type ChannelState = {
  reports: ChannelReport[];
  snapshotVersion: number;
  snapshotBumps: number;
  uploadDigest: string;
  uploadFrames: number;
  uploadBytes: number;
  uploadReadback: string;
  uploadAborted: number;
  uploadFailReceived: number;
  uploadFailFinished: number;
  uploadFailAborted: number;
  duplexReceived: number;
  duplexCommitted: string;
  duplexHalfReceived: number;
  duplexHalfCommitted: string;
  duplexFailReceived: number;
  duplexFailAborted: number;
  outboxCounter: number;
  outboxRollback: boolean;
  publishedReliable: number;
};
type CrossState = { readonly sameProcess: ChannelReport | null; readonly crossProcess: ChannelReport | null };
type RuntimeWorker = { pid: number; worker_instance_id: string; boot_nonce: string };

const WORKER_PHASES = [
  'stream', 'stream-missing', 'upload', 'upload-fail', 'duplex', 'duplex-half-close', 'duplex-fail',
  'snapshot', 'snapshot-update', 'snapshot-none', 'snapshot-schema',
  'events-reliable', 'events-ack', 'events-gap', 'transient',
];

describe('plugin communication channels real-process integration (control provider ↔ supervised workers)', () => {
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
    fixture = await createChannelGatewayFixture();
    lease = await reservePortBlock();
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
    let leaseReleased = !masterStartup.attempted;
    if (lease !== undefined) {
      try { await releasePortBlock(lease); leaseReleased = true; }
      catch (error) { quarantinePortBlock(lease); cleanupErrors.push(error); }
      lease = undefined;
    }
    const portsVerifiedClosed = !masterStartup.attempted || leaseReleased;
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

  test('both supervised workers stream, upload, snapshot, and subscribe over the peer channel', async () => {
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
          { plugin_name: CHANNEL_PROBE_PROVIDER },
          { plugin_name: CHANNEL_PROBE_CONSUMER },
          { plugin_name: CHANNEL_PROBE_CROSS },
        ],
        logical_configuration: {
          plugins: [],
          services: [{
            id: SERVICE_ID, position: 1, name: 'channel-probe-noop', plugins: [],
            endpoints: [{
              id: UPSTREAM_ID, position: 1, target: 'http://127.0.0.1:9/', weight: 100, priority: 1, is_disabled: false, plugins: [],
            }],
          }],
          routes: [{
            id: ROUTE_ID, position: 1, path: '/channel-probe-noop', service_id: SERVICE_ID, plugins: [],
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
      const workers = await waitForWorkers(management, revision, currentFixture);
      await recordOwnedWorkers(master, workers);
      expect(workers).toHaveLength(2);
      const pids = workers.map((worker) => worker.pid).sort((left, right) => left - right);

      const state = await waitForChannelState(management, currentFixture, (current) => {
        const completed = new Set(phasePids(current, 'complete'));
        if (completed.size !== 2) return false;
        for (const phase of WORKER_PHASES) {
          if (new Set(phasePids(current, phase)).size !== 2) return false;
        }
        return true;
      }, 'both supervised workers did not complete the channel sequence', 120_000);
      // The control-side cross fixture must have applied BOTH views.
      const cross = await waitForCrossState(management, currentFixture, (current) => current.sameProcess !== null && current.crossProcess !== null,
        'the control process did not apply both the same-process and the control->worker snapshot views', 60_000);

      // ---- read stream: a body far beyond one 64 KiB control message.
      const streamReports = state.reports.filter((report) => report.phase === 'stream');
      expect(streamReports.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of streamReports) {
        expect(report.bytes).toBe(CHANNEL_OBJECT_SIZE);
        expect(report.bytes).toBeGreaterThan(64 * 1024);
        expect(report.digestMatch).toBe(true);
      }
      const missing = state.reports.filter((report) => report.phase === 'stream-missing');
      expect(missing.map((report) => report.failed).sort()).toEqual([true, true]);

      // ---- write stream: the provider verified and committed the uploaded body.
      const uploads = state.reports.filter((report) => report.phase === 'upload');
      expect(uploads.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of uploads) {
        expect(report.bytes).toBe(CHANNEL_UPLOAD_SIZE);
        expect(String(report.digest)).toStartWith('sha256:');
      }
      // The provider's own receipt proves it SAW the same body: it accumulated the
      // bytes, hashed them itself, and read the committed body back independently.
      expect(state.uploadDigest).toContain('|');
      expect(Number(state.uploadDigest.split('|')[1])).toBe(CHANNEL_UPLOAD_SIZE);
      expect(state.uploadBytes).toBe(CHANNEL_UPLOAD_SIZE);
      expect(uploads[0]!.digest).toBe(state.uploadDigest.split('|')[0]);
      expect(state.uploadReadback).toBe(state.uploadDigest.split('|')[0]);
      expect(uploads.map((report) => report.digest).every((digest) => digest === state.uploadDigest.split('|')[0])).toBe(true);
      expect(state.uploadFrames).toBeGreaterThan(1);

      // ---- injected mid-transfer sink failure: the sink REALLY received bytes,
      // then failed; finish never ran and the consumer never saw a false commit.
      const uploadFail = state.reports.filter((report) => report.phase === 'upload-fail');
      expect(uploadFail.map((report) => report.ok).sort()).toEqual([true, true]);
      expect(state.uploadFailReceived).toBeGreaterThan(0);
      expect(state.uploadFailReceived).toBeLessThan(CHANNEL_FAIL_UPLOAD_SIZE);
      expect(state.uploadFailFinished).toBe(0);
      expect(state.uploadFailAborted).toBeGreaterThan(0);

      // ---- TRUE duplex: ONE session with concurrent read + write, one shared terminal.
      const duplex = state.reports.filter((report) => report.phase === 'duplex');
      expect(duplex.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of duplex) {
        expect(report.readBytes).toBe(CHANNEL_DUPLEX_READ_SIZE);
        expect(report.writeBytes).toBe(CHANNEL_DUPLEX_WRITE_SIZE);
        expect(report.resultReadBytes).toBe(CHANNEL_DUPLEX_READ_SIZE);
        expect(report.resultWriteDigest).toBe(report.writeDigest);
      }
      expect(state.duplexReceived).toBe(CHANNEL_DUPLEX_WRITE_SIZE);
      expect(state.duplexCommitted).toBe(`${duplex[0]!.writeDigest}|${CHANNEL_DUPLEX_WRITE_SIZE}`);

      // ---- half-close: the read direction ends as null while the write commits.
      const halfClose = state.reports.filter((report) => report.phase === 'duplex-half-close');
      expect(halfClose.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of halfClose) {
        expect(report.resultRead).toBeNull();
        expect(report.resultWriteDigest).toBe(report.writeDigest);
      }
      expect(state.duplexHalfReceived).toBe(CHANNEL_DUPLEX_HALF_WRITE_SIZE);
      expect(state.duplexHalfCommitted).toContain('|');

      // ---- a failure in ONE direction drains BOTH: the consumer's session rejects
      // and the provider's sibling write half is really aborted.
      const duplexFail = state.reports.filter((report) => report.phase === 'duplex-fail');
      expect(duplexFail.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of duplexFail) expect(report.completedFailed).toBe(true);
      expect(state.duplexFailAborted).toBeGreaterThan(0);
      expect(state.duplexFailReceived).toBeLessThan(CHANNEL_DUPLEX_FAIL_WRITE_SIZE);

      // ---- snapshot: the host-managed view applied a full multi-megabyte body.
      const snapshots = state.reports.filter((report) => report.phase === 'snapshot');
      expect(snapshots.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of snapshots) {
        expect(report.status).toBe('ready');
        expect(report.size).toBe(CHANNEL_SNAPSHOT_SIZE);
        expect(report.size).toBeGreaterThan(1024 * 1024);
        expect(['applied', 'unchanged']).toContain(report.outcome);
      }
      const updates = state.reports.filter((report) => report.phase === 'snapshot-update');
      expect(updates.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of updates) {
        expect(report.toVersion).toBeGreaterThan(report.fromVersion);
        expect(report.size).toBe(CHANNEL_SNAPSHOT_SIZE);
        expect(report.digestChanged).toBe(true);
      }
      const none = state.reports.filter((report) => report.phase === 'snapshot-none');
      expect(none.map((report) => report.failed).sort()).toEqual([true, true]);

      // ---- content-schema validation: a schema-invalid refresh fails closed and
      // keeps the previously applied (schema-valid + digest-verified) version.
      const schemaReports = state.reports.filter((report) => report.phase === 'snapshot-schema');
      expect(schemaReports.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of schemaReports) {
        expect(report.first).toBe('applied');
        expect(report.failed).toBe('failed');
        expect(report.appliedVersion).toBe(1);
        expect(report.keptVersion).toBe(1);
        expect(report.status).toBe('stale');
      }

      // ---- durable events: both workers replay the committed log in order.
      const reliable = state.reports.filter((report) => report.phase === 'events-reliable');
      expect(reliable.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of reliable) {
        expect(report.fromSequence).toBe(1);
        expect(report.sequences).toEqual(Array.from({ length: CHANNEL_RELIABLE_EVENTS }, (_value, index) => index + 1));
      }

      // ---- per-consumer ACK/checkpoint. A worker's ack must NOT prune another's
      // replay, must never regress or accept an undelivered sequence, and must not
      // reset the durable sequence when everyone has acked.
      const ack = state.reports.filter((report) => report.phase === 'events-ack');
      expect(ack.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of ack) {
        // A resume may also deliver events published after this worker's ack.
        expect(report.received.slice(0, CHANNEL_ACK_EVENTS)).toEqual(Array.from({ length: CHANNEL_ACK_EVENTS }, (_value, index) => index + 1));
        expect(report.acked).toBeGreaterThanOrEqual(CHANNEL_ACK_EVENTS);
        expect(report.resumedFrom).toBe(report.acked + 1);
        // A resume delivers nothing already acked; a later live event may arrive.
        expect(report.resumed.every((sequence: number) => sequence >= CHANNEL_ACK_EVENTS + 1)).toBe(true);
        expect(report.futureRejected).toBe(true);
        expect(report.regressedRejected).toBe(true);
        expect(report.sequenceAfterAck).toBeGreaterThan(CHANNEL_ACK_EVENTS);
      }
      // Both workers acknowledged their own checkpoints and the log still holds
      // the retained window: publishing continued instead of restarting at 1.
      expect(new Set(ack.map((report) => report.sequenceAfterAck)).size).toBe(2);

      // ---- bounded retention produces an explicit gap only outside the window.
      const gaps = state.reports.filter((report) => report.phase === 'events-gap');
      expect(gaps.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of gaps) {
        expect(report.gap).toBe(true);
        expect(report.gapCode).toBe('gap');
        expect(report.last).toBeGreaterThanOrEqual(CHANNEL_GAP_RETENTION);
      }

      // ---- transient notifications reach both workers.
      const transient = state.reports.filter((report) => report.phase === 'transient');
      expect(transient.map((report) => report.ok).sort()).toEqual([true, true]);
      for (const report of transient) {
        expect(report.count).toBeGreaterThan(0);
        expect(report.dropped).toBeGreaterThanOrEqual(0);
      }

      // ---- same-process consume (in-process route) AND control->worker consume
      // (peer route the other way), both from the same control process.
      expect(cross.sameProcess).not.toBeNull();
      expect(cross.sameProcess!.size).toBe(CHANNEL_SNAPSHOT_SIZE);
      expect(['applied', 'unchanged']).toContain(cross.sameProcess!.outcome);
      expect(String(cross.sameProcess!.digest)).toStartWith('sha256:');
      // Both supervised workers honour their declared worker-snapshot publication
      // (a declared channel MUST be published before ready), so the global target is
      // genuinely multi-instance and the host must refuse to guess: `ambiguous`.
      expect(cross.crossProcess).not.toBeNull();
      expect(cross.crossProcess!.outcome).toBe('failed');
      expect(cross.crossProcess!.error).toBe('ambiguous');

      // ---- the outbox committed state + event in one transaction, and a
      // conflicting command rolled both back.
      expect(state.outboxCounter).toBe(CHANNEL_RELIABLE_EVENTS);
      expect(state.outboxRollback).toBe(true);
      expect(state.publishedReliable).toBe(CHANNEL_RELIABLE_EVENTS);
      expect(state.snapshotBumps).toBeGreaterThan(0);
      expect(new Set(state.reports.filter((report) => report.phase === 'complete').map((report) => report.pid)).size).toBe(2);
      expect(state.reports.filter((report) => report.phase === 'complete').map((report) => report.pid).sort((left, right) => left - right)).toEqual(pids);
    } catch (error) {
      const runtime = await requestJson(`${management}/api/config/runtime`, { signal: AbortSignal.timeout(2_000) }, currentFixture)
        .then(result => result.body, () => null);
      const provider = await readChannelState(management, currentFixture);
      const crossState = await readCrossState(management, currentFixture);
      console.error(scrub(JSON.stringify({ event: 'channel_probe_failure_snapshot', runtime, provider, cross: crossState }), currentFixture));
      const diagnostics = (await master?.diagnostics?.().catch((cause) => safeGatewayError(cause, currentFixture)) ?? '').slice(-12_000);
      throw new Error(safeGatewayError(new Error(`${safeGatewayError(error, currentFixture)}; master exit=${master?.child.exitCode ?? master?.child.signalCode ?? 'running'}; diagnostics=${diagnostics}`), currentFixture, 24_576));
    }
  }, 240_000);
});

function phasePids(state: ChannelState, phase: string): number[] {
  return state.reports.filter((report) => report.phase === phase).map((report) => Number(report.pid));
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

async function readChannelState(portBaseUrl: string, fixture: GatewayFixture): Promise<ChannelState | null> {
  try {
    const result = await requestJson(
      `${portBaseUrl}/api/plugins/${CHANNEL_PROBE_PROVIDER}/control/state`,
      { signal: AbortSignal.timeout(2_000) },
      fixture,
    );
    if (!result.response.ok) return null;
    return result.body as ChannelState;
  } catch {
    return null;
  }
}

async function readCrossState(portBaseUrl: string, fixture: GatewayFixture): Promise<CrossState | null> {
  try {
    const result = await requestJson(
      `${portBaseUrl}/api/plugins/${CHANNEL_PROBE_CROSS}/control/state`,
      { signal: AbortSignal.timeout(2_000) },
      fixture,
    );
    if (!result.response.ok) return null;
    return result.body as CrossState;
  } catch {
    return null;
  }
}

async function waitForCrossState(
  portBaseUrl: string,
  fixture: GatewayFixture,
  predicate: (state: CrossState) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<CrossState> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'cross control API not reachable';
  for (;;) {
    const state = await readCrossState(portBaseUrl, fixture);
    if (state !== null) {
      if (predicate(state)) return state;
      lastReason = `predicate not satisfied: ${JSON.stringify(state).slice(-2_048)}`;
    }
    if (Date.now() >= deadline) throw new Error(`${message}; ${lastReason}`);
    await Bun.sleep(200);
  }
}

async function waitForChannelState(
  portBaseUrl: string,
  fixture: GatewayFixture,
  predicate: (state: ChannelState) => boolean,
  message: string,
  timeoutMs = 30_000,
): Promise<ChannelState> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'provider control API not reachable';
  for (;;) {
    const state = await readChannelState(portBaseUrl, fixture);
    if (state !== null) {
      try {
        if (predicate(state)) return state;
        lastReason = `predicate not satisfied: ${JSON.stringify(state).slice(-4_096)}`;
      } catch (error) {
        lastReason = `predicate threw: ${safeGatewayError(error, fixture, 2_048)}`;
      }
    }
    if (Date.now() >= deadline) throw new Error(`${message}; ${lastReason}`);
    await Bun.sleep(200);
  }
}
