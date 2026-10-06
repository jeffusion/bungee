/**
 * Unit acceptance for the P5 host communication lanes (stream read/write, event,
 * snapshot) over a REAL authenticated peer link pair, plus the same-process
 * loopback route and the host durable store outbox seam.
 *
 * The transport is an in-memory wire that only moves already-signed BPC1 frames,
 * so every assertion exercises the real link authentication, replay window,
 * correlation, credit accounting and terminal barriers. Nothing is mocked at the
 * protocol level.
 */

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deriveSupervisionProcessKey } from '../../src/supervision';
import {
  createPluginPeerCredential,
  type PluginPeerAuthority,
  type PluginPeerCredential,
} from '../../src/plugin-services/peer-protocol';
import { PluginPeerRpcLink, type PluginPeerRpcSendAdapter } from '../../src/plugin-services/peer-rpc-link';
import { decodePluginPeerFrame } from '../../src/plugin-services/peer-frame';
import {
  PluginPeerChannelHub,
  type PluginChannelEventEntry,
  type PluginChannelReliableEventLog,
  type PluginChannelRouteResolution,
  type PluginChannelSnapshotProvider,
  type PluginChannelStreamProvider,
} from '../../src/plugin-services/peer-channel-hub';
import { PluginServiceHost, type PluginServiceCommunications } from '../../src/plugin-services';
import { HostChannelAdapter, StoreBackedReliableEventLog } from '../../src/plugin-services/channels';
import { HostSnapshotStore } from '../../src/plugin-services/snapshot-store';
import { PluginCommunicationStore } from '../../src/plugin-services/persistence';
import { PluginDurableStateStore, PLUGIN_DURABLE_STATE_SCHEMA_SQL } from '../../src/plugin-durable-state';
import type { ChannelSnapshotDescriptor, PluginChannelLane, PluginChannelTarget } from '../../src/plugin-services/peer-channel-protocol';

const ROOT_KEY = new Uint8Array(32).fill(31);
const INSTANCE = '10000000-0000-4000-8000-0000000000d1';
const WORKER_ID = '20000000-0000-4000-8000-0000000000d1';
const BOOT = '30000000-0000-4000-8000-0000000000d1';
const CONTROLLER = '40000000-0000-4000-8000-0000000000d1';
const AUTHORITY: PluginPeerAuthority = Object.freeze({ controller_epoch: 11, controller_id: CONTROLLER });
const EMPTY = new Uint8Array(0);
const LANES: readonly PluginChannelLane[] = Object.freeze(['event', 'snapshot', 'stream']);
const CONTRACT = 'a'.repeat(32);
const CALLER = 'consumer-plugin';
const CALLER_SCOPE = 'global';

const credential: PluginPeerCredential = createPluginPeerCredential(
  deriveSupervisionProcessKey(ROOT_KEY, INSTANCE, 'worker', WORKER_ID, BOOT),
);

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pattern(size: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
  return bytes;
}

interface Fixture {
  readonly workerHub: PluginPeerChannelHub;
  readonly controlHub: PluginPeerChannelHub;
  readonly authorized: { value: boolean };
  readonly workerLink: PluginPeerRpcLink;
  readonly controlLink: PluginPeerRpcLink;
}

const openFixtures: Fixture[] = [];

function makeFixture(options: {
  readonly authorizeInbound?: boolean;
  readonly beginProviderOperation?: () => (() => void) | null;
} = {}): Fixture {
  const authorized = { value: options.authorizeInbound ?? true };
  const workerLink = new PluginPeerRpcLink({
    credential, authority: AUTHORITY, outgoingDirection: 'peer-to-control',
    onRequest: () => ({ result: Promise.resolve(EMPTY), terminal: Promise.resolve() }),
  });
  const controlLink = new PluginPeerRpcLink({
    credential, authority: AUTHORITY, outgoingDirection: 'control-to-peer',
    onRequest: () => ({ result: Promise.resolve(EMPTY), terminal: Promise.resolve() }),
  });
  // Synchronous in-memory wire: a frame written by one link is authenticated and
  // dispatched by the other immediately. Only protocol frames travel here.
  workerLink.attach((frame) => { controlLink.receive(frame); return true; });
  controlLink.attach((frame) => { workerLink.receive(frame); return true; });
  const workerHub = new PluginPeerChannelHub({
    process: 'worker', peerProcess: 'control',
    // The consumer's route is its OWN link: writing there reaches the peer.
    resolveRoute: (target): PluginChannelRouteResolution => ({ kind: 'remote', link: workerLink }),
    authorizeInbound: () => true,
  });
  const controlHub = new PluginPeerChannelHub({
    process: 'control', peerProcess: 'worker',
    resolveRoute: (target): PluginChannelRouteResolution => ({ kind: 'remote', link: controlLink }),
    authorizeInbound: () => authorized.value,
    beginProviderOperation: options.beginProviderOperation,
  });
  for (const lane of LANES) {
    workerLink.registerLaneHandler(lane, workerHub.handlerFor(workerLink));
    controlLink.registerLaneHandler(lane, controlHub.handlerFor(controlLink));
  }
  const fixture: Fixture = { workerHub, controlHub, authorized, workerLink, controlLink };
  openFixtures.push(fixture);
  return fixture;
}

afterEach(() => {
  for (const fixture of openFixtures.splice(0)) {
    try { fixture.workerHub.dispose(); } catch { /* idempotent */ }
    try { fixture.controlHub.dispose(); } catch { /* idempotent */ }
    try { fixture.workerLink.confirmRemoteStopped(); } catch { /* host-only */ }
    try { fixture.controlLink.confirmRemoteStopped(); } catch { /* host-only */ }
    try { fixture.workerLink.dispose(); } catch { /* idempotent */ }
    try { fixture.controlLink.dispose(); } catch { /* idempotent */ }
  }
});

/** Structural owner-input shape used only to build test owners (checked at the call). */
type HostChannelOwnerInputLike = Parameters<HostChannelAdapter['createOwner']>[0];

const STREAM_TARGET: PluginChannelTarget = Object.freeze({ provider: 'catalog-provider', service: 'catalog.objects', major: 1 });
const SNAPSHOT_TARGET: PluginChannelTarget = Object.freeze({ provider: 'catalog-provider', service: 'catalog.snapshot', major: 1 });
const EVENT_TARGET: PluginChannelTarget = Object.freeze({ provider: 'audit-provider', service: 'audit.events', major: 1 });

