import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeDaemonMetadataV1 } from '@jeffusion/bungee-types';
import { createLaunchingDaemonMetadataFile, deleteDaemonMetadataForLauncher, readDaemonMetadataFile, transitionDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { createTestManager, makeCanonicalTempDir, optionsFor } from './test-support';

const directories: string[] = [];

async function seedMetadata(directory: string, state: 'launching' | 'starting' | 'armed' | 'stopping', launcherPid = process.pid): Promise<void> {
  const path = join(directory, 'daemon.json');
  const launching: DaemonMetadataV1 = {
    schema: 'bungee-daemon-metadata-v1', launcher_pid: launcherPid, state: 'launching',
    boot_nonce: '11111111-1111-4111-8111-111111111111', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    executable: process.execPath, entrypoint: null, pid: null, instance_id: null, management_host: null, management_port: null,
  };
  await createLaunchingDaemonMetadataFile(path, launching, optionsFor(directory));
  if (state === 'launching') return;
  const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242 };
  await transitionDaemonMetadataFile(path, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
  }, optionsFor(directory));
  if (state === 'starting') return;
  const armed: DaemonMetadataV1 = { ...starting, state: 'armed', instance_id: '22222222-2222-4222-8222-222222222222', management_host: '127.0.0.1', management_port: 8089 };
  await transitionDaemonMetadataFile(path, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'starting', expectedShutdownSecret: launching.shutdown_secret, next: armed,
  }, optionsFor(directory));
  if (state === 'armed') return;
  await transitionDaemonMetadataFile(path, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'armed', expectedShutdownSecret: launching.shutdown_secret,
    next: { ...armed, state: 'stopping' },
  }, optionsFor(directory));
}

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

type BootstrapResult = { readonly ok: true } | { readonly ok: false; readonly error: unknown };

function ownBootstrap(bootstraps: Array<Promise<BootstrapResult>>, task: Promise<unknown>): void {
  bootstraps.push(task.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  ));
}

async function startWithJoinedBootstraps(
  start: () => Promise<void>, bootstraps: ReadonlyArray<Promise<BootstrapResult>>,
): Promise<void> {
  const started = await start().then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );
  const completed = await Promise.all(bootstraps);
  if (!started.ok) throw started.error;
  const failed = completed.find((result) => !result.ok);
  if (failed && !failed.ok) throw failed.error;
}

