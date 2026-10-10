/**
 * Control entry of the channel-probe provider fixture.
 *
 * It publishes REAL control-process services through the public plugin SDK:
 *
 *  - an RPC `handshake` / `report` / `fillTopic` / `publishAck` service;
 *  - a read stream (immutable, digest-addressed, larger than the 64 KiB envelope);
 *  - a write stream (the worker uploads a body this process verifies and commits);
 *  - a versioned snapshot whose current version is bumped on a timer;
 *  - a provider with no valid snapshot at all (explicit failure);
 *  - reliable event topics (durable log supplied by the host communication store,
 *    with the outbox committed in the SAME transaction as its business state), a
 *    bounded-retention topic for the gap proof, and a transient notification topic;
 *  - a same-process consume of its OWN snapshot (in-process loopback) and a
 *    control->worker consume of the worker's snapshot (peer routing the other way).
 *
 * The file is import-free except for `node:crypto`, so the production control
 * artifact loader compiles it from the copied plugin directory.
 */

import { createHash } from 'node:crypto';

export const CHANNEL_RPC_ID = 'channel-probe.control.v1';
export const CHANNEL_STREAM_ID = 'channel-probe.objects.v1';
export const CHANNEL_UPLOAD_ID = 'channel-probe.uploads.v1';
export const CHANNEL_FAIL_UPLOAD_ID = 'channel-probe.uploads.fail.v1';
export const CHANNEL_SNAPSHOT_ID = 'channel-probe.snapshot.v1';
export const CHANNEL_EMPTY_SNAPSHOT_ID = 'channel-probe.snapshot.none.v1';
export const CHANNEL_SCHEMA_SNAPSHOT_ID = 'channel-probe.snapshot.schema.v1';
export const CHANNEL_EVENT_ID = 'channel-probe.events.v1';
export const CHANNEL_ACK_EVENT_ID = 'channel-probe.ack-events.v1';
export const CHANNEL_GAP_EVENT_ID = 'channel-probe.gap-events.v1';
export const CHANNEL_TRANSIENT_ID = 'channel-probe.transient.v1';
export const CHANNEL_DUPLEX_ID = 'channel-probe.duplex.v1';

export const CHANNEL_OBJECT_ID = 'probe-object-1';
/** Comfortably beyond the 64 KiB peer message envelope. */
export const CHANNEL_OBJECT_SIZE = 2 * 1024 * 1024 + 4099;
export const CHANNEL_UPLOAD_ID_VALUE = 'probe-upload-1';
export const CHANNEL_UPLOAD_SIZE = 1024 * 1024 + 77;
export const CHANNEL_FAIL_UPLOAD_ID_VALUE = 'probe-upload-fail-1';
export const CHANNEL_FAIL_UPLOAD_SIZE = 256 * 1024;
/** The injected sink failure fires only AFTER this many real bytes arrived. */
export const CHANNEL_FAIL_AFTER_BYTES = 60 * 1024;
/** A real multi-megabyte snapshot body, chunked by the host. */
export const CHANNEL_SNAPSHOT_SIZE = 5 * 1024 * 1024 + 123;
export const CHANNEL_DUPLEX_ID_VALUE = 'probe-duplex-1';
export const CHANNEL_DUPLEX_HALF_ID_VALUE = 'probe-duplex-half-1';
export const CHANNEL_DUPLEX_FAIL_ID_VALUE = 'probe-duplex-fail-1';
export const CHANNEL_DUPLEX_READ_SIZE = 512 * 1024 + 7;
export const CHANNEL_DUPLEX_WRITE_SIZE = 384 * 1024 + 11;
export const CHANNEL_DUPLEX_HALF_READ_SIZE = 128 * 1024 + 5;
export const CHANNEL_DUPLEX_HALF_WRITE_SIZE = 96 * 1024 + 13;
export const CHANNEL_DUPLEX_FAIL_WRITE_SIZE = 128 * 1024 + 3;
export const CHANNEL_RELIABLE_EVENTS = 4;
export const CHANNEL_ACK_EVENTS = 2;
export const CHANNEL_GAP_RETENTION = 3;
export const CHANNEL_SNAPSHOT_MAX_VERSION = 8;

/* Contract literals kept byte-for-byte equivalent to the consumer's copies: the
 * host hashes them and refuses a call whose hash disagrees. */