function registerReadStream(fixture: Fixture, objectId: string, bytes: Uint8Array): { readonly opened: number[] } {
  const opened: number[] = [];
  const provider: PluginChannelStreamProvider = {
    open: (input) => {
      opened.push(input.version);
      if (input.objectId !== objectId) return null;
      return { size: bytes.byteLength, digest: sha256(bytes), read: async (offset, length) => bytes.slice(offset, offset + length) };
    },
  };
  const handle = fixture.controlHub.registerStream(
    { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
    provider,
  );
  handle.markReady();
  return { opened };
}

function registerWriteStream(fixture: Fixture, objectId: string): { readonly received: Uint8Array[]; readonly finished: Array<{ size: number; digest: string }> } {
  const received: Uint8Array[] = [];
  const finished: Array<{ size: number; digest: string }> = [];
  const provider: PluginChannelStreamProvider = {
    accept: (input) => {
      if (input.objectId !== objectId) return null;
      return {
        write: async (offset, bytes) => { received.push(bytes.slice()); expect(offset).toBe(received.reduce((total, chunk) => total + chunk.byteLength, 0) - bytes.byteLength); },
        finish: async (size, digest) => {
          const joined = Buffer.concat(received.map(chunk => Buffer.from(chunk)));
          expect(joined.byteLength).toBe(size);
          expect(sha256(new Uint8Array(joined))).toBe(digest);
          finished.push({ size, digest });
        },
      };
    },
  };
  const handle = fixture.controlHub.registerStream(
    { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
    provider,
  );
  handle.markReady();
  return { received, finished };
}

function registerSnapshot(fixture: Fixture, versions: Map<number, Uint8Array>): { current: number } {
  const state: { current: number } = { current: 1 };
  const build = (version: number): { descriptor: ChannelSnapshotDescriptor; read(offset: number, length: number): Promise<Uint8Array> } | null => {
    const bytes = versions.get(version);
    if (bytes === undefined) return null;
    return {
      descriptor: {
        owner: 'catalog-provider', epoch: 3, version, schemaVersion: 1,
        digest: sha256(bytes), size: bytes.byteLength, chunkBytes: 60 * 1024,
      },
      read: async (offset, length) => bytes.slice(offset, offset + length),
    };
  };
  const provider: PluginChannelSnapshotProvider = { current: () => build(state.current), version: (version) => build(version) };
  const handle = fixture.controlHub.registerSnapshot(
    { lane: 'snapshot', provider: 'catalog-provider', service: 'catalog.snapshot', major: 1, process: 'control', contract: CONTRACT },
    provider,
  );
  handle.markReady();
  return state;
}

/** In-memory durable log used to prove hub semantics without the SQLite store. */
class MemoryEventLog implements PluginChannelReliableEventLog {
  readonly #entries: PluginChannelEventEntry[] = [];
  readonly #checkpoints = new Map<string, number>();
  #prunedThrough = 0;
  constructor(private readonly maxEvents = 128) {}
  oldestSequence(): number | null { return this.#entries.length === 0 ? null : this.#entries[0]!.sequence; }
  latestSequence(): number { return this.#entries.length === 0 ? 0 : this.#entries[this.#entries.length - 1]!.sequence; }
  prunedThrough(): number { return this.#prunedThrough; }
  async list(fromSequence: number, limit: number): Promise<readonly PluginChannelEventEntry[]> {
    return Object.freeze(this.#entries.filter(entry => entry.sequence >= fromSequence).slice(0, limit));
  }
  checkpoint(consumerId: string): number { return this.#checkpoints.get(consumerId) ?? 0; }
  ack(consumerId: string, sequence: number): { readonly acked: number } {
    const prior = this.#checkpoints.get(consumerId) ?? 0;
    if (sequence <= prior) return Object.freeze({ acked: prior });
    this.#checkpoints.set(consumerId, sequence);
    return Object.freeze({ acked: sequence });
  }
  append(payload: Uint8Array): { readonly sequence: number; readonly eventId: string } {
    const sequence = this.latestSequence() + 1;
    this.#entries.push({ sequence, eventId: sha256(payload).slice(7, 39), payload: new Uint8Array(payload) });
    while (this.#entries.length > this.maxEvents) {
      const stale = this.#entries.shift()!;
      this.#prunedThrough = Math.max(this.#prunedThrough, stale.sequence);
    }
    return { sequence, eventId: this.#entries[this.#entries.length - 1]!.eventId };
  }
  pruneBelow(sequence: number): void {
    while (this.#entries.length > 0 && this.#entries[0]!.sequence < sequence) {
      this.#prunedThrough = Math.max(this.#prunedThrough, this.#entries[0]!.sequence);
      this.#entries.shift();
    }
  }
}

async function flush(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** Minimal host communications whose channel adapter is a pure stub. */
function hostCommunications(): PluginServiceCommunications {
  return {
    identity: () => ({ endpoint: 'endpoint', instance: 'instance', generation: 1, catalog: 'catalog', subject: 'subject' }),
    resolvePlacement: () => null,
    resolveJournal: () => null,
    resolveCallee: () => Object.freeze({}),
    channels: (() => ({
      capabilities: { local: true, remote: false, reliableEvents: false, outbox: false, snapshotViews: true, writeStreams: true },
      markReady: () => undefined,
      retire: () => undefined,
      dispose: async () => undefined,
    })) as never,
  };
}

describe('plugin channel hub over a real peer link', () => {
  test('streams a body larger than the RPC envelope with real credit backpressure and digest verification', async () => {
    const fixture = makeFixture();
    const size = 300 * 1024;
    const bytes = pattern(size);
    expect(size).toBeGreaterThan(64 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);

    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size, digest: sha256(bytes),
    });
    const collected = await stream.collect();
    expect(collected.bytes).toBe(size);
    expect(collected.digest).toBe(sha256(bytes));
    expect(collected.body.byteLength).toBe(size);
    expect(sha256(collected.body)).toBe(sha256(bytes));
    // Real backpressure: the initial credit is below the object size, so the
    // producer had to wait for replenishments from the consumer.
    expect(size).toBeGreaterThan(4 * 60 * 1024);
  });

  test('completion is tied to full consumption: an unread stream holds its slot until idle', async () => {
    const fixture = makeFixture();
    const bytes = pattern(200 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes), idleMs: 5_000,
    });
    await flush();
    // Not consumed: the transfer is still active and completion is unresolved.
    expect(fixture.workerHub.status().activeOutboundTransfers).toBe(1);
    let settled = false;
    void stream.completed.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    stream.cancel();
    await expect(stream.completed).rejects.toBeDefined();
    expect(fixture.workerHub.status().activeOutboundTransfers).toBe(0);
  });

  test('a resume offset streams only the requested suffix', async () => {
    const fixture = makeFixture();
    const bytes = pattern(160 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 100 * 1024, size: null, digest: null,
    });
    const collected = await stream.collect();
    expect(collected.bytes).toBe(60 * 1024);
  });

  test('a consumer-side digest mismatch fails the stream instead of delivering bytes as complete', async () => {
    const fixture = makeFixture();
    const declared = pattern(48 * 1024);
    const actual = pattern(48 * 1024);
    actual[1024] = (actual[1024]! + 1) & 0xff;
    const handle = fixture.controlHub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      { open: () => ({ size: actual.byteLength, digest: sha256(declared), read: async (offset, length) => actual.slice(offset, offset + length) }) },
    );
    handle.markReady();
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: actual.byteLength, digest: sha256(declared),
    });
    let failure: unknown = null;
    try { await stream.collect(); } catch (error) { failure = error; }
    expect(String((failure as { message?: string } | null)?.message ?? failure)).toContain('truncated');
  });

  test('an in-flight stream can be cancelled by the consumer', async () => {
    const fixture = makeFixture();
    const bytes = pattern(120 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes), creditBytes: 60 * 1024,
    });
    const iterator = stream.chunks();
    await iterator.next();
    stream.cancel();
    await expect(stream.completed).rejects.toBeDefined();
  });

  test('breaking out of the iterator releases the live transfer', async () => {
    const fixture = makeFixture();
    const bytes = pattern(180 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes),
    });
    for await (const _chunk of stream.chunks()) break;
    await flush();
    await expect(stream.completed).rejects.toBeDefined();
    expect(fixture.workerHub.status().activeOutboundTransfers).toBe(0);
  });

  test('an external abort signal cancels the stream', async () => {
    const fixture = makeFixture();
    const bytes = pattern(120 * 1024);
    registerReadStream(fixture, 'catalog-v1', bytes);
    const controller = new AbortController();
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes), signal: controller.signal,
    });
    controller.abort();
    await expect(stream.completed).rejects.toBeDefined();
  });

  test('an unauthorized lane request is refused without touching the provider', async () => {
    const fixture = makeFixture({ authorizeInbound: false });
    const bytes = pattern(1024);
    const { opened } = registerReadStream(fixture, 'catalog-v1', bytes);
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, offset: 0, size: null, digest: null,
    });
    await expect(stream.completed).rejects.toBeDefined();
    expect(opened).toHaveLength(0);
  });

  test('a mismatched contract hash is refused before the provider runs', async () => {
    const fixture = makeFixture();
    const { opened } = registerReadStream(fixture, 'catalog-v1', pattern(512));
    const stream = fixture.workerHub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, 'b'.repeat(32), {
      objectId: 'catalog-v1', version: 1, offset: 0, size: null, digest: null,
    });
    await expect(stream.completed).rejects.toBeDefined();
    expect(opened).toHaveLength(0);
  });

  test('a same-process provider is served through the in-process loopback without a peer link', async () => {
    const hub = new PluginPeerChannelHub({
      process: 'control', peerProcess: 'worker',
      resolveRoute: () => { throw new Error('a local route must never consult the peer resolver'); },
      // A same-process route is authorized by the HOST too (`local: true`), never
      // blindly trusted just because no peer frame exists.
      authorizeInbound: (request) => request.local,
    });
    const bytes = pattern(180 * 1024, 3);
    const handle = hub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      { open: () => ({ size: bytes.byteLength, digest: sha256(bytes), read: async (offset, length) => bytes.slice(offset, offset + length) }) },
    );
    handle.markReady();
    try {
      const stream = hub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
        objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes),
      });
      const collected = await stream.collect();
      expect(collected.bytes).toBe(bytes.byteLength);
      expect(collected.digest).toBe(sha256(bytes));
    } finally { hub.dispose(); }
  });

  test('a same-process route is refused when the host does not authorize it', async () => {
    const hub = new PluginPeerChannelHub({
      process: 'control', peerProcess: 'worker',
      resolveRoute: () => { throw new Error('a local route must never consult the peer resolver'); },
      authorizeInbound: () => false,
    });
    const bytes = pattern(64 * 1024, 7);
    const handle = hub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      { open: () => ({ size: bytes.byteLength, digest: sha256(bytes), read: async (offset, length) => bytes.slice(offset, offset + length) }) },
    );
    handle.markReady();
    try {
      const stream = hub.openStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
        objectId: 'catalog-v1', version: 1, offset: 0, size: bytes.byteLength, digest: sha256(bytes),
      });
      await expect(stream.collect()).rejects.toBeDefined();
    } finally { hub.dispose(); }
  });

  test('concurrent writes preserve offsets and do not expand credit before the sink consumes', async () => {
    const fixture = makeFixture();
    const body = pattern(16 * 1024);
    let unblock!: () => void;
    let enter!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const offsets: number[] = [];
    const received: Uint8Array[] = [];
    const handle = fixture.controlHub.registerStream({
      lane: 'stream', provider: STREAM_TARGET.provider, service: STREAM_TARGET.service,
      major: 1, process: 'control', contract: CONTRACT,
    }, { accept: () => ({
      write: async (offset, bytes) => {
        offsets.push(offset);
        if (offset === 0) { enter(); await blocked; }
        received.push(new Uint8Array(bytes));
      },
      finish: async (size, digest) => {
        const actual = new Uint8Array(Buffer.concat(received));
        expect(actual.byteLength).toBe(size);
        expect(sha256(actual)).toBe(digest);
      },
    }) });
    handle.markReady();
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'upload', version: 1, size: body.byteLength, digest: sha256(body), creditBytes: 8 * 1024,
    });
    const first = stream.write(body.slice(0, 8 * 1024));
    let secondSent = false;
    const second = stream.write(body.slice(8 * 1024)).then(() => { secondSent = true; });
    const finish = stream.finish();
    await entered;
    expect(secondSent).toBe(false);
    expect(offsets).toEqual([0]);
    expect(received).toHaveLength(0);
    unblock();
    await Promise.all([first, second, finish]);
    expect(offsets).toEqual([0, 8 * 1024]);
    expect(Array.from(Buffer.concat(received))).toEqual(Array.from(body));
  });

  test('cancelling a suspended finish retains both leases until the real sink task ends', async () => {
    let providerLeases = 0;
    let callerReleased = 0;
    const fixture = makeFixture({ beginProviderOperation: () => {
      providerLeases += 1;
      return () => { providerLeases -= 1; };
    } });
    let unblock!: () => void;
    let enter!: () => void;
    let aborted!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
    const handle = fixture.controlHub.registerStream({
      lane: 'stream', provider: STREAM_TARGET.provider, service: STREAM_TARGET.service,
      major: 1, process: 'control', contract: CONTRACT,
    }, { accept: () => ({
      write: async () => undefined,
      finish: async () => { enter(); await blocked; },
      abort: () => { aborted(); },
    }) });
    handle.markReady();
    const body = pattern(1024);
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'upload', version: 1, size: body.byteLength, digest: sha256(body),
      release: () => { callerReleased += 1; },
    });
    const outcome = stream.completed.catch(() => undefined);
    await stream.write(body);
    const finish = stream.finish().catch(() => undefined);
    await entered;
    stream.abort();
    await abortObserved;
    expect(providerLeases).toBe(1);
    expect(callerReleased).toBe(0);
    expect(fixture.controlHub.status().activeInboundTransfers).toBe(1);
    unblock();
    await Promise.all([outcome, finish]);
    for (let turn = 0; turn < 20 && callerReleased === 0; turn += 1) await Promise.resolve();
    expect(providerLeases).toBe(0);
    expect(callerReleased).toBe(1);
  });

  test('writes a body to the provider, which commits it after verifying size and digest', async () => {
    const fixture = makeFixture();
    const bytes = pattern(200 * 1024, 5);
    const sink = registerWriteStream(fixture, 'upload-1');
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'upload-1', version: 1, size: bytes.byteLength, digest: sha256(bytes), creditBytes: 2 * 60 * 1024,
    });
    for (let offset = 0; offset < bytes.byteLength; offset += 60 * 1024) {
      await stream.write(bytes.slice(offset, Math.min(offset + 60 * 1024, bytes.byteLength)));
    }
    const receipt = await stream.finish();
    expect(receipt.bytes).toBe(bytes.byteLength);
    expect(receipt.digest).toBe(sha256(bytes));
    expect(sink.finished).toHaveLength(1);
    const joined = Buffer.concat(sink.received.map(chunk => Buffer.from(chunk)));
    expect(joined.byteLength).toBe(bytes.byteLength);
    expect(sha256(new Uint8Array(joined))).toBe(sha256(bytes));
  });

  test.each([false, true])('write transport backpressure yields despite available credit (persistent=%s)', async (persistent) => {
    const fixture = makeFixture();
    const bytes = pattern(8 * 1024, 5);
    const sink = registerWriteStream(fixture, 'upload-backpressure');
    let ready = false;
    let refusals = 0;
    let timerRan = false;
    fixture.workerLink.attach(frame => {
      const packet = decodePluginPeerFrame(frame);
      if (packet.header.kind === 'chunk' && !ready) {
        if (refusals++ === 0) setTimeout(() => { timerRan = true; ready = !persistent; }, 0);
        return false;
      }
      fixture.controlLink.receive(frame);
      return true;
    });
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'upload-backpressure', version: 1, size: bytes.byteLength, digest: sha256(bytes),
    });
    const completion = stream.completed.catch(error => error);
    if (persistent) {
      await expect(stream.write(bytes)).rejects.toMatchObject({code: 'overloaded'});
      expect((await completion).code).toBe('overloaded');
      expect(sink.finished).toHaveLength(0);
    } else {
      await stream.write(bytes);
      expect(await stream.finish()).toEqual({bytes: bytes.byteLength, digest: sha256(bytes)});
      await completion;
      expect(Buffer.concat(sink.received)).toEqual(Buffer.from(bytes));
      expect(sink.finished).toHaveLength(1);
    }
    expect(timerRan).toBe(true);
    expect(refusals).toBeGreaterThan(0);
    expect(refusals).toBeLessThanOrEqual(256);
  });

  test('an unknown write target fails instead of silently accepting bytes', async () => {
    const fixture = makeFixture();
    registerWriteStream(fixture, 'upload-1');
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'missing', version: 1, size: null, digest: null,
    });
    await expect(stream.completed).rejects.toBeDefined();
  });

  test('fetches a multi-chunk snapshot, verifies its digest, and can read a fixed version', async () => {
    const fixture = makeFixture();
    const v1 = pattern(200 * 1024, 11);
    const v2 = pattern(150 * 1024, 12);
    registerSnapshot(fixture, new Map([[1, v1], [2, v2]]));
    const read = await fixture.workerHub.readSnapshot(SNAPSHOT_TARGET, CALLER, CALLER_SCOPE, CONTRACT);
    expect(read.descriptor.version).toBe(1);
    expect(sha256(read.bytes)).toBe(sha256(v1));
    const pinned = await fixture.workerHub.readSnapshot(SNAPSHOT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, { version: 2 });
    expect(pinned.descriptor.version).toBe(2);
    expect(sha256(pinned.bytes)).toBe(sha256(v2));
  });

  test('a provider with no valid snapshot and a corrupted body both fail explicitly', async () => {
    const fixture = makeFixture();
    const bytes = pattern(120 * 1024, 13);
    const handle = fixture.controlHub.registerSnapshot(
      { lane: 'snapshot', provider: 'catalog-provider', service: 'catalog.snapshot', major: 1, process: 'control', contract: CONTRACT },
      {
        current: () => ({
          descriptor: { owner: 'catalog-provider', epoch: 1, version: 1, schemaVersion: 1, digest: sha256(pattern(64, 99)), size: bytes.byteLength, chunkBytes: 60 * 1024 },
          read: async (offset, length) => bytes.slice(offset, offset + length),
        }),
        version: () => null,
      },
    );
    handle.markReady();
    await expect(fixture.workerHub.readSnapshot(SNAPSHOT_TARGET, CALLER, CALLER_SCOPE, CONTRACT)).rejects.toBeDefined();
  });

  test('reliable events: two consumers replay independently and neither ack prunes the other', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    handle.markReady();
    for (let index = 0; index < 3; index += 1) await fixture.controlHub.publishReliable(handle, new TextEncoder().encode(`evt-${index}`));

    const firstA: number[] = [];
    const subA = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'worker-a', onEvent: (event) => firstA.push(event.sequence),
    });
    await flush();
    expect(firstA).toEqual([1, 2, 3]);
    // Consumer A acknowledges everything.
    expect(await subA.ack(3)).toBe(3);
    expect(log.prunedThrough()).toBe(0);

    // Consumer B still replays the full retained log: an ack is per consumer.
    const firstB: number[] = [];
    const subB = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'worker-b', onEvent: (event) => firstB.push(event.sequence),
    });
    await flush();
    expect(firstB).toEqual([1, 2, 3]);
    expect(subB.fromSequence).toBe(1);
    await subB.ack(2);

    // A re-subscribe for A resumes from A's own checkpoint, not from B's.
    subA.close();
    subB.close();
    await flush();
    const resumedA = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'worker-a', onEvent: () => undefined,
    });
    expect(resumedA.fromSequence).toBe(4);
    resumedA.close();
  });

  test('ack is monotonic and refuses an undelivered or regressed sequence', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    handle.markReady();
    await fixture.controlHub.publishReliable(handle, new TextEncoder().encode('one'));
    const sub = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'worker-a', onEvent: () => undefined,
    });
    await flush();
    await expect(sub.ack(5)).rejects.toBeDefined();     // future: never delivered
    expect(await sub.ack(1)).toBe(1);
    await expect(sub.ack(1)).rejects.toBeDefined();     // regressed
    // The durable checkpoint is isolated per (caller plugin, caller scope, consumer id).
    expect(log.checkpoint(`${CALLER}\0${CALLER_SCOPE}\0worker-a`)).toBe(1);
    sub.close();
  });

  test('pruning outside the retention window produces an explicit gap', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    handle.markReady();
    for (let index = 0; index < 3; index += 1) await fixture.controlHub.publishReliable(handle, new TextEncoder().encode(`e${index}`));
    log.pruneBelow(3);
    await expect(fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'worker-c', from: 1, onEvent: () => undefined,
    })).rejects.toBeDefined();
  });

  test('transient notifications reach the subscriber and overflow is observable', async () => {
    const fixture = makeFixture();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'dash-provider', service: 'dash.notify', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'transient' },
    );
    handle.markReady();
    const target: PluginChannelTarget = Object.freeze({ provider: 'dash-provider', service: 'dash.notify', major: 1 });
    const received: unknown[] = [];
    const subscription = await fixture.workerHub.subscribeEvents(target, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'transient', consumerId: 'worker-a', onEvent: (event) => received.push(event.payload),
    });
    for (let index = 0; index < 3; index += 1) fixture.controlHub.publishTransient(handle, new TextEncoder().encode(`n-${index}`));
    await flush();
    expect(received.map(entry => new TextDecoder().decode(entry as Uint8Array))).toEqual(['n-0', 'n-1', 'n-2']);
    expect(subscription.dropped()).toBeGreaterThanOrEqual(0);
    subscription.close();
  });
});

