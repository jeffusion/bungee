import { describe, expect, test } from 'bun:test';
import {
  captureProcessIdentity,
  probeProcessIdentity,
  ProcessIdentityMissingError,
  ProcessIdentityUnavailableError,
  resolveWindowsPowerShell,
  type CapturedProcessIdentity,
  type LivenessFn,
  type ProcessIdentityDeps,
  type RealpathFn,
} from '../../src/master-runtime/process-identity';

const INSTANCE = '0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_INSTANCE = '99999999-8888-4777-8666-555555555555';
const MARKER = `--bungee-process-identity=${INSTANCE}`;
const PID = 321;
const WORKER_ARGV = ['/usr/bin/bun', 'src/main.ts', MARKER];
const DARWIN_PID = 777;
const DARWIN_LSTART = 'Thu Sep 18 09:15:20 2026';
const DARWIN_EXECUTABLE = '/usr/local/bin/bun';
const DARWIN_ARGV = [DARWIN_EXECUTABLE, 'src/main.ts', MARKER];

function linuxStat(starttime: string, state = 'S'): string {
  // fields[0] after "(comm)" is state (stat field 3); starttime (field 22) is fields[19].
  return `${PID} (bun) ${state} ${'0 '.repeat(18)}${starttime} 0 0`;
}

function enoent(): NodeJS.ErrnoException { return Object.assign(new Error('no such file'), { code: 'ENOENT' }); }

function linuxDeps(stat: () => string, argv: readonly string[], realpath: RealpathFn = async () => '/usr/bin/bun'): ProcessIdentityDeps {
  return {
    platform: 'linux',
    readFile: async (path: string) => {
      if (path === `/proc/${PID}/stat`) return stat();
      if (path === `/proc/${PID}/cmdline`) return `${argv.join('\0')}\0`;
      throw enoent();
    },
    realpath,
  };
}

function kernProcargs2(executable: string, argv: readonly string[]): Buffer {
  const argc = Buffer.alloc(4);
  argc.writeUInt32LE(argv.length, 0);
  return Buffer.concat([argc, Buffer.from(`${executable}\0`), ...argv.map((argument) => Buffer.from(`${argument}\0`))]);
}

function macosDeps(exec: (file: string, options: object) => Promise<{ stdout: string | Buffer }>, liveness?: LivenessFn): ProcessIdentityDeps {
  return { platform: 'darwin', execFile: async (_file, _args, options) => exec(_file, options), liveness };
}

function psFailure(): Error { return Object.assign(new Error('ps: no such process'), { code: 1 }); }