export const CHANNEL_OBJECT_SCHEMA = {
  type: 'object',
  properties: { objectId: { type: 'string' }, version: { type: 'number', integer: true, minimum: 1 } },
} as const;
export const CHANNEL_EVENT_SCHEMA = {
  type: 'object',
  properties: { topic: { type: 'string' }, index: { type: 'number', integer: true, minimum: 0 }, at: { type: 'number' } },
} as const;
export const CHANNEL_CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' }, bytes: { type: 'number', integer: true, minimum: 0 },
    filler: { type: 'string' },
  },
} as const;

export const CHANNEL_OBJECT_CONTRACT = { id: CHANNEL_STREAM_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
export const CHANNEL_UPLOAD_CONTRACT = { id: CHANNEL_UPLOAD_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
export const CHANNEL_FAIL_UPLOAD_CONTRACT = { id: CHANNEL_FAIL_UPLOAD_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };
export const CHANNEL_SNAPSHOT_CONTRACT = { id: CHANNEL_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
export const CHANNEL_EMPTY_SNAPSHOT_CONTRACT = { id: CHANNEL_EMPTY_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
export const CHANNEL_SCHEMA_SNAPSHOT_CONTRACT = { id: CHANNEL_SCHEMA_SNAPSHOT_ID, version: 1, content: CHANNEL_CONTENT_SCHEMA };
export const CHANNEL_EVENT_CONTRACT = { id: CHANNEL_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA };
export const CHANNEL_ACK_EVENT_CONTRACT = { id: CHANNEL_ACK_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA };
export const CHANNEL_GAP_EVENT_CONTRACT = { id: CHANNEL_GAP_EVENT_ID, version: 1, delivery: 'reliable', event: CHANNEL_EVENT_SCHEMA, retention: { maxEvents: CHANNEL_GAP_RETENTION } };
export const CHANNEL_TRANSIENT_CONTRACT = { id: CHANNEL_TRANSIENT_ID, version: 1, delivery: 'transient', event: CHANNEL_EVENT_SCHEMA };
export const CHANNEL_DUPLEX_CONTRACT = { id: CHANNEL_DUPLEX_ID, version: 1, object: CHANNEL_OBJECT_SCHEMA };

const RPC_CONTRACT = {
  id: CHANNEL_RPC_ID,
  version: 1,
  methods: {
    handshake: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    report: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    fillTopic: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    publishAck: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
  },
};

function pattern(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = (state >>> 24) & 0xff;
  }
  return bytes;
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * A snapshot body is fixed UTF-8 JSON matching the declared content schema. The
 * body is padded to an exact byte size so size/digest assertions stay exact.
 */
function jsonSnapshot(size: number, kind: string): Uint8Array {
  const encoder = new TextEncoder();
  const head = `{"kind":${JSON.stringify(kind)},"bytes":${size},"filler":"`;
  const tail = '"}';
  const fill = size - encoder.encode(head).length - encoder.encode(tail).length;
  if (fill < 0) throw new Error('snapshot size is too small for the JSON envelope');
  return encoder.encode(`${head}${'x'.repeat(fill)}${tail}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createControl(context: any) {
  const state = {
    reports: [] as any[],
    snapshotVersion: 1,
    schemaSnapshotVersion: 1,
    snapshotBumps: 0,
    objectSize: 0,
    objectDigest: '',
    uploadDigest: '',
    uploadFrames: 0,
    uploadBytes: 0,
    uploadReadback: '',
    uploadAborted: 0,
    uploadFailReceived: 0,
    uploadFailFinished: 0,
    uploadFailAborted: 0,
    duplexReceived: 0,
    duplexCommitted: '',
    duplexHalfReceived: 0,
    duplexHalfCommitted: '',
    duplexFailReceived: 0,
    duplexFailAborted: 0,
    snapshotPublishError: '',
    snapshotReadError: '',
    snapshotStoreVersion: 0,
    snapshotReadCalls: 0,
    snapshotReadMs: 0,
    snapshotReadMaxMs: 0,
    snapshotPublishMs: 0,
    snapshotPublishMaxMs: 0,
    publishedReliable: 0,
    publishedAck: 0,
    transientPublished: 0,
    outboxCounter: 0,
    outboxRollback: false,
    gapFirst: 0,
    gapLast: 0,
  };
  const objectBytes = pattern(CHANNEL_OBJECT_SIZE, 11);
  state.objectSize = objectBytes.byteLength;
  state.objectDigest = digestOf(objectBytes);
  const snapshotCache = new Map<number, Uint8Array>();
  const snapshotBytes = (version: number): Uint8Array => {
    let bytes = snapshotCache.get(version);
    if (bytes === undefined) {
      bytes = jsonSnapshot(CHANNEL_SNAPSHOT_SIZE, `snapshot-v${version}`);
      snapshotCache.set(version, bytes);
      // Bounded fixture cache: the host store retains only a few versions, so
      // holding every published body forever would only create GC pauses.
      while (snapshotCache.size > 4) {
        const oldest = Math.min(...snapshotCache.keys());
        if (oldest === version) break;
        snapshotCache.delete(oldest);
      }
    }
    return bytes;
  };
  const schemaSnapshotBytes = (version: number): Uint8Array =>
    (version <= 1 ? jsonSnapshot(256, 'schema-ok') : new TextEncoder().encode('{"kind":123}'));
  const descriptorOf = (version: number, bytes: Uint8Array) => ({
    owner: 'channel-probe-provider', epoch: 1, version, schemaVersion: 1,
    digest: digestOf(bytes), size: bytes.byteLength, chunkBytes: 60 * 1024,
  });

  /** The bytes the sink really received and committed (never the caller's claim). */
  let uploadBody: Uint8Array | null = null;
  let ackPublisher: any = null;
  let reliablePublisher: any = null;
  let gapPublisher: any = null;
  let transientPublisher: any = null;
  let bumpTimer: ReturnType<typeof setInterval> | null = null;
  let transientTimer: ReturnType<typeof setInterval> | null = null;

  return {
    api: [{
      path: '/state',
      methods: ['GET'],
      handler: 'state',
      invoke: async () => Response.json({
        reports: state.reports,
        snapshotVersion: state.snapshotVersion,
        snapshotBumps: state.snapshotBumps,
        objectSize: state.objectSize,
        objectDigest: state.objectDigest,
        uploadDigest: state.uploadDigest,
        uploadFrames: state.uploadFrames,
        uploadBytes: state.uploadBytes,
        uploadReadback: state.uploadReadback,
        uploadAborted: state.uploadAborted,
        uploadFailReceived: state.uploadFailReceived,
        uploadFailFinished: state.uploadFailFinished,
        uploadFailAborted: state.uploadFailAborted,
        duplexReceived: state.duplexReceived,
        duplexCommitted: state.duplexCommitted,
        duplexHalfReceived: state.duplexHalfReceived,
        duplexHalfCommitted: state.duplexHalfCommitted,
        duplexFailReceived: state.duplexFailReceived,
        duplexFailAborted: state.duplexFailAborted,
        snapshotPublishError: state.snapshotPublishError,
        snapshotReadError: state.snapshotReadError,
        snapshotStoreVersion: state.snapshotStoreVersion,
        snapshotReadCalls: state.snapshotReadCalls,
        snapshotReadMs: state.snapshotReadMs,
        snapshotReadMaxMs: state.snapshotReadMaxMs,
        snapshotPublishMs: state.snapshotPublishMs,
        snapshotPublishMaxMs: state.snapshotPublishMaxMs,
        publishedReliable: state.publishedReliable,
        publishedAck: state.publishedAck,
        transientPublished: state.transientPublished,
        outboxCounter: state.outboxCounter,
        outboxRecord: await context.durableState.get('audit.counter'),
        outboxRollback: state.outboxRollback,
        gapFirst: state.gapFirst,
        gapLast: state.gapLast,
      }),
    }, {
      path: '/outbox/retry', methods: ['POST'], handler: 'outboxRetry',
      invoke: async ({ request }: any) => {
        const input = await request.json();
        const index = input?.index;
        if (!Number.isSafeInteger(index) || index < 0 || index >= CHANNEL_RELIABLE_EVENTS) return Response.json({ error: 'invalid_input' }, { status: 400 });
        try {
          const sequence = await reliablePublisher.publishWithState({ topic: 'audit', index, at: input.changed === true ? 1 : 0 }, [{ key: 'audit.counter', expectedVersion: index, value: { value: index + 1 } }]);
          return Response.json({ sequence, record: await context.durableState.get('audit.counter') });
        } catch { return Response.json({ error: 'outbox_conflict', record: await context.durableState.get('audit.counter') }, { status: 409 }); }
      },
    }],
    rpc: [],
    start: async () => {
      context.services.rpc.publish(RPC_CONTRACT, {
        handshake: () => ({
          objectId: CHANNEL_OBJECT_ID, objectSize: state.objectSize, objectDigest: state.objectDigest,
          uploadId: CHANNEL_UPLOAD_ID_VALUE, uploadSize: CHANNEL_UPLOAD_SIZE,
          snapshotVersion: state.snapshotVersion, reliableEvents: CHANNEL_RELIABLE_EVENTS,
          ackEvents: CHANNEL_ACK_EVENTS, gapRetention: CHANNEL_GAP_RETENTION,
        }),
        report: (input: any) => {
          const pid = typeof input?.pid === 'number' ? input.pid : process.pid;
          state.reports.push({ ...input, pid: input?.pid ?? pid });
          if (state.reports.length > 256) state.reports.splice(0, state.reports.length - 256);
          return { stored: state.reports.length };
        },
        fillTopic: async () => {
          const first = gapPublisher === null ? 0 : await gapPublisher.publish({ topic: 'gap', index: state.gapLast, at: Date.now() });
          state.gapFirst ||= first;
          for (let index = 1; index <= CHANNEL_GAP_RETENTION + 2; index += 1) {
            state.gapLast = await gapPublisher.publish({ topic: 'gap', index, at: Date.now() });
          }
          return { first: state.gapFirst, last: state.gapLast };
        },
        publishAck: async () => {
          const sequence = await ackPublisher.publish({ topic: 'ack', index: 0, at: Date.now() });
          state.publishedAck += 1;
          return { sequence };
        },
      });

      context.services.stream.provide(CHANNEL_OBJECT_CONTRACT, {
        open: ({ object }: any) => {
          if (object?.objectId !== CHANNEL_OBJECT_ID || object?.version !== 1) return null;
          return { size: objectBytes.byteLength, digest: state.objectDigest, read: async (offset: number, length: number) => objectBytes.slice(offset, offset + length) };
        },
      });

      context.services.stream.provide(CHANNEL_UPLOAD_CONTRACT, {
        accept: ({ object }: any) => {
          if (object?.objectId !== CHANNEL_UPLOAD_ID_VALUE || object?.version !== 1) return null;
          // A REAL sink receipt: it accumulates the actual bytes (never trusts the
          // caller's digest), verifies contiguity/size/digest itself, and the
          // committed body is read back and re-hashed independently.
          const chunks: Uint8Array[] = [];
          let received = 0;
          return {
            write: async (offset: number, bytes: Uint8Array) => {
              if (offset !== received) throw new Error('channel upload offset mismatch');
              chunks.push(bytes.slice());
              received += bytes.byteLength;
              state.uploadFrames += 1;
              // A deliberately slow sink: finish must wait for every write to settle.
              await new Promise<void>((resolve) => setTimeout(resolve, 3));
            },
            finish: async (size: number, digest: string) => {
              const joined = new Uint8Array(received);
              let at = 0;
              for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
              const actual = digestOf(joined);
              if (joined.byteLength !== size) throw new Error('channel upload size mismatch');
              if (actual !== digest) throw new Error('channel upload digest mismatch');
              uploadBody = joined;
              state.uploadBytes = joined.byteLength;
              state.uploadDigest = `${actual}|${joined.byteLength}`;
              state.uploadReadback = digestOf(uploadBody);
            },
            abort: () => { state.uploadAborted += 1; },
          };
        },
      });

      // True duplex: ONE session serves both directions, and the provider sink
      // really accumulates the consumer's bytes (verified independently).
      context.services.stream.provide(CHANNEL_DUPLEX_CONTRACT, {
        duplex: ({ object }: any) => {
          const objectId = object?.objectId;
          const half = objectId === CHANNEL_DUPLEX_HALF_ID_VALUE;
          const failing = objectId === CHANNEL_DUPLEX_FAIL_ID_VALUE;
          if (object?.version !== 1 || (!half && !failing && objectId !== CHANNEL_DUPLEX_ID_VALUE)) return null;
          const key = failing ? 'duplexFail' : half ? 'duplexHalf' : 'duplex';
          const inbound = pattern(failing ? 256 * 1024 : half ? CHANNEL_DUPLEX_HALF_READ_SIZE : CHANNEL_DUPLEX_READ_SIZE, failing ? 35 : half ? 34 : 33);
          const chunks: Uint8Array[] = [];
          let received = 0;
          return {
            source: {
              size: inbound.byteLength,
              digest: digestOf(inbound),
              read: async (offset: number, length: number) => {
                // Injected provider-side read failure AFTER real chunks were served.
                if (failing && offset >= CHANNEL_FAIL_AFTER_BYTES) throw new Error('injected duplex source failure');
                return inbound.slice(offset, offset + length);
              },
            },
            sink: {
              write: async (offset: number, bytes: Uint8Array) => {
                if (offset !== received) throw new Error('duplex sink offset mismatch');
                chunks.push(bytes.slice());
                received += bytes.byteLength;
                state[`${key}Received`] = received;
                await new Promise<void>((resolve) => setTimeout(resolve, 2));
              },
              finish: async (size: number, digest: string) => {
                const joined = new Uint8Array(received);
                let at = 0;
                for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
                if (joined.byteLength !== size || digestOf(joined) !== digest) throw new Error('duplex sink mismatch');
                state[`${key}Committed`] = `${digest}|${size}`;
              },
              abort: () => { state[`${key}Aborted`] = (state[`${key}Aborted`] ?? 0) + 1; },
            },
          };
        },
      });

      // R17 failure injection: the sink really receives bytes, then fails; `finish`
      // must never run and the provider must never claim a committed body.
      context.services.stream.provide(CHANNEL_FAIL_UPLOAD_CONTRACT, {
        accept: ({ object }: any) => {
          if (object?.objectId !== CHANNEL_FAIL_UPLOAD_ID_VALUE || object?.version !== 1) return null;
          let received = 0;
          return {
            write: async (_offset: number, bytes: Uint8Array) => {
              received += bytes.byteLength;
              state.uploadFailReceived = received;
              if (received >= CHANNEL_FAIL_AFTER_BYTES) throw new Error('injected channel upload sink failure');
            },
            finish: async () => { state.uploadFailFinished += 1; throw new Error('finish must not run after a failed sink'); },
            abort: () => { state.uploadFailAborted += 1; },
          };
        },
      });

      // Prefer the host-managed persistent version store: chunked, atomic, bounded
      // retention, and it never frees a version a live whole-body read retained.
      const snapshotStore = typeof context.services.snapshot.store === 'function'
        ? context.services.snapshot.store({ id: CHANNEL_SNAPSHOT_ID, schemaVersion: 1, epoch: 1, maxVersions: 3 })
        : null;
      const recordPublishError = (error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        if (state.snapshotPublishError === '') state.snapshotPublishError = message.slice(0, 200);
      };
      const restoredSnapshot = await snapshotStore?.current();
      if (restoredSnapshot) {
        state.snapshotVersion = restoredSnapshot.descriptor.version;
        state.snapshotStoreVersion = state.snapshotVersion;
        await restoredSnapshot.release?.();
      } else {
        try { await snapshotStore?.publish(1, snapshotBytes(1)); state.snapshotStoreVersion = 1; } catch (error) { recordPublishError(error); }
      }
      const memorySource = (version: number) => ({
        descriptor: descriptorOf(version, snapshotBytes(version)),
        read: async (offset: number, length: number) => snapshotBytes(version).slice(offset, offset + length),
      });
      // Guard the host-store source so a failed chunk read records WHY it failed.
      const guard = (source: any, version: number | null): any => (source === null ? null : {
        descriptor: source.descriptor,
        ...(source.retain === undefined ? {} : { retain: () => source.retain() }),
        ...(source.release === undefined ? {} : { release: () => source.release() }),
        read: async (offset: number, length: number) => {
          const startedAt = Date.now();
          try { return await source.read(offset, length); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (state.snapshotReadError === '') {
              const current = await snapshotStore.current();
              state.snapshotReadError = `v${version}@${offset}+${length} cur=${current?.descriptor.version ?? 'null'}: ${message}`.slice(0, 240);
              await current?.release?.();
            }
            throw error;
          } finally {
            const elapsed = Date.now() - startedAt;
            state.snapshotReadCalls += 1;
            state.snapshotReadMs += elapsed;
            if (elapsed > state.snapshotReadMaxMs) state.snapshotReadMaxMs = elapsed;
          }
        },
      });
      context.services.snapshot.provide(CHANNEL_SNAPSHOT_CONTRACT, snapshotStore !== null
        ? {
          current: async () => { const source = await snapshotStore.current(); return guard(source, source?.descriptor.version ?? null); },
          version: async (version: number) => guard(await snapshotStore.version(version), version),
        }
        : {
          current: () => memorySource(state.snapshotVersion),
          version: (version: number) => (version <= state.snapshotVersion ? memorySource(version) : null),
        });

      context.services.snapshot.provide(CHANNEL_EMPTY_SNAPSHOT_CONTRACT, { current: () => null, version: () => null });

      // v1 is schema-valid; v2 is valid UTF-8 JSON that VIOLATES the content schema,
      // so a forced refresh to v2 must fail and keep the applied v1 snapshot.
      const schemaSource = (version: number) => ({
        descriptor: descriptorOf(version, schemaSnapshotBytes(version)),
        read: async (offset: number, length: number) => schemaSnapshotBytes(version).slice(offset, offset + length),
      });
      context.services.snapshot.provide(CHANNEL_SCHEMA_SNAPSHOT_CONTRACT, {
        current: () => schemaSource(state.schemaSnapshotVersion),
        version: (version: number) => (version <= 2 ? schemaSource(version) : null),
      });

      reliablePublisher = context.services.events.provide(CHANNEL_EVENT_CONTRACT);
      ackPublisher = context.services.events.provide(CHANNEL_ACK_EVENT_CONTRACT);
      gapPublisher = context.services.events.provide(CHANNEL_GAP_EVENT_CONTRACT);
      transientPublisher = context.services.events.provide(CHANNEL_TRANSIENT_CONTRACT);

      // Outbox: every durable event commits its business state in ONE transaction.
      for (let index = 0; index < CHANNEL_RELIABLE_EVENTS; index += 1) {
        const next = index + 1;
        const payload = { topic: 'audit', index, at: 0 };
        const mutations = [{ key: 'audit.counter', expectedVersion: index, value: { value: next } }];
        await reliablePublisher.publishWithState(payload, mutations);
        try { await reliablePublisher.publishWithState(payload, mutations); throw new Error('outbox retry accepted stale CAS'); }
        catch (error) { if ((error as any)?.code !== 'durable_state_conflict') throw error; }
        state.outboxCounter = (await context.durableState.get('audit.counter'))?.value.value ?? 0;
        state.publishedReliable += 1;
      }
      for (let index = 0; index < CHANNEL_ACK_EVENTS; index += 1) {
        await ackPublisher.publish({ topic: 'ack', index, at: Date.now() });
        state.publishedAck += 1;
      }
      // A conflicting outbox command must roll the event row back with the state.
      try {
        await reliablePublisher.publishWithState({ topic: 'audit', index: 99, at: Date.now() }, [{ key: 'audit.counter', expectedVersion: 0, value: { value: 9999 } }]);
      } catch {
        state.outboxRollback = true;
      }

      // The provider keeps publishing new immutable versions for the whole run, so
      // a consumer always has a newer version to reconcile against (and the store's
      // bounded retention is exercised continuously).
      bumpTimer = setInterval(() => {
        try {
          context.services.runBackground(async () => {
            state.snapshotVersion += 1;
            const startedAt = Date.now();
            try { await snapshotStore?.publish(state.snapshotVersion, snapshotBytes(state.snapshotVersion)); state.snapshotStoreVersion = state.snapshotVersion; } catch (error) { recordPublishError(error); }
            const elapsed = Date.now() - startedAt;
            state.snapshotPublishMs += elapsed;
            if (elapsed > state.snapshotPublishMaxMs) state.snapshotPublishMaxMs = elapsed;
            state.snapshotBumps += 1;
          });
        } catch (error) { recordPublishError(error); }
      }, 2_000);
      if (typeof bumpTimer?.unref === 'function') bumpTimer.unref();

      transientTimer = setInterval(() => {
        state.transientPublished += 1;
        try { context.services.runBackground(() => transientPublisher.notify({ topic: 'tick', index: state.transientPublished, at: Date.now() })); }
        catch { /* transient is best-effort by contract */ }
      }, 250);
      if (typeof transientTimer?.unref === 'function') transientTimer.unref();

    },
    dispose: () => {
      if (bumpTimer !== null) clearInterval(bumpTimer);
      if (transientTimer !== null) clearInterval(transientTimer);
    },
  };
}

export default { createControl };
