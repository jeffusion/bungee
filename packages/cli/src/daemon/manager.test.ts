import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BinaryManager } from '../binary/manager';
import { ConfigPaths } from '../config/paths';
import { createLaunchingDaemonMetadataFile, readDaemonMetadataFile, transitionDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { createTestManager, makeCanonicalTempDir, optionsFor } from './test-support';

import type { DaemonManager } from './manager';

const spawnCalls: Array<{ readonly executable: string; readonly options: SpawnOptions }> = [];
const directories: string[] = [];
const originalTestMarker = process.env.BUNGEE_CLI_TEST_MARKER;

type KillCall = { readonly pid: number; readonly signal: NodeJS.Signals | number };

afterEach(async () => {
  spawnCalls.length = 0;
  if (originalTestMarker === undefined) delete process.env.BUNGEE_CLI_TEST_MARKER;
  else process.env.BUNGEE_CLI_TEST_MARKER = originalTestMarker;
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
  mock.restore();
});

async function startManager(
  startupSucceeds = true,
  options: { readonly workers?: string; readonly port?: string } = {},
): Promise<{ readonly output: readonly string[]; readonly logFile: string }> {
  const directory = makeCanonicalTempDir('bungee-daemon-manager');
  directories.push(directory);
  const file = optionsFor(directory);
  const manager = createTestManager((executable, _args, options) => {
    spawnCalls.push({ executable, options });
    if (startupSucceeds) {
      const metadataPath = join(directory, 'daemon.json');
      void readDaemonMetadataFile(metadataPath, file).then(async (launching) => {
        const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242,
          instance_id: null, management_host: null, management_port: null };
        await transitionDaemonMetadataFile(metadataPath, {
          expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
        }, file);
        await transitionDaemonMetadataFile(metadataPath, {
          expectedBootNonce: launching.boot_nonce, expectedState: 'starting', expectedShutdownSecret: launching.shutdown_secret,
          next: { ...starting, state: 'armed', instance_id: '11111111-1111-4111-8111-111111111111', management_host: '127.0.0.1', management_port: 8089 },
        }, file);
      });
    }
    return { pid: 4242, unref() {} };
  }, undefined, {
    runtimeDirectory: directory, windowsAcl: file.windowsAcl,
    directLaunch: { executable: process.execPath, entrypoint: null },
    probeProcess: async () => startupSucceeds ? 'exact' : 'dead',
  });
  manager['pidFile'] = join(directory, 'bungee.pid');
  manager['logFile'] = join(directory, 'bungee.log');
  manager['errorLogFile'] = join(directory, 'bungee.error.log');
  spyOn(BinaryManager, 'ensureBinary').mockResolvedValue(process.execPath);
  const output: string[] = [];
  spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  });

  const start = manager.start(options);
  if (startupSucceeds) await start;
  else expect(await start.catch((error: unknown) => error)).toBeInstanceOf(Error);
  expect(await readFile(manager['logFile'], 'utf8')).toBe('');
  expect(await readFile(manager['errorLogFile'], 'utf8')).toBe('');
  return { output, logFile: manager['logFile'] };
}

async function stopManager(
  kill: (pid: number, signal: NodeJS.Signals | number) => void,
  options: { readonly responseStatus?: number; readonly forceStop?: (metadata: DaemonMetadataV1) => Promise<void>; readonly now?: () => number; readonly sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<{ readonly manager: DaemonManager; readonly pidFile: string; readonly calls: KillCall[] }> {
  const directory = makeCanonicalTempDir('bungee-daemon-stop');
  directories.push(directory);
  const file = optionsFor(directory);
  const pidFile = join(directory, 'bungee.pid');
  const calls: KillCall[] = [];
  let alive = true;
  const manager = createTestManager(
    () => ({ pid: 4242, unref() {} }),
    { kill: (pid, signal) => { calls.push({ pid, signal }); kill(pid, signal); } },
    { runtimeDirectory: directory, windowsAcl: file.windowsAcl, now: options.now, sleep: options.sleep, probeProcess: async () => alive ? 'exact' : 'dead',
      findProcess: async () => 'none',
      httpRequest: async () => {
        if ((options.responseStatus ?? 202) === 202) alive = false;
        return new Response((options.responseStatus ?? 202) === 202 ? JSON.stringify({
          status: 'accepted', boot_nonce: '11111111-1111-4111-8111-111111111111',
          instance_id: '22222222-2222-4222-8222-222222222222', pid: 4242,
        }) : 'not found', { status: options.responseStatus ?? 202 });
      }, forceStop: options.forceStop },
  );
  manager['pidFile'] = pidFile;
  await writeFile(pidFile, '4242');
  const metadataPath = join(directory, 'daemon.json');
  const launching: DaemonMetadataV1 = {
    schema: 'bungee-daemon-metadata-v1', state: 'launching', launcher_pid: process.pid,
    boot_nonce: '11111111-1111-4111-8111-111111111111', executable: process.execPath,
    shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', entrypoint: null,
    pid: null, instance_id: null, management_host: null, management_port: null,
  };
  await createLaunchingDaemonMetadataFile(metadataPath, launching, file);
  const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242,
    instance_id: null, management_host: null, management_port: null };
  await transitionDaemonMetadataFile(metadataPath, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
  }, file);
  await transitionDaemonMetadataFile(metadataPath, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'starting', expectedShutdownSecret: launching.shutdown_secret,
    next: { ...starting, state: 'armed', instance_id: '22222222-2222-4222-8222-222222222222', management_host: '127.0.0.1', management_port: 8089 },
  }, file);
  return { manager, pidFile, calls };
}

