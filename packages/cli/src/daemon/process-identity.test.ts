import { describe, expect, test } from 'bun:test';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { canonicalProcessPath, exactBootMarker, findExactDaemonProcess, findExactDaemonProcessDetailed, parseCommandLine, probeDaemonProcess, TargetProcessMissingError } from './process-identity';
import { readDarwinProcessSnapshot } from './process-tree';
import { makeCanonicalTempDir } from './test-support';

const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';
const testExecutable = process.execPath;

describe('CLI process identity parsing', () => {
  test('requires an exact marker token', () => {
    expect(exactBootMarker(['bun', join('fixtures', 'main.ts'), `--bungee-daemon-boot=${BOOT}`], BOOT)).toBe(true);
    expect(exactBootMarker(['bun', `--bungee-daemon-boot=${BOOT}x`], BOOT)).toBe(false);
    expect(exactBootMarker(['bun', `--bungee-daemon-boot=${BOOT}`, `--bungee-daemon-boot=${BOOT}`], BOOT)).toBe(false);
  });

  test('parses quoted Windows arguments and folds Windows paths', () => {
    expect(parseCommandLine('"C:\\Program Files\\bun.exe" "C:\\App Dir\\main.ts"', 'win32'))
      .toEqual(['C:\\Program Files\\bun.exe', 'C:\\App Dir\\main.ts']);
    expect(canonicalProcessPath('C:\\APP\\BUN.EXE', 'win32')).toBe('c:/app/bun.exe');
  });

  test('only treats explicit target-missing probes as dead', async () => {
    const expected = { executable: win32.join('C:\\', 'Bun', 'bun.exe'), entrypoint: null };
    const missing = async () => { throw Object.assign(new Error('missing target'), { code: 3 }); };
    expect(await probeDaemonProcess(42, expected, BOOT, { platform: 'win32', execFile: missing })).toBe('dead');
    const toolMissing = async () => { throw Object.assign(new Error('powershell unavailable'), { code: 'ENOENT' }); };
    expect(await probeDaemonProcess(42, expected, BOOT, { platform: 'win32', execFile: toolMissing })).toBe('unknown');
    const psMissing = async () => ({ stdout: '' });
    expect(await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, { platform: 'darwin', execFile: psMissing })).toBe('dead');
    const psToolMissing = async () => { throw Object.assign(new Error('ps unavailable'), { code: 'ENOENT' }); };
    expect(await probeDaemonProcess(42, expected, BOOT, { platform: 'darwin', execFile: psToolMissing })).toBe('unknown');
  });

  test('does not turn unrelated /proc errors into dead', async () => {
    const expected = { executable: testExecutable, entrypoint: null };
    const missing = async () => { throw Object.assign(new Error('missing target'), { code: 'ENOENT' }); };
    expect(await probeDaemonProcess(42, expected, BOOT, { platform: 'linux', readFile: missing })).toBe('dead');
    const denied = async () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); };
    expect(await probeDaemonProcess(42, expected, BOOT, { platform: 'linux', readFile: denied })).toBe('unknown');
    expect(TargetProcessMissingError).toBeDefined();
  });

  test('normalizes only the Linux proc deleted suffix and preserves fail-closed identity results', async () => {
    const stat = '(bun) S 1 1 1 1 1 1';
    const readFile = async (path: string, encoding?: unknown) => path.endsWith('/stat') ? stat : Buffer.from(`bun\0--bungee-daemon-boot=${BOOT}\0`);
    const deleted = await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, {
      platform: 'linux', readFile: readFile as never, realpath: (async () => `${testExecutable} (deleted)`) as never,
    });
    expect(deleted).toBe('exact');
    expect(await probeDaemonProcess(42, { executable: `${testExecutable} (deleted)`, entrypoint: null }, BOOT, {
      platform: 'linux', readFile: readFile as never, realpath: (async () => `${testExecutable} (deleted)`) as never,
    })).toBe('unknown');
    const noMarker = async (path: string) => path.endsWith('/stat') ? stat : Buffer.from('bun\0other\0');
    expect(await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, {
      platform: 'linux', readFile: noMarker as never, realpath: (async () => { throw new Error('canonicalization failed'); }) as never,
    })).toBe('mismatch');
    expect(await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, {
      platform: 'linux', readFile: readFile as never, realpath: (async () => { throw new Error('canonicalization failed'); }) as never,
    })).toBe('unknown');
  });

  test('does not turn Darwin ps exit 1 into dead without an explicit liveness result', async () => {
    const psExit = async () => { throw Object.assign(new Error('ps no row'), { code: 1 }); };
    expect(await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, {
      platform: 'darwin', execFile: psExit, liveness: async () => 'dead',
    })).toBe('dead');
    expect(await probeDaemonProcess(42, { executable: testExecutable, entrypoint: null }, BOOT, {
      platform: 'darwin', execFile: psExit, liveness: async () => 'alive',
    })).toBe('unknown');
  });

  test('classifies Windows marker query outcomes with fixed reasons', async () => {
    const error = (code: string, extra: Record<string, unknown> = {}) => async () => {
      throw Object.assign(new Error('raw process query must not escape'), { code, ...extra });
    };
    const cases = [
      ['query_timeout', error('ETIMEDOUT', { killed: true })],
      ['query_exit', error('1')],
      ['spawn_error', error('ENOENT')],
      ['access_denied', error('EACCES')],
      ['parse_error', async () => ({ stdout: '{not-json' })],
      ['incomplete', async () => ({ stdout: '{}' })],
    ] as const;
    for (const [reason, execFile] of cases) {
      expect(await findExactDaemonProcessDetailed(BOOT, { platform: 'win32', execFile: execFile as never }))
        .toEqual({ status: 'unknown', reason });
    }
    const marker = `--bungee-daemon-boot=${BOOT}`;
    expect(await findExactDaemonProcessDetailed(BOOT, {
      platform: 'win32', execFile: async () => ({ stdout: JSON.stringify({ CommandLine: `bun.exe ${marker}` }) }),
    })).toEqual({ status: 'found', reason: null });
    expect(await findExactDaemonProcessDetailed(BOOT, {
      platform: 'win32', execFile: async () => ({ stdout: JSON.stringify({ CommandLine: 'bun.exe' }) }),
    })).toEqual({ status: 'none', reason: null });
    expect(await findExactDaemonProcess(BOOT, {
      platform: 'win32', execFile: async () => ({ stdout: JSON.stringify({ CommandLine: 'bun.exe' }) }),
    })).toBe('none');
  });

  test('reads Darwin stopped states and reports an empty ps row as target missing', async () => {
    const marker = `--bungee-daemon-boot=${BOOT}`;
    const row = `42 1 100 Ts Mon Jan  1 00:00:00 2024 ${process.execPath} ${marker}`;
    const exec = async (file: string) => ({ stdout: file === 'ps' ? row : `p42\nn${process.execPath}\n` });
    const snapshot = await readDarwinProcessSnapshot(42, { execFile: exec as never });
    expect(snapshot.state).toBe('Ts');
    expect(snapshot.rawCommand).toBe(`${process.execPath} ${marker}`);
    const emptyExec = (async () => ({ stdout: '' })) as never;
    await expect(readDarwinProcessSnapshot(42, { execFile: emptyExec })).rejects.toBeInstanceOf(TargetProcessMissingError);
  });

  test('Darwin uses fixed-locale raw command topology and lsof executable paths with spaces', async () => {
    const directory = makeCanonicalTempDir('bungee-darwin-snapshot');
    const executable = join(directory, 'Bun Runtime With Spaces');
    await writeFile(executable, 'test');
    const physicalExecutable = await realpath(executable);
    try {
      let psArgs: readonly string[] = []; let lsofArgs: readonly string[] = [];
      const marker = `--bungee-daemon-boot=${BOOT}`;
      const exec = async (file: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        expect(options.env?.LC_ALL).toBe('C'); expect(options.env?.LANG).toBe('C');
        if (file === 'ps') { psArgs = args; return { stdout: `42 1 100 Ts Mon Jan  1 00:00:00 2024 "${executable}" ${marker}` }; }
        lsofArgs = args; return { stdout: `p42\nn${executable}\n` };
      };
      const snapshot = await readDarwinProcessSnapshot(42, { execFile: exec as never });
      expect(snapshot.state.startsWith('T')).toBe(true);
      expect(snapshot.executable).toBe(physicalExecutable);
      expect(snapshot.rawCommand).toBe(`"${executable}" ${marker}`);
      expect(psArgs).toContain('pid=,ppid=,uid=,state=,lstart=,command=');
      expect(lsofArgs).toEqual(['-a', '-p', '42', '-d', 'txt', '-Fn']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('Darwin ps exit 1 is dead only after injected liveness says dead', async () => {
    const psExit = async () => { throw Object.assign(new Error('no row'), { code: 1 }); };
    await expect(readDarwinProcessSnapshot(42, { execFile: psExit as never, liveness: async () => 'dead' })).rejects.toBeInstanceOf(TargetProcessMissingError);
    await expect(readDarwinProcessSnapshot(42, { execFile: psExit as never, liveness: async () => 'alive' })).rejects.toMatchObject({ code: 1 });
    const toolMissing = async () => { throw Object.assign(new Error('ps missing'), { code: 'ENOENT' }); };
    await expect(readDarwinProcessSnapshot(42, { execFile: toolMissing as never })).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