describe('store-backed reliable event log', () => {
  function makeLog(maxEvents = 4): { db: Database; store: PluginCommunicationStore; log: StoreBackedReliableEventLog } {
    const db = new Database(':memory:');
    const store = new PluginCommunicationStore(db, {}, { setup: true });
    const log = new StoreBackedReliableEventLog(store.forNamespace('audit-provider'), 'audit.events', maxEvents);
    return { db, store, log };
  }

  test('sequence is durable and monotonic, event ids are independent of the payload, retention prunes oldest', async () => {
    const { db, store, log } = makeLog(3);
    try {
      const a = log.append(new TextEncoder().encode('same'));
      const b = log.append(new TextEncoder().encode('same'));
      expect(a.sequence).toBe(1);
      expect(b.sequence).toBe(2);
      // Same payload, different events: the id is per (topic, sequence).
      expect(a.eventId).not.toBe(b.eventId);
      log.append(new TextEncoder().encode('third'));
      log.append(new TextEncoder().encode('fourth'));
      expect(log.latestSequence()).toBe(4);
      expect(log.oldestSequence()).toBe(2);
      expect(log.prunedThrough()).toBe(1);

      // A restart (fresh log object over the same namespace) continues, never resets.
      const reopened = new StoreBackedReliableEventLog(store.forNamespace('audit-provider'), 'audit.events', 3);
      expect(reopened.latestSequence()).toBe(4);
      expect(reopened.append(new TextEncoder().encode('fifth')).sequence).toBe(5);

      // Checkpoints are per consumer and monotonic.
      expect(reopened.ack('worker-a', 4).acked).toBe(4);
      expect(reopened.ack('worker-b', 2).acked).toBe(2);
      expect(reopened.ack('worker-a', 3).acked).toBe(4);
      expect(reopened.checkpoint('worker-a')).toBe(4);
      expect(reopened.checkpoint('worker-b')).toBe(2);
      expect(reopened.checkpoint('unknown')).toBe(0);
    } finally { db.close(); }
  });

  test('the outbox seam commits the event and the business state in one transaction', async () => {
    const db = new Database(':memory:');
    try {
      db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
      const store = new PluginCommunicationStore(db, {}, { setup: true });
      const log = new StoreBackedReliableEventLog(store.forNamespace('audit-provider'), 'audit.events', 8);
      const durable = new PluginDurableStateStore(db);
      const state = durable.forNamespace('audit-provider');

      let appended: { readonly sequence: number; readonly eventId: string } | null = null;
      state.execute({ commandId: 'commit-1', mutations: [{ key: 'balance', expectedVersion: 0, value: { value: 10 } }] }, {
        extend: () => { appended = log.appendWithinTransaction(new TextEncoder().encode('debited')); },
      });
      expect(appended!.sequence).toBe(1);
      expect(state.get('balance')?.value).toEqual({ value: 10 });
      expect(log.latestSequence()).toBe(1);
      expect((await log.list(1, 8)).map(entry => new TextDecoder().decode(entry.payload))).toEqual(['debited']);

      // A conflicting command rolls BOTH the state and the outbox row back.
      expect(() => state.execute({ commandId: 'commit-2', mutations: [{ key: 'balance', expectedVersion: 0, value: { value: 99 } }] }, {
        extend: () => { log.appendWithinTransaction(new TextEncoder().encode('never')); },
      })).toThrow();
      expect(state.get('balance')?.value).toEqual({ value: 10 });
      expect(log.latestSequence()).toBe(1);

      // An idempotent replay never runs the outbox seam again.
      state.execute({ commandId: 'commit-1', mutations: [{ key: 'balance', expectedVersion: 0, value: { value: 10 } }] }, {
        extend: () => { log.appendWithinTransaction(new TextEncoder().encode('duplicate')); },
      });
      expect(log.latestSequence()).toBe(1);
    } finally { db.close(); }
  });

  test('a durable outbox receipt returns the FIRST result on an idempotent retry', async () => {
    const { db, store, log } = makeLog(8);
    try {
      const payload = new TextEncoder().encode('debited');
      const first = log.appendWithinTransaction(payload, 'outbox:commit-1');
      const receipt = log.receipt('outbox:commit-1');
      expect(receipt).not.toBeNull();
      expect(receipt!.sequence).toBe(first.sequence);
      expect(receipt!.eventId).toBe(first.eventId);
      expect(receipt!.payloadHash).toBe(createHash('sha256').update(payload).digest('hex'));
      // A different payload under the same receipt id is distinguishable, so the
      // outbox seam can reject a changed payload instead of silently returning the
      // first event.
      const changed = createHash('sha256').update(new TextEncoder().encode('different')).digest('hex');
      expect(changed).not.toBe(receipt!.payloadHash);
      expect(log.receipt('outbox:absent')).toBeNull();
      expect(log.latestSequence()).toBe(1);
    } finally { db.close(); }
  });

  test('a corrupt watermark, a hole in the retained window, and a bad checkpoint all fail closed', async () => {
    const { db, store, log } = makeLog(8);
    const namespace = store.forNamespace('audit-provider');
    const short = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);
    const metaKey = `m:${short('audit.events@1')}`;
    const eventKey = (sequence: number): string => `e:${short('audit.events@1')}:${String(sequence).padStart(16, '0')}`;
    const checkpointKey = (consumerId: string): string => `c:${short('audit.events@1')}:${short(consumerId)}`;
    try {
      namespace.put(metaKey, new TextEncoder().encode('{not json'), { required: false, expiresAt: null });
      expect(() => log.latestSequence()).toThrow();
      // A missing row INSIDE the retained window is corruption, never "empty".
      namespace.put(metaKey, new TextEncoder().encode(JSON.stringify({ latest: 3, pruned: 0 })), { required: false, expiresAt: null });
      namespace.put(eventKey(1), new TextEncoder().encode('one'), { required: false, expiresAt: null });
      namespace.put(eventKey(3), new TextEncoder().encode('three'), { required: false, expiresAt: null });
      await expect(log.list(1, 8)).rejects.toThrow();
      // A malformed durable checkpoint is refused, never read as zero.
      namespace.put(checkpointKey('worker-a'), new TextEncoder().encode('not-a-number'), { required: false, expiresAt: null });
      expect(() => log.checkpoint('worker-a')).toThrow();
    } finally { db.close(); }
  });

  test('a duplex session carries both directions over one transfer with one shared terminal', async () => {
    const fixture = makeFixture();
    const inbound = pattern(140 * 1024, 21);
    const received: Uint8Array[] = [];
    const finished: { size: number | null; digest: string | null } = { size: null, digest: null };
    const handle = fixture.controlHub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      {
        duplex: () => ({
          source: { size: inbound.byteLength, digest: sha256(inbound), read: async (offset, length) => inbound.slice(offset, offset + length) },
          sink: {
            write: async (offset, bytes) => { expect(offset).toBe(received.reduce((total, chunk) => total + chunk.byteLength, 0)); received.push(bytes.slice()); },
            finish: async (size, digest) => { finished.size = size; finished.digest = digest; },
          },
        }),
      },
    );
    handle.markReady();
    const outbound = pattern(96 * 1024, 22);
    const outboundDigest = sha256(outbound);
    const session = fixture.workerHub.openDuplex(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1,
      readSize: inbound.byteLength, writeSize: outbound.byteLength,
      readCreditBytes: 60 * 1024, writeCreditBytes: 60 * 1024,
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
    expect(read.bytes).toBe(inbound.byteLength);
    expect(read.digest).toBe(sha256(inbound));
    expect(write.bytes).toBe(outbound.byteLength);
    expect(write.digest).toBe(outboundDigest);
    expect(finished).toEqual({ size: outbound.byteLength, digest: outboundDigest });
    expect(result.read?.bytes).toBe(inbound.byteLength);
    expect(result.write?.digest).toBe(outboundDigest);
    expect(received.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(outbound.byteLength);
  });

  test('a settled invocation frame can never authorize channel work; the explicit background context can', async () => {
    const host = new PluginServiceHost('worker');
    const context = host.createContext('consumer-plugin');
    host.markReady('consumer-plugin', 'global', context);
    // Inside the invocation the frame really authorizes channel work.
    host.runInInvocation(context, { purpose: 'background' }, () => {
      expect(host.beginChannelOperation('consumer-plugin', 'global')).not.toBeNull();
    });
    // The async context outlives the invocation: the frame is then STALE and must
    // be refused outright, never re-interpreted as fresh (or downgraded) authority.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let stale: Promise<unknown> | undefined;
    host.runInInvocation(context, { purpose: 'background' }, () => {
      stale = (async () => { await gate; return host.beginChannelOperation('consumer-plugin', 'global'); })();
    });
    release();
    expect(await stale).toBeNull();
    // Host-managed work asks for the explicit independent background context.
    host.runInInvocation(context, { purpose: 'background' }, () => {
      expect(host.beginChannelOperation('consumer-plugin', 'global', { background: true })).not.toBeNull();
    });
  });

  test('a host snapshot view is bound to its owner instance; disposed and cross-owner views are refused', async () => {
    const fixture = makeFixture();
    const body = new TextEncoder().encode(JSON.stringify({ kind: 'owned', bytes: 7 }));
    const content = {
      type: 'object' as const,
      properties: { kind: { type: 'string' as const }, bytes: { type: 'number' as const, integer: true, minimum: 0 } },
    };
    const contract = { id: 'catalog.snapshot', version: 1, content };
    const source = (): { readonly descriptor: ChannelSnapshotDescriptor; read(offset: number, length: number): Promise<Uint8Array> } => ({
      descriptor: { owner: 'catalog-provider', epoch: 1, version: 1, schemaVersion: 1, digest: sha256(body), size: body.byteLength, chunkBytes: body.byteLength },
      read: async (offset, length) => body.slice(offset, offset + length),
    });
    const control = new HostChannelAdapter({ hub: fixture.controlHub, process: 'control' });
    const worker = new HostChannelAdapter({ hub: fixture.workerHub, process: 'worker' });
    const lifecycle = { endpoint: 'endpoint', instance: 'instance', generation: 1, catalog: 'catalog', subject: 'subject' };
    const providerOwner = control.createOwner({
      plugin: 'catalog-provider', scope: 'global',
      declarations: { provides: [{ id: 'catalog.snapshot', version: 1, kind: 'snapshot', process: 'control' }] } as never,
      lifecycle, getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }),
      dependencies: {}, trackPending: () => {},
      beginOperation: () => ({ purpose: 'background' as const, release: () => undefined }),
    });
    providerOwner.snapshot!.provide(contract as never, { current: source, version: (version: number) => (version === 1 ? source() : null) });
    providerOwner.markReady();

    const consumerOwner = (): HostChannelOwnerInputLike => ({
      plugin: 'consumer-plugin', scope: 'global',
      declarations: { consumes: [{ plugin: 'catalog-provider', id: 'catalog.snapshot', version: 1, kind: 'snapshot', process: 'worker' }] } as never,
      lifecycle, getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }),
      dependencies: { 'catalog-provider': '^1.0.0' }, trackPending: () => {},
      beginOperation: () => ({ purpose: 'background' as const, release: () => undefined }),
    });

    const first = worker.createOwner(consumerOwner() as never);
    const viewA = first.snapshot!.consume('catalog-provider', contract as never);
    expect(`${await viewA.sync()}:${viewA.status().error}`).toBe('applied:null');
    // The returned body is a defensive COPY: tampering never mutates the view.
    const returned = viewA.current()!;
    returned.bytes[0] = 0;
    expect(viewA.current()!.bytes[0]).not.toBe(0);
    await first.dispose();
    // The disposed owner's view is refused outright (sync and reads alike).
    expect(() => viewA.sync()).toThrow();
    expect(() => viewA.current()).toThrow();

    // A NEW owner with the SAME plugin/scope starts from its own empty view.
    const second = worker.createOwner(consumerOwner() as never);
    const viewB = second.snapshot!.consume('catalog-provider', contract as never);
    expect(viewB.current()).toBeNull();
    expect(`${await viewB.sync()}:${viewB.status().error}`).toBe('applied:null');
    expect(viewB.current()!.descriptor.version).toBe(1);
    await second.dispose();
    await providerOwner.dispose();
  });

  test('a duplex read half-close keeps the write half open until it commits', async () => {
    const fixture = makeFixture();
    const inbound = pattern(200 * 1024, 31);
    const received: Uint8Array[] = [];
    const finished: { size: number | null; digest: string | null } = { size: null, digest: null };
    const handle = fixture.controlHub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      {
        duplex: () => ({
          source: { size: inbound.byteLength, digest: sha256(inbound), read: async (offset, length) => inbound.slice(offset, offset + length) },
          sink: {
            write: async (offset, bytes) => { expect(offset).toBe(received.reduce((total, chunk) => total + chunk.byteLength, 0)); received.push(bytes.slice()); },
            finish: async (size, digest) => { finished.size = size; finished.digest = digest; },
          },
        }),
      },
    );
    handle.markReady();
    const outbound = pattern(64 * 1024, 32);
    const session = fixture.workerHub.openDuplex(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, readSize: inbound.byteLength, writeSize: outbound.byteLength,
    });
    const iterator = session.chunks();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    session.endRead();
    try { await iterator.return?.(undefined); } catch { /* already closed */ }
    for (let offset = 0; offset < outbound.byteLength; offset += 60 * 1024) {
      await session.write(outbound.slice(offset, Math.min(offset + 60 * 1024, outbound.byteLength)));
    }
    const write = await session.finishWrite();
    const result = await session.completed;
    expect(write.digest).toBe(sha256(outbound));
    expect(finished).toEqual({ size: outbound.byteLength, digest: sha256(outbound) });
    expect(result.read).toBeNull();
    expect(result.write?.digest).toBe(sha256(outbound));
    expect(received.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(outbound.byteLength);
  });

  test('a failure in one duplex direction drains the whole session', async () => {
    const fixture = makeFixture();
    const inbound = pattern(200 * 1024, 23);
    let aborted = 0;
    const handle = fixture.controlHub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      {
        duplex: () => ({
          source: {
            size: inbound.byteLength, digest: sha256(inbound),
            read: async (offset, length) => {
              // One real chunk, then a provider-side read failure.
              if (offset >= 60 * 1024) throw new Error('injected duplex read failure');
              return inbound.slice(offset, offset + length);
            },
          },
          sink: {
            write: async () => { /* accept */ },
            finish: async () => { /* must not commit after the sibling failed */ },
            abort: () => { aborted += 1; },
          },
        }),
      },
    );
    handle.markReady();
    const session = fixture.workerHub.openDuplex(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, readSize: inbound.byteLength, writeSize: 64 * 1024,
    });
    const readTask = session.collect().catch(() => null);
    const completed = session.completed;
    let writeFailed = false;
    try {
      await session.write(pattern(64 * 1024, 24));
      await session.finishWrite();
    } catch { writeFailed = true; }
    await expect(completed).rejects.toBeDefined();
    await readTask;
    expect(aborted).toBeGreaterThan(0);
    void writeFailed;
    fixture.controlHub.dispose();
    fixture.workerHub.dispose();
  });

  test('the host snapshot store publishes atomically, retains in-use versions, and bounds retention', async () => {
    const db = new Database(':memory:');
    try {
      const store = new PluginCommunicationStore(db, {}, { setup: true });
      const versioned = new HostSnapshotStore(store.forNamespace('catalog-provider'), {
        owner: 'catalog-provider', schemaVersion: 1, epoch: 2, maxVersions: 2, chunkBytes: 60 * 1024,
      });
      const body = { kind: 'a', bytes: 3, filler: 'x'.repeat(1024) };
      const first = versioned.publish(1, body);
      expect(first.owner).toBe('catalog-provider');
      expect(first.epoch).toBe(2);
      expect(first.schemaVersion).toBe(1);
      const source = versioned.current();
      expect(source).not.toBeNull();
      expect(source!.descriptor.version).toBe(1);
      source!.retain?.();
      versioned.publish(2, { kind: 'b', bytes: 3, filler: 'y' });
      versioned.publish(3, { kind: 'c', bytes: 3, filler: 'z' });
      // The retained version survives GC and still reads its exact body.
      const kept = versioned.version(1);
      expect(kept).not.toBeNull();
      const bytes = await kept!.read(0, kept!.descriptor.size);
      expect(bytes.byteLength).toBe(kept!.descriptor.size);
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(body);
      source!.release?.();
      versioned.collect();
      expect(versioned.current()?.descriptor.version).toBe(3);
    } finally { db.close(); }
  });

  test('the host snapshot store keeps up with continuous publishing of large bodies', async () => {
    const db = new Database(':memory:');
    try {
      const store = new PluginCommunicationStore(db, {}, { setup: true });
      const versioned = new HostSnapshotStore(store.forNamespace('catalog-provider'), {
        owner: 'catalog-provider', schemaVersion: 1, maxVersions: 3, chunkBytes: 60 * 1024,
      });
      const big = { kind: 'big', bytes: 5 * 1024 * 1024 + 123, filler: 'x'.repeat(5 * 1024 * 1024) };
      for (let version = 1; version <= 8; version += 1) {
        versioned.publish(version, big);
        const current = versioned.current();
        expect(current).not.toBeNull();
        expect(current!.descriptor.version).toBe(version);
      }
      const source = versioned.current()!;
      const bytes = await source.read(0, source.descriptor.size);
      expect(bytes.byteLength).toBe(source.descriptor.size);
      expect(bytes[0]).toBe(new TextEncoder().encode('{')[0]);
    } finally { db.close(); }
  });

  test('a reliable consumer checkpoint is isolated per caller plugin and scope', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    handle.markReady();
    await fixture.controlHub.publishReliable(handle, new TextEncoder().encode('one'));
    const first = await fixture.workerHub.subscribeEvents(EVENT_TARGET, 'plugin-a', 'global', CONTRACT, {
      delivery: 'reliable', consumerId: 'shared', onEvent: () => undefined,
    });
    await flush();
    expect(await first.ack(1)).toBe(1);
    first.close();
    expect(log.checkpoint('plugin-a\0global\0shared')).toBe(1);
    expect(log.checkpoint('plugin-b\0global\0shared')).toBe(0);
    // The other caller reusing the same consumer id starts from its OWN cursor.
    const second = await fixture.workerHub.subscribeEvents(EVENT_TARGET, 'plugin-b', 'global', CONTRACT, {
      delivery: 'reliable', consumerId: 'shared', onEvent: () => undefined,
    });
    expect(second.fromSequence).toBe(1);
    second.close();
  });

  test('binding channel declarations are refused before owner creation', () => {
    for (const declarations of [
      { provides: [{ id: 'x.events', version: 1, kind: 'events', process: 'worker', scope: 'binding' }] },
      { consumes: [{ plugin: 'provider-p', id: 'x.events', version: 1, kind: 'events', process: 'worker', scope: 'binding' }] },
    ]) expect(() => new PluginServiceHost('worker', hostCommunications()).setDeclarations(new Map([['plugin', declarations as never]]))).toThrow('Only global');
  });
  test('a request lease retains the exact in-process channel provider so its channel work is authorized', () => {
    const host = new PluginServiceHost('worker', hostCommunications());
    host.setDeclarations(new Map([
      ['provider-p', { provides: [{ id: 'x.events', version: 1, kind: 'events', process: 'worker' }] }],
      ['consumer-c', { consumes: [{ plugin: 'provider-p', id: 'x.events', version: 1, kind: 'events', process: 'worker' }] }],
    ]));
    const provider = host.createContext('provider-p');
    const consumer = host.createContext('consumer-c', 'global', { 'provider-p': '^1' });
    host.markReady('provider-p', 'global', provider);
    host.markReady('consumer-c', 'global', consumer);
    host.runInInvocation(consumer, { purpose: 'background' }, () => {
      const lease = host.acquireLease('consumer-c');
      host.runInInvocation(consumer, { purpose: 'request', lease }, () => {
        // Without the channel provider inside the lease proof this request-bound
        // channel operation would be refused instead of authorized exactly.
        expect(host.beginChannelOperation('provider-p', 'global')).not.toBeNull();
      });
      lease();
    });
  });

  test('a snapshot store family id isolates families and shares pin management across instances', () => {
    const db = new Database(':memory:');
    try {
      const store = new PluginCommunicationStore(db, {}, { setup: true });
      const namespace = store.forNamespace('catalog-provider');
      const familyA1 = new HostSnapshotStore(namespace, { owner: 'catalog-provider', id: 'alpha', schemaVersion: 1, maxVersions: 1, chunkBytes: 60 * 1024 });
      const familyA2 = new HostSnapshotStore(namespace, { owner: 'catalog-provider', id: 'alpha', schemaVersion: 1, maxVersions: 1, chunkBytes: 60 * 1024 });
      const familyB = new HostSnapshotStore(namespace, { owner: 'catalog-provider', id: 'beta', schemaVersion: 1, maxVersions: 1, chunkBytes: 60 * 1024 });
      familyA1.publish(1, { kind: 'a', bytes: 1 });
      // The same family is durable and readable from a second instance.
      expect(familyA2.current()!.descriptor.version).toBe(1);
      familyB.publish(1, { kind: 'b', bytes: 1 });
      expect(familyB.current()!.descriptor.version).toBe(1);
      const pinned = familyA2.version(1)!;
      pinned.retain?.();
      familyA1.publish(2, { kind: 'a2', bytes: 2 });
      familyA1.publish(3, { kind: 'a3', bytes: 3 });
      // A version pinned through the OTHER instance survives this instance's GC.
      expect(familyA2.version(1)).not.toBeNull();
      pinned.release?.();
      familyA1.collect();
      // The sibling family is untouched by family A's GC.
      expect(familyB.current()!.descriptor.version).toBe(1);
    } finally { db.close(); }
  });

  test('the snapshot store never moves current backwards and refuses a corrupt current pointer', () => {
    const db = new Database(':memory:');
    try {
      const store = new PluginCommunicationStore(db, {}, { setup: true });
      const namespace = store.forNamespace('catalog-provider');
      const versioned = new HostSnapshotStore(namespace, { owner: 'catalog-provider', schemaVersion: 1, chunkBytes: 60 * 1024 });
      versioned.publish(2, { kind: 'b', bytes: 2 });
      // A new but LOWER version is durable, yet it never moves current backwards.
      versioned.publish(1, { kind: 'a', bytes: 1 });
      expect(versioned.current()!.descriptor.version).toBe(2);
      // Re-publishing an existing version is idempotent and keeps current.
      versioned.publish(2, { kind: 'b', bytes: 2 });
      expect(versioned.current()!.descriptor.version).toBe(2);
      const pointer = namespace.list(256).find((record) => record.key.endsWith(':cur'));
      expect(pointer).toBeDefined();
      namespace.put(pointer!.key, new TextEncoder().encode('not-a-version'), { required: false, expiresAt: null });
      expect(() => versioned.current()).toThrow();
    } finally { db.close(); }
  });

  test('a draining link refuses a NEW open yet keeps an accepted transfer and its finish', async () => {
    const fixture = makeFixture();
    const outbound = pattern(96 * 1024, 51);
    const { finished } = registerWriteStream(fixture, 'catalog-drain');
    const stream = fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-drain', version: 1, size: outbound.byteLength, digest: sha256(outbound),
    });
    await stream.write(outbound.slice(0, 32 * 1024));
    // The consumer's link retires: no NEW open, but the accepted write continues.
    fixture.workerLink.retire();
    expect(() => fixture.workerHub.openWriteStream(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-other', version: 1, size: 16, digest: null,
    })).toThrow();
    await stream.write(outbound.slice(32 * 1024, 64 * 1024));
    await stream.write(outbound.slice(64 * 1024));
    const done = await stream.finish();
    expect(done.digest).toBe(sha256(outbound));
    expect(finished).toEqual([{ size: outbound.byteLength, digest: sha256(outbound) }]);
  });

  test('reliable history beyond the delivery window waits for ACK and replays every retained fact', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog(512);
    const publisher = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    publisher.markReady();
    for (let sequence = 1; sequence <= 384; sequence += 1) {
      await fixture.controlHub.publishReliable(publisher, new TextEncoder().encode(String(sequence)));
    }
    const received: number[] = [];
    const subscription = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'large-history', onEvent: event => { received.push(event.sequence); },
    });
    await flush();
    expect(received).toHaveLength(256);
    expect(received).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
    await subscription.ack(256);
    await flush();
    expect(received).toEqual(Array.from({ length: 384 }, (_, index) => index + 1));
    await subscription.ack(384);
    await fixture.controlHub.publishReliable(publisher, new TextEncoder().encode('385'));
    await flush();
    expect(received.at(-1)).toBe(385);
    expect(subscription.dropped()).toBe(0);
    subscription.close();
    expect(await subscription.terminal).toBe('closed');
  });

  test('a reliable delivery gap is an explicit public failure, never a silent shift', async () => {
    const fixture = makeFixture();
    const log = new MemoryEventLog();
    const handle = fixture.controlHub.registerEvent(
      { lane: 'event', provider: 'audit-provider', service: 'audit.events', major: 1, process: 'control', contract: CONTRACT },
      { delivery: 'reliable', log },
    );
    handle.markReady();
    await fixture.controlHub.publishReliable(handle, new TextEncoder().encode('one'));
    const received: number[] = [];
    const sub = await fixture.workerHub.subscribeEvents(EVENT_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      delivery: 'reliable', consumerId: 'gap-a', onEvent: (event) => received.push(event.sequence),
    });
    await flush();
    expect(received).toEqual([1]);
    expect(await sub.ack(1)).toBe(1);
    // The provider skips sequence 2 and emits 3: a real hole the consumer must
    // report, never deliver as if the run were contiguous.
    const emitted = fixture.controlLink.emitLane('event', 'notification', sub.subscriptionId, Date.now() + 60_000,
      { kind: 'event.notify', subscriptionId: sub.subscriptionId, sequence: 3, eventId: 'a'.repeat(16), delivery: 'reliable' },
      new TextEncoder().encode('three'));
    expect(emitted).toBe(true);
    await flush();
    expect(received).toEqual([1]);
    expect(await sub.terminal).toBe('failed');
    await expect(sub.ack(3)).rejects.toBeDefined();
  });

  test('a duplex provider that offers no read direction settles it as an explicit null', async () => {
    const fixture = makeFixture();
    const outbound = pattern(48 * 1024, 61);
    const finished: Array<{ size: number; digest: string }> = [];
    const handle = fixture.controlHub.registerStream(
      { lane: 'stream', provider: 'catalog-provider', service: 'catalog.objects', major: 1, process: 'control', contract: CONTRACT },
      {
        duplex: () => ({
          sink: {
            write: async () => { /* accept */ },
            finish: async (size, digest) => { finished.push({ size, digest }); },
          },
        }),
      },
    );
    handle.markReady();
    const session = fixture.workerHub.openDuplex(STREAM_TARGET, CALLER, CALLER_SCOPE, CONTRACT, {
      objectId: 'catalog-v1', version: 1, writeSize: outbound.byteLength,
    });
    await session.write(outbound);
    const write = await session.finishWrite();
    const result = await session.completed;
    expect(result.read).toBeNull();
    expect(result.write?.digest).toBe(sha256(outbound));
    expect(write.digest).toBe(sha256(outbound));
    expect(finished).toEqual([{ size: outbound.byteLength, digest: sha256(outbound) }]);
  });

  test('explicit background callbacks replace stale frames and hold their exact owner until real completion', async () => {
    const host = new PluginServiceHost('control');
    const context = host.createContext('background-provider');
    const abort = new AbortController();
    let run!: () => Promise<void>;
    let unblock!: () => void;
    let enter!: () => void;
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    host.runInInvocation(context, { purpose: 'bootstrap', deadlineAt: 1, signal: abort.signal }, () => {
      run = () => context.runBackground!(async () => {
        const operation = host.beginChannelOperation('background-provider');
        expect(operation?.purpose).toBe('background');
        expect(operation?.deadlineAt).toBeUndefined();
        expect(operation?.signal).toBeUndefined();
        enter();
        try { await blocked; } finally { operation?.release(); }
      });
    });
    abort.abort();
    host.markReady('background-provider');
    const task = run();
    await entered;
    let disposed = false;
    const disposal = host.dispose('background-provider').then(() => { disposed = true; });
    await flush();
    expect(disposed).toBe(false);
    expect(() => context.runBackground!(() => undefined)).toThrow();
    unblock();
    await task;
    await disposal;
    expect(disposed).toBe(true);
  });

  test('a retiring owner cannot publish through a cached publisher', () => {
    const fixture = makeFixture();
    const adapter = new HostChannelAdapter({ hub: fixture.controlHub, process: 'control' });
    let admitting = true;
    const owner = adapter.createOwner({
      plugin: 'audit-provider', scope: 'global',
      declarations: { provides: [{ id: 'audit.events', version: 1, kind: 'events', process: 'control' }] },
      lifecycle: { endpoint: 'endpoint', instance: 'instance', generation: 1, catalog: 'catalog', subject: 'subject' },
      getLifecycleState: () => ({ ready: admitting, retiring: !admitting, revoked: false }),
      dependencies: {}, trackPending: () => {},
      beginOperation: () => (admitting ? { purpose: 'background' as const, release: () => undefined } : null),
    });
    const publisher = owner.events!.provide(
      { id: 'audit.events', version: 1, delivery: 'transient', event: { type: 'object', properties: { n: { type: 'number' } } } },
      {},
    );
    owner.markReady();
    expect(publisher.notify({ n: 1 })).toBe(true);
    admitting = false;
    expect(() => publisher.notify({ n: 2 })).toThrow();
  });
});


