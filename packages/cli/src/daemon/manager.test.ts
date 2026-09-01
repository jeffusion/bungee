import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinaryManager } from '../binary/manager';
import { ConfigPaths } from '../config/paths';

const spawnCalls: Array<{ readonly executable: string; readonly options: SpawnOptions }> = [];

mock.module('child_process', () => ({
  spawn(executable: string, _args: readonly string[], options: SpawnOptions) {
    spawnCalls.push({ executable, options });
    return { pid: 4242, unref() {} };
  },
}));

const { DaemonManager } = await import('./manager');
const directories: string[] = [];
const originalTestMarker = process.env.BUNGEE_CLI_TEST_MARKER;

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
  const manager = new DaemonManager();
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