describe('DaemonManager Stage C-1 ownership', () => {
  test('deletes the launch record when spawn throws without exposing the secret in arguments', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-spawn', { daemonSafe: true });
    directories.push(directory);
    const manager = createTestManager(() => { throw new Error('spawn failed'); }, undefined, {
      runtimeDirectory: directory,
      directLaunch: { executable: process.execPath, entrypoint: null },
    });
    await expect(manager.start()).rejects.toThrow('spawn failed');
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeFalse();
  });

  test('passes a direct canonical entrypoint and only the boot marker in argv', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-direct', { daemonSafe: true });
    directories.push(directory);
    const entrypoint = join(directory, 'master.ts');
    await writeFile(entrypoint, '');
    let launchArgs: readonly string[] = [];
    const bootstraps: Array<Promise<BootstrapResult>> = [];
    const manager = createTestManager((executable, args) => {
      launchArgs = args;
      const file = optionsFor(directory);
      ownBootstrap(bootstraps, readDaemonMetadataFile(join(directory, 'daemon.json'), file).then(async (launching) => {
        const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242,
          instance_id: null, management_host: null, management_port: null };
        await transitionDaemonMetadataFile(join(directory, 'daemon.json'), {
          expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
        }, file);
        await transitionDaemonMetadataFile(join(directory, 'daemon.json'), {
          expectedBootNonce: launching.boot_nonce, expectedState: 'starting', expectedShutdownSecret: launching.shutdown_secret,
          next: { ...starting, state: 'armed', instance_id: '11111111-1111-4111-8111-111111111111', management_host: '127.0.0.1', management_port: 8089 },
        }, file);
      }));
      return { pid: 4242, unref() {} };
    }, undefined, {
      runtimeDirectory: directory,
      directLaunch: { executable: process.execPath, entrypoint },
      probeProcess: async () => 'exact',
    });
    (manager as unknown as { pidFile: string }).pidFile = join(directory, 'bungee.pid');
    await startWithJoinedBootstraps(() => manager.start(), bootstraps);
    expect(launchArgs).toHaveLength(2);
    expect(launchArgs[0]).toBe(entrypoint);
    expect(launchArgs[1]).toMatch(/^--bungee-daemon-boot=[0-9a-f-]{36}$/);
    expect((await Bun.file(join(directory, 'bungee.pid')).text())).toBe('4242');
  });

  test('locks compiled-shaped launch identity to a null entrypoint and marker-only argv', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-compiled', { daemonSafe: true });
    directories.push(directory);
    let capturedArgs: readonly string[] = [];
    let capturedEnv: Readonly<Record<string, string | undefined>> = {};
    const manager = createTestManager((_executable, args, options) => {
      capturedArgs = args;
      capturedEnv = options.env ?? {};
      return { pid: 4242, unref() {} };
    }, undefined, { runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null } });
    manager['startTimeoutMs'] = 0;
    await expect(manager.start()).rejects.toThrow('metadata retained');
    const metadata = await readDaemonMetadataFile(join(directory, 'daemon.json'), optionsFor(directory));
    expect(metadata.entrypoint).toBeNull();
    expect(capturedArgs).toEqual([`--bungee-daemon-boot=${metadata.boot_nonce}`]);
    expect(capturedArgs.join(' ')).not.toContain(metadata.shutdown_secret);
    expect(capturedEnv.BUNGEE_DAEMON_BOOT_NONCE).toBe(metadata.boot_nonce);
    expect(capturedEnv.BUNGEE_DAEMON_SHUTDOWN_SECRET).toBe(metadata.shutdown_secret);
  });

  test('does not fail an armed start when the compatibility PID mirror fails', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-mirror', { daemonSafe: true });
    directories.push(directory);
    const bootstraps: Array<Promise<BootstrapResult>> = [];
    const manager = createTestManager(() => {
      const file = optionsFor(directory);
      ownBootstrap(bootstraps, readDaemonMetadataFile(join(directory, 'daemon.json'), file).then(async (launching) => {
        const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242,
          instance_id: null, management_host: null, management_port: null };
        await transitionDaemonMetadataFile(join(directory, 'daemon.json'), {
          expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
        }, file);
        await transitionDaemonMetadataFile(join(directory, 'daemon.json'), {
          expectedBootNonce: launching.boot_nonce, expectedState: 'starting', expectedShutdownSecret: launching.shutdown_secret,
          next: { ...starting, state: 'armed', instance_id: '11111111-1111-4111-8111-111111111111', management_host: '127.0.0.1', management_port: 8089 },
        }, file);
      }));
      return { pid: 4242, unref() {} };
    }, undefined, {
      runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null },
      probeProcess: async () => 'exact', writePidMirror: async () => { throw new Error('disk full / secret omitted'); },
    });
    (manager as unknown as { pidFile: string }).pidFile = join(directory, 'bungee.pid');
    await expect(startWithJoinedBootstraps(() => manager.start(), bootstraps)).resolves.toBeUndefined();
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeTrue();
    expect(await Bun.file(join(directory, 'bungee.pid')).exists()).toBeFalse();
  });

  test('two concurrent starts have one O_EXCL winner and one loser', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-concurrent', { daemonSafe: true });
    directories.push(directory);
    let spawns = 0;
    let winnerArgs: readonly string[] = [];
    const create = () => {
      const manager = createTestManager((_executable, args) => { spawns += 1; winnerArgs = args; return { pid: 4242, unref() {} }; }, undefined, {
        runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null },
      });
      manager['startTimeoutMs'] = 0;
      return manager.start();
    };
    await Promise.all([create().catch(() => undefined), create().catch(() => undefined)]);
    expect(spawns).toBe(1);
    const metadata = await readDaemonMetadataFile(join(directory, 'daemon.json'), optionsFor(directory));
    expect(metadata.state).toBe('launching');
    expect(winnerArgs).toEqual([`--bungee-daemon-boot=${metadata.boot_nonce}`]);
    expect(winnerArgs.join(' ')).not.toContain(metadata.shutdown_secret);
    expect(await readFile(join(directory, 'daemon.json'))).toEqual(Buffer.from(encodeDaemonMetadataV1(metadata)));
  });

  test('stale ownership matrix never signals and only dead/safe-mismatch records are replaced', async () => {
    const cases = [
      { name: 'launching alive', state: 'launching' as const, launcher: 'alive' as const, marker: 'none' as const, probe: 'exact' as const, action: 'keep' as const },
      { name: 'launching dead marker found', state: 'launching' as const, launcher: 'dead' as const, marker: 'found' as const, probe: 'exact' as const, action: 'keep' as const },
      { name: 'launching dead marker unknown', state: 'launching' as const, launcher: 'dead' as const, marker: 'unknown' as const, probe: 'exact' as const, action: 'keep' as const },
      { name: 'launching dead marker none', state: 'launching' as const, launcher: 'dead' as const, marker: 'none' as const, probe: 'exact' as const, action: 'replace' as const },
      ...(['starting', 'armed', 'stopping'] as const).flatMap((state) => [
        { name: `${state} exact`, state, launcher: 'dead' as const, marker: 'none' as const, probe: 'exact' as const, action: 'keep' as const },
        { name: `${state} unknown`, state, launcher: 'dead' as const, marker: 'none' as const, probe: 'unknown' as const, action: 'keep' as const },
        { name: `${state} dead`, state, launcher: 'dead' as const, marker: 'none' as const, probe: 'dead' as const, action: 'replace' as const },
        { name: `${state} PID reuse mismatch`, state, launcher: 'dead' as const, marker: 'none' as const, probe: 'mismatch' as const, action: 'replace' as const },
      ]),
    ];
    for (const item of cases) {
      const directory = makeCanonicalTempDir('bungee-c1-stale', { daemonSafe: true });
      directories.push(directory);
      const oldLauncherPid = item.state === 'launching' ? process.pid + 100_000 : process.pid;
      await seedMetadata(directory, item.state, oldLauncherPid);
      const path = join(directory, 'daemon.json');
      const before = await readFile(path);
      let spawns = 0;
      const signals: Array<string | number> = [];
      const manager = createTestManager(() => { spawns += 1; return { pid: 5252, unref() {} }; }, {
        kill(_pid, signal) {
          signals.push(signal);
          if (item.launcher === 'dead') { const error = new Error('dead') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; }
        },
      }, {
        runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null },
        findProcess: async () => item.marker,
        probeProcess: async () => item.probe,
      });
      manager['startTimeoutMs'] = 0;
      await (item.action === 'keep' ? expect(manager.start()).rejects.toThrow() : expect(manager.start()).rejects.toThrow('metadata retained'));
      if (item.name === 'launching alive') {
        const metadata = await readDaemonMetadataFile(path, optionsFor(directory));
        expect(await deleteDaemonMetadataForLauncher(path, {
          bootNonce: metadata.boot_nonce, shutdownSecret: metadata.shutdown_secret,
        }, optionsFor(directory))).toBeFalse();
      }
      expect(spawns).toBe(item.action === 'replace' ? 1 : 0);
      expect(signals.every((signal) => signal === 0)).toBeTrue();
      const after = await readFile(path);
      if (item.action === 'keep') expect(after).toEqual(before);
      else expect(after).not.toEqual(before);
    }
  });

  test('removes a dead launching record before retrying a transient boot marker', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-launching-stop', { daemonSafe: true });
    directories.push(directory);
    await seedMetadata(directory, 'launching', process.pid + 100_000);
    let clock = 0;
    let markerCalls = 0;
    const manager = createTestManager(undefined, { kill: () => { throw new Error('must not signal'); } }, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      probePid: async () => 'dead',
      findProcess: async () => (['none', 'found', 'none'] as const)[markerCalls++] ?? 'none',
    });
    manager['stopTimeoutMs'] = 300;
    await manager.stop();
    expect(markerCalls).toBe(3);
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeFalse();
  });

  test('waits for an unref failure child to exit before launch cleanup', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-unref', { daemonSafe: true });
    directories.push(directory);
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void; kill: () => boolean };
    child.pid = 4242;
    child.unref = () => { throw new Error('unref failed'); };
    child.kill = () => { child.emit('exit'); return true; };
    const manager = createTestManager(() => child, undefined, {
      runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null },
    });
    await expect(manager.start()).rejects.toThrow('unref failed');
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeFalse();
  });

  test('cleans the owner-specific record when the child exits in launching, starting, or armed', async () => {
    for (const targetState of ['launching', 'starting', 'armed'] as const) {
      const directory = makeCanonicalTempDir(`bungee-c1-exit-${targetState}`, { daemonSafe: true });
      directories.push(directory);
      const path = join(directory, 'daemon.json');
      const file = optionsFor(directory);
      let child!: EventEmitter & { pid: number; unref: () => void };
      let clock = 0;
      const manager = createTestManager(() => {
        child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
        child.pid = 4242;
        child.unref = () => {};
        return child;
      }, undefined, {
        runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null },
        now: () => clock,
        sleep: async (milliseconds) => { clock += milliseconds; },
        probeProcess: async () => {
          let metadata = await readDaemonMetadataFile(path, file);
          if (metadata.state === targetState) {
            child.emit('exit');
            return 'exact';
          }
          if (metadata.state === 'launching' && targetState !== 'launching') {
            const starting: Extract<DaemonMetadataV1, { state: 'starting' }> = { ...metadata, state: 'starting', pid: child.pid };
            metadata = await transitionDaemonMetadataFile(path, {
              expectedBootNonce: metadata.boot_nonce, expectedState: 'launching', expectedShutdownSecret: metadata.shutdown_secret, next: starting,
            }, file);
          }
          if (metadata.state === 'starting' && targetState === 'armed') {
            await transitionDaemonMetadataFile(path, {
              expectedBootNonce: metadata.boot_nonce, expectedState: 'starting', expectedShutdownSecret: metadata.shutdown_secret,
              next: { ...metadata, state: 'armed', instance_id: '33333333-3333-4333-8333-333333333333', management_host: '127.0.0.1', management_port: 8089 },
            }, file);
          }
          return 'exact';
        },
      });
      manager['startTimeoutMs'] = 1_000;
      await expect(manager.start()).rejects.toThrow();
      expect(await Bun.file(path).exists()).toBeFalse();
    }
  });

  test('does not delete a replacement record after the old child exits', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-exit-replaced', { daemonSafe: true });
    directories.push(directory);
    const path = join(directory, 'daemon.json');
    const file = optionsFor(directory);
    let child!: EventEmitter & { pid: number; unref: () => void };
    const manager = createTestManager(() => {
      child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = 4242;
      child.unref = () => {};
      return child;
    }, undefined, {
      runtimeDirectory: directory,
      directLaunch: { executable: process.execPath, entrypoint: null },
      probeProcess: async () => {
        const metadata = await readDaemonMetadataFile(path, file);
        child.emit('exit');
        await writeFile(path, encodeDaemonMetadataV1({
          ...metadata,
          boot_nonce: '44444444-4444-4444-8444-444444444444',
          shutdown_secret: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA',
        }));
        return 'exact';
      },
    });
    await expect(manager.start()).rejects.toThrow('exited before takeover');
    const metadata = await readDaemonMetadataFile(path, file);
    expect(metadata.boot_nonce).toBe('44444444-4444-4444-8444-444444444444');
    expect(metadata.shutdown_secret).toBe('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA');
  });

  test('repairs stale metadata after an armed child crashes before the next status/start', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-crash-repair', { daemonSafe: true });
    directories.push(directory);
    const path = join(directory, 'daemon.json');
    const file = optionsFor(directory);
    let child!: EventEmitter & { pid: number; unref: () => void };
    let childAlive = false;
    let clock = 0;
    let spawns = 0;
    const bootstraps: Array<Promise<BootstrapResult>> = [];
    const manager = createTestManager(() => {
      spawns += 1;
      child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
      child.pid = 4242;
      child.unref = () => {};
      childAlive = true;
      ownBootstrap(bootstraps, (async () => {
        const launching = await readDaemonMetadataFile(path, file);
        if (launching.state !== 'launching') throw new Error('expected launching metadata');
        const starting: Extract<DaemonMetadataV1, { state: 'starting' }> = { ...launching, state: 'starting', pid: child.pid };
        await transitionDaemonMetadataFile(path, {
          expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
        }, file);
        await transitionDaemonMetadataFile(path, {
          expectedBootNonce: starting.boot_nonce, expectedState: 'starting', expectedShutdownSecret: starting.shutdown_secret,
          next: { ...starting, state: 'armed', instance_id: '55555555-5555-4555-8555-555555555555', management_host: '127.0.0.1', management_port: 8089 },
        }, file);
      })());
      return child;
    }, undefined, {
      runtimeDirectory: directory,
      directLaunch: { executable: process.execPath, entrypoint: null },
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      probeProcess: async () => childAlive ? 'exact' : 'dead',
    });

    await startWithJoinedBootstraps(() => manager.start(), bootstraps);
    childAlive = false;
    child.emit('exit');
    const status = await manager.getStatus();
    expect(status.running).toBeFalse();
    expect(await Bun.file(path).exists()).toBeTrue();

    await startWithJoinedBootstraps(() => manager.start(), bootstraps);
    expect(spawns).toBe(2);
    expect((await manager.getStatus()).running).toBeTrue();
  });

  test('observes an asynchronous spawn error without an unhandled error or secret leak', async () => {
    const directory = makeCanonicalTempDir('bungee-c1-async-error', { daemonSafe: true });
    directories.push(directory);
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 4242;
    child.unref = () => {};
    const manager = createTestManager(() => {
      queueMicrotask(() => { child.emit('error', new Error('spawn failed with hidden-secret')); child.emit('exit'); });
      return child;
    }, undefined, { runtimeDirectory: directory, directLaunch: { executable: process.execPath, entrypoint: null } });
    let error: unknown;
    try { await manager.start(); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('expected asynchronous spawn error');
    expect(error.message).not.toContain('hidden-secret');
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeFalse();
  });

  test('fails closed on corrupt metadata and retains live metadata on timeout', async () => {
    const corruptDir = makeCanonicalTempDir('bungee-c1-corrupt', { daemonSafe: true });
    directories.push(corruptDir);
    await writeFile(join(corruptDir, 'daemon.json'), '{not metadata');
    const corrupt = createTestManager(() => { throw new Error('must not spawn'); }, undefined, {
      runtimeDirectory: corruptDir, pidFile: join(corruptDir, 'bungee.pid'),
      directLaunch: { executable: process.execPath, entrypoint: null },
    });
    await expect(corrupt.start()).rejects.toThrow('Cannot safely inspect');

    const liveDir = makeCanonicalTempDir('bungee-c1-timeout', { daemonSafe: true });
    directories.push(liveDir);
    const live = createTestManager(() => ({ pid: 4242, unref() {} }), undefined, {
      runtimeDirectory: liveDir, pidFile: join(liveDir, 'bungee.pid'),
      directLaunch: { executable: process.execPath, entrypoint: null },
      probeProcess: async () => 'exact',
    });
    live['startTimeoutMs'] = 0;
    await expect(live.start()).rejects.toThrow('metadata retained');
    expect(await Bun.file(join(liveDir, 'daemon.json')).exists()).toBeTrue();
  });
});
