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
const DARWIN_PS_OUT = `${DARWIN_LSTART} ${DARWIN_EXECUTABLE} src/main.ts ${MARKER}\n`;
// The real runner maps extra non-dylib text images; the comm name must disambiguate.
const DARWIN_LSOF_OUT = `p${DARWIN_PID}\nn${DARWIN_EXECUTABLE}\nn/usr/lib/dyld\nn/usr/lib/libSystem.B.dylib\nn/opt/homebrew/lib/helper\n`;
const DARWIN_COMM = 'bun\n';

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

type RecordedExec = { file: string; args: readonly string[]; options: { readonly env?: NodeJS.ProcessEnv } };

function macosHarness(
  ps: string | Buffer,
  comm: string | Buffer,
  lsof: string | Buffer,
  liveness?: LivenessFn,
): { deps: ProcessIdentityDeps; calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  const deps: ProcessIdentityDeps = {
    platform: 'darwin',
    liveness,
    execFile: async (file, args, options) => {
      calls.push({ file, args, options: options as { readonly env?: NodeJS.ProcessEnv } });
      if (file === '/bin/ps') return { stdout: args.includes('comm=') ? comm : ps };
      if (file === '/usr/sbin/lsof') return { stdout: lsof };
      throw new Error(`unexpected command ${file}`);
    },
  };
  return { deps, calls };
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

  test('macos capture and probe are exact with absolute C-locale single-pid queries', async () => {
    const { deps, calls } = macosHarness(DARWIN_PS_OUT, DARWIN_COMM, DARWIN_LSOF_OUT);
    const identity = await captureProcessIdentity(DARWIN_PID, INSTANCE, deps);
    expect(identity).toEqual({ pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE });
    expect(await probeProcessIdentity(identity, deps)).toBe('exact');
    // sysctl is gone for good: only the absolute /bin/ps and /usr/sbin/lsof run.
    expect(calls.map(({ file }) => file).every((file) => file === '/bin/ps' || file === '/usr/sbin/lsof')).toBe(true);
    const psCalls = calls.filter(({ file }) => file === '/bin/ps');
    const listing = psCalls.filter(({ args }) => args.includes('lstart='));
    const commCalls = psCalls.filter(({ args }) => args.includes('comm='));
    const lsofCalls = calls.filter(({ file }) => file === '/usr/sbin/lsof');
    expect(listing.length).toBeGreaterThan(0);
    expect(commCalls.length).toBeGreaterThan(0);
    expect(lsofCalls.length).toBeGreaterThan(0);
    // Every ps query is wide, single-pid, and pinned to the C locale.
    for (const { args, options } of psCalls) {
      expect(args).toContain('-ww');
      expect(args).toEqual(expect.arrayContaining(['-p', String(DARWIN_PID)]));
      expect(options.env?.LC_ALL).toBe('C');
      expect(options.env?.LANG).toBe('C');
    }
    for (const { args } of listing) {
      expect(args).toEqual(expect.arrayContaining(['-o', 'lstart=']));
      expect(args).toEqual(expect.arrayContaining(['-o', 'command=']));
    }
    for (const { args } of commCalls) expect(args).toEqual(['-ww', '-p', String(DARWIN_PID), '-o', 'comm=']);
    for (const { args, options } of lsofCalls) {
      expect(args).toEqual(['-a', '-p', String(DARWIN_PID), '-d', 'txt', '-Fn']);
      expect(options.env?.LC_ALL).toBe('C');
    }
  });

  test('macos comm basename selects the single matching txt image, path or spaced', async () => {
    // Extra non-dylib txt images (helper) are ignored: only the comm match counts.
    const fullPathComm = macosHarness(DARWIN_PS_OUT, `${DARWIN_EXECUTABLE}\n`, DARWIN_LSOF_OUT);
    const identity = await captureProcessIdentity(DARWIN_PID, INSTANCE, fullPathComm.deps);
    expect(identity.executable).toBe(DARWIN_EXECUTABLE);
    const spacedExecutable = '/opt/my app/bun';
    const spaced = macosHarness(
      `${DARWIN_LSTART} ${spacedExecutable} src/main.ts ${MARKER}\n`,
      `${spacedExecutable}\n`,
      `p${DARWIN_PID}\nn${spacedExecutable}\nn/usr/lib/dyld\nn/opt/homebrew/lib/helper\n`,
    );
    const spacedIdentity = await captureProcessIdentity(DARWIN_PID, INSTANCE, spaced.deps);
    expect(spacedIdentity.executable).toBe(spacedExecutable);
    expect(await probeProcessIdentity(spacedIdentity, spaced.deps)).toBe('exact');
  });

  test('macos zero or ambiguous comm matches fail closed', async () => {
    const expected: CapturedProcessIdentity = { pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE };
    const none = macosHarness(DARWIN_PS_OUT, 'other\n', DARWIN_LSOF_OUT);
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, none.deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, none.deps)).toBe('unknown');
    const ambiguous = macosHarness(
      DARWIN_PS_OUT,
      DARWIN_COMM,
      `p${DARWIN_PID}\nn${DARWIN_EXECUTABLE}\nn/opt/tool/bun\nn/usr/lib/dyld\n`,
    );
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, ambiguous.deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, ambiguous.deps)).toBe('unknown');
    const emptyComm = macosHarness(DARWIN_PS_OUT, '\n', DARWIN_LSOF_OUT);
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, emptyComm.deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, emptyComm.deps)).toBe('unknown');
    const malformed = macosHarness('not a ps line\n', DARWIN_COMM, DARWIN_LSOF_OUT);
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, malformed.deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, malformed.deps)).toBe('unknown');
  });

  test('macos command with an embedded-space marker never matches exactly', async () => {
    const spaced = `${DARWIN_LSTART} ${DARWIN_EXECUTABLE} src/main.ts --bungee-process-identity=abc def\n`;
    const { deps } = macosHarness(spaced, DARWIN_COMM, DARWIN_LSOF_OUT);
    const expected: CapturedProcessIdentity = { pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE };
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, deps)).toBe('mismatch');
  });

  test('macos query failure is dead only when liveness confirms death', async () => {
    const expected: CapturedProcessIdentity = { pid: DARWIN_PID, startToken: DARWIN_LSTART, executable: DARWIN_EXECUTABLE, processInstanceId: INSTANCE };
    const deadEmpty = macosHarness('', DARWIN_COMM, DARWIN_LSOF_OUT, async () => 'dead');
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, deadEmpty.deps)).rejects.toBeInstanceOf(ProcessIdentityMissingError);
    expect(await probeProcessIdentity(expected, deadEmpty.deps)).toBe('dead');
    const unknownEmpty = macosHarness('', DARWIN_COMM, DARWIN_LSOF_OUT, async () => 'unknown');
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, unknownEmpty.deps)).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, unknownEmpty.deps)).toBe('unknown');
    const throwing = (liveness: LivenessFn): ProcessIdentityDeps => ({
      platform: 'darwin',
      liveness,
      execFile: async () => { throw psFailure(); },
    });
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, throwing(async () => 'dead'))).rejects.toBeInstanceOf(ProcessIdentityMissingError);
    expect(await probeProcessIdentity(expected, throwing(async () => 'dead'))).toBe('dead');
    await expect(captureProcessIdentity(DARWIN_PID, INSTANCE, throwing(async () => 'unknown'))).rejects.toBeInstanceOf(ProcessIdentityUnavailableError);
    expect(await probeProcessIdentity(expected, throwing(async () => 'unknown'))).toBe('unknown');
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