describe('DaemonManager start', () => {
  test('does not expose ACL process output when metadata inspection fails', async () => {
    const directory = makeCanonicalTempDir('bungee-daemon-acl-diagnostic');
    directories.push(directory);
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'powershell.exe'), '#!/bin/sh\nprintf \'path=/tmp secret=hidden\' >&2\nexit 17\n');
    await chmod(join(bin, 'powershell.exe'), 0o755);
    const previousPath = process.env.PATH;
    const previousProfile = process.env.USERPROFILE;
    process.env.PATH = bin;
    process.env.USERPROFILE = dirname(directory);
    try {
      const manager = createTestManager(undefined, undefined, {
        runtimeDirectory: directory, filePlatform: 'win32', windowsAcl: undefined,
        directLaunch: { executable: process.execPath, entrypoint: null },
      });
      const error = await manager.start().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Cannot safely inspect daemon metadata: acl_operation=read outcome=exit last_phase=null killed=false');
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toContain(directory);
      expect((error as Error).message).not.toContain('path=/tmp');
      expect((error as Error).message).not.toContain('secret=hidden');
    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
    }
  });

  test('spawns a detached daemon with isolated logs and current output', async () => {
    const { output, logFile } = await startManager();
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('expected daemon spawn');

    expect(call.options.detached).toBe(true);
    expect(call.options.stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(output).toEqual([
      '✅ Bungee daemon started successfully',
      '📋 PID: 4242',
      `💾 Data: ${ConfigPaths.DATA_DIR}`,
      `📝 Logs: ${logFile}`,
    ]);
  });

  test('passes current options and inherited environment to the daemon', async () => {
    process.env.BUNGEE_CLI_TEST_MARKER = 'inherited';

    await startManager(true, { workers: '4', port: '9091' });
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('expected daemon spawn');

    expect(call.options.cwd).toBe(ConfigPaths.DATA_DIR);
    expect(call.options.env?.BUNGEE_CLI_TEST_MARKER).toBe('inherited');
    expect(call.options.env?.WORKER_COUNT).toBe('4');
    expect(call.options.env?.PORT).toBe('9091');
    expect(call.options.env?.DAEMON_MODE).toBe('true');
  });

  test('does not print success output when startup fails', async () => {
    const { output } = await startManager(false);
    const call = spawnCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error('expected daemon spawn');

    expect(output).toEqual([]);
    expect(call.options.env?.BUNGEE_CONFIG_DB_PATH).toBe(join(ConfigPaths.DATA_DIR, 'bungee.db'));
    expect(call.options.env?.BUNGEE_ACCESS_DB_PATH).toBe(join(ConfigPaths.LOGS_DIR, 'access.db'));
  });
});

describe('DaemonManager stop and status', () => {
  test('stops through the authenticated RPC without signaling the root PID', async () => {
    const { manager, pidFile, calls } = await stopManager(() => {});
    await manager.stop();
    expect(calls).toEqual([]);
    expect(await Bun.file(pidFile).exists()).toBe(false);
    expect(await manager.isRunning()).toBe(false);
  });

  test('retries failed graceful RPCs and invokes force only after the deadline', async () => {
    let forcedAt = -1; let clock = 0;
    const { manager, pidFile, calls } = await stopManager(() => {}, {
      responseStatus: 404,
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
      forceStop: async () => { forcedAt = clock; },
    });
    manager['stopTimeoutMs'] = 300;
    await expect(manager.stop()).rejects.toThrow('Forced daemon stop did not prove process exit');
    expect(forcedAt).toBeGreaterThanOrEqual(300);
    expect(calls).toEqual([]);
    expect(await Bun.file(pidFile).exists()).toBe(true);
  });

  test('restart awaits stop before starting and does not sleep between them', async () => {
    const { manager } = await stopManager(() => {});
    const ensureBinary = spyOn(BinaryManager, 'ensureBinary').mockResolvedValue(process.execPath);
    manager['startTimeoutMs'] = 0;
    const startedAt = Date.now();
    await expect(manager.restart()).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(ensureBinary).toHaveBeenCalledTimes(1);
  });
});
