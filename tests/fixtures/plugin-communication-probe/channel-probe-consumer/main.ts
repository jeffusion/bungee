/**
 * Worker consumer of the channel-probe fixture.
 *
 * It exercises every P5 lane over the REAL authenticated peer transport and
 * returns its observations to the control provider through the RPC `report`
 * method. It also PROVIDES one worker-side snapshot so the control plugin can
 * consume across the peer in the opposite direction.
 *
 * Contract literals are byte-for-byte equal to the provider's copies: the host
 * hashes them and refuses a call whose hash disagrees.
 */

import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const CHANNEL_RPC_ID = 'channel-probe.control.v1';
const CHANNEL_STREAM_ID = 'channel-probe.objects.v1';
const CHANNEL_UPLOAD_ID = 'channel-probe.uploads.v1';
const CHANNEL_SNAPSHOT_ID = 'channel-probe.snapshot.v1';
const CHANNEL_EMPTY_SNAPSHOT_ID = 'channel-probe.snapshot.none.v1';
const CHANNEL_SCHEMA_SNAPSHOT_ID = 'channel-probe.snapshot.schema.v1';
const CHANNEL_EVENT_ID = 'channel-probe.events.v1';
const CHANNEL_ACK_EVENT_ID = 'channel-probe.ack-events.v1';
const CHANNEL_GAP_EVENT_ID = 'channel-probe.gap-events.v1';
const CHANNEL_TRANSIENT_ID = 'channel-probe.transient.v1';
const CHANNEL_WORKER_SNAPSHOT_ID = 'channel-probe.worker-snapshot.v1';

const CHANNEL_RELIABLE_EVENTS = 4;
const CHANNEL_ACK_EVENTS = 2;
const CHANNEL_GAP_RETENTION = 3;
const CHANNEL_WORKER_SNAPSHOT_SIZE = 512 * 1024 + 31;

const CHANNEL_OBJECT_SCHEMA = {
  type: 'object',
  properties: { objectId: { type: 'string' }, version: { type: 'number', integer: true, minimum: 1 } },
} as const;
const CHANNEL_EVENT_SCHEMA = {
  type: 'object',
  properties: { topic: { type: 'string' }, index: { type: 'number', integer: true, minimum: 0 }, at: { type: 'number' } },
} as const;
const CHANNEL_CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' }, bytes: { type: 'number', integer: true, minimum: 0 },
    filler: { type: 'string' },
  },
} as const;

