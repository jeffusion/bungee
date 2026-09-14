import { afterEach, describe, expect, test } from 'bun:test';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER, DAEMON_SHUTDOWN_PATH, type DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { DaemonFileError, deleteDaemonMetadataAfterOwnerExit, deleteDaemonMetadataForLauncher, readDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import { findExactDaemonProcess, probeDaemonProcess, TargetProcessMissingError } from './process-identity';
import { captureDarwinProcessTree, captureProcessTree, readDarwinProcessSnapshot, readProcessTreeSnapshot, sameProcessTreeSnapshot } from './process-tree';
import { DaemonManager } from './manager';

const roots: string[] = [];
const safeToRemove = new Set<string>();
const coreEntry = resolve(import.meta.dir, '../../../core/dist/main.js');

async function freePort(): Promise<number> {
  for (;;) {
    const first = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') });
    const port = first.port;
    let second: ReturnType<typeof Bun.serve> | undefined;
    let third: ReturnType<typeof Bun.serve> | undefined;
    try {
      if (port === undefined) throw new Error('port unavailable');
      second = Bun.serve({ hostname: '127.0.0.1', port: port + 1, fetch: () => new Response('reserved') });
      third = Bun.serve({ hostname: '127.0.0.1', port: port + 2, fetch: () => new Response('reserved') });
      await first.stop(true); await second.stop(true); await third.stop(true);
      return port;
    } catch {
      await first.stop(true); await second?.stop(true); await third?.stop(true);
    }
  }
}

async function waitUntil(predicate: () => Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(50);
  }
  throw new Error(message);
}

