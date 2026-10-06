import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommunicationStoreError, PluginCommunicationStore } from '../../src/plugin-services/persistence';
import type { PluginCommunicationLimits } from '../../src/plugin-services/persistence';

const OVERHEAD = 10;
const MAX_ID = 128;
const FP = 64;

/** Mirrors the store's billing model so tests assert the real UTF-8 charge. */
const text = (value: string): number => Buffer.byteLength(value, 'utf8');
const rowBase = (namespace: string): number => OVERHEAD + text(namespace);
const reservationCharge = (namespace: string, id: string, capacity: number): number =>
  2 * rowBase(namespace) + text(id) + 2 * MAX_ID + FP + capacity;
const recordCharge = (namespace: string, key: string, data: number): number => rowBase(namespace) + text(key) + data;
const receiptCharge = (namespace: string, id: string, key: string): number => rowBase(namespace) + text(id) + text(key) + FP;
const tombstoneCharge = (namespace: string, id: string): number => rowBase(namespace) + text(id);

const TIGHT = {
  globalBudgetBytes: 64_000, globalRequiredReserveBytes: 8_000, globalMaxRows: 400, globalRequiredRowReserve: 100,
  namespaceQuotaBytes: 16_000, requiredReserveBytes: 4_000, maxRecordsPerNamespace: 40, requiredRowReserve: 10,
  maxRecordBytes: 4_000, entryOverheadBytes: OVERHEAD,
} satisfies PluginCommunicationLimits;

const NARROW = {
  globalBudgetBytes: 8_000, globalRequiredReserveBytes: 1_000, globalMaxRows: 400, globalRequiredRowReserve: 100,
  namespaceQuotaBytes: 2_000, requiredReserveBytes: 500, maxRecordsPerNamespace: 40, requiredRowReserve: 10,
  maxRecordBytes: 1_500, entryOverheadBytes: OVERHEAD,
} satisfies PluginCommunicationLimits;

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try { db.close(); } catch { /* a test may have closed it already */ }
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function memoryStore(limits: PluginCommunicationLimits = TIGHT): { db: Database; store: PluginCommunicationStore } {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: new PluginCommunicationStore(db, limits) };
}

function fileStore(limits: PluginCommunicationLimits): { db: Database; store: PluginCommunicationStore; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-comm-'));
  directories.push(directory);
  const file = path.join(directory, 'comm.db');
  const db = new Database(file, { create: true, readwrite: true });
  databases.push(db);
  return { db, store: new PluginCommunicationStore(db, limits), file };
}

function codeOf(run: () => unknown): string | undefined {
  try { run(); } catch (error) { return error instanceof CommunicationStoreError ? error.code : undefined; }
  return undefined;
}