describe('process identity', () => {
  test('linux capture and probe are exact', async () => {
    const deps = linuxDeps(() => linuxStat('100'), WORKER_ARGV);
    const identity = await captureProcessIdentity(PID, INSTANCE, deps);
    expect(identity).toEqual({ pid: PID, startToken: '100', executable: '/usr/bin/bun', processInstanceId: INSTANCE });
    expect(await probeProcessIdentity(identity, deps)).toBe('exact');
  });

  test('linux missing process is dead', async () => {
    const deps = linuxDeps(() => { throw enoent(); }, WORKER_ARGV);
    const expected: CapturedProcessIdentity = { pid: PID, startToken: '100', executable: '/usr/bin/bun', processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(PID, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityMissingError);
    expect(await probeProcessIdentity(expected, deps)).toBe('dead');
  });

  test('linux requires two consistent samples', async () => {
    let reads = 0;
    const deps = linuxDeps(() => linuxStat(reads++ % 2 === 0 ? '100' : '999'), WORKER_ARGV);
    let error: unknown;
    try { await captureProcessIdentity(PID, INSTANCE, deps); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProcessIdentityUnavailableError);
    expect((error as Error).message).not.toContain(MARKER);
    const expected: CapturedProcessIdentity = { pid: PID, startToken: '100', executable: '/usr/bin/bun', processInstanceId: INSTANCE };
    expect(await probeProcessIdentity(expected, deps)).toBe('unknown');
  });

  test('linux exe ENOENT with live stat is unavailable, not dead', async () => {
    const deps = linuxDeps(() => linuxStat('100'), WORKER_ARGV, async () => { throw enoent(); });
    const expected: CapturedProcessIdentity = { pid: PID, startToken: '100', executable: '/usr/bin/bun', processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(PID, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, deps)).toBe('unknown');
  });

  test('capture rejects processes without the exact identity marker', async () => {
    const stat = () => linuxStat('100');
    const noMarker = linuxDeps(stat, ['/usr/bin/bun', 'src/main.ts']);
    await expect(captureProcessIdentity(PID, INSTANCE, noMarker)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    const wrong = linuxDeps(stat, ['/usr/bin/bun', 'src/main.ts', `--bungee-process-identity=${OTHER_INSTANCE}`]);
    await expect(captureProcessIdentity(PID, INSTANCE, wrong)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    const duplicate = linuxDeps(stat, ['/usr/bin/bun', 'src/main.ts', MARKER, MARKER]);
    await expect(captureProcessIdentity(PID, INSTANCE, duplicate)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
  });

  test('windows prefers pwsh, queries one pid via ManagementObjectSearcher, and never Get-CimInstance', async () => {
    const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const calls: { file: string; args: readonly string[] }[] = [];
    const record = {
      ProcessId: 4242,
      CreationDate: '2026-09-18T08:00:00.0000000+00:00',
      ExecutablePath: 'C:\\bungee\\bun.exe',
      CommandLine: `"C:\\bungee\\bun.exe" dist/main.js ${MARKER}`,
    };
    const deps: ProcessIdentityDeps = {
      platform: 'win32',
      windowsPowerShell: () => PWSH,
      execFile: async (file, args) => { calls.push({ file, args }); return { stdout: JSON.stringify(record) }; },
    };
    const identity = await captureProcessIdentity(4242, INSTANCE, deps);
    const script = calls[0]?.args[3] ?? '';
    expect(calls[0]?.file).toBe(PWSH);
    expect(script.startsWith("$ErrorActionPreference='Stop'")).toBe(true);
    expect(script).toContain('System.Management.ManagementObjectSearcher');
    expect(script).toContain('Win32_Process');
    expect(script).toContain('ProcessId=4242');
    expect(script).not.toContain('Get-CimInstance');
    expect(identity).toEqual({ pid: 4242, startToken: record.CreationDate, executable: 'C:\\bungee\\bun.exe', processInstanceId: INSTANCE });
    expect(await probeProcessIdentity(identity, deps)).toBe('exact');
  });

  test('windows falls back to powershell.exe when the resolver says so', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const record = {
      ProcessId: 4242,
      CreationDate: '2026-09-18T08:00:00.0000000+00:00',
      ExecutablePath: 'C:\\bungee\\bun.exe',
      CommandLine: `"C:\\bungee\\bun.exe" dist/main.js ${MARKER}`,
    };
    const deps: ProcessIdentityDeps = {
      platform: 'win32',
      windowsPowerShell: () => 'powershell.exe',
      execFile: async (file, args) => { calls.push({ file, args }); return { stdout: JSON.stringify(record) }; },
    };
    await expect(captureProcessIdentity(4242, INSTANCE, deps)).resolves.toMatchObject({ pid: 4242 });
    expect(calls[0]?.file).toBe('powershell.exe');
    expect((calls[0]?.args[3] ?? '')).not.toContain('Get-CimInstance');
  });

  test('resolveWindowsPowerShell prefers an installed pwsh and falls back without one', () => {
    const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    expect(resolveWindowsPowerShell('C:\\Program Files', () => true)).toBe(PWSH);
    expect(resolveWindowsPowerShell('C:\\Program Files', () => false)).toBe('powershell.exe');
    expect(resolveWindowsPowerShell(undefined, () => true)).toBe('powershell.exe');
    const seen: string[] = [];
    resolveWindowsPowerShell('C:\\Program Files', (path) => { seen.push(path); return false; });
    expect(seen).toEqual([PWSH]);
  });

  test('windows malformed output is unknown', async () => {
    const deps: ProcessIdentityDeps = { platform: 'win32', execFile: async () => ({ stdout: 'not-json{' }) };
    const expected: CapturedProcessIdentity = { pid: 4242, startToken: 'x', executable: 'C:\\bungee\\bun.exe', processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(4242, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, deps)).toBe('unknown');
  });

  test('windows record pid mismatch is unavailable', async () => {
    const record = {
      ProcessId: 9999,
      CreationDate: '2026-09-18T08:00:00.0000000+00:00',
      ExecutablePath: 'C:\\bungee\\bun.exe',
      CommandLine: `"C:\\bungee\\bun.exe" dist/main.js ${MARKER}`,
    };
    const deps: ProcessIdentityDeps = { platform: 'win32', execFile: async () => ({ stdout: JSON.stringify(record) }) };
    const expected: CapturedProcessIdentity = { pid: 4242, startToken: record.CreationDate, executable: 'C:\\bungee\\bun.exe', processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(4242, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, deps)).toBe('unknown');
  });

  test('macos capture and probe are exact', async () => {
    const sysctlOptions: object[] = [];
    const deps = macosDeps(async (file, options) => {
      if (file === 'sysctl') {
        sysctlOptions.push(options);
        return { stdout: kernProcargs2(DARWIN_EXECUTABLE, DARWIN_ARGV) };
      }
      if (file === 'ps') return { stdout: `${DARWIN_LSTART}\n` };
      throw new Error(`unexpected command ${file}`);
    });
    const identity = await captureProcessIdentity(DARWIN_PID, INSTANCE, deps);
    expect(identity).toEqual({ pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE });
    expect(await probeProcessIdentity(identity, deps)).toBe('exact');
    // The raw KERN_PROCARGS2 sampler must request a Buffer, never a UTF-8 string decode.
    expect(sysctlOptions.length).toBeGreaterThan(0);
    for (const options of sysctlOptions) {
      expect((options as { readonly encoding?: unknown }).encoding).toBe('buffer');
    }
  });

  test('macos argv with an embedded-space marker never matches exactly', async () => {
    const argv = [DARWIN_EXECUTABLE, 'src/main.ts', `--bungee-process-identity=abc def`];
    const deps = macosDeps(async (file) => {
      if (file === 'sysctl') return { stdout: kernProcargs2(DARWIN_EXECUTABLE, argv) };
      if (file === 'ps') return { stdout: `${DARWIN_LSTART}\n` };
      throw new Error(`unexpected command ${file}`);
    });
    const expected: CapturedProcessIdentity = { pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, deps)).toBe('mismatch');
  });

  test('macos ps failure is dead only when liveness confirms death', async () => {
    const sysctlOk = () => ({ stdout: kernProcargs2(DARWIN_EXECUTABLE, DARWIN_ARGV) });
    const expected: CapturedProcessIdentity = { pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE };
    const dead = macosDeps(async (file) => file === 'sysctl' ? sysctlOk() : (() => { throw psFailure(); })(), async () => 'dead');
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, dead)).rejects.toBeInstanceOf(ProcessIdentityMissingError);
    expect(await probeProcessIdentity(expected, dead)).toBe('dead');
    const unknown = macosDeps(async (file) => file === 'sysctl' ? sysctlOk() : (() => { throw psFailure(); })(), async () => 'unknown');
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, unknown)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, unknown)).toBe('unknown');
  });

  test('wrong or duplicate marker mismatches', async () => {
    const expected: CapturedProcessIdentity = { pid: PID, startToken: '100', executable: '/usr/bin/bun', processInstanceId: INSTANCE };
    const wrong = linuxDeps(() => linuxStat('100'), ['/usr/bin/bun', 'src/main.ts', `--bungee-process-identity=${OTHER_INSTANCE}`]);
    expect(await probeProcessIdentity(expected, wrong)).toBe('mismatch');
    const duplicate = linuxDeps(() => linuxStat('100'), ['/usr/bin/bun', 'src/main.ts', MARKER, MARKER]);
    expect(await probeProcessIdentity(expected, duplicate)).toBe('mismatch');
  });

  test('startToken change from pid reuse mismatches', async () => {
    let starttime = '100';
    const deps = linuxDeps(() => linuxStat(starttime), WORKER_ARGV);
    const identity = await captureProcessIdentity(PID, INSTANCE, deps);
    starttime = '200';
    expect(await probeProcessIdentity(identity, deps)).toBe('mismatch');
  });
});

