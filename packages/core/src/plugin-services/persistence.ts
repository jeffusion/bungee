/**
 * Plugin communication persistence (P3): durable records, atomic capacity
 * reservations, and explicit retention governance. Host-only leaf module:
 * `PluginCommunicationStore` owns the strict schema and the raw `Database`, and
 * `forNamespace(plugin)` returns a frozen capability bound to one namespace
 * (no other namespace, no connection). It backs host-mediated command receipts,
 * reliable events, and large-object reuse; it is not a plugin shared database.
 *
 * Charging model (a conservative estimate, NOT a measured SQLite disk
 * footprint): each persisted row is charged `entryOverheadBytes` (fixed row
 * estimate) plus the UTF-8 length of its identifier text (namespace plus
 * key/reservation id) plus its stored data bytes. A reservation pre-pays the
 * worst case of BOTH the record row and the receipt row it can produce (key
 * bounded by MAX_IDENTIFIER_BYTES, capacity supplied by the caller); `commit`
 * releases the actual-vs-reserved difference, so a row can never grow past what
 * was reserved. A zero-capacity reservation still carries a positive minimum
 * charge, so it can always be replaced by a tombstone without exceeding quota.
 * Reads never delete; only `collect`, `delete`, `ack`, and `forceRelease` do.
 *
 * `PluginCommunicationLimits` (notably `entryOverheadBytes`) is part of the
 * on-disk accounting contract: reads recompute expected charges and report
 * `corruption` on mismatch, so limits must stay stable across restarts.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

const MIB = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_IDENTIFIER_BYTES = 128;
const FINGERPRINT_BYTES = 64;
const EMPTY = new Uint8Array(0);
const ENCODER = new TextEncoder();
const DEFAULT_LIST_LIMIT = 128;
const MAX_LIST_LIMIT = 256;
const MAX_COLLECT_BATCH = 256;

export const PLUGIN_COMMUNICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_communication_reservations (
  namespace TEXT NOT NULL, reservation_id TEXT NOT NULL,
  capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes >= 0),
  charged_bytes INTEGER NOT NULL CHECK(charged_bytes >= 0),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  expires_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, reservation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_communication_records (
  namespace TEXT NOT NULL, key TEXT NOT NULL,
  payload BLOB NOT NULL, metadata TEXT,
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes >= 0),
  metadata_bytes INTEGER NOT NULL CHECK(metadata_bytes >= 0),
  charged_bytes INTEGER NOT NULL CHECK(charged_bytes >= 0),
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  expires_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, key)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_communication_receipts (
  namespace TEXT NOT NULL, reservation_id TEXT NOT NULL, key TEXT NOT NULL,
  capacity_bytes INTEGER NOT NULL CHECK(capacity_bytes >= 0),
  charged_bytes INTEGER NOT NULL CHECK(charged_bytes >= 0),
  fingerprint TEXT NOT NULL,
  required INTEGER NOT NULL CHECK(required IN (0,1)),
  committed_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, reservation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS plugin_communication_tombstones (
  namespace TEXT NOT NULL, reservation_id TEXT NOT NULL,
  charged_bytes INTEGER NOT NULL CHECK(charged_bytes >= 0),
  cancelled_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, reservation_id)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_plugin_communication_records_expiry
  ON plugin_communication_records(namespace, required, expires_at);
CREATE INDEX IF NOT EXISTS idx_plugin_communication_reservations_expiry
  ON plugin_communication_reservations(namespace, required, expires_at);
`;

export type CommunicationStoreErrorCode =
  | 'invalid_input'
  | 'quota_exceeded'
  | 'overloaded'
  | 'reservation_conflict'
  | 'reservation_missing'
  | 'record_protected'
  | 'corruption'
  | 'storage_failure';

const ERROR_MESSAGES: Record<CommunicationStoreErrorCode, string> = {
  invalid_input: 'communication store input is invalid',
  quota_exceeded: 'communication store quota is exhausted',
  overloaded: 'communication store required capacity is exhausted',
  reservation_conflict: 'communication reservation id is already used with a different shape',
  reservation_missing: 'communication reservation does not exist',
  record_protected: 'communication record is protected and cannot be removed or overwritten here',
  corruption: 'communication store row is corrupt',
  storage_failure: 'communication store database operation failed',
};

export class CommunicationStoreError extends Error {
  readonly name = 'CommunicationStoreError';
  constructor(readonly code: CommunicationStoreErrorCode) { super(ERROR_MESSAGES[code]); }
}

export interface PluginCommunicationLimits {
  readonly globalBudgetBytes?: number;
  /** Slice of the global budget best-effort rows may never consume. */
  readonly globalRequiredReserveBytes?: number;
  readonly globalMaxRows?: number;
  /** Slice of the global row cap best-effort rows may never consume. */
  readonly globalRequiredRowReserve?: number;
  readonly namespaceQuotaBytes?: number;
  /** Slice of the namespace quota best-effort rows may never consume. */
  readonly requiredReserveBytes?: number;
  readonly maxRecordsPerNamespace?: number;
  /** Slice of the namespace row cap best-effort rows may never consume. */
  readonly requiredRowReserve?: number;
  /** Maximum payload+metadata capacity a single record or reservation may hold. */
  readonly maxRecordBytes?: number;
  /** Fixed per-row estimate; not a measured SQLite disk footprint. */
  readonly entryOverheadBytes?: number;
}

