import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  __testReadWindowsAcl,
  createLaunchingDaemonMetadataFile,
  deleteDaemonMetadataForMaster,
  deleteDaemonMetadataAfterOwnerExit,
  deleteDaemonMetadataForLauncher,
  readDaemonMetadataFile,
  transitionDaemonMetadataFile,
} from '../src/daemon-file.js';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { makeCanonicalTempDir } from '../../../tests/support/canonical-temp';
import { serializeErrorChain } from '../../core/src/master-runtime/error-chain';

const dirs: string[] = [];
const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

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

function options(dir: string) { return { runtimeDirectory: dir }; }

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

describe('daemon metadata file primitive', () => {
  test('creates, reads, tightens permissions, and transitions atomically', async () => {
    const { dir, path, launching } = await fixture();
    await createLaunchingDaemonMetadataFile(path, launching, options(dir));
    await chmod(path, 0o644);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: process.pid,
      instance_id: null, management_host: null, management_port: null };
    await transitionDaemonMetadataFile(path, {
      expectedBootNonce: BOOT, expectedState: 'launching', expectedShutdownSecret: SECRET, next: starting,
    }, options(dir));
    expect(await readDaemonMetadataFile(path, options(dir))).toEqual(starting);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
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
  test('locks the PowerShell read script and child environment contract on every platform', async () => {
    const source = await Bun.file(new URL('../src/daemon-file.ts', import.meta.url)).text();
    expect(source).toContain('ForEach-Object { @{');
    expect(source).not.toContain('ForEach-Object @{');
    expect(source).toContain('ConvertTo-Json -Compress -Depth 4');
    expect(source).toContain("Buffer.from(script, 'utf16le')");
    expect(source).toContain("'-EncodedCommand'");
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
    const calls: string[] = [];
    const secured = new Set<string>();
    const good = (directory: boolean) => ({ currentSid: 'S-1-5-21-1', entries: [
      { sid: 'S-1-5-21-1', access: 'allow' as const, rights: 2_032_127, inheritance: directory ? 3 : 0, propagation: 0, inherited: false },
      { sid: 'S-1-5-18', access: 'allow' as const, rights: 2_032_127, inheritance: directory ? 3 : 0, propagation: 0, inherited: false },
      { sid: 'S-1-5-32-544', access: 'allow' as const, rights: 2_032_127, inheritance: directory ? 3 : 0, propagation: 0, inherited: false },
    ] });
    const adapter = {
      async read(value: string) { return secured.has(resolve(value)) ? good(resolve(value) === resolve(dir)) : { currentSid: 'S-1-5-21-1', entries: [] }; },
      async set(value: string, _sid: string, kind?: 'directory' | 'file') { calls.push(`${kind}`); secured.add(resolve(value)); },
    };
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = dirname(dir);
    try {
      await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter });
      expect(calls).toContain('directory');
      expect(calls).toContain('file');
      await chmod(path, 0o644);
      await expect(readDaemonMetadataFile(path, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter })).resolves.toEqual(launching);
      const badAdapter = {
        async read(value: string) { const snapshot = good(value === dir); return { ...snapshot, entries: snapshot.entries.map((entry) => ({ ...entry, propagation: 1 })) }; },
        async set() {},
      };
      await expect(readDaemonMetadataFile(path, { runtimeDirectory: dir, platform: 'win32', windowsAcl: badAdapter })).rejects.toThrow();
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
      const snapshot = await __testReadWindowsAcl(runtimeDirectory, 4_000);
      expect(snapshot.currentSid).toMatch(/^S-\d+(?:-\d+)+$/);
      expect(snapshot.entries.length).toBeGreaterThan(0);
    } finally { await rm(runtimeDirectory, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform === 'win32')('source-test direct ACL READ starts one fake PowerShell', async () => {
    const { dir, path } = await fixture();
    const countFile = join(dir, 'count');
    await withFakePowerShell(dir, `#!/bin/sh
printf '%s' '1' > '${countFile}'
printf '%s' '{"currentSid":"S-1-5-21-1","entries":[]}'
`, async () => {
      await expect(__testReadWindowsAcl(path, 4_000)).resolves.toEqual({ currentSid: 'S-1-5-21-1', entries: [] });
      expect(await readFile(countFile, 'utf8')).toBe('1');
    });
  });
});
