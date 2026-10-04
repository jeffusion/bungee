import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { readDaemonMetadataFile, transitionDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import { ConfigPaths } from '../config/paths';
import { createTestManager, makeCanonicalTempDir, optionsFor } from './test-support';

test('injected directories do not initialize the parent user directories', async () => {
  const directory = makeCanonicalTempDir('bungee-manager-fixture-directories');
  const spies = [ConfigPaths.ensureConfigDir, ConfigPaths.ensureDataDir, ConfigPaths.ensureLogsDir];
  const methods = ['ensureConfigDir', 'ensureDataDir', 'ensureLogsDir'] as const;
  const checks = methods.map(method => spyOn(ConfigPaths, method).mockImplementation(() => { throw new Error('parent directory touched'); }));
  try {
    const configDirectory = join(directory, 'config');
    const dataDirectory = join(directory, 'data');
    const logsDirectory = join(directory, 'logs');
    createTestManager(undefined, undefined, { configDirectory, dataDirectory, logsDirectory,
      runtimeDirectory: join(directory, 'run') });
    for (const path of [configDirectory, dataDirectory, logsDirectory]) expect(existsSync(path)).toBe(true);
    for (const check of checks) expect(check).not.toHaveBeenCalled();
  } finally {
    for (let i = 0; i < checks.length; i++) { checks[i]!.mockRestore(); expect(ConfigPaths[methods[i]!]).toBe(spies[i]!); }
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [undefined, 35_000, false],
  [60_000, 35_000, true],
  [60_000, 65_000, false],
] as const)('startup budget %s at readiness %ims, accepted=%s', async (startupTimeoutMs, readyAt, accepted) => {
  const directory = makeCanonicalTempDir('bungee-manager-startup-budget', { daemonSafe: true });
  const file = optionsFor(directory);
  const metadataPath = join(directory, 'daemon.json');
  let now = 0;
  let armed = false;
  try {
    const manager = createTestManager(() => ({ pid: 4242, unref() {} }), undefined, {
      runtimeDirectory: directory, configDirectory: directory, dataDirectory: directory, logsDirectory: directory,
      pidFile: join(directory, 'bungee.pid'), logFile: join(directory, 'bungee.log'), errorLogFile: join(directory, 'bungee.error.log'),
      directLaunch: { executable: process.execPath, entrypoint: null }, startupTimeoutMs,
      probeProcess: async () => 'exact', now: () => now,
      sleep: async ms => {
        now += Math.max(ms, 1_000);
        if (armed || now < readyAt) return;
        armed = true;
        const launching = await readDaemonMetadataFile(metadataPath, file);
        const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242,
          instance_id: null, management_host: null, management_port: null };
        await transitionDaemonMetadataFile(metadataPath, { expectedBootNonce: launching.boot_nonce,
          expectedShutdownSecret: launching.shutdown_secret, expectedState: 'launching', next: starting }, file);
        await transitionDaemonMetadataFile(metadataPath, { expectedBootNonce: launching.boot_nonce,
          expectedShutdownSecret: launching.shutdown_secret, expectedState: 'starting', next: {
            ...starting, state: 'armed', instance_id: '11111111-1111-4111-8111-111111111111', management_host: '127.0.0.1', management_port: 8089,
          } }, file);
      },
    });
    if (accepted) {
      await expect(manager.start()).resolves.toBeUndefined();
      expect(now).toBe(readyAt);
    } else {
      await expect(manager.start()).rejects.toThrow(`within ${(startupTimeoutMs ?? 30_000) / 1000} seconds`);
      expect(now).toBe(startupTimeoutMs ?? 30_000);
      expect((await readDaemonMetadataFile(metadataPath, file)).state).toBe('launching');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