async function shutdown(metadataPath: string, metadata: Extract<DaemonMetadataV1, { state: 'armed' | 'stopping' }>): Promise<void> {
  const response = await fetch(`http://${metadata.management_host}:${metadata.management_port}${DAEMON_SHUTDOWN_PATH}`, {
    method: 'POST',
    headers: {
      [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${metadata.shutdown_secret}`,
      [DAEMON_BOOT_HEADER]: metadata.boot_nonce,
      [DAEMON_INSTANCE_HEADER]: metadata.instance_id,
      [DAEMON_PID_HEADER]: String(metadata.pid),
    },
  });
  expect(response.status).toBe(202);
  expect(await response.text()).toBe(JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid }));
  await waitUntil(async () => !(await Bun.file(metadataPath).exists()), 'real C1 daemon metadata was not removed', 15_000);
}

async function cleanupRealDaemon(metadataPath: string, runtimeDirectory: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!await Bun.file(metadataPath).exists()) return;
    let metadata: DaemonMetadataV1;
    try { metadata = await readDaemonMetadataFile(metadataPath, { runtimeDirectory }); }
    catch (error) {
      if (error instanceof DaemonFileError && error.code === 'race') { await Bun.sleep(50); continue; }
      throw error;
    }
    if (metadata.state === 'armed' || metadata.state === 'stopping') {
      await shutdown(metadataPath, metadata);
      return;
    }
    if (metadata.state === 'launching') {
      const marker = await findExactDaemonProcess(metadata.boot_nonce);
      if (marker === 'unknown' || marker === 'found') { await Bun.sleep(50); continue; }
      await deleteDaemonMetadataForLauncher(metadataPath, {
        bootNonce: metadata.boot_nonce, shutdownSecret: metadata.shutdown_secret,
      }, { runtimeDirectory });
      return;
    }
    const probe = await probeDaemonProcess(metadata.pid, {
      executable: metadata.executable, entrypoint: metadata.entrypoint,
    }, metadata.boot_nonce);
    if (probe === 'dead') {
      await deleteDaemonMetadataAfterOwnerExit(metadataPath, {
        bootNonce: metadata.boot_nonce, state: metadata.state, shutdownSecret: metadata.shutdown_secret,
      }, { runtimeDirectory });
      return;
    }
    await Bun.sleep(50);
  }
  throw new Error('real C1 process cleanup timed out');
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => { child.once('exit', () => resolve(true)); child.once('close', () => resolve(true)); }),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return exited;
}

async function cleanupCapturedChildren(children: readonly ChildProcess[]): Promise<{ readonly errors: readonly unknown[]; readonly allExited: boolean }> {
  const errors: unknown[] = [];
  let allExited = true;
  for (const child of children) {
    let exited = await waitForChildExit(child);
    if (!exited) {
      errors.push(new Error('graceful lifecycle failure: child did not exit naturally'));
      try {
        if (child.kill('SIGKILL') !== true) throw new Error('emergency child kill returned false');
      } catch (error) {
        errors.push(new Error('emergency child kill failed', { cause: error }));
      }
      exited = await waitForChildExit(child);
      if (!exited) errors.push(new Error('emergency child exit was not confirmed'));
    }
    if (!exited) allExited = false;
  }
  return { errors, allExited };
}

async function waitPortClosed(port: number): Promise<void> {
  await waitUntil(async () => {
    try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(250) }); return false; }
    catch { return true; }
  }, `port ${port} remained open`, 5_000);
}

type RealDaemonFixture = Readonly<{
  root: string;
  home: string;
  runtime: string;
  manager: DaemonManager;
  children: readonly ChildProcess[];
  basePort: number;
}>;

async function createRealDaemonFixture(): Promise<RealDaemonFixture> {
  if (!(await Bun.file(coreEntry).exists())) throw new Error(`Core build is required: ${coreEntry}`);
  const root = await mkdtemp(join(tmpdir(), 'bungee real c1 '));
  roots.push(root);
  const home = join(root, 'test home with spaces');
  const data = join(home, 'data with spaces');
  const logs = join(home, 'logs with spaces');
  const runtime = join(home, '.bungee', 'run');
  const plugin = join(data, 'plugins', 'c1-fixture');
  await Promise.all([mkdir(data, { recursive: true }), mkdir(plugin, { recursive: true }), mkdir(logs, { recursive: true }), mkdir(runtime, { recursive: true }), mkdir(join(home, 'entry point with spaces'), { recursive: true })]);
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify({
    name: 'c1-fixture', version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin', main: 'index.js',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none', engines: { bungee: '^4.2.0' }, builtin: false,
    contributes: {}, configSchema: [], metadata: { name: 'c1-fixture', description: 'C1 fixture', icon: 'test' },
  }));
  await writeFile(join(plugin, 'index.js'), "const plugin = class { static version = '1.0.0'; register() {} }; export default plugin;");
  const basePort = await freePort();
  const children: ChildProcess[] = [];
  const manager = new DaemonManager((executable, args, options) => {
    const child = nodeSpawn(executable, [...args], options);
    children.push(child);
    return child;
  }, undefined, {
    runtimeDirectory: runtime, dataDirectory: data, logsDirectory: logs, configDirectory: join(home, '.bungee'),
    pidFile: join(home, '.bungee', 'bungee.pid'), logFile: join(home, '.bungee', 'bungee.log'), errorLogFile: join(home, '.bungee', 'bungee.error.log'),
    directLaunch: { executable: process.execPath, entrypoint: coreEntry },
    inheritedEnvironment: {
      ...process.env, HOME: home, USERPROFILE: home, BUNGEE_MANAGEMENT_PORT: String(basePort + 1),
      BUNGEE_INGRESS_SUPERVISION_PORT: String(basePort + 2), BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false',
      BUNGEE_PLUGIN_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'), BUNGEE_FILE_LOG_DIR: logs, LOG_LEVEL: 'error',
    },
  });
  return { root, home, runtime, manager, children, basePort };
}

describe('DaemonManager real Core C1', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).filter((root) => safeToRemove.delete(root)).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('takes a direct built JS through launching, Master takeover, armed, and authenticated cleanup', async () => {
    const { root, home, runtime, manager, children, basePort } = await createRealDaemonFixture();
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await manager.start({ workers: '1', port: String(basePort) });
      const metadata = await readDaemonMetadataFile(join(runtime, 'daemon.json'), { runtimeDirectory: runtime });
      expect(metadata.state).toBe('armed');
      if (metadata.state !== 'armed') throw new Error('daemon metadata was not armed');
      expect(await probeDaemonProcess(metadata.pid, { executable: metadata.executable, entrypoint: metadata.entrypoint }, metadata.boot_nonce)).toBe('exact');
      if (process.platform !== 'win32') expect((await stat(join(home, '.bungee', 'bungee.pid'))).mode & 0o777).toBe(0o600);
    } catch (error) {
      primaryError = error;
    } finally {
      try { await cleanupRealDaemon(join(runtime, 'daemon.json'), runtime); }
      catch (error) { cleanupErrors.push(new Error('graceful lifecycle failure', { cause: error })); }
      const childCleanup = await cleanupCapturedChildren(children);
      cleanupErrors.push(...childCleanup.errors);
      if (childCleanup.allExited) safeToRemove.add(root);
      if (primaryError !== undefined || cleanupErrors.length > 0) {
        throw new AggregateError([
          ...(primaryError === undefined ? [] : [primaryError]),
          ...cleanupErrors,
        ], 'real C1 test failed');
      }
    }
  }, 90_000);

  test('stops and restarts a real daemon only after exact process cleanup', async () => {
    const { root, runtime, manager, children, basePort } = await createRealDaemonFixture();
    let primaryError: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await manager.start({ workers: '2', port: String(basePort) });
      const first = await readDaemonMetadataFile(join(runtime, 'daemon.json'), { runtimeDirectory: runtime });
      if (first.state !== 'armed') throw new Error('first daemon was not armed');
      const firstTree = process.platform === 'linux'
        ? await captureProcessTree(first.pid)
        : process.platform === 'darwin' ? await captureDarwinProcessTree(first.pid) : null;
      if (firstTree !== null) expect(firstTree.length).toBeGreaterThanOrEqual(4);
      expect(await probeDaemonProcess(first.pid, { executable: first.executable, entrypoint: first.entrypoint }, first.boot_nonce)).toBe('exact');

      await manager.restart({ workers: '2', port: String(basePort) });
      const second = await readDaemonMetadataFile(join(runtime, 'daemon.json'), { runtimeDirectory: runtime });
      if (second.state !== 'armed') throw new Error('restarted daemon was not armed');
      expect(second.boot_nonce).not.toBe(first.boot_nonce);
      expect(await probeDaemonProcess(first.pid, { executable: first.executable, entrypoint: first.entrypoint }, first.boot_nonce)).not.toBe('exact');
      expect(await probeDaemonProcess(second.pid, { executable: second.executable, entrypoint: second.entrypoint }, second.boot_nonce)).toBe('exact');
      if (process.platform === 'linux' && firstTree !== null) {
        for (const snapshot of firstTree) {
          try {
            const current = await readProcessTreeSnapshot(snapshot.pid);
            expect(sameProcessTreeSnapshot(current, snapshot)).toBeFalse();
          } catch (error) {
            expect(error instanceof TargetProcessMissingError || (error as NodeJS.ErrnoException).code === 'ENOENT').toBeTrue();
          }
        }
      } else if (process.platform === 'darwin' && firstTree !== null) {
        for (const snapshot of firstTree) {
          try {
            const current = await readDarwinProcessSnapshot(snapshot.pid);
            expect(sameProcessTreeSnapshot(current, snapshot)).toBeFalse();
          } catch (error) {
            expect(error).toBeInstanceOf(TargetProcessMissingError);
          }
        }
      } else {
        expect(await waitForChildExit(children[0]!)).toBeTrue();
      }

      await manager.stop();
      expect(await Bun.file(join(runtime, 'daemon.json')).exists()).toBeFalse();
      await waitPortClosed(basePort);
      await waitPortClosed(basePort + 1);
      await waitPortClosed(basePort + 2);
    } catch (error) {
      primaryError = error;
    } finally {
      try { await cleanupRealDaemon(join(runtime, 'daemon.json'), runtime); }
      catch (error) { cleanupErrors.push(new Error('graceful lifecycle failure', { cause: error })); }
      const childCleanup = await cleanupCapturedChildren(children);
      cleanupErrors.push(...childCleanup.errors);
      if (childCleanup.allExited) safeToRemove.add(root);
      if (primaryError !== undefined || cleanupErrors.length > 0) {
        throw new AggregateError([
          ...(primaryError === undefined ? [] : [primaryError]), ...cleanupErrors,
        ], 'real C2 test failed');
      }
    }
  }, 150_000);
});
