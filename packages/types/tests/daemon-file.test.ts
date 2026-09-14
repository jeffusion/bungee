import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createLaunchingDaemonMetadataFile,
  deleteDaemonMetadataForMaster,
  deleteDaemonMetadataAfterOwnerExit,
  deleteDaemonMetadataForLauncher,
  readDaemonMetadataFile,
  transitionDaemonMetadataFile,
} from '../src/daemon-file.js';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';

const dirs: string[] = [];
const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const execFileAsync = promisify(execFile);

afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ dir: string; path: string; launching: DaemonMetadataV1 }> {
  const dir = await mkdtemp('/tmp/bungee-daemon-file-');
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
      async read(value: string) { return secured.has(value) ? good(value === dir) : { currentSid: 'S-1-5-21-1', entries: [] }; },
      async set(value: string, _sid: string, kind?: 'directory' | 'file') { calls.push(`${value}:${kind}`); secured.add(value); },
    };
    const previous = process.env.USERPROFILE;
    process.env.USERPROFILE = '/tmp';
    try {
      await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: dir, platform: 'win32', windowsAcl: adapter });
      expect(calls).toContain(`${dir}:directory`);
      expect(calls).toContain(`${path}:file`);
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

  test.skipIf(process.platform !== 'win32')('round-trips with the default ACL adapter in a special-character runtime path', async () => {
    const runtimeDirectory = join(homedir(), `ora-32 & acl ' ${process.pid}-${Date.now()}`);
    const path = join(runtimeDirectory, 'daemon.json');
    const launching: DaemonMetadataV1 = {
      schema: 'bungee-daemon-metadata-v1', launcher_pid: process.pid, state: 'launching',
      boot_nonce: BOOT, shutdown_secret: SECRET, executable: process.execPath, entrypoint: null,
      pid: null, instance_id: null, management_host: null, management_port: null,
    };
    const inspect = async (value: string) => {
      const script = '$a=Get-Acl -LiteralPath $env:ORA32_ACL_PATH;$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'
        + '$e=@($a.Access|ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;'
        + 'access=$(if([int]$_.AccessControlType -eq 0){"allow"}else{"deny"});rights=[int]$_.FileSystemRights;'
        + 'inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=[bool]$_.IsInherited} });'
        + 'ConvertTo-Json -Compress -Depth 4 @{currentSid=$sid;entries=$e}';
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { env: { ...process.env, ORA32_ACL_PATH: value }, windowsHide: true });
      return JSON.parse(stdout) as { currentSid: string; entries: Array<{ sid: string; access: string; rights: number; inheritance: number; propagation: number; inherited: boolean }> };
    };
    try {
      await mkdir(runtimeDirectory, { recursive: true });
      await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory });
      await expect(readDaemonMetadataFile(path, { runtimeDirectory })).resolves.toEqual(launching);
      const directoryAcl = await inspect(runtimeDirectory);
      const fileAcl = await inspect(path);
      const allowed = new Set([directoryAcl.currentSid, 'S-1-5-18', 'S-1-5-32-544']);
      for (const [acl, inheritance] of [[directoryAcl, 3], [fileAcl, 0]] as const) {
        expect(acl.entries).toHaveLength(3);
        for (const entry of acl.entries) {
          expect(allowed.has(entry.sid)).toBeTrue();
          expect(entry.access).toBe('allow');
          expect(entry.rights).toBe(2_032_127);
          expect(entry.inheritance).toBe(inheritance);
          expect(entry.propagation).toBe(0);
          expect(entry.inherited).toBeFalse();
        }
      }
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  });
});
