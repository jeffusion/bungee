import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinaryManager } from '../binary/manager';
import { ConfigPaths } from '../config/paths';

import { DaemonManager } from './manager';

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
  const directory = await mkdtemp(join(tmpdir(), 'bungee-daemon-manager-'));
  directories.push(directory);
  const manager = new DaemonManager((executable, _args, options) => {
    spawnCalls.push({ executable, options });
    return { pid: 4242, unref() {} };
  });
  manager['pidFile'] = join(directory, 'bungee.pid');
  manager['logFile'] = join(directory, 'bungee.log');
  manager['errorLogFile'] = join(directory, 'bungee.error.log');
  let runningCheck = 0;
  manager.isRunning = async () => runningCheck++ > 0 && startupSucceeds;

  spyOn(BinaryManager, 'ensureBinary').mockResolvedValue('/tmp/fake-bungee');
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
): Promise<{ readonly manager: DaemonManager; readonly pidFile: string; readonly calls: KillCall[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-daemon-stop-'));
  directories.push(directory);
  const pidFile = join(directory, 'bungee.pid');
  const calls: KillCall[] = [];
  const manager = new DaemonManager(
    () => ({ pid: 4242, unref() {} }),
    { kill: (pid, signal) => { calls.push({ pid, signal }); kill(pid, signal); } },
  );
  manager['pidFile'] = pidFile;
  await writeFile(pidFile, '4242');
  return { manager, pidFile, calls };
}

describe('DaemonManager start', () => {
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
  test('defines running by the numeric PID file, without probing process health', async () => {
    const { manager } = await stopManager(() => {
      throw new Error('process probe should not be called');
    });

    expect(await manager.isRunning()).toBe(true);
    expect((await manager.getStatus()).running).toBe(true);
  });

  test('sends exactly one SIGTERM and clears the PID file after normal exit', async () => {
    let alive = true;
    const { manager, pidFile, calls } = await stopManager((_pid, signal) => {
      if (signal === 'SIGTERM') alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });

    await manager.stop();

    expect(calls.filter(({ signal }) => signal === 'SIGTERM')).toHaveLength(1);
    expect(calls.some(({ signal }) => signal === 'SIGKILL')).toBe(false);
    expect(await Bun.file(pidFile).exists()).toBe(false);
  });

  test('treats ESRCH as stopped and clears the PID file', async () => {
    const { manager, pidFile, calls } = await stopManager((_pid, signal) => {
      if (signal === 'SIGTERM') throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });

    await manager.stop();

    expect(calls).toEqual([{ pid: 4242, signal: 'SIGTERM' }]);
    expect(await Bun.file(pidFile).exists()).toBe(false);
  });

  test('retains the PID file and propagates non-ESRCH kill errors', async () => {
    const { manager, pidFile } = await stopManager(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    await expect(manager.stop()).rejects.toThrow('permission denied');
    expect(await Bun.file(pidFile).exists()).toBe(true);
  });

  test('retains the PID file on timeout without SIGKILL', async () => {
    const { manager, pidFile, calls } = await stopManager(() => {});
    manager['stopTimeoutMs'] = 0;

    await expect(manager.stop()).rejects.toThrow('PID file retained');

    expect(calls.filter(({ signal }) => signal === 'SIGTERM')).toHaveLength(1);
    expect(calls.some(({ signal }) => signal === 'SIGKILL')).toBe(false);
    expect(await Bun.file(pidFile).exists()).toBe(true);
  });

  test('does not spawn during a restart when stop times out', async () => {
    const { manager } = await stopManager(() => {});
    manager['stopTimeoutMs'] = 0;
    const ensureBinary = spyOn(BinaryManager, 'ensureBinary');

    await expect(manager.restart()).rejects.toThrow('PID file retained');

    expect(ensureBinary).not.toHaveBeenCalled();
  });
});