interface ResolvedLimits {
  readonly globalBudgetBytes: number;
  readonly globalRequiredReserveBytes: number;
  readonly globalMaxRows: number;
  readonly globalRequiredRowReserve: number;
  readonly namespaceQuotaBytes: number;
  readonly requiredReserveBytes: number;
  readonly maxRecordsPerNamespace: number;
  readonly requiredRowReserve: number;
  readonly maxRecordBytes: number;
  readonly entryOverheadBytes: number;
}

export interface CommunicationRetention {
  readonly required: boolean;
  /** Required records are durable; a required declaration must omit expiry. */
  readonly expiresAt?: number | null;
}

export interface CommunicationReservation {
  readonly id: string;
  /** Declared payload+metadata capacity in bytes. */
  readonly capacityBytes: number;
  /** Store-computed total charge the reservation holds (capacity plus row charges). */
  readonly chargedBytes: number;
  readonly required: boolean;
  readonly expiresAt: number | null;
}

export interface CommunicationReceipt {
  readonly id: string;
  readonly key: string;
  readonly capacityBytes: number;
  readonly chargedBytes: number;
  readonly fingerprint: string;
  readonly required: boolean;
  readonly committedAt: number;
}

export interface CommunicationRecord {
  readonly key: string;
  readonly payload: Uint8Array;
  readonly metadata: string | null;
  readonly required: boolean;
  readonly expiresAt: number | null;
  readonly createdAt: number;
}

export interface CommunicationRecordSummary {
  readonly key: string;
  readonly payloadBytes: number;
  readonly metadataBytes: number;
  readonly chargedBytes: number;
  readonly required: boolean;
  readonly expiresAt: number | null;
  readonly createdAt: number;
}

export interface CommunicationNamespaceStatus {
  readonly namespace: string;
  /** Durable rows plus prepaid row slots (two per live reservation). */
  readonly recordCount: number;
  /** Records + receipts + tombstones. */
  readonly usedBytes: number;
  /** Live reservations. */
  readonly reservedBytes: number;
  /** Payload + metadata bytes actually stored in records. */
  readonly dataBytes: number;
  readonly namespaceQuotaBytes: number;
  readonly requiredReserveBytes: number;
  readonly maxRecordsPerNamespace: number;
  readonly requiredRowReserve: number;
  readonly globalBudgetBytes: number;
  readonly globalRequiredReserveBytes: number;
  readonly globalUsedBytes: number;
  readonly globalReservedBytes: number;
  readonly globalMaxRows: number;
  readonly globalRecordCount: number;
}

/**
 * Same-connection raw mutator. Every method performs exactly one statement group
 * and opens NO transaction of its own, so a caller can compose several writes
 * into one atomic unit (either through {@link CommunicationNamespaceStore.transact}
 * or from inside another store's transaction on the same database).
 */
export interface CommunicationMutator {
  get(key: string): CommunicationRecord | null;
  /** Charges quota exactly like the public `put`, without opening a transaction. */
  put(key: string, payload: Uint8Array, options: CommunicationRetention): CommunicationRecordSummary;
  /** Removes a record (including a protected required one), without a transaction. */
  ack(key: string): boolean;
  list(limit?: number): readonly CommunicationRecordSummary[];
}

export interface CommunicationNamespaceStore {
  readonly namespace: string;
  get(key: string): CommunicationRecord | null;
  /** Reserves `capacityBytes` of payload+metadata for a future commit under `id`. */
  reserve(id: string, capacityBytes: number, options: CommunicationRetention): CommunicationReservation;
  /** Consumes the reservation once; an idempotent retry must match the stored fingerprint exactly. */
  commit(reservation: CommunicationReservation, key: string, payload: Uint8Array, metadata?: string | null): CommunicationReceipt;
  /** Durable receipt for a committed id, or `null` when none exists. */
  receipt(id: string): CommunicationReceipt | null;
  cancel(id: string): boolean;
  /** Atomic records-only write. Never creates a receipt or a replay id. */
  put(key: string, payload: Uint8Array, options: CommunicationRetention): CommunicationRecordSummary;
  delete(key: string): boolean;
  /** Explicit host confirmation; removes even a protected required record. */
  ack(key: string): boolean;
  /**
   * DANGEROUS host-only fence forget: releases a reservation, receipt, or
   * tombstone so its id may be reused. Only call after an external
   * expiry/sequence/caller fence proves the old operation can never replay;
   * this method does NOT by itself make replay safe and is never exposed as a
   * plugin context capability.
   */
  forceRelease(id: string): boolean;
  collect(now: number, limit: number): number;
  list(limit?: number): readonly CommunicationRecordSummary[];
  status(): CommunicationNamespaceStatus;
  /** Raw same-connection mutator; never opens a transaction. */
  mutator(): CommunicationMutator;
  /** Runs one composite mutation in a single immediate transaction. */
  transact<Result>(run: (mutator: CommunicationMutator) => Result): Result;
}

