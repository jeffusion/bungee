import { afterEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { chmod, lstat, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  __testReadWindowsAcl,
  DaemonFileError,
  createLaunchingDaemonMetadataFile,
  deleteDaemonMetadataForMaster,
  deleteDaemonMetadataAfterOwnerExit,
  deleteDaemonMetadataForLauncher,
  formatDaemonFileAclError,
  readDaemonMetadataFile,
  transitionDaemonMetadataFile,
} from '../src/daemon-file.js';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import type { DaemonFileErrorCode, DaemonFileTestStage, WindowsAclAdapter, WindowsAclEntry, WindowsAclSnapshot } from '../src/daemon-file.js';
import { makeCanonicalTempDir } from '../../../tests/support/canonical-temp';
import { serializeErrorChain } from '../../core/src/master-runtime/error-chain';

const dirs: string[] = [];
const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  optionsByRuntime.clear();
});

async function fixture(): Promise<{ dir: string; path: string; launching: DaemonMetadataV1 }> {
  const dir = makeCanonicalTempDir('bungee-daemon-file');
  dirs.push(dir);
  const path = join(dir, 'daemon.json');
  const launching = {
    schema: 'bungee-daemon-metadata-v1', launcher_pid: 1, state: 'launching', boot_nonce: BOOT,
    shutdown_secret: SECRET, executable: process.execPath, entrypoint: null,
    pid: null, instance_id: null, management_host: null, management_port: null,
  } as const satisfies DaemonMetadataV1;
  return { dir, path, launching };
}

function hostileAcl(): WindowsAclSnapshot {
  return { currentSid: 'S-1-5-21-1', entries: [] };
}

type MemoryAclState = Readonly<{ owner: string; inheritance: number; entries: readonly WindowsAclEntry[] }>;
type MemoryAcl = WindowsAclAdapter & { readonly states: Map<string, MemoryAclState>; readonly reads: { count: number }; readonly sets: { count: number } };

function canonicalAclPath(path: string): string {
  try { return realpathSync.native(resolve(path)).toLowerCase(); }
  catch { return resolve(path).toLowerCase(); }
}

function createMemoryWindowsAcl(): MemoryAcl {
  const states = new Map<string, MemoryAclState>();
  const reads = { count: 0 };
  const sets = { count: 0 };
  return {
    states, reads, sets,
    read: async (path) => {
      reads.count += 1;
      const state = states.get(canonicalAclPath(path));
      return state === undefined ? hostileAcl() : { currentSid: state.owner, entries: state.entries };
    },
    set: async (path, currentSid, kind = 'file') => {
      sets.count += 1;
      const inheritance = kind === 'directory' ? 3 : 0;
      states.set(canonicalAclPath(path), {
        owner: currentSid,
        inheritance,
        entries: [
          { sid: currentSid, access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
          { sid: 'S-1-5-18', access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
          { sid: 'S-1-5-32-544', access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
        ],
      });
    },
  };
}

type MemoryOptions = { readonly runtimeDirectory: string; readonly platform: NodeJS.Platform; readonly windowsAcl: MemoryAcl };
const optionsByRuntime = new Map<string, MemoryOptions>();

function optionsFor(dir: string, windowsAcl?: MemoryAcl): MemoryOptions {
  const key = canonicalAclPath(dir);
  const cached = optionsByRuntime.get(key);
  if (windowsAcl !== undefined || cached === undefined) {
    const options = { runtimeDirectory: dir, platform: process.platform, windowsAcl: windowsAcl ?? createMemoryWindowsAcl() };
    optionsByRuntime.set(key, options);
    return options;
  }
  return cached;
}

const options = optionsFor;

async function withFakePowerShell(dir: string, source: string, run: () => Promise<void>): Promise<void> {
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const executable = join(bin, 'powershell.exe');
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  const oldPath = process.env.PATH;
  const oldProfile = process.env.USERPROFILE;
  process.env.PATH = bin;
  process.env.USERPROFILE = dirname(dir);
  try { await run(); }
  finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  }
}

function diagnosticFrom(error: unknown): Record<string, unknown> {
  const cause = (error as { readonly cause?: { readonly message?: string } }).cause;
  return JSON.parse(cause?.message ?? '{}') as Record<string, unknown>;
}

const ALLOWLISTED_DAEMON_FILE_CODES = new Set<DaemonFileErrorCode>([
  'race', 'path', 'symlink', 'containment', 'directory', 'owner', 'permissions',
  'file', 'limit', 'invalid', 'acl', 'state', 'secret', 'transition',
]);

const CREATE_LAUNCHING_OPERATIONS = new Set(['create_launching'] as const);
type CreateLaunchingOperation = typeof CREATE_LAUNCHING_OPERATIONS extends Set<infer T> ? T : never;

const ALLOWLISTED_NODE_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES', 'EBADF', 'EBUSY', 'EDQUOT', 'EEXIST', 'EINTR', 'EINVAL', 'EIO', 'EISDIR',
  'ELOOP', 'EMFILE', 'ENAMETOOLONG', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTEMPTY',
  'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EROFS', 'EXDEV', 'ENOSYS',
] as const);

