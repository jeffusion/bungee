import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { storageMessageBytes } from '../../src/plugin-state/message-size';
import { PluginStateClient } from '../../src/plugin-state/client';

test('message budgets count binary bytes, Buffer before toJSON, and complete backing buffers', () => {
  expect(storageMessageBytes([{ value: 'abc' }])).toBe(Buffer.byteLength(JSON.stringify([{ value: 'abc' }])));
  expect(storageMessageBytes([new Uint8Array(1024)])).toBe(1030);
  expect(storageMessageBytes([Buffer.alloc(1024)])).toBe(1030);
  expect(storageMessageBytes([new Uint8Array(new ArrayBuffer(1024), 10, 2)])).toBe(1030);
  expect(storageMessageBytes([new ArrayBuffer(1024)])).toBe(1030);
  expect(() => storageMessageBytes([1n])).toThrow();
});

test('message budgets reject hidden clone graphs and accessors before evaluating them', () => {
  const body = new Uint8Array(16 * 1024 * 1024);
  for (const value of [new Map([['blob', body]]), new Set([body]), new Date(), { toJSON() { return {}; } }]) {
    expect(() => storageMessageBytes([value])).toThrow();
  }
  let getterCalls = 0;
  const value = { get blob() { getterCalls++; return body; } };
  expect(() => storageMessageBytes([value])).toThrow('storage_message_accessor');
  expect(getterCalls).toBe(0);
  const cycle: any = {}; cycle.self = cycle;
  expect(() => storageMessageBytes([cycle])).toThrow('storage_message_cycle');
});

test('binary intrinsic sizes cannot be shadowed and undefined property keys remain charged', () => {
  let getterCalls = 0;
  const typed = new Uint8Array(16 * 1024 * 1024);
  Object.defineProperty(typed, 'buffer', { get() { getterCalls++; return new ArrayBuffer(0); } });
  expect(storageMessageBytes([typed])).toBe(typed.byteLength + 6);
  const buffer = new ArrayBuffer(16 * 1024 * 1024);
  Object.defineProperty(buffer, 'byteLength', { value: 0 });
  expect(storageMessageBytes([buffer])).toBe(16 * 1024 * 1024 + 6);
  const view = new DataView(buffer);
  Object.defineProperty(view, 'buffer', { get() { getterCalls++; return new ArrayBuffer(0); } });
  expect(storageMessageBytes([view])).toBe(16 * 1024 * 1024 + 6);
  expect(getterCalls).toBe(0);
  const key = 'k'.repeat(16 * 1024 * 1024);
  expect(storageMessageBytes([{ [key]: undefined }])).toBe(key.length + 11);
  expect(storageMessageBytes([new Array(100_000_000)])).toBe(500_000_003);
});

test('the default bounded client publishes and reads a 5 MiB binary snapshot without JSON expansion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-binary-snapshot-'));
  const client = await PluginStateClient.open(join(directory, 'state.db'), { initialize: true });
  try {
    const kv = client.pluginStorage('binary-validation');
    await expect(kv.set('hidden', new Map([['blob', new Uint8Array(16 * 1024 * 1024)]]))).rejects.toHaveProperty('code', 'request_failed');
    let getterCalls = 0;
    await expect(kv.set('getter', { get blob() { getterCalls++; return new Uint8Array(16 * 1024 * 1024); } })).rejects.toHaveProperty('code', 'request_failed');
    expect(getterCalls).toBe(0);
    const hidden = new Uint8Array(16 * 1024 * 1024);
    Object.defineProperty(hidden, 'buffer', { value: new ArrayBuffer(0) });
    await expect(kv.set('shadowed', hidden)).rejects.toHaveProperty('code', 'queue_full');
    await expect(kv.set('undefined', { ['k'.repeat(16 * 1024 * 1024)]: undefined })).rejects.toHaveProperty('code', 'queue_full');
    const body = new Uint8Array(5 * 1024 * 1024 + 123); body.fill(37);
    const store = client.snapshotStore('binary-provider', { id: 'large', schemaVersion: 1 });
    const descriptor = await store.publish(1, body);
    const source = await store.current();
    expect(source?.descriptor).toEqual(descriptor);
    if (!source) throw new Error('snapshot_missing');
    try { expect(await source.read(0, 1024)).toEqual(body.slice(0, 1024)); }
    finally { await source.release?.(); }
    await expect(store.publish(2, new Uint8Array(8 * 1024 * 1024 + 1))).rejects.toHaveProperty('code', 'queue_full');
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