export interface PluginCommunicationStoreOptions {
  /** `false` skips schema creation for an already-initialized read-only reader. */
  readonly setup?: boolean;
}

type ScalarRow = { value: number };
type ReservationRow = { capacity_bytes: number; charged_bytes: number; required: number; expires_at: number | null; created_at: number };
type RecordInfoRow = { charged_bytes: number; required: number };
type RecordRow = {
  key: string; payload: Uint8Array; metadata: string | null; payload_bytes: number; metadata_bytes: number;
  charged_bytes: number; required: number; expires_at: number | null; created_at: number;
};
type SummaryRow = {
  key: string; payload_bytes: number; metadata_bytes: number; charged_bytes: number;
  required: number; expires_at: number | null; created_at: number;
};
type ReceiptRow = {
  key: string; capacity_bytes: number; charged_bytes: number; fingerprint: string; required: number; committed_at: number;
};

const USED_SQL = `
SELECT
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_records WHERE namespace=?) +
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_receipts WHERE namespace=?) +
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_tombstones WHERE namespace=?) AS value`;
const RESERVED_SQL = `SELECT COALESCE(SUM(charged_bytes),0) AS value FROM plugin_communication_reservations WHERE namespace=?`;
const COUNT_SQL = `
SELECT
 (SELECT COUNT(*) FROM plugin_communication_records WHERE namespace=?) +
 (SELECT COUNT(*) FROM plugin_communication_receipts WHERE namespace=?) +
 (SELECT COUNT(*) FROM plugin_communication_tombstones WHERE namespace=?) +
  2 * (SELECT COUNT(*) FROM plugin_communication_reservations WHERE namespace=?) AS value`;
const DATA_SQL = `SELECT COALESCE(SUM(payload_bytes + metadata_bytes),0) AS value FROM plugin_communication_records WHERE namespace=?`;
const GLOBAL_USED_SQL = `
SELECT
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_records) +
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_receipts) +
 (SELECT COALESCE(SUM(charged_bytes),0) FROM plugin_communication_tombstones) AS value`;
const GLOBAL_RESERVED_SQL = `SELECT COALESCE(SUM(charged_bytes),0) AS value FROM plugin_communication_reservations`;
const GLOBAL_COUNT_SQL = `
SELECT
 (SELECT COUNT(*) FROM plugin_communication_records) +
 (SELECT COUNT(*) FROM plugin_communication_receipts) +
 (SELECT COUNT(*) FROM plugin_communication_tombstones) +
  2 * (SELECT COUNT(*) FROM plugin_communication_reservations) AS value`;

function positiveLimit(value: unknown, fallback: number): number {
  if (value === undefined) value = fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new CommunicationStoreError('invalid_input');
  }
  return value;
}

function resolveLimits(limits: PluginCommunicationLimits = {}): ResolvedLimits {
  const globalBudgetBytes = positiveLimit(limits.globalBudgetBytes, 128 * MIB);
  const namespaceQuotaBytes = positiveLimit(limits.namespaceQuotaBytes, 64 * MIB);
  const maxRecordBytes = positiveLimit(limits.maxRecordBytes, 16 * MIB);
  const maxRecordsPerNamespace = positiveLimit(limits.maxRecordsPerNamespace, 4096);
  const entryOverheadBytes = positiveLimit(limits.entryOverheadBytes, 64);
  const requiredReserveBytes = positiveLimit(limits.requiredReserveBytes, Math.max(1, Math.floor(namespaceQuotaBytes / 4)));
  const globalRequiredReserveBytes = positiveLimit(limits.globalRequiredReserveBytes, Math.max(1, Math.floor(globalBudgetBytes / 4)));
  const globalMaxRows = positiveLimit(limits.globalMaxRows, 1_048_576);
  const requiredRowReserve = positiveLimit(limits.requiredRowReserve, Math.max(1, Math.floor(maxRecordsPerNamespace / 4)));
  const globalRequiredRowReserve = positiveLimit(limits.globalRequiredRowReserve, Math.max(1, Math.floor(globalMaxRows / 4)));
  if (namespaceQuotaBytes > globalBudgetBytes
      || requiredReserveBytes >= namespaceQuotaBytes
      || globalRequiredReserveBytes >= globalBudgetBytes
      || maxRecordBytes > namespaceQuotaBytes
      || requiredRowReserve >= maxRecordsPerNamespace
      || globalRequiredRowReserve >= globalMaxRows) {
    throw new CommunicationStoreError('invalid_input');
  }
  return Object.freeze({
    globalBudgetBytes, globalRequiredReserveBytes, globalMaxRows, globalRequiredRowReserve,
    namespaceQuotaBytes, requiredReserveBytes, maxRecordsPerNamespace, requiredRowReserve,
    maxRecordBytes, entryOverheadBytes,
  });
}

function textBytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }

function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new CommunicationStoreError('invalid_input');
}

function assertByteCount(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CommunicationStoreError('invalid_input');
  }
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertPayload(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) throw new CommunicationStoreError('invalid_input');
}