describe('PluginCommunicationStore', () => {
  test('isolates namespaces, freezes the capability, hides the database, and copies payloads', () => {
    const { store } = memoryStore();
    const alpha = store.forNamespace('alpha');
    const beta = store.forNamespace('beta');
    expect(Object.isFrozen(alpha)).toBe(true);
    expect('db' in alpha).toBe(false);
    expect(alpha.namespace).toBe('alpha');

    const payload = new Uint8Array([1, 2, 3]);
    alpha.put('k', payload, { required: false });
    payload[0] = 9;
    expect(Array.from(alpha.get('k')!.payload)).toEqual([1, 2, 3]);
    alpha.get('k')!.payload[0] = 7;
    expect(Array.from(alpha.get('k')!.payload)).toEqual([1, 2, 3]);
    expect(beta.get('k')).toBeNull();
    expect(beta.list()).toEqual([]);
    expect(alpha.list()).toHaveLength(1);
    expect(alpha.status().usedBytes).toBe(recordCharge('alpha', 'k', 3));
    expect(beta.status().usedBytes).toBe(0);
    expect(codeOf(() => store.forNamespace('bad name'))).toBe('invalid_input');
  });

  test('distinguishes a missing key, a closed database, and corrupt rows', () => {
    const { db, store } = memoryStore();
    const ns = store.forNamespace('alpha');
    expect(ns.get('missing')).toBeNull();
    ns.put('k', new Uint8Array([1]), { required: false });
    db.run('UPDATE plugin_communication_records SET payload_bytes = payload_bytes + 1 WHERE namespace=? AND key=?', ['alpha', 'k']);
    expect(codeOf(() => ns.get('k'))).toBe('corruption');
    expect(codeOf(() => ns.list())).toBe('corruption');

    const closedDb = new Database(':memory:');
    databases.push(closedDb);
    const closed = new PluginCommunicationStore(closedDb, TIGHT).forNamespace('alpha');
    closedDb.close();
    expect(codeOf(() => closed.get('k'))).toBe('storage_failure');
  });

  test('reserves are shape-idempotent, reject conflicts, and survive a reopen', () => {
    const { db, store, file } = fileStore(TIGHT);
    const ns = store.forNamespace('alpha');
    const charge = reservationCharge('alpha', 'r1', 128);
    const r1 = ns.reserve('r1', 128, { required: true });
    expect(r1).toEqual({ id: 'r1', capacityBytes: 128, chargedBytes: charge, required: true, expiresAt: null });
    expect(ns.reserve('r1', 128, { required: true })).toEqual(r1);
    expect(codeOf(() => ns.reserve('r1', 129, { required: true }))).toBe('reservation_conflict');
    expect(codeOf(() => ns.reserve('r1', 128, { required: false }))).toBe('reservation_conflict');
    expect(codeOf(() => ns.reserve('r1', 128, { required: false, expiresAt: 1_000 }))).toBe('reservation_conflict');
    expect(codeOf(() => ns.reserve('r1', 128, { required: true, expiresAt: 1_000 }))).toBe('invalid_input');
    expect(ns.status().reservedBytes).toBe(charge);
    db.close();

    const reopenedDb = new Database(file, { create: true, readwrite: true });
    databases.push(reopenedDb);
    const reopened = new PluginCommunicationStore(reopenedDb, TIGHT).forNamespace('alpha');
    expect(reopened.status().reservedBytes).toBe(charge);
    const receipt = reopened.commit(r1, 'rkey', new Uint8Array(4));
    expect(receipt.capacityBytes).toBe(128);
    expect(receipt.chargedBytes).toBe(receiptCharge('alpha', 'r1', 'rkey'));
    expect(reopened.get('rkey')!.payload.byteLength).toBe(4);
    expect(reopened.status().reservedBytes).toBe(0);
    expect(reopened.status().usedBytes).toBe(recordCharge('alpha', 'rkey', 4) + receiptCharge('alpha', 'r1', 'rkey'));
  });

  test('commit consumes once and rejects any changed content, metadata, expiry, key, or capacity', () => {
    const { store } = memoryStore();
    const ns = store.forNamespace('alpha');
    const reservation = ns.reserve('idem', 200, { required: false });
    const first = ns.commit(reservation, 'k', new Uint8Array([1, 2, 3]), 'meta');
    const used = ns.status().usedBytes;
    const second = ns.commit(reservation, 'k', new Uint8Array([1, 2, 3]), 'meta');
    expect(second).toEqual(first);
    expect(ns.receipt('idem')).toEqual(first);
    expect(ns.status().usedBytes).toBe(used);
    expect(codeOf(() => ns.commit(reservation, 'k', new Uint8Array([1, 2, 4]), 'meta'))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit(reservation, 'k', new Uint8Array([1, 2, 3]), 'other'))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit({ ...reservation, expiresAt: 5_000 }, 'k', new Uint8Array([1, 2, 3]), 'meta'))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit(reservation, 'other', new Uint8Array([1, 2, 3]), 'meta'))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit({ ...reservation, capacityBytes: 201 }, 'k', new Uint8Array([1, 2, 3]), 'meta'))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit({ id: 'ghost', capacityBytes: 10, chargedBytes: 0, required: false, expiresAt: null }, 'g', new Uint8Array([1]))))
      .toBe('reservation_missing');
    expect(ns.get('k')!.metadata).toBe('meta');
    expect(Array.from(ns.get('k')!.payload)).toEqual([1, 2, 3]);

    const expired = ns.reserve('ttl', 64, { required: false, expiresAt: 1 });
    expect(codeOf(() => ns.commit(expired, 'ttlkey', new Uint8Array([1])))).toBe('reservation_conflict');
    expect(ns.collect(1_000, 10)).toBe(1);
    expect(ns.receipt('ttl')).toBeNull();
    expect(codeOf(() => ns.commit(expired, 'ttlkey', new Uint8Array([1])))).toBe('reservation_conflict');
    expect(codeOf(() => ns.reserve('ttl', 64, { required: false, expiresAt: 1 }))).toBe('reservation_conflict');
  });

  test('cancel is idempotent, seals the id with a tombstone, and a zero-capacity cancel never grows', () => {
    const { store } = memoryStore();
    const ns = store.forNamespace('alpha');
    expect(ns.reserve('c1', 64, { required: false }).chargedBytes).toBe(reservationCharge('alpha', 'c1', 64));
    expect(ns.cancel('c1')).toBe(true);
    expect(ns.cancel('c1')).toBe(false);
    expect(ns.status().reservedBytes).toBe(0);
    expect(ns.status().usedBytes).toBe(tombstoneCharge('alpha', 'c1'));
    expect(codeOf(() => ns.reserve('c1', 64, { required: false }))).toBe('reservation_conflict');
    expect(codeOf(() => ns.commit({ id: 'c1', capacityBytes: 64, chargedBytes: 0, required: false, expiresAt: null }, 'x', new Uint8Array([1]))))
      .toBe('reservation_conflict');

    const zero = reservationCharge('alpha', 'c0', 0);
    expect(zero).toBeGreaterThan(0);
    ns.reserve('c0', 0, { required: false });
    expect(ns.cancel('c0')).toBe(true);
    expect(ns.status().reservedBytes).toBe(0);
    expect(ns.status().usedBytes).toBe(tombstoneCharge('alpha', 'c1') + tombstoneCharge('alpha', 'c0'));

    const micro = memoryStore({
      ...TIGHT, namespaceQuotaBytes: 800, requiredReserveBytes: 300, maxRecordBytes: 700,
      globalBudgetBytes: 2_000, globalRequiredReserveBytes: 500,
    }).store.forNamespace('alpha');
    micro.reserve('z1', 0, { required: false });
    expect(micro.cancel('z1')).toBe(true);
    expect(micro.status().usedBytes + micro.status().reservedBytes).toBeLessThanOrEqual(800);
    expect(micro.status().usedBytes).toBe(tombstoneCharge('alpha', 'z1'));
  });

  test('put overwrites atomically, keeps no receipt, and protects un-acked required records', () => {
    const { db, store } = memoryStore();
    const ns = store.forNamespace('alpha');
    ns.put('ow', new Uint8Array(5), { required: false });
    expect(ns.status().usedBytes).toBe(recordCharge('alpha', 'ow', 5));
    ns.put('ow', new Uint8Array(2), { required: false });
    expect(Array.from(ns.get('ow')!.payload)).toEqual([0, 0]);
    expect(ns.status().usedBytes).toBe(recordCharge('alpha', 'ow', 2));
    expect(ns.status().recordCount).toBe(1);

    db.run("CREATE TRIGGER comm_abort BEFORE INSERT ON plugin_communication_records BEGIN SELECT RAISE(ABORT, 'injected'); END");
    try {
      expect(codeOf(() => ns.put('ow', new Uint8Array(1), { required: false }))).toBe('storage_failure');
    } finally {
      db.run('DROP TRIGGER comm_abort');
    }
    expect(Array.from(ns.get('ow')!.payload)).toEqual([0, 0]);
    expect(ns.status().usedBytes).toBe(recordCharge('alpha', 'ow', 2));

    ns.put('req', new Uint8Array(3), { required: true });
    expect(codeOf(() => ns.put('req', new Uint8Array(1), { required: true }))).toBe('record_protected');
    expect(codeOf(() => ns.put('req', new Uint8Array(1), { required: false }))).toBe('record_protected');
    const reservation = ns.reserve('rq', 10, { required: true });
    expect(codeOf(() => ns.commit(reservation, 'req', new Uint8Array(1)))).toBe('record_protected');
    expect(ns.ack('req')).toBe(true);
    expect(ns.put('req', new Uint8Array(1), { required: true }).key).toBe('req');
  });

  test('bills the real UTF-8 payload and metadata bytes and rejects oversized records', () => {
    const { store } = memoryStore();
    const ns = store.forNamespace('alpha');
    const metadata = '中é';
    const capacity = 3 + text(metadata);
    ns.commit(ns.reserve('m1', capacity, { required: false }), 'm', new Uint8Array(3), metadata);
    expect(ns.status().usedBytes).toBe(recordCharge('alpha', 'm', capacity) + receiptCharge('alpha', 'm1', 'm'));
    expect(ns.status().dataBytes).toBe(3 + text(metadata));
    expect(ns.list()[0]).toMatchObject({ key: 'm', payloadBytes: 3, metadataBytes: text(metadata) });

    expect(codeOf(() => ns.put('big', new Uint8Array(4_001), { required: false }))).toBe('quota_exceeded');
    const over = ns.reserve('m2', 4_000, { required: false });
    expect(codeOf(() => ns.commit(over, 'm2', new Uint8Array(4_001)))).toBe('quota_exceeded');
  });

  test('keeps a required reserve for bytes and reports overload when only required capacity fails', () => {
    const { store } = memoryStore(NARROW);
    const alpha = store.forNamespace('alpha');
    alpha.put('r1', new Uint8Array(1_000), { required: true });
    alpha.put('r2', new Uint8Array(900), { required: true });
    expect(codeOf(() => alpha.put('r3', new Uint8Array(100), { required: true }))).toBe('overloaded');

    const beta = store.forNamespace('beta');
    beta.put('o1', new Uint8Array(1_400), { required: false });
    expect(codeOf(() => beta.put('o2', new Uint8Array(100), { required: false }))).toBe('quota_exceeded');
  });

  test('reserves a global slice and global row slots so best-effort cannot starve required work', () => {
    const globalLimited = { ...NARROW, globalBudgetBytes: 3_000, globalRequiredReserveBytes: 1_000 };
    const { store } = memoryStore(globalLimited);
    store.forNamespace('alpha').put('a', new Uint8Array(1_400), { required: false });
    store.forNamespace('beta').put('b', new Uint8Array(500), { required: false });
    expect(codeOf(() => store.forNamespace('gamma').put('c', new Uint8Array(100), { required: false }))).toBe('quota_exceeded');
    expect(store.forNamespace('gamma').put('c', new Uint8Array(400), { required: true }).key).toBe('c');

    const rowLimited = { ...TIGHT, maxRecordsPerNamespace: 6, requiredRowReserve: 2 };
    const rows = memoryStore(rowLimited).store.forNamespace('alpha');
    const b1 = rows.reserve('b1', 0, { required: false });
    const b2 = rows.reserve('b2', 0, { required: false });
    expect(rows.status().recordCount).toBe(4);
    expect(codeOf(() => rows.reserve('b3', 0, { required: false }))).toBe('quota_exceeded');
    const q1 = rows.reserve('q1', 0, { required: true });
    expect(rows.status().recordCount).toBe(6);
    expect(codeOf(() => rows.reserve('q2', 0, { required: true }))).toBe('overloaded');
    rows.commit(b1, 'b1key', new Uint8Array());
    rows.commit(b2, 'b2key', new Uint8Array());
    rows.commit(q1, 'q1key', new Uint8Array());
    expect(rows.status().recordCount).toBe(6);
  });

  test('accepted reservations can commit at the global row ceiling despite another namespace', () => {
    const { store } = memoryStore({ ...TIGHT, globalMaxRows: 6, globalRequiredRowReserve: 2 });
    const alpha = store.forNamespace('alpha'), beta = store.forNamespace('beta');
    const a = alpha.reserve('a', 0, { required: false });
    const b = beta.reserve('b', 0, { required: false });
    const q = beta.reserve('q', 0, { required: true });
    expect(alpha.status().globalRecordCount).toBe(6);
    expect(codeOf(() => store.forNamespace('gamma').put('x', new Uint8Array(), { required: true }))).toBe('quota_exceeded');
    alpha.commit(a, 'akey', new Uint8Array());
    beta.commit(b, 'bkey', new Uint8Array());
    beta.commit(q, 'qkey', new Uint8Array());
    expect(alpha.status().globalRecordCount).toBe(6);
  });

  test('small namespace and global row limits still reserve a required slot', () => {
    const { requiredRowReserve: _ns, globalRequiredRowReserve: _global, ...limits } = TIGHT;
    const ns = memoryStore({ ...limits, maxRecordsPerNamespace: 3 }).store.forNamespace('alpha');
    ns.put('a', new Uint8Array(), { required: false });
    ns.put('b', new Uint8Array(), { required: false });
    expect(codeOf(() => ns.put('c', new Uint8Array(), { required: false }))).toBe('quota_exceeded');
    expect(ns.put('c', new Uint8Array(), { required: true }).key).toBe('c');
    const store = memoryStore({ ...limits, globalMaxRows: 3 }).store;
    store.forNamespace('a').put('k', new Uint8Array(), { required: false });
    store.forNamespace('b').put('k', new Uint8Array(), { required: false });
    expect(codeOf(() => store.forNamespace('c').put('k', new Uint8Array(), { required: false }))).toBe('quota_exceeded');
    expect(store.forNamespace('c').put('k', new Uint8Array(), { required: true }).key).toBe('k');
    expect(codeOf(() => memoryStore({ ...limits, maxRecordsPerNamespace: 1 }))).toBe('invalid_input');
    expect(codeOf(() => memoryStore({ ...limits, globalMaxRows: 1 }))).toBe('invalid_input');
  });

  test('collect only reclaims expired best-effort rows and convert reservations into replay-fencing tombstones', () => {
    const { store } = memoryStore();
    const ns = store.forNamespace('alpha');
    const past = 1_000;
    const future = Date.now() + 3_600_000;
    ns.put('mand', new Uint8Array([1]), { required: true });
    expect(ns.collect(future, 10)).toBe(0);
    expect(ns.get('mand')).not.toBeNull();
    expect(codeOf(() => ns.delete('mand'))).toBe('record_protected');

    ns.put('opt', new Uint8Array([1]), { required: false, expiresAt: past });
    const rowsBefore = ns.status().recordCount;
    expect(ns.get('opt')).not.toBeNull();
    expect(ns.status().recordCount).toBe(rowsBefore);
    expect(ns.collect(past, 10)).toBe(1);
    expect(ns.get('opt')).toBeNull();

    ns.put('later', new Uint8Array([1]), { required: false, expiresAt: future });
    expect(ns.collect(past, 10)).toBe(0);
    expect(ns.get('later')).not.toBeNull();

    const beta = store.forNamespace('beta');
    const reserved = beta.reserve('er', 16, { required: false, expiresAt: past });
    expect(beta.status().reservedBytes).toBe(reserved.chargedBytes);
    expect(beta.collect(past, 10)).toBe(1);
    expect(beta.status().reservedBytes).toBe(0);
    expect(beta.status().usedBytes).toBe(tombstoneCharge('beta', 'er'));
    expect(codeOf(() => beta.reserve('er', 16, { required: false, expiresAt: past }))).toBe('reservation_conflict');

    expect(ns.ack('mand')).toBe(true);
    expect(ns.get('mand')).toBeNull();
  });

  test('bounds list and status and aggregates namespace and global capacity', () => {
    const { store } = memoryStore();
    const alpha = store.forNamespace('alpha');
    for (let index = 0; index < 5; index += 1) alpha.put(`k${index}`, new Uint8Array([index]), { required: false });
    expect(alpha.list(2)).toHaveLength(2);
    expect(alpha.list()).toHaveLength(5);
    expect(codeOf(() => alpha.list(0))).toBe('invalid_input');

    const status = alpha.status();
    expect(status.namespace).toBe('alpha');
    expect(status.recordCount).toBe(5);
    expect(status.usedBytes).toBe(
      [0, 1, 2, 3, 4].reduce((sum, index) => sum + recordCharge('alpha', `k${index}`, 1), 0),
    );
    expect(status.dataBytes).toBe(5);
    expect(status.namespaceQuotaBytes).toBe(16_000);
    expect(status.requiredReserveBytes).toBe(4_000);
    expect(status.maxRecordsPerNamespace).toBe(40);
    expect(status.requiredRowReserve).toBe(10);
    expect(status.globalBudgetBytes).toBe(64_000);
    expect(status.globalRequiredReserveBytes).toBe(8_000);
    expect(status.globalMaxRows).toBe(400);

    const beta = store.forNamespace('beta');
    beta.put('b', new Uint8Array([1]), { required: false });
    expect(alpha.status().globalUsedBytes).toBe(status.usedBytes + recordCharge('beta', 'b', 1));
    expect(alpha.status().globalRecordCount).toBe(6);
    expect(beta.status().usedBytes).toBe(recordCharge('beta', 'b', 1));
  });

  test('overwrites near quota and forceRelease forgets only under a trusted host fence', () => {
    const { store } = memoryStore(NARROW);
    const ns = store.forNamespace('alpha');
    ns.put('a', new Uint8Array(1_400), { required: false });
    expect(codeOf(() => ns.put('b', new Uint8Array(100), { required: false }))).toBe('quota_exceeded');
    expect(ns.put('a', new Uint8Array(1_400), { required: false }).key).toBe('a');
    expect(ns.put('a', new Uint8Array(1_450), { required: false }).key).toBe('a');
    expect(codeOf(() => ns.put('a', new Uint8Array(1_500), { required: false }))).toBe('quota_exceeded');

    const beta = store.forNamespace('beta');
    beta.commit(beta.reserve('fr', 128, { required: false }), 'frkey', new Uint8Array(4));
    expect(beta.receipt('fr')).not.toBeNull();
    expect(beta.status().usedBytes).toBe(recordCharge('beta', 'frkey', 4) + receiptCharge('beta', 'fr', 'frkey'));
    // The trusted host has established its own fence; forceRelease alone does not make replay safe.
    expect(beta.forceRelease('fr')).toBe(true);
    expect(beta.receipt('fr')).toBeNull();
    expect(beta.status().usedBytes).toBe(recordCharge('beta', 'frkey', 4));
    expect(beta.forceRelease('fr')).toBe(false);
    expect(beta.reserve('fr', 128, { required: false }).id).toBe('fr');
  });

  test('setup:false opens an already-initialized database without issuing DDL', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const reader = new PluginCommunicationStore(db, TIGHT, { setup: false }).forNamespace('alpha');
    expect(codeOf(() => reader.get('k'))).toBe('storage_failure');
    new PluginCommunicationStore(db, TIGHT);
    reader.put('k', new Uint8Array([1]), { required: false });
    expect(Array.from(reader.get('k')!.payload)).toEqual([1]);
  });
});