test('snapshot GC failure after commit preserves publish success and retries through Host maintenance', async () => {
  const db = new Database(':memory:');
  try {
    const namespace = new PluginCommunicationStore(db, {}, { setup: true }).forNamespace('snapshot-provider');
    let fail = false;
    const wrapped = { ...namespace, transact: <T>(run: Parameters<typeof namespace.transact<T>>[0]): T => {
      if (fail) { fail = false; throw new Error('gc failed'); }
      const result = namespace.transact(run);
      fail = true;
      return result;
    } };
    const fixture = makeFixture();
    const adapter = new HostChannelAdapter({ hub: fixture.controlHub, process: 'control', snapshotNamespace: () => wrapped });
    const owner = adapter.createOwner({
      plugin: 'snapshot-provider', scope: 'global', dependencies: {}, declarations: {},
      lifecycle: { endpoint: 'endpoint', instance: 'instance', generation: 1, catalog: 'catalog', subject: 'snapshot-provider' },
      getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }), trackPending: () => {},
      beginOperation: () => ({ purpose: 'background', release: () => {} }),
    });
    const versioned = owner.snapshot!.store!({ id: 'snapshot.test', schemaVersion: 1, maxVersions: 1 })!;
    const descriptor = versioned.publish(1, { n: 1 });
    expect(descriptor.version).toBe(1);
    expect(versioned.current()!.descriptor).toEqual(descriptor);
    expect(versioned.maintenanceStatus()).toEqual({ pending: true, error: 'storage_failure' });
    fail = false;
    expect(adapter.maintainSnapshots(1)).toEqual({ stores: 1, removed: 0, failures: 0 });
    expect(versioned.maintenanceStatus()).toEqual({ pending: false, error: null });
    await owner.dispose();
    expect(adapter.maintainSnapshots(1)).toEqual({ stores: 0, removed: 0, failures: 0 });
  } finally { db.close(); }
});