function assertMetadata(value: unknown): asserts value is string | null | undefined {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new CommunicationStoreError('invalid_input');
  }
}

function assertRetention(options: unknown): { required: boolean; expiresAt: number | null } {
  if (options === null || typeof options !== 'object') throw new CommunicationStoreError('invalid_input');
  const required = (options as { required?: unknown }).required;
  if (typeof required !== 'boolean') throw new CommunicationStoreError('invalid_input');
  const raw = (options as { expiresAt?: unknown }).expiresAt;
  if (raw === undefined || raw === null) return { required, expiresAt: null };
  if (!isTimestamp(raw) || raw === 0) throw new CommunicationStoreError('invalid_input');
  if (required) throw new CommunicationStoreError('invalid_input');
  return { required, expiresAt: raw };
}

function assertReservationShape(value: unknown): asserts value is CommunicationReservation {
  if (value === null || typeof value !== 'object') throw new CommunicationStoreError('invalid_input');
  const reservation = value as CommunicationReservation;
  assertIdentifier(reservation.id);
  assertByteCount(reservation.capacityBytes);
  assertByteCount(reservation.chargedBytes);
  if (typeof reservation.required !== 'boolean') throw new CommunicationStoreError('invalid_input');
  if (reservation.expiresAt !== null && !isTimestamp(reservation.expiresAt)) throw new CommunicationStoreError('invalid_input');
}