const ALLOWLISTED_DAEMON_FILE_STAGES: ReadonlySet<DaemonFileTestStage> = new Set([
  'runtime_components', 'runtime_lstat', 'runtime_mkdir', 'runtime_created_lstat', 'runtime_realpath', 'profile_realpath',
  'directory_acl', 'target_components', 'target_lstat', 'target_realpath', 'create_open', 'descriptor_stat', 'verify_lstat',
  'file_acl', 'file_write', 'file_sync', 'file_close',
]);

function sanitizedNodeErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' && ALLOWLISTED_NODE_ERROR_CODES.has(code) ? code : 'unknown';
}

function daemonFileDiagnostic(error: unknown): string {
  const code = error instanceof DaemonFileError && ALLOWLISTED_DAEMON_FILE_CODES.has(error.code)
    ? error.code : 'unknown';
  return `daemon_file_error_code=${code}`;
}

function sanitizedDaemonFileStage(stage: unknown): DaemonFileTestStage | 'unknown' {
  return typeof stage === 'string' && ALLOWLISTED_DAEMON_FILE_STAGES.has(stage as DaemonFileTestStage)
    ? stage as DaemonFileTestStage : 'unknown';
}

function createLaunchingDiagnostic(error: unknown, operation: CreateLaunchingOperation = 'create_launching', stage?: unknown): string {
  if (error instanceof DaemonFileError) return daemonFileDiagnostic(error);
  const safeOperation = CREATE_LAUNCHING_OPERATIONS.has(operation) ? operation : 'create_launching';
  return `daemon_file_error_code=unknown operation=${safeOperation} stage=${sanitizedDaemonFileStage(stage)} node_error_code=${sanitizedNodeErrorCode(error)}`;
}

async function createLaunchingSuccess<T>(
  operation: () => Promise<T>, observedOperation: CreateLaunchingOperation = 'create_launching', evidence?: { stage?: DaemonFileTestStage },
): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(createLaunchingDiagnostic(error, observedOperation, evidence?.stage)); }
}

async function daemonFileSuccess<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(daemonFileDiagnostic(error)); }
}

async function daemonFileFailure(operation: () => Promise<unknown>, expectedCode: DaemonFileErrorCode): Promise<void> {
  try {
    await operation();
    throw new Error('daemon_file_error_code=unknown');
  } catch (error) {
    const diagnostic = daemonFileDiagnostic(error);
    const expected = `daemon_file_error_code=${expectedCode}`;
    if (diagnostic !== expected) throw new Error(diagnostic);
  }
}