const OBJECT_CONTRACT = { id: CHANNEL_STREAM_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
const UPLOAD_CONTRACT = { id: CHANNEL_UPLOAD_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
const SNAPSHOT_CONTRACT = { id: CHANNEL_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
const EMPTY_SNAPSHOT_CONTRACT = { id: CHANNEL_EMPTY_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
const SCHEMA_SNAPSHOT_CONTRACT = { id: CHANNEL_SCHEMA_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
const WORKER_SNAPSHOT_CONTRACT = { id: CHANNEL_WORKER_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
const EVENT_CONTRACT = { id: CHANNEL_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA };
const ACK_EVENT_CONTRACT = { id: CHANNEL_ACK_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA };
const GAP_EVENT_CONTRACT = { id: CHANNEL_GAP_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA, retention: { maxEvents: CHANNEL_GAP_RETENTION } };
const TRANSIENT_CONTRACT = { id: CHANNEL_TRANSIENT_ID, version: 1, delivery: 'transient', event: CHANNEL_EVENT_SCHEMA };

const CHANNEL_FAIL_UPLOAD_ID = 'channel-probe.uploads.fail.v1';
const CHANNEL_DUPLEX_ID = 'channel-probe.duplex.v1';
const FAIL_UPLOAD_CONTRACT = { id: CHANNEL_FAIL_UPLOAD_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
const DUPLEX_CONTRACT = { id: CHANNEL_DUPLEX_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
const FAIL_UPLOAD_ID_VALUE = 'probe-upload-fail-1';
const FAIL_UPLOAD_SIZE = 256 * 1024;
const DUPLEX_ID_VALUE = 'probe-duplex-1';
const DUPLEX_HALF_ID_VALUE = 'probe-duplex-half-1';
const DUPLEX_FAIL_ID_VALUE = 'probe-duplex-fail-1';
const DUPLEX_FAIL_READ_SIZE = 256 * 1024;
const DUPLEX_FAIL_WRITE_SIZE = 128 * 1024 + 3;
const DUPLEX_READ_SIZE = 512 * 1024 + 7;
const DUPLEX_WRITE_SIZE = 384 * 1024 + 11;
const DUPLEX_HALF_WRITE_SIZE = 96 * 1024 + 13;

const CONTRACT = {
  id: CHANNEL_RPC_ID,
  version: 1,
  methods: {
    handshake: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    report: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    fillTopic: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    publishAck: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (typeof timer?.unref === 'function') timer.unref(); });
}

function codeOf(error: any): string {
  return typeof error?.code === 'string' ? error.code : error instanceof Error ? 'thrown' : 'unknown';
}

function pattern(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

function digestOf(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Snapshot bodies are fixed UTF-8 JSON matching the declared content schema. */
function jsonSnapshot(size: number, kind: string): Uint8Array {
  const encoder = new TextEncoder();
  const head = `{"kind":${JSON.stringify(kind)},"bytes":${size},"filler":"`;
  const tail = '"}';
  const fill = size - encoder.encode(head).length - encoder.encode(tail).length;
  if (fill < 0) throw new Error('snapshot size is too small for the JSON envelope');
  return encoder.encode(`${head}${'x'.repeat(fill)}${tail}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(100);
  }
  return predicate();
}

function trace(event: string, detail: Record<string, unknown> = {}): void {
  try {
    const root = process.env.HOME ?? '/tmp';
    appendFileSync(`${root}/channel-probe-consumer-${process.pid}.jsonl`, `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...detail })}\n`);
  } catch { /* diagnostics are best-effort */ }
}

/**
 * Module-scope pump: registered while the module is imported, so the adapter
 * selects the real `background` purpose rather than an already-closed frame.
 */
let pendingTask: (() => Promise<void>) | null = null;
let pumpStopped = false;
(() => {
  const timer = setInterval(() => {
    if (pumpStopped) { clearInterval(timer); return; }
    const task = pendingTask;
    if (task === null) return;
    pendingTask = null;
    void task().catch(() => undefined);
  }, 25);
  if (typeof timer?.unref === 'function') timer.unref();
})();

/* eslint-disable @typescript-eslint/no-explicit-any */
export class ChannelProbeConsumer {
  static readonly name = 'channel-probe-consumer';
  static readonly version = '1.0.0';

  #rpc: any = null;
  #services: any = null;
  #stopped = false;

  async init(context: any): Promise<void> {
    trace('init');
    this.#rpc = context.services.rpc.consume('channel-probe-provider', CONTRACT);
    this.#services = context.services;
    const workerSnapshot = jsonSnapshot(CHANNEL_WORKER_SNAPSHOT_SIZE, 'worker-snapshot');
    const digest = digestOf(workerSnapshot);
    // Every worker honours its declared worker-side snapshot publication: the host
    // refuses to become ready for a declared channel that was never published, so a
    // deliberately silent second instance is NOT allowed. Two global providers are
    // the host's explicit `ambiguous` case rather than a silently chosen one.
    context.services.snapshot.provide(WORKER_SNAPSHOT_CONTRACT, {
      current: () => ({
        descriptor: { owner: 'channel-probe-consumer', epoch: 1, version: 1, schemaVersion: 1, digest, size: workerSnapshot.byteLength, chunkBytes: 60 * 1024 },
        read: async (offset: number, length: number) => workerSnapshot.slice(offset, offset + length),
      }),
      version: (version: number) => (version === 1
        ? { descriptor: { owner: 'channel-probe-consumer', epoch: 1, version: 1, schemaVersion: 1, digest, size: workerSnapshot.byteLength, chunkBytes: 60 * 1024 }, read: async (offset: number, length: number) => workerSnapshot.slice(offset, offset + length) }
        : null),
    });
    trace('init-ok', { hasRpc: true, hasStream: !!context.services.stream, hasSnapshot: !!context.services.snapshot, hasEvents: !!context.services.events });
    pendingTask = () => context.services.runBackground(() => this.#run().catch((error) => { trace('run-failed', { code: codeOf(error) }); }));
  }

  async #report(payload: Record<string, unknown>): Promise<void> {
    try { await this.#rpc.report({ pid: process.pid, ...payload }); }
    catch (error) { trace('report-failed', { phase: String(payload.phase ?? '?'), code: codeOf(error) }); }
  }

  async #run(): Promise<void> {
    const pid = process.pid;
    if (this.#stopped) return;
    trace('run-start');
    let handshake: any = null;
    try { handshake = await this.#rpc.handshake({ pid }); }
    catch (error) { await this.#report({ phase: 'handshake', ok: false, code: codeOf(error) }); return; }
    trace('handshake-ok', { objectSize: handshake?.objectSize ?? null });
    await this.#report({ phase: 'handshake', ok: true, objectSize: handshake?.objectSize ?? null, objectDigest: handshake?.objectDigest ?? null });
    await this.#probeStream(handshake);
    await this.#probeUpload(handshake);
    await this.#probeUploadFailure();
    await this.#probeDuplex();
    await this.#probeDuplexHalfClose();
    await this.#probeDuplexFailure();
    await this.#probeSnapshot();
    await this.#probeSnapshotSchema();
    await this.#probeReliableEvents();
    await this.#probeAckEvents();
    await this.#probeGap(handshake);
    await this.#probeTransient();
    await this.#report({ phase: 'complete', ok: true });
  }

  async #probeStream(handshake: any): Promise<void> {
    try {
      const stream = this.#services.stream.open('channel-probe-provider', OBJECT_CONTRACT, { objectId: handshake.objectId, version: 1 }, {
        offset: 0, size: handshake.objectSize, digest: handshake.objectDigest, timeoutMs: 60_000,
      });
      const collected = await stream.collect();
      await this.#report({
        phase: 'stream', ok: true, bytes: collected.bytes,
        digestMatch: collected.digest === handshake.objectDigest, expectedBytes: handshake.objectSize,
      });
    } catch (error) { await this.#report({ phase: 'stream', ok: false, code: codeOf(error) }); }
    try {
      const missing = this.#services.stream.open('channel-probe-provider', OBJECT_CONTRACT, { objectId: 'missing-object', version: 1 }, { timeoutMs: 15_000 });
      await missing.collect();
      await this.#report({ phase: 'stream-missing', failed: false });
    } catch (error) { await this.#report({ phase: 'stream-missing', failed: true, code: codeOf(error) }); }
  }

  async #probeUpload(handshake: any): Promise<void> {
    try {
      const body = pattern(handshake.uploadSize, 21);
      const digest = digestOf(body);
      const stream = this.#services.stream.openWrite('channel-probe-provider', UPLOAD_CONTRACT, { objectId: handshake.uploadId, version: 1 }, {
        size: body.byteLength, digest, timeoutMs: 60_000,
      });
      for (let offset = 0; offset < body.byteLength; offset += 60 * 1024) {
        await stream.write(body.slice(offset, Math.min(offset + 60 * 1024, body.byteLength)));
      }
      const receipt = await stream.finish();
      await this.#report({ phase: 'upload', ok: true, bytes: receipt.bytes, digest: receipt.digest });
    } catch (error) { await this.#report({ phase: 'upload', ok: false, code: codeOf(error) }); }
  }

  async #probeSnapshot(): Promise<void> {
    try {
      const view = this.#services.snapshot.consume('channel-probe-provider', SNAPSHOT_CONTRACT);
      const stop = view.start({ intervalMs: 1_000 });
      await this.#report({ phase: 'snapshot-begin', ok: true });
      const startedAt = Date.now();
      // A local bound so a wedged sync still reports (and never silently stalls the
      // whole worker sequence).
      const outcome = await Promise.race([
        view.sync({ timeoutMs: 60_000 }),
        (async () => { await sleep(75_000); return 'timed-out' as const; })(),
      ]);
      const applied = view.current();
      const first = applied?.descriptor.version ?? null;
      await this.#report({
        phase: 'snapshot', ok: applied !== null, outcome, version: first,
        size: applied?.bytes.byteLength ?? null, status: view.status().status, error: view.status().error,
        elapsedMs: Date.now() - startedAt,
      });
      const deadline = Date.now() + 25_000;
      let updated: any = null;
      while (Date.now() < deadline && !this.#stopped) {
        await sleep(500);
        const current = view.current();
        if (current !== null && first !== null && current.descriptor.version > first) { updated = current; break; }
      }
      await this.#report({
        phase: 'snapshot-update', ok: updated !== null, fromVersion: first,
        toVersion: updated?.descriptor.version ?? null, size: updated?.bytes.byteLength ?? null,
        digestChanged: updated !== null && updated.descriptor.digest !== applied?.descriptor.digest,
      });
      stop();
    } catch (error) { await this.#report({ phase: 'snapshot', ok: false, code: codeOf(error) }); }
    try {
      const empty = this.#services.snapshot.consume('channel-probe-provider', EMPTY_SNAPSHOT_CONTRACT);
      const outcome = await empty.sync({ timeoutMs: 15_000 });
      await this.#report({ phase: 'snapshot-none', failed: outcome === 'failed', outcome, status: empty.status().status });
    } catch (error) { await this.#report({ phase: 'snapshot-none', failed: true, code: codeOf(error) }); }
  }

  async #probeReliableEvents(): Promise<void> {
    try {
      const sequences: number[] = [];
      const subscription = await this.#services.events.subscribe('channel-probe-provider', EVENT_CONTRACT, {
        consumerId: `probe-${process.pid}`, from: 1, onEvent: (event: any) => { sequences.push(event.sequence); }, timeoutMs: 30_000,
      });
      await waitUntil(() => sequences.length >= CHANNEL_RELIABLE_EVENTS, 20_000);
      await this.#report({
        phase: 'events-reliable', ok: sequences.length >= CHANNEL_RELIABLE_EVENTS,
        fromSequence: subscription.fromSequence, sequences, expected: CHANNEL_RELIABLE_EVENTS,
      });
      subscription.close();
    } catch (error) { await this.#report({ phase: 'events-reliable', ok: false, code: codeOf(error) }); }
  }

  /** Every worker owns its OWN checkpoint: one worker's ack never prunes another's replay. */
  async #probeAckEvents(): Promise<void> {
    const consumerId = `ack-${process.pid}`;
    try {
      const received: number[] = [];
      const subscription = await this.#services.events.subscribe('channel-probe-provider', ACK_EVENT_CONTRACT, {
        consumerId, from: 1, onEvent: (event: any) => { received.push(event.sequence); }, timeoutMs: 30_000,
      });
      await waitUntil(() => received.length >= CHANNEL_ACK_EVENTS, 20_000);
      const acked = received[received.length - 1] ?? 0;
      const durable = await subscription.ack(acked);
      let futureRejected = false;
      try { await subscription.ack(acked + 5); } catch { futureRejected = true; }
      let regressedRejected = false;
      try { await subscription.ack(acked); } catch { regressedRejected = true; }
      subscription.close();

      // Re-subscribe with no `from`: the provider must resume from this
      // consumer's own durable checkpoint and deliver nothing already acked.
      const resumed: number[] = [];
      const second = await this.#services.events.subscribe('channel-probe-provider', ACK_EVENT_CONTRACT, {
        consumerId, onEvent: (event: any) => { resumed.push(event.sequence); }, timeoutMs: 30_000,
      });
      await sleep(500);
      const resumedFrom = second.fromSequence;
      second.close();

      // Publishing after everyone acked must continue the durable sequence.
      const published = await this.#rpc.publishAck({ pid: process.pid });
      await this.#report({
        phase: 'events-ack', ok: true, received, acked: durable, resumedFrom, resumed,
        futureRejected, regressedRejected, sequenceAfterAck: published?.sequence ?? null,
      });
    } catch (error) { await this.#report({ phase: 'events-ack', ok: false, code: codeOf(error) }); }
  }

  /** Bounded retention: filling past the window makes an over-old `from` an explicit gap. */
  async #probeGap(handshake: any): Promise<void> {
    try {
      const filled = await this.#rpc.fillTopic({ pid: process.pid });
      let gap = false;
      let gapCode: string | null = null;
      try {
        const stale = await this.#services.events.subscribe('channel-probe-provider', GAP_EVENT_CONTRACT, {
          consumerId: `gap-${process.pid}`, from: 1, onEvent: () => undefined, timeoutMs: 15_000,
        });
        stale.close();
      } catch (error) { gap = true; gapCode = codeOf(error); }
      // The retained suffix is still replayable from the oldest surviving event.
      await this.#report({
        phase: 'events-gap', ok: true, gap, gapCode,
        first: filled?.first ?? null, last: filled?.last ?? null, retention: handshake?.gapRetention ?? CHANNEL_GAP_RETENTION,
      });
    } catch (error) { await this.#report({ phase: 'events-gap', ok: false, code: codeOf(error) }); }
  }

  async #probeTransient(): Promise<void> {
    try {
      const received: number[] = [];
      const subscription = await this.#services.events.subscribe('channel-probe-provider', TRANSIENT_CONTRACT, {
        consumerId: `transient-${process.pid}`, onEvent: () => { received.push(1); }, timeoutMs: 30_000,
      });
      await sleep(2_000);
      subscription.close();
      await this.#report({ phase: 'transient', ok: received.length > 0, count: received.length, dropped: subscription.dropped() });
    } catch (error) { await this.#report({ phase: 'transient', ok: false, code: codeOf(error) }); }
  }

  /** R17: the provider sink really receives bytes, then fails; no false commit. */
  async #probeUploadFailure(): Promise<void> {
    try {
      const body = pattern(FAIL_UPLOAD_SIZE, 23);
      const stream = this.#services.stream.openWrite('channel-probe-provider', FAIL_UPLOAD_CONTRACT, { objectId: FAIL_UPLOAD_ID_VALUE, version: 1 }, {
        size: body.byteLength, timeoutMs: 30_000,
      });
      let completedFailed = false;
      void stream.completed.catch(() => { completedFailed = true; });
      let finishFailed = false;
      try {
        for (let offset = 0; offset < body.byteLength; offset += 60 * 1024) {
          await stream.write(body.slice(offset, Math.min(offset + 60 * 1024, body.byteLength)));
        }
        await stream.finish();
      } catch { finishFailed = true; }
      await sleep(300);
      await this.#report({
        phase: 'upload-fail', ok: finishFailed || completedFailed, finishFailed, completedFailed, sent: body.byteLength,
      });
    } catch (error) { await this.#report({ phase: 'upload-fail', ok: false, code: codeOf(error) }); }
  }

  /** R16: ONE duplex session with CONCURRENT read and write over one transfer id. */
  async #probeDuplex(): Promise<void> {
    try {
      const outbound = pattern(DUPLEX_WRITE_SIZE, 44);
      const outboundDigest = digestOf(outbound);
      const session = this.#services.stream.openDuplex('channel-probe-provider', DUPLEX_CONTRACT, { objectId: DUPLEX_ID_VALUE, version: 1 }, {
        readSize: DUPLEX_READ_SIZE, writeSize: outbound.byteLength,
        readCreditBytes: 60 * 1024, writeCreditBytes: 60 * 1024, timeoutMs: 60_000,
      });
      const readTask = session.collect();
      const writeTask = (async () => {
        for (let offset = 0; offset < outbound.byteLength; offset += 60 * 1024) {
          await session.write(outbound.slice(offset, Math.min(offset + 60 * 1024, outbound.byteLength)));
        }
        return session.finishWrite();
      })();
      const [read, write] = await Promise.all([readTask, writeTask]);
      const result = await session.completed;
      await this.#report({
        phase: 'duplex',
        ok: read.bytes === DUPLEX_READ_SIZE && write.bytes === outbound.byteLength
          && result.read?.digest === read.digest && result.write?.digest === outboundDigest,
        readBytes: read.bytes, readDigest: read.digest, writeBytes: write.bytes, writeDigest: write.digest,
        resultReadBytes: result.read?.bytes ?? null, resultWriteDigest: result.write?.digest ?? null,
      });
    } catch (error) { await this.#report({ phase: 'duplex', ok: false, code: codeOf(error) }); }
  }

  /** R16: half-close the read direction; the write direction must still commit. */
  async #probeDuplexHalfClose(): Promise<void> {
    try {
      const outbound = pattern(DUPLEX_HALF_WRITE_SIZE, 45);
      const outboundDigest = digestOf(outbound);
      const session = this.#services.stream.openDuplex('channel-probe-provider', DUPLEX_CONTRACT, { objectId: DUPLEX_HALF_ID_VALUE, version: 1 }, {
        readSize: 128 * 1024 + 5, writeSize: outbound.byteLength, timeoutMs: 60_000,
      });
      const iterator = session.chunks();
      const first = await iterator.next();
      session.endRead();
      try { await iterator.return?.(undefined); } catch { /* already closed */ }
      const write = await (async () => {
        for (let offset = 0; offset < outbound.byteLength; offset += 60 * 1024) {
          await session.write(outbound.slice(offset, Math.min(offset + 60 * 1024, outbound.byteLength)));
        }
        return session.finishWrite();
      })();
      const result = await session.completed;
      await this.#report({
        phase: 'duplex-half-close',
        ok: first.done === false && write.digest === outboundDigest && result.read === null && result.write?.digest === outboundDigest,
        firstChunk: first.done === false ? (first.value?.byteLength ?? 0) : 0,
        writeBytes: write.bytes, writeDigest: write.digest,
        resultRead: result.read, resultWriteDigest: result.write?.digest ?? null,
      });
    } catch (error) { await this.#report({ phase: 'duplex-half-close', ok: false, code: codeOf(error) }); }
  }

  /** R16: a failure in ONE direction drains the whole session (shared drain). */
  async #probeDuplexFailure(): Promise<void> {
    try {
      const outbound = pattern(DUPLEX_FAIL_WRITE_SIZE, 46);
      const session = this.#services.stream.openDuplex('channel-probe-provider', DUPLEX_CONTRACT, { objectId: DUPLEX_FAIL_ID_VALUE, version: 1 }, {
        readSize: DUPLEX_FAIL_READ_SIZE, writeSize: outbound.byteLength, timeoutMs: 30_000,
      });
      let completedFailed = false;
      void session.completed.catch(() => { completedFailed = true; });
      const readTask = session.collect().catch(() => null);
      let writeFailed = false;
      try {
        for (let offset = 0; offset < outbound.byteLength; offset += 60 * 1024) {
          await session.write(outbound.slice(offset, Math.min(offset + 60 * 1024, outbound.byteLength)));
        }
        await session.finishWrite();
      } catch { writeFailed = true; }
      await Promise.race([readTask, sleep(5_000)]);
      await sleep(300);
      await this.#report({
        phase: 'duplex-fail', ok: completedFailed, completedFailed, writeFailed, sent: outbound.byteLength,
      });
    } catch (error) { await this.#report({ phase: 'duplex-fail', ok: false, code: codeOf(error) }); }
  }

  /** R14: a schema-invalid refresh must fail and keep the applied snapshot. */
  async #probeSnapshotSchema(): Promise<void> {
    try {
      const view = this.#services.snapshot.consume('channel-probe-provider', SCHEMA_SNAPSHOT_CONTRACT);
      const first = await view.sync({ timeoutMs: 30_000 });
      const applied = view.current();
      const failed = await view.sync({ version: 2, force: true, timeoutMs: 30_000 });
      const kept = view.current();
      await this.#report({
        phase: 'snapshot-schema',
        ok: applied !== null && applied.descriptor.version === 1 && failed === 'failed' && kept?.descriptor.version === 1,
        first, failed, appliedVersion: applied?.descriptor.version ?? null,
        keptVersion: kept?.descriptor.version ?? null, status: view.status().status,
      });
    } catch (error) { await this.#report({ phase: 'snapshot-schema', ok: false, code: codeOf(error) }); }
  }

  bodyRequirements() { return { request: 'none' as const }; }

  register(): void {}
  async onDestroy(): Promise<void> { this.#stopped = true; pumpStopped = true; }
}

export default ChannelProbeConsumer;