function frameFingerprint(fields: readonly (string | Uint8Array | null)[]): string {
  const hash = createHash('sha256');
  const prefix = Buffer.alloc(5);
  for (const field of fields) {
    const kind = field === null ? 0 : typeof field === 'string' ? 1 : 2;
    const bytes = field === null ? EMPTY : typeof field === 'string' ? ENCODER.encode(field) : field;
    prefix.writeUInt8(kind, 0);
    prefix.writeUInt32BE(bytes.byteLength, 1);
    hash.update(prefix);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function commitFingerprint(
  namespace: string, reservation: CommunicationReservation, key: string, payload: Uint8Array, metadata: string | null,
): string {
  return frameFingerprint([
    'communication.commit.v1', namespace, reservation.id, key,
    reservation.required ? 'required' : 'best-effort',
    reservation.expiresAt === null ? null : String(reservation.expiresAt),
    String(reservation.capacityBytes),
    payload, metadata,
  ]);
}

function scalar(db: Database, sql: string, params: readonly (string | number)[]): number {
  const row = db.query(sql).get(...params) as ScalarRow | null;
  if (row === null || typeof row.value !== 'number' || !Number.isSafeInteger(row.value) || row.value < 0) {
    throw new CommunicationStoreError('storage_failure');
  }
  return row.value;
}

function runDatabase<Result>(action: () => Result): Result {
  try { return action(); }
  catch (error) {
    if (error instanceof CommunicationStoreError) throw error;
    throw new CommunicationStoreError('storage_failure');
  }
}

function dataBytesOf(payload: Uint8Array, metadata: string | null): number {
  return payload.byteLength + (metadata === null ? 0 : textBytes(metadata));
}

function freezeRecord(row: RecordRow, rowBase: number): CommunicationRecord {
  const metadataBytes = row.metadata === null ? 0 : typeof row.metadata === 'string' ? textBytes(row.metadata) : -1;
  const expected = rowBase + textBytes(row.key) + row.payload_bytes + row.metadata_bytes;
  if (!(row.payload instanceof Uint8Array)
      || !IDENTIFIER.test(row.key)
      || row.payload_bytes !== row.payload.byteLength
      || metadataBytes !== row.metadata_bytes
      || !Number.isSafeInteger(row.charged_bytes) || row.charged_bytes !== expected
      || !isTimestamp(row.created_at)
      || (row.expires_at !== null && !isTimestamp(row.expires_at))
      || (row.required !== 0 && row.required !== 1)
      || (row.required === 1 && row.expires_at !== null)) {
    throw new CommunicationStoreError('corruption');
  }
  return Object.freeze({
    key: row.key,
    payload: new Uint8Array(row.payload),
    metadata: row.metadata === null ? null : String(row.metadata),
    required: row.required === 1,
    expiresAt: row.expires_at === null ? null : row.expires_at,
    createdAt: row.created_at,
  });
}

function freezeSummary(row: SummaryRow, rowBase: number): CommunicationRecordSummary {
  const expected = rowBase + textBytes(row.key) + row.payload_bytes + row.metadata_bytes;
  if (!IDENTIFIER.test(row.key)
      || !Number.isSafeInteger(row.payload_bytes) || !Number.isSafeInteger(row.metadata_bytes)
      || !Number.isSafeInteger(row.charged_bytes) || row.charged_bytes !== expected
      || !isTimestamp(row.created_at)
      || (row.expires_at !== null && !isTimestamp(row.expires_at))
      || (row.required !== 0 && row.required !== 1)
      || (row.required === 1 && row.expires_at !== null)) {
    throw new CommunicationStoreError('corruption');
  }
  return Object.freeze({
    key: row.key,
    payloadBytes: row.payload_bytes,
    metadataBytes: row.metadata_bytes,
    chargedBytes: row.charged_bytes,
    required: row.required === 1,
    expiresAt: row.expires_at === null ? null : row.expires_at,
    createdAt: row.created_at,
  });
}

function freezeReceipt(id: string, row: ReceiptRow, rowBase: number): CommunicationReceipt {
  const expected = rowBase + textBytes(id) + textBytes(row.key) + FINGERPRINT_BYTES;
  if (!/^[0-9a-f]{64}$/.test(row.fingerprint)
      || !Number.isSafeInteger(row.capacity_bytes) || row.capacity_bytes < 0
      || !Number.isSafeInteger(row.charged_bytes) || row.charged_bytes !== expected
      || !isTimestamp(row.committed_at)
      || (row.required !== 0 && row.required !== 1)) {
    throw new CommunicationStoreError('corruption');
  }
  return Object.freeze({
    id, key: row.key, capacityBytes: row.capacity_bytes, chargedBytes: row.charged_bytes,
    fingerprint: row.fingerprint, required: row.required === 1, committedAt: row.committed_at,
  });
}

function freezeReservation(id: string, row: ReservationRow, reservationCharge: (id: string, capacity: number) => number): CommunicationReservation {
  const expected = reservationCharge(id, row.capacity_bytes);
  if (!Number.isSafeInteger(row.capacity_bytes) || row.capacity_bytes < 0
      || !Number.isSafeInteger(row.charged_bytes) || row.charged_bytes !== expected
      || !isTimestamp(row.created_at)
      || (row.expires_at !== null && (!isTimestamp(row.expires_at) || row.expires_at === 0))
      || (row.required !== 0 && row.required !== 1)
      || (row.required === 1 && row.expires_at !== null)) {
    throw new CommunicationStoreError('corruption');
  }
  return Object.freeze({
    id, capacityBytes: row.capacity_bytes, chargedBytes: row.charged_bytes,
    required: row.required === 1, expiresAt: row.expires_at === null ? null : row.expires_at,
  });
}

/** Owns the schema; hands out namespace-bound capabilities only. */
export class PluginCommunicationStore {
  private readonly db: Database;
  private readonly limits: ResolvedLimits;

  constructor(db: Database, limits?: PluginCommunicationLimits, options?: PluginCommunicationStoreOptions) {
    this.db = db;
    this.limits = resolveLimits(limits);
    if (options?.setup !== false) db.exec(PLUGIN_COMMUNICATION_SCHEMA_SQL);
  }

  forNamespace(plugin: string): CommunicationNamespaceStore {
    assertIdentifier(plugin);
    return createNamespace(this.db, this.limits, plugin);
  }
}

function createNamespace(db: Database, limits: ResolvedLimits, namespace: string): CommunicationNamespaceStore {
  const rowBase = limits.entryOverheadBytes + textBytes(namespace);
  const reservationCharge = (id: string, capacityBytes: number): number =>
    2 * rowBase + textBytes(id) + 2 * MAX_IDENTIFIER_BYTES + FINGERPRINT_BYTES + capacityBytes;
  const recordCharge = (key: string, dataBytes: number): number => rowBase + textBytes(key) + dataBytes;
  const receiptCharge = (id: string, key: string): number => rowBase + textBytes(id) + textBytes(key) + FINGERPRINT_BYTES;
  const tombstoneCharge = (id: string): number => rowBase + textBytes(id);

  const readReservation = (id: string): ReservationRow | null => db.query<ReservationRow, [string, string]>(
    'SELECT capacity_bytes,charged_bytes,required,expires_at,created_at FROM plugin_communication_reservations WHERE namespace=? AND reservation_id=?',
  ).get(namespace, id) ?? null;
  const readRecordInfo = (key: string): RecordInfoRow | null => db.query<RecordInfoRow, [string, string]>(
    'SELECT charged_bytes,required FROM plugin_communication_records WHERE namespace=? AND key=?',
  ).get(namespace, key) ?? null;
  const readRecord = (key: string): RecordRow | null => db.query<RecordRow, [string, string]>(
    `SELECT key,payload,metadata,payload_bytes,metadata_bytes,charged_bytes,required,expires_at,created_at
     FROM plugin_communication_records WHERE namespace=? AND key=?`,
  ).get(namespace, key) ?? null;
  const readReceipt = (id: string): ReceiptRow | null => db.query<ReceiptRow, [string, string]>(
    'SELECT key,capacity_bytes,charged_bytes,fingerprint,required,committed_at FROM plugin_communication_receipts WHERE namespace=? AND reservation_id=?',
  ).get(namespace, id) ?? null;
  const hasTombstone = (id: string): boolean => db.query<{ present: number }, [string, string]>(
    'SELECT 1 AS present FROM plugin_communication_tombstones WHERE namespace=? AND reservation_id=?',
  ).get(namespace, id) !== null;

  const usedBytes = (): number => scalar(db, USED_SQL, [namespace, namespace, namespace]);
  const reservedBytes = (): number => scalar(db, RESERVED_SQL, [namespace]);
  const rowCount = (): number => scalar(db, COUNT_SQL, [namespace, namespace, namespace, namespace]);
  const dataBytes = (): number => scalar(db, DATA_SQL, [namespace]);
  const globalUsedBytes = (): number => scalar(db, GLOBAL_USED_SQL, []);
  const globalReservedBytes = (): number => scalar(db, GLOBAL_RESERVED_SQL, []);
  const globalRowCount = (): number => scalar(db, GLOBAL_COUNT_SQL, []);

  function assertBytes(requested: number, required: boolean): void {
    const occupied = usedBytes() + reservedBytes();
    const available = required
      ? limits.namespaceQuotaBytes - occupied
      : limits.namespaceQuotaBytes - limits.requiredReserveBytes - occupied;
    if (requested > available) throw new CommunicationStoreError(required ? 'overloaded' : 'quota_exceeded');
    const globalAvailable = required
      ? limits.globalBudgetBytes - (globalUsedBytes() + globalReservedBytes())
      : limits.globalBudgetBytes - limits.globalRequiredReserveBytes - (globalUsedBytes() + globalReservedBytes());
    if (requested > globalAvailable) throw new CommunicationStoreError('quota_exceeded');
  }

  function assertRows(delta: number, required: boolean): void {
    if (delta <= 0) return;
    const rows = rowCount();
    const available = required
      ? limits.maxRecordsPerNamespace - rows
      : limits.maxRecordsPerNamespace - limits.requiredRowReserve - rows;
    if (delta > available) throw new CommunicationStoreError(required ? 'overloaded' : 'quota_exceeded');
    const globalRows = globalRowCount();
    const globalAvailable = required
      ? limits.globalMaxRows - globalRows
      : limits.globalMaxRows - limits.globalRequiredRowReserve - globalRows;
    if (delta > globalAvailable) throw new CommunicationStoreError('quota_exceeded');
  }

  function insertReservation(id: string, capacityBytes: number, charged: number, required: boolean, expiresAt: number | null, at: number): void {
    db.run(
      `INSERT INTO plugin_communication_reservations
        (namespace,reservation_id,capacity_bytes,charged_bytes,required,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`,
      [namespace, id, capacityBytes, charged, required ? 1 : 0, expiresAt, at],
    );
  }

  function insertRecord(key: string, payload: Uint8Array, metadata: string | null, data: number, charged: number, required: boolean, expiresAt: number | null, at: number): void {
    db.run(
      `INSERT INTO plugin_communication_records
        (namespace,key,payload,metadata,payload_bytes,metadata_bytes,charged_bytes,required,expires_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [namespace, key, payload, metadata, payload.byteLength, data - payload.byteLength, charged, required ? 1 : 0, expiresAt, at],
    );
  }

  function insertReceipt(id: string, key: string, capacityBytes: number, charged: number, fingerprint: string, required: boolean, at: number): void {
    db.run(
      `INSERT INTO plugin_communication_receipts
        (namespace,reservation_id,key,capacity_bytes,charged_bytes,fingerprint,required,committed_at) VALUES (?,?,?,?,?,?,?,?)`,
      [namespace, id, key, capacityBytes, charged, fingerprint, required ? 1 : 0, at],
    );
  }

  function insertTombstone(id: string, charged: number, at: number): void {
    db.run(
      'INSERT INTO plugin_communication_tombstones(namespace,reservation_id,charged_bytes,cancelled_at) VALUES (?,?,?,?)',
      [namespace, id, charged, at],
    );
  }

  function tombstoneFor(id: string): boolean {
    if (readReservation(id) === null) return false;
    db.run('DELETE FROM plugin_communication_reservations WHERE namespace=? AND reservation_id=?', [namespace, id]);
    insertTombstone(id, tombstoneCharge(id), Date.now());
    return true;
  }

  /**
   * Charge-checked atomic record write without its own transaction. The public
   * `put` and the raw {@link CommunicationMutator} share this exact logic, so a
   * composite transaction charges and stores identically.
   */
  function putInternal(key: string, payload: Uint8Array, options: CommunicationRetention): CommunicationRecordSummary {
    assertIdentifier(key);
    assertPayload(payload);
    const { required, expiresAt } = assertRetention(options);
    if (payload.byteLength > limits.maxRecordBytes) throw new CommunicationStoreError('quota_exceeded');
    const current = readRecordInfo(key);
    if (current !== null && current.required === 1) throw new CommunicationStoreError('record_protected');
    const charge = recordCharge(key, payload.byteLength);
    const delta = charge - (current === null ? 0 : current.charged_bytes);
    if (delta > 0) assertBytes(delta, required);
    if (current === null) assertRows(1, required);
    const at = Date.now();
    db.run('DELETE FROM plugin_communication_records WHERE namespace=? AND key=?', [namespace, key]);
    insertRecord(key, payload, null, payload.byteLength, charge, required, expiresAt, at);
    const stored = readRecord(key);
    if (stored === null) throw new CommunicationStoreError('corruption');
    return freezeSummary(stored, rowBase);
  }

  function ackInternal(key: string): boolean {
    assertIdentifier(key);
    if (readRecordInfo(key) === null) return false;
    db.run('DELETE FROM plugin_communication_records WHERE namespace=? AND key=?', [namespace, key]);
    return true;
  }

  function listInternal(limit: number = DEFAULT_LIST_LIMIT): readonly CommunicationRecordSummary[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new CommunicationStoreError('invalid_input');
    const cap = Math.min(limit, MAX_LIST_LIMIT);
    return Object.freeze(db.query<SummaryRow, [string, number]>(
      `SELECT key,payload_bytes,metadata_bytes,charged_bytes,required,expires_at,created_at
       FROM plugin_communication_records WHERE namespace=? ORDER BY key LIMIT ?`,
    ).all(namespace, cap).map((row) => freezeSummary(row, rowBase)));
  }

  function rawMutator(): CommunicationMutator {
    return Object.freeze({
      get: (key: string): CommunicationRecord | null => {
        assertIdentifier(key);
        const row = readRecord(key);
        return row === null ? null : freezeRecord(row, rowBase);
      },
      put: (key: string, payload: Uint8Array, options: CommunicationRetention): CommunicationRecordSummary => putInternal(key, payload, options),
      ack: (key: string): boolean => ackInternal(key),
      list: (limit: number = DEFAULT_LIST_LIMIT): readonly CommunicationRecordSummary[] => listInternal(limit),
    });
  }

  function commitInternal(reservation: CommunicationReservation, key: string, payload: Uint8Array, metadata: string | null, data: number, fingerprint: string): CommunicationReceipt {
    const prior = readReceipt(reservation.id);
    if (prior !== null) {
      if (prior.fingerprint === fingerprint) return freezeReceipt(reservation.id, prior, rowBase);
      throw new CommunicationStoreError('reservation_conflict');
    }
    const row = readReservation(reservation.id);
    if (row === null) {
      throw new CommunicationStoreError(hasTombstone(reservation.id) ? 'reservation_conflict' : 'reservation_missing');
    }
    if (row.capacity_bytes !== reservation.capacityBytes
        || row.required !== (reservation.required ? 1 : 0)
        || row.expires_at !== reservation.expiresAt) {
      throw new CommunicationStoreError('reservation_conflict');
    }
    if (row.expires_at !== null && row.expires_at <= Date.now()) throw new CommunicationStoreError('reservation_conflict');
    if (data > row.capacity_bytes) throw new CommunicationStoreError('reservation_conflict');
    const current = readRecordInfo(key);
    if (current !== null && current.required === 1) throw new CommunicationStoreError('record_protected');
    // Both output rows were paid at reserve(); commit never borrows another slot.
    const at = Date.now();
    db.run('DELETE FROM plugin_communication_records WHERE namespace=? AND key=?', [namespace, key]);
    insertRecord(key, payload, metadata, data, recordCharge(key, data), reservation.required, reservation.expiresAt, at);
    db.run('DELETE FROM plugin_communication_reservations WHERE namespace=? AND reservation_id=?', [namespace, reservation.id]);
    insertReceipt(reservation.id, key, row.capacity_bytes, receiptCharge(reservation.id, key), fingerprint, reservation.required, at);
    return Object.freeze({
      id: reservation.id, key, capacityBytes: row.capacity_bytes,
      chargedBytes: receiptCharge(reservation.id, key), fingerprint, required: reservation.required, committedAt: at,
    });
  }

  return Object.freeze({
    namespace,

    get(key: string): CommunicationRecord | null {
      assertIdentifier(key);
      return runDatabase(() => {
        const row = readRecord(key);
        return row === null ? null : freezeRecord(row, rowBase);
      });
    },

    reserve(id: string, capacityBytes: number, options: CommunicationRetention): CommunicationReservation {
      assertIdentifier(id);
      assertByteCount(capacityBytes);
      const { required, expiresAt } = assertRetention(options);
      if (capacityBytes > limits.maxRecordBytes) throw new CommunicationStoreError('quota_exceeded');
      return runDatabase(() => db.transaction(() => {
        const existing = readReservation(id);
        if (existing !== null) {
          if (existing.capacity_bytes === capacityBytes && existing.required === (required ? 1 : 0) && existing.expires_at === expiresAt) {
            return freezeReservation(id, existing, reservationCharge);
          }
          throw new CommunicationStoreError('reservation_conflict');
        }
        if (readReceipt(id) !== null || hasTombstone(id)) throw new CommunicationStoreError('reservation_conflict');
        const charge = reservationCharge(id, capacityBytes);
        assertBytes(charge, required);
        assertRows(2, required);
        insertReservation(id, capacityBytes, charge, required, expiresAt, Date.now());
        return Object.freeze({ id, capacityBytes, chargedBytes: charge, required, expiresAt });
      }).immediate());
    },

    commit(reservation: CommunicationReservation, key: string, payload: Uint8Array, metadata?: string | null): CommunicationReceipt {
      assertReservationShape(reservation);
      assertIdentifier(key);
      assertPayload(payload);
      assertMetadata(metadata);
      const normalized = metadata ?? null;
      const data = dataBytesOf(payload, normalized);
      if (data > limits.maxRecordBytes) throw new CommunicationStoreError('quota_exceeded');
      const fingerprint = commitFingerprint(namespace, reservation, key, payload, normalized);
      return runDatabase(() => db.transaction(() => commitInternal(reservation, key, payload, normalized, data, fingerprint)).immediate());
    },

    receipt(id: string): CommunicationReceipt | null {
      assertIdentifier(id);
      return runDatabase(() => {
        const row = readReceipt(id);
        return row === null ? null : freezeReceipt(id, row, rowBase);
      });
    },

    cancel(id: string): boolean {
      assertIdentifier(id);
      return runDatabase(() => db.transaction(() => {
        if (tombstoneFor(id)) return true;
        if (hasTombstone(id)) return false;
        if (readReceipt(id) !== null) throw new CommunicationStoreError('reservation_conflict');
        return false;
      }).immediate());
    },

    put(key: string, payload: Uint8Array, options: CommunicationRetention): CommunicationRecordSummary {
      return runDatabase(() => db.transaction(() => putInternal(key, payload, options)).immediate());
    },

    delete(key: string): boolean {
      assertIdentifier(key);
      return runDatabase(() => db.transaction(() => {
        const current = readRecordInfo(key);
        if (current === null) return false;
        if (current.required === 1) throw new CommunicationStoreError('record_protected');
        db.run('DELETE FROM plugin_communication_records WHERE namespace=? AND key=?', [namespace, key]);
        return true;
      }).immediate());
    },

    ack(key: string): boolean {
      return runDatabase(() => db.transaction(() => ackInternal(key)).immediate());
    },

    forceRelease(id: string): boolean {
      assertIdentifier(id);
      return runDatabase(() => db.transaction(() => {
        let released = false;
        if (db.run('DELETE FROM plugin_communication_reservations WHERE namespace=? AND reservation_id=?', [namespace, id]).changes > 0) released = true;
        if (db.run('DELETE FROM plugin_communication_receipts WHERE namespace=? AND reservation_id=?', [namespace, id]).changes > 0) released = true;
        if (db.run('DELETE FROM plugin_communication_tombstones WHERE namespace=? AND reservation_id=?', [namespace, id]).changes > 0) released = true;
        return released;
      }).immediate());
    },

    collect(now: number, limit: number): number {
      if (!isTimestamp(now) || !Number.isSafeInteger(limit) || limit <= 0) throw new CommunicationStoreError('invalid_input');
      const budget = Math.min(limit, MAX_COLLECT_BATCH);
      return runDatabase(() => db.transaction(() => {
        let removed = 0;
        const records = db.query<{ key: string }, [string, number, number]>(
          `SELECT key FROM plugin_communication_records
           WHERE namespace=? AND required=0 AND expires_at IS NOT NULL AND expires_at <= ?
           ORDER BY expires_at, key LIMIT ?`,
        ).all(namespace, now, budget);
        for (const row of records) {
          db.run('DELETE FROM plugin_communication_records WHERE namespace=? AND key=? AND required=0', [namespace, row.key]);
          removed += 1;
        }
        if (removed < budget) {
          const reservations = db.query<{ reservation_id: string }, [string, number, number]>(
            `SELECT reservation_id FROM plugin_communication_reservations
             WHERE namespace=? AND required=0 AND expires_at IS NOT NULL AND expires_at <= ?
             ORDER BY expires_at, reservation_id LIMIT ?`,
          ).all(namespace, now, budget - removed);
          for (const row of reservations) {
            if (tombstoneFor(row.reservation_id)) removed += 1;
          }
        }
        return removed;
      }).immediate());
    },

    list(limit: number = DEFAULT_LIST_LIMIT): readonly CommunicationRecordSummary[] {
      return runDatabase(() => listInternal(limit));
    },

    mutator(): CommunicationMutator {
      return rawMutator();
    },

    transact<Result>(run: (mutator: CommunicationMutator) => Result): Result {
      if (typeof run !== 'function') throw new CommunicationStoreError('invalid_input');
      return runDatabase(() => db.transaction(() => run(rawMutator())).immediate());
    },

    status(): CommunicationNamespaceStatus {
      return runDatabase(() => db.transaction(() => Object.freeze({
        namespace,
        recordCount: rowCount(),
        usedBytes: usedBytes(),
        reservedBytes: reservedBytes(),
        dataBytes: dataBytes(),
        namespaceQuotaBytes: limits.namespaceQuotaBytes,
        requiredReserveBytes: limits.requiredReserveBytes,
        maxRecordsPerNamespace: limits.maxRecordsPerNamespace,
        requiredRowReserve: limits.requiredRowReserve,
        globalBudgetBytes: limits.globalBudgetBytes,
        globalRequiredReserveBytes: limits.globalRequiredReserveBytes,
        globalUsedBytes: globalUsedBytes(),
        globalReservedBytes: globalReservedBytes(),
        globalMaxRows: limits.globalMaxRows,
        globalRecordCount: globalRowCount(),
      }))());
    },
  });
}