describe('daemon metadata file primitive', () => {
  test('keeps create-launching EPERM evidence at a fixed allowlisted stage', async () => {
    const stages: readonly DaemonFileTestStage[] = [
      'runtime_components', 'runtime_lstat', 'runtime_mkdir', 'runtime_created_lstat', 'runtime_realpath', 'profile_realpath',
      'directory_acl', 'target_components', 'target_lstat', 'target_realpath', 'create_open', 'descriptor_stat', 'verify_lstat',
      'file_acl', 'file_write', 'file_sync', 'file_close',
    ];
    for (const expectedStage of stages) {
      const { dir, path, launching } = await fixture();
      if (expectedStage === 'runtime_mkdir' || expectedStage === 'runtime_created_lstat') await rm(dir, { recursive: true });
      if (expectedStage === 'target_realpath') await writeFile(path, '{}');
      const evidence: { stage?: DaemonFileTestStage } = {};
      let failed = false;
      const previousProfile = process.env.USERPROFILE;
      process.env.USERPROFILE = dirname(dir);
      try {
        const nodeError = Object.assign(new Error(`path=${path} message=hidden`), { code: 'EPERM' });
        const daemonOptions = {
          runtimeDirectory: dir, platform: 'win32' as const, windowsAcl: createMemoryWindowsAcl(),
          testHooks: { onStage: (stage: DaemonFileTestStage) => {
            if (failed) return;
            evidence.stage = stage;
            if (stage === expectedStage) { failed = true; throw nodeError; }
          } },
        };
        let error: unknown;
        try { await createLaunchingDaemonMetadataFile(path, launching, daemonOptions); }
        catch (caught) { error = caught; }
        expect(error).toBe(nodeError);
        const diagnostic = createLaunchingDiagnostic(error, 'create_launching', evidence.stage);
        expect(diagnostic).toBe(`daemon_file_error_code=unknown operation=create_launching stage=${expectedStage} node_error_code=EPERM`);
        expect(diagnostic).not.toContain(path);
        expect(diagnostic).not.toContain('path=');
        expect(diagnostic).not.toContain('message=');
      } finally {
        if (previousProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousProfile;
      }
    }
    expect(createLaunchingDiagnostic(Object.assign(new Error('hidden'), { code: 'EPERM' }), 'create_launching', 'runtime_unknown')).toContain('stage=unknown');
  });

  test('creates, reads, tightens permissions, and transitions atomically', async () => {
    const { dir, path, launching } = await fixture();
    const daemonOptions = options(dir);
    await createLaunchingDaemonMetadataFile(path, launching, daemonOptions);
    if (process.platform === 'win32') {
      const state = daemonOptions.windowsAcl;
      state.states.set(canonicalAclPath(path), { owner: 'S-1-5-21-1', inheritance: 0, entries: [] });
      await expect(readDaemonMetadataFile(path, daemonOptions)).resolves.toEqual(launching);
      expect(state.states.get(canonicalAclPath(path))).toMatchObject({ owner: 'S-1-5-21-1', inheritance: 0 });
      expect(state.states.get(canonicalAclPath(path))?.entries).toHaveLength(3);
    } else {
      await chmod(path, 0o644);
      expect((await lstat(path)).mode & 0o777).toBe(0o644);
    }
    const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: process.pid,
      instance_id: null, management_host: null, management_port: null };
    await transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'launching', expectedShutdownSecret: SECRET, next: starting,
    }, daemonOptions);
    expect(await readDaemonMetadataFile(path, daemonOptions)).toEqual(starting);
    if (process.platform !== 'win32') expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  test('rejects symlinks and oversized content without truncating the target', async () => {
    const { dir, path, launching } = await fixture();
    const target = join(dir, 'target');
    await writeFile(target, 'keep');
    await symlink(target, path);
    await expect(readDaemonMetadataFile(path, options(dir))).rejects.toThrow();
    await rm(path);
    await writeFile(path, 'x'.repeat(4097));
    await expect(readDaemonMetadataFile(path, options(dir))).rejects.toThrow();
    expect((await readFile(path, 'utf8')).length).toBe(4097);
    await expect(transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'launching', expectedShutdownSecret: SECRET, next: launching,
    }, options(dir))).rejects.toThrow();
  });

  test('does not replace an existing launching record', async () => {
    const { dir, path, launching } = await fixture();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    await expect(createLaunchingDaemonMetadataFile(path, launching, options(dir))).rejects.toThrow();
  });

  test('rejects hardlinks and targets outside the trusted root', async () => {
    const { dir, path, launching } = await fixture();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    await link(path, join(dir, 'hardlink'));
    await expect(readDaemonMetadataFile(path, options(dir))).rejects.toThrow();
    await expect(readDaemonMetadataFile(join(dir, '..', 'outside', 'daemon.json'), options(dir))).rejects.toThrow();
  });

  test('retries detached inode and size races, but bounds observer retries at four', async () => {
    const { dir, path, launching } = await fixture();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    const original = await readFile(path);
    let detachedReads = 0;
    await expect(readDaemonMetadataFile(path, {
      ...options(dir), testHooks: { afterOpen: async (target) => {
        detachedReads += 1;
        if (detachedReads > 1) return;
        await rm(target);
        await writeFile(target, original);
      } },
    })).resolves.toEqual(launching);
    expect(detachedReads).toBe(2);

    let exhaustedReads = 0;
    await expect(readDaemonMetadataFile(path, {
      ...options(dir), testHooks: { afterOpen: async (target) => {
        exhaustedReads += 1;
        await rm(target);
        await writeFile(target, original);
      } },
    })).rejects.toMatchObject({ code: 'race' });
    expect(exhaustedReads).toBe(4);

    await expect(readDaemonMetadataFile(path, {
      ...options(dir), testHooks: { afterInitialStat: async (target) => { await writeFile(target, `${await readFile(target, 'utf8')} `); } },
    })).rejects.toMatchObject({ code: 'race' });
  });

  test('conditional owner-death delete treats absent and mismatched records as no-op', async () => {
    const { dir, path, launching } = await fixture();
    const expected = { bootNonce: BOOT, state: 'launching' as const, shutdownSecret: SECRET };
    expect(await deleteDaemonMetadataAfterOwnerExit(path, expected, options(dir))).toBeFalse();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    expect(await deleteDaemonMetadataAfterOwnerExit(path, { ...expected, bootNonce: '00000000-0000-0000-0000-000000000000' }, options(dir))).toBeFalse();
    expect(await deleteDaemonMetadataAfterOwnerExit(path, expected, options(dir))).toBeTrue();
  }, 30_000);

  test('launcher delete requires the current launcher and exact secret', async () => {
    const { dir, path, launching } = await fixture();
    const owned = { ...launching, launcher_pid: process.pid };
    await createLaunchingDaemonMetadataFile(path, owned, options(dir));
    expect(await deleteDaemonMetadataForLauncher(path, {
      bootNonce: BOOT, shutdownSecret: SECRET,
    }, options(dir))).toBeTrue();
    expect(await Bun.file(path).exists()).toBeFalse();
  });

  test('master delete requires the exact stopping record and current pid', async () => {
    const { dir, path, launching } = await fixture();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: process.pid, instance_id: null, management_host: null, management_port: null };
    await transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'launching', expectedShutdownSecret: SECRET, next: starting,
    }, options(dir));
    const armed: DaemonMetadataV1 = { ...starting, state: 'armed', instance_id: '11111111-1111-4111-8111-111111111111', management_host: '127.0.0.1', management_port: 8089 };
    await transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'starting', expectedShutdownSecret: SECRET, next: armed,
    }, options(dir));
    const stopping: DaemonMetadataV1 = { ...armed, state: 'stopping' };
    await transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'armed', expectedShutdownSecret: SECRET, next: stopping,
    }, options(dir));
    await expect(deleteDaemonMetadataForMaster(path, { bootNonce: BOOT, shutdownSecret: SECRET, pid: process.pid + 1 }, options(dir))).rejects.toThrow();
    await expect(deleteDaemonMetadataForMaster(path, { bootNonce: BOOT, shutdownSecret: SECRET, pid: process.pid }, options(dir))).resolves.toBeTrue();
    await expect(readDaemonMetadataFile(path, options(dir))).rejects.toThrow();
  });
});

