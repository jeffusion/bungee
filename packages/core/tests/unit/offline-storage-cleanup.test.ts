import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stopped from '../../src/master-runtime/stopped-instance-lock';
import { acquireMasterInstanceLock, type MasterInstanceLock } from '../../src/master-runtime/instance-lock';
import { initializeConfigurationDatabase } from '../../src/master-runtime/initialize-configuration';
import { recoverOffline } from '../../src/master-runtime/offline-recovery';
import { withOfflineStorageSession } from '../../src/master-runtime/offline-storage-session';
import { PluginStateClient } from '../../src/plugin-state/client';
import { AsyncConfigRepository } from '../../src/config-storage/async-config-repository';

async function fixture(operation: (path: string, locks: MasterInstanceLock[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-offline-close-'));
  const path = join(directory, 'bungee.db');
  const locks: MasterInstanceLock[] = [];
  const acquire = stopped.acquireStoppedInstanceLock;
  const capture = spyOn(stopped, 'acquireStoppedInstanceLock').mockImplementation(async (...args) => {
    const lock = await acquire(...args); locks.push(lock); return lock;
  });
  try { await operation(path, locks); }
  finally {
    capture.mockRestore();
    for (const lock of locks) await lock.release();
    await rm(directory, { recursive: true, force: true });
  }
}

test('initialization retains all locks after a plugin close failure and still closes config storage', async () => {
  await fixture(async path => {
    const openPlugin = PluginStateClient.open;
    const openConfig = AsyncConfigRepository.open;
    let configClosed = false;
    const plugin = spyOn(PluginStateClient, 'open').mockImplementation(async (...args) => {
      const client = await openPlugin(...args); const close = client.close.bind(client);
      client.close = async () => { await close(); throw new Error('injected plugin close failure'); };
      return client;
    });
    const config = spyOn(AsyncConfigRepository, 'open').mockImplementation(async (...args) => {
      const client = await openConfig(...args); const close = client.close.bind(client);
      client.close = async () => { await close(); configClosed = true; }; return client;
    });
    try {
      const failure = await initializeConfigurationDatabase({ configDbPath: path }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(configClosed).toBe(true);
      for (const lockPath of [path + '.lock', join(path, '..', 'plugin-state.db.lock'), join(path, '..', 'ingress.instance.lock'), join(process.cwd(), 'logs/access.db.lock')]) {
        await expect(acquireMasterInstanceLock(lockPath)).rejects.toThrow('held');
      }
    } finally { plugin.mockRestore(); config.mockRestore(); }
  });
});

test('offline recovery preserves its original error and the locks when config close is unconfirmed', async () => {
  await fixture(async path => {
    await initializeConfigurationDatabase({ configDbPath: path });
    const openConfig = AsyncConfigRepository.open;
    const config = spyOn(AsyncConfigRepository, 'open').mockImplementation(async (...args) => {
      const client = await openConfig(...args); const close = client.close.bind(client);
      client.close = async () => { await close(); throw new Error('injected config close failure'); }; return client;
    });
    try {
      const failure = await recoverOffline(path, { kind: 'identity', plugin: 'local-accounts', payload: {} }).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.cause).toHaveProperty('message', 'invalid_password');
      expect(failure.errors.some((error: Error) => error.message === 'injected config close failure')).toBe(true);
      await expect(acquireMasterInstanceLock(path + '.lock')).rejects.toThrow('held');
    } finally { config.mockRestore(); }
  });
});

test('invalid secret material opens no plugin Worker and permits corrected offline calls in the same process', async () => {
  await fixture(async path => {
    const previous = process.env.BUNGEE_PLUGIN_SECRETS_KEY;
    try {
      process.env.BUNGEE_PLUGIN_SECRETS_KEY = 'invalid-key';
      await expect(initializeConfigurationDatabase({ configDbPath: path })).rejects.toThrow();
      await expect(recoverOffline(path, { kind: 'identity', plugin: 'local-accounts', payload: {} })).rejects.toThrow();
      if (previous === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previous;
      await initializeConfigurationDatabase({ configDbPath: path });
      await expect(recoverOffline(path, { kind: 'identity', plugin: 'local-accounts', payload: {} })).rejects.toThrow('invalid_password');
      await initializeConfigurationDatabase({ configDbPath: path });
    } finally {
      if (previous === undefined) delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
      else process.env.BUNGEE_PLUGIN_SECRETS_KEY = previous;
    }
  });
});

test('rejected storage open keeps the locks and independently cleans up every acquired resource', async () => {
  await fixture(async path => {
    const closed: number[] = [];
    const primary = new Error('open failed without closure proof');
    const failure = await withOfflineStorageSession(path, async session => {
      await session.open(async () => ({ close: async () => { closed.push(1); throw new Error('close failed'); } }));
      await session.open(async () => ({ close: async () => { closed.push(2); } }));
      await session.open(async () => { throw primary; });
    }).catch(error => error);
    expect(failure.cause).toBe(primary);
    expect(closed).toEqual([2, 1]);
    expect(failure.errors.at(-1).resourceUnreleased).toBe(true);
    await expect(acquireMasterInstanceLock(path + '.lock')).rejects.toThrow('held');
  });
});