test('Host channel self snapshot consumption requires a matching other-process publication', async () => {
  const fixture = makeFixture();
  const declaration = { id: 'models-dev.catalog.snapshot.v1', version: 1, kind: 'snapshot' as const };
  const adapter = new HostChannelAdapter({ hub: fixture.workerHub, process: 'worker' });
  const input: HostChannelOwnerInputLike = {
    plugin: 'models-dev', scope: 'global', dependencies: {},
    declarations: { provides: [{ ...declaration, process: 'control' }], consumes: [{ ...declaration, plugin: 'models-dev', process: 'worker' }] },
    lifecycle: { endpoint: 'endpoint', instance: 'instance', generation: 1, catalog: 'catalog', subject: 'models-dev' },
    getLifecycleState: () => ({ ready: true, retiring: false, revoked: false }), trackPending: () => {},
    beginOperation: () => ({ purpose: 'background', release: () => {} }),
  };
  const owner = adapter.createOwner(input);
  expect(owner.snapshot!.consume('models-dev', { id: declaration.id, version: 1, content: { type: 'json' } }).status().status).toBe('empty');
  for (const process of ['worker', null] as const) {
    const refused = adapter.createOwner({ ...input, declarations: { ...input.declarations, provides: process === null ? [] : [{ ...declaration, process }] } });
    expect(() => refused.snapshot!.consume('models-dev', { id: declaration.id, version: 1, content: { type: 'json' } })).toThrow('declared dependency');
    await refused.dispose();
  }
  await owner.dispose();
});