describe('Windows ACL contract', () => {
  test('formats only a direct ACL process failure chain', async () => {
    const { dir, path, launching } = await fixture();
    await withFakePowerShell(dir, '#!/bin/sh\nprintf \'path=/tmp secret=hidden\' >&2\nexit 17\n', async () => {
      let error: unknown;
      try { await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32' }); }
      catch (caught) { error = caught; }
      expect(formatDaemonFileAclError(error)).toBe('acl_operation=read outcome=exit last_phase=null killed=false');
      expect(formatDaemonFileAclError(new DaemonFileError('acl', 'path=/tmp'))).toBeNull();
      expect(formatDaemonFileAclError(new Error('path=/tmp'))).toBeNull();
    });
  });

  test('locks the PowerShell read script and child environment contract on every platform', async () => {
    const source = await Bun.file(new URL('../src/daemon-file.ts', import.meta.url)).text();
    expect(source).toContain('ForEach-Object { @{');
    expect(source).not.toContain('ForEach-Object @{');
    expect(source).toContain('ConvertTo-Json -Compress -Depth 4');
    expect(source).toContain("Buffer.from(script, 'utf16le')");
    expect(source).toContain("'-EncodedCommand'");
    expect(source).toContain('$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,"Modules")');
    expect(source).toContain('Import-Module Microsoft.PowerShell.Security -ErrorAction Stop');
    expect(source).toContain('const WINDOWS_ACL_DEADLINE_MS = 10_000;');
    expect(source).toContain('deadlineMs = WINDOWS_ACL_DEADLINE_MS');
    expect(source).toContain('key.toLowerCase()');
    expect(source).not.toContain('...process.env');
  });

  test.skipIf(process.platform === 'win32')('bounds and redacts default ACL adapter failure evidence', async () => {
    const { dir, path, launching } = await fixture();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'powershell.exe'), '#!/bin/sh\nfor key in PSModulePath psmodulepath pSmOdUlEpAtH; do if printenv "$key" >/dev/null; then printf "%s" "$key" >&2; fi; done\nprintf "/tmp/acl-secret $USERPROFILE S-1-5-21-9 environment -EncodedCommand abc secret=top-secret" >&2\nexit 17\n');
    await chmod(join(bin, 'powershell.exe'), 0o755);
    const oldPath = process.env.PATH;
    const oldProfile = process.env.USERPROFILE;
    const polluted = ['PSModulePath', 'psmodulepath', 'pSmOdUlEpAtH'] as const;
    const oldPolluted = polluted.map((key) => process.env[key]);
    process.env.PATH = bin;
    process.env.USERPROFILE = dirname(dir);
    polluted.forEach((key) => { process.env[key] = 'polluted'; });
    try {
      let error: unknown;
      try { await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32' }); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'acl', message: 'Windows ACL probe failed' });
      const cause = (error as { readonly cause?: Error & { readonly code?: string } }).cause;
      expect(cause).toBeInstanceOf(Error);
      expect(cause?.code).toBe('BUNGEE_WINDOWS_ACL_PROCESS');
      const serialized = serializeErrorChain(error);
      expect(serialized.cause?.code).toBe('BUNGEE_WINDOWS_ACL_PROCESS');
      const diagnostic = JSON.parse(serialized.cause?.message ?? '') as Record<string, unknown>;
      expect(diagnostic).toEqual({
        operation: 'read', outcome: 'exit', elapsed_ms: expect.any(Number), exit_code: 17, signal: null,
        killed: false, stdout_bytes: 0, stderr_bytes: expect.any(Number), last_phase: null,
        psmodulepath_present: false, systemroot_present: expect.any(Boolean),
      });
      expect(Object.keys(diagnostic).sort()).toEqual([
        'elapsed_ms', 'exit_code', 'killed', 'last_phase', 'operation', 'outcome', 'psmodulepath_present',
        'signal', 'stderr_bytes', 'stdout_bytes', 'systemroot_present',
      ]);
      expect(serialized.cause?.message).not.toContain(dir);
      expect(serialized.cause?.message).not.toContain('S-1-5-21-9');
      expect(serialized.cause?.message).not.toContain('top-secret');
      expect(serialized.cause?.message).not.toContain('EncodedCommand');
      expect(serialized.cause?.message).not.toContain('environment');
      expect(serialized.cause?.message).not.toContain('polluted');
      expect(Buffer.byteLength(serialized.cause?.message ?? '')).toBeLessThanOrEqual(512);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
      polluted.forEach((key, index) => {
        const value = oldPolluted[index];
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      });
    }
  });

  test.skipIf(process.platform === 'win32')('round-trips the default ACL adapter through a fake PowerShell', async () => {
    const { dir, path, launching } = await fixture();
    await withFakePowerShell(dir, `#!/bin/sh
kind_file='${join(dir, 'kind')}'
if [ -n "$BUNGEE_DAEMON_ACL_KIND" ]; then printf '%s' "$BUNGEE_DAEMON_ACL_KIND" > "$kind_file"; exit 0; fi
if [ -f "$kind_file" ]; then
  inheritance=0
  if [ "$(/bin/cat "$kind_file")" = 'directory' ]; then inheritance=3; fi
  printf '%s' '{"currentSid":"S-1-5-21-1","entries":[{"sid":"S-1-5-21-1","access":"allow","rights":2032127,"inheritance":'
  printf '%s' "$inheritance"
  printf '%s' ',"propagation":0,"inherited":false},{"sid":"S-1-5-18","access":"allow","rights":2032127,"inheritance":'
  printf '%s' "$inheritance"
  printf '%s' ',"propagation":0,"inherited":false},{"sid":"S-1-5-32-544","access":"allow","rights":2032127,"inheritance":'
  printf '%s' "$inheritance"
  printf '%s' ',"propagation":0,"inherited":false}]}'
else printf '%s' '{"currentSid":"S-1-5-21-1","entries":[]}'
fi
`, async () => {
      await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32' });
      await expect(readDaemonMetadataFile(path, { runtimeDirectory: dir, platform: 'win32' })).resolves.toEqual(launching);
    });
  });

  test.skipIf(process.platform === 'win32')('reports a bounded set diagnostic without retaining process output', async () => {
    const { dir, path, launching } = await fixture();
    await withFakePowerShell(dir, `#!/bin/sh
count_file='${join(dir, 'count')}'
count=0
if [ -f "$count_file" ]; then count=$(/bin/cat "$count_file"); fi
count=$((count + 1))
printf '%s' "$count" > "$count_file"
if [ "$count" -eq 1 ]; then printf '%s' '{"currentSid":"S-1-5-21-1","entries":[]}'
else printf '%s' 'secret=/tmp/not-in-diagnostic S-1-5-21-9' >&2; exit 23
fi
`, async () => {
      let error: unknown;
      try { await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32' }); }
      catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: 'acl' });
      expect(diagnosticFrom(error)).toMatchObject({
        operation: 'set', outcome: 'exit', elapsed_ms: expect.any(Number), exit_code: 23, signal: null,
        killed: false, stdout_bytes: 0, stderr_bytes: expect.any(Number), last_phase: null,
        psmodulepath_present: false, systemroot_present: expect.any(Boolean),
      });
      expect(JSON.stringify(diagnosticFrom(error))).not.toContain('not-in-diagnostic');
    });
  });

  test.skipIf(process.platform === 'win32')('reports spawn errors with no child output', async () => {
    const { dir, path, launching } = await fixture();
    const oldPath = process.env.PATH;
    const oldProfile = process.env.USERPROFILE;
    process.env.PATH = join(dir, 'missing-bin');
    process.env.USERPROFILE = dirname(dir);
    try {
      let error: unknown;
      try { await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32' }); }
      catch (caught) { error = caught; }
      expect(diagnosticFrom(error)).toEqual({
        operation: 'read', outcome: 'spawn_error', elapsed_ms: expect.any(Number), exit_code: null, signal: null,
        killed: false, stdout_bytes: 0, stderr_bytes: 0, last_phase: null,
        psmodulepath_present: false, systemroot_present: expect.any(Boolean),
      });
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
    }
  });

  test.skipIf(process.platform === 'win32')('kills a timed-out adapter, drains stdio, and leaves no child', async () => {
    const { dir, path } = await fixture();
    const pidFile = join(dir, 'child.pid');
    const source = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stderr.write('__BUNGEE_ACL_PHASE__:started\\n__BUNGEE_ACL_PHASE__:before_get_acl\\n');
setInterval(() => {}, 1000);
`;
    await withFakePowerShell(dir, source, async () => {
      let error: unknown;
      try { await __testReadWindowsAcl(path, 4_000); }
      catch (caught) { error = caught; }
      const diagnostic = diagnosticFrom(error);
      expect(diagnostic).toMatchObject({
        operation: 'read', outcome: 'timeout', elapsed_ms: 4_000, exit_code: null, signal: 'SIGKILL',
        killed: true, stdout_bytes: 0, stderr_bytes: expect.any(Number), last_phase: 'before_get_acl',
        psmodulepath_present: false, systemroot_present: expect.any(Boolean),
      });
      const pid = Number(await readFile(pidFile, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive).toBeFalse();
    });
  }, 10_000);

  test('uses deterministic injected directory/file ACLs and rejects forbidden entries', async () => {
    const { dir, path, launching } = await fixture();
    const windowsAcl = createMemoryWindowsAcl();
    const kinds: string[] = [];
    const adapter: MemoryAcl = {
      ...windowsAcl,
      async set(value, sid, kind) {
        kinds.push(`${kind}`);
        await windowsAcl.set(value, sid, kind);
      },
    };
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = dirname(dir);
    try {
      await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter });
      expect(kinds).toContain('directory');
      expect(kinds).toContain('file');
      if (process.platform !== 'win32') await chmod(path, 0o644);
      await expect(readDaemonMetadataFile(path, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter })).resolves.toEqual(launching);
      const state = adapter.states.get(canonicalAclPath(path));
      expect(state).toBeDefined();
      adapter.states.set(canonicalAclPath(path), { ...state!, owner: 'unknown' });
      await expect(readDaemonMetadataFile(path, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter })).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });

  test('uses the injected Windows ACL adapter without spawning PowerShell', async () => {
    const { dir, path, launching } = await fixture();
    const countFile = join(dir, 'powershell-count');
    await writeFile(countFile, '0');
    const windowsAcl = createMemoryWindowsAcl();
    const daemonOptions = { ...optionsFor(dir, windowsAcl), platform: 'win32' as const };
    await withFakePowerShell(dir, `#!/bin/sh
count_file='${countFile}'
count=$(/bin/cat "$count_file")
printf '%s' "$((count + 1))" > "$count_file"
`, async () => {
      await createLaunchingDaemonMetadataFile(path, launching, daemonOptions);
    });
    expect(await readFile(countFile, 'utf8')).toBe('0');
  });

  test('memory ACL keeps directory, file, temp, and aliases on separate case-folded keys', async () => {
    const { dir, path, launching } = await fixture();
    const windowsAcl = createMemoryWindowsAcl();
    const daemonOptions = { ...optionsFor(dir, windowsAcl), platform: 'win32' as const };
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = dirname(dir);
    try {
      await createLaunchingDaemonMetadataFile(path, launching, daemonOptions);
      const rootKey = canonicalAclPath(dir);
      const fileKey = canonicalAclPath(path);
      const rootBefore = windowsAcl.states.get(rootKey);
      expect(rootBefore?.inheritance).toBe(3);

      await transitionDaemonMetadataFile(path, {
        expectedBootNonce: BOOT, expectedState: 'launching', expectedShutdownSecret: SECRET,
        next: { ...launching, state: 'starting', pid: process.pid, instance_id: null, management_host: null, management_port: null },
      }, daemonOptions);
      expect(windowsAcl.states.get(rootKey)).toEqual(rootBefore);
      expect(windowsAcl.states.get(fileKey)?.inheritance).toBe(0);
      expect(await windowsAcl.read(join(dir, '.', 'DAEMON.JSON'))).toEqual(await windowsAcl.read(path));
      expect([...windowsAcl.states.keys()].filter((key) => key !== rootKey && key !== fileKey)).toHaveLength(1);
      expect(windowsAcl.sets.count).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });

  test('does not call the ACL adapter for profile root or an escaping target', async () => {
    const { dir, path, launching } = await fixture();
    const calls: string[] = [];
    const adapter = {
      async read(value: string) { calls.push(`read:${value}`); return { currentSid: 'S-1-5-21-1', entries: [] }; },
      async set(value: string) { calls.push(`set:${value}`); },
    };
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = dir;
    try {
      await expect(createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter })).rejects.toThrow();
      expect(calls).toEqual([]);
      calls.length = 0;
      process.env.USERPROFILE = '/tmp';
      await expect(createLaunchingDaemonMetadataFile(join(dir, '..', 'escape', 'daemon.json'), launching, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter })).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });

  test.skipIf(process.platform !== 'win32')('reads one default ACL probe in a special-character path', async () => {
    const runtimeDirectory = join(homedir(), `ora-32 & acl ' ${process.pid}-${Date.now()}`);
    try {
      await mkdir(runtimeDirectory, { recursive: true });
      const snapshot = await __testReadWindowsAcl(runtimeDirectory);
      expect(snapshot.currentSid).toMatch(/^S-\d+(?:-\d+)+$/);
      expect(snapshot.entries.length).toBeGreaterThan(0);
    } finally { await rm(runtimeDirectory, { recursive: true, force: true }); }
  }, 15_000);

  test.skipIf(process.platform === 'win32')('source-test direct ACL READ starts one fake PowerShell', async () => {
    const { dir, path } = await fixture();
    const countFile = join(dir, 'count');
    await withFakePowerShell(dir, `#!/bin/sh
printf '%s' '1' > '${countFile}'
printf '%s' '{"currentSid":"S-1-5-21-1","entries":[]}'
`, async () => {
      await expect(__testReadWindowsAcl(path)).resolves.toEqual({ currentSid: 'S-1-5-21-1', entries: [] });
      expect(await readFile(countFile, 'utf8')).toBe('1');
    });
  });

  test.skipIf(process.platform !== 'win32')('accepts an 8.3 runtime alias and rejects escape and sibling targets', async () => {
    const { dir, launching } = await fixture();
    const longRuntimeDirectory = join(dir, 'runtime-directory-with-long-name');
    await mkdir(longRuntimeDirectory);
    let shortRuntimeDirectory = '';
    try {
      shortRuntimeDirectory = Bun.spawnSync({
        cmd: ['cmd.exe', '/d', '/c', `for %I in ("${longRuntimeDirectory}") do @echo %~sI`],
        stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim();
    } catch {
      throw new Error('daemon_file_error_code=alias_unavailable');
    }
    if (shortRuntimeDirectory.length === 0 || shortRuntimeDirectory === longRuntimeDirectory) {
      throw new Error('daemon_file_error_code=alias_unavailable');
    }
    const adapter = createMemoryWindowsAcl();
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = dirname(dir);
    try {
      const options = { runtimeDirectory: shortRuntimeDirectory, platform: 'win32' as const, windowsAcl: adapter };
      const aliasPath = join(shortRuntimeDirectory, 'daemon.json');
      const evidence: { stage?: DaemonFileTestStage } = {};
      const instrumentedOptions = { ...options, testHooks: { onStage: (stage: DaemonFileTestStage) => { evidence.stage = stage; } } };
      await createLaunchingSuccess(() => createLaunchingDaemonMetadataFile(aliasPath, launching, instrumentedOptions), 'create_launching', evidence);
      const metadata = await daemonFileSuccess(() => readDaemonMetadataFile(aliasPath, options));
      if (JSON.stringify(metadata) !== JSON.stringify(launching)) throw new Error('daemon_file_error_code=unknown');
      await daemonFileFailure(
        () => readDaemonMetadataFile(join(shortRuntimeDirectory, '..', 'escape', 'daemon.json'), options),
        'containment',
      );
      await daemonFileFailure(
        () => readDaemonMetadataFile(join(shortRuntimeDirectory, 'daemon.json.sibling'), options),
        'containment',
      );
    } finally {
      if (previous === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previous;
    }
  });
});
