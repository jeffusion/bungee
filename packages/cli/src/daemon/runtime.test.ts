import { afterEach, describe, expect, test } from 'bun:test';
import { join, posix, win32 } from 'node:path';
import { rm } from 'node:fs/promises';
import { canonicalTempRoot, makeCanonicalTempDir } from './test-support';
import { createDaemonRuntime } from './runtime';

const directories: string[] = [];

function runtimePaths(): { readonly dataDirectory: string; readonly logsDirectory: string; readonly path: string } {
  const path = makeCanonicalTempDir('bungee-runtime');
  directories.push(path);
  return { path, dataDirectory: join(path, 'data'), logsDirectory: join(path, 'logs') };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('createDaemonRuntime', () => {
  test('uses stable absolute SQLite paths and explicit process options', () => {
    // Given
    const { dataDirectory, logsDirectory, path } = runtimePaths();
    const inheritedPath = join(path, 'bin');
    const legacyConfig = join(path, 'legacy.json');
    const unsafePlugins = join(path, 'unsafe-plugins');

    // When
    const runtime = createDaemonRuntime({
      dataDirectory,
      logsDirectory,
      workers: '3',
      port: '9090',
      inheritedEnvironment: {
        PATH: inheritedPath,
        CONFIG_PATH: legacyConfig,
        PLUGINS_DIR: unsafePlugins,
      },
    });

    // Then
    expect(runtime.cwd).toBe(dataDirectory);
    expect(runtime.env).toEqual({
      BUNGEE_CONFIG_DB_PATH: join(dataDirectory, 'bungee.db'),
      BUNGEE_ACCESS_DB_PATH: join(logsDirectory, 'access.db'),
      WORKER_COUNT: '3',
      DAEMON_MODE: 'true',
      PORT: '9090',
      PATH: inheritedPath,
    });
    expect('CONFIG_PATH' in runtime.env).toBe(false);
    expect('PLUGINS_DIR' in runtime.env).toBe(false);
  });

  test('preserves generic inherited environment entries', () => {
    // Given
    const inheritedEnvironment = {
      CUSTOM_SETTING: 'enabled',
      EMPTY_SETTING: undefined,
    };

    // When
    const { dataDirectory, logsDirectory } = runtimePaths();
    const runtime = createDaemonRuntime({
      dataDirectory,
      logsDirectory,
      inheritedEnvironment,
    });

    // Then
    expect(runtime.env).toEqual({
      BUNGEE_CONFIG_DB_PATH: join(dataDirectory, 'bungee.db'),
      BUNGEE_ACCESS_DB_PATH: join(logsDirectory, 'access.db'),
      WORKER_COUNT: '2',
      DAEMON_MODE: 'true',
      CUSTOM_SETTING: 'enabled',
    });
  });

  test('uses daemon defaults without optional port', () => {
    // Given
    const { dataDirectory, logsDirectory } = runtimePaths();
    const options = { dataDirectory, logsDirectory };

    // When
    const runtime = createDaemonRuntime(options);

    // Then
    expect(runtime).toEqual({
      cwd: dataDirectory,
      env: {
        BUNGEE_CONFIG_DB_PATH: join(dataDirectory, 'bungee.db'),
        BUNGEE_ACCESS_DB_PATH: join(logsDirectory, 'access.db'),
        WORKER_COUNT: '2',
        DAEMON_MODE: 'true',
      },
    });
  });

  test('strips bootstrap and role variables without case sensitivity', () => {
    const { dataDirectory, logsDirectory, path } = runtimePaths();
    const runtime = createDaemonRuntime({
      dataDirectory, logsDirectory,
      inheritedEnvironment: {
        bUnGeE_dAeMoN_mEtAdAtA_pAtH: join(path, 'metadata'), BUNGEE_DAEMON_BOOT_NONCE: 'boot',
        bungee_daemon_shutdown_secret: 'secret', bUnGeE_rOlE: 'worker', SAFE: 'yes',
      },
    });
    expect(runtime.env).toEqual({
      BUNGEE_CONFIG_DB_PATH: join(dataDirectory, 'bungee.db'),
      BUNGEE_ACCESS_DB_PATH: join(logsDirectory, 'access.db'), WORKER_COUNT: '2', DAEMON_MODE: 'true', SAFE: 'yes',
    });
  });

  test('uses platform-native physical temp roots', () => {
    const windowsHome = win32.join('C:\\', 'Users', 'alice');
    const windowsTemp = win32.join('C:\\', 'tmp', 'profile');
    let windowsMkdtempCalls = 0;
    const windowsFs = {
      realpathSync: (path: string) => path,
      mkdtempSync: (prefix: string) => { windowsMkdtempCalls += 1; return `${prefix}fixture`; },
    };
    const windowsRoot = makeCanonicalTempDir('fixture', {
      daemonSafe: true, platform: 'win32', homedir: () => windowsHome, tmpdir: () => windowsTemp, fs: windowsFs,
    });
    const relative = win32.relative(windowsHome, windowsRoot);
    expect(relative.length).toBeGreaterThan(0);
    expect(win32.isAbsolute(relative)).toBe(false);
    expect(relative).not.toBe('..');
    expect(relative.startsWith(`..${win32.sep}`)).toBe(false);
    expect(windowsRoot).not.toContain(windowsTemp);
    expect(windowsRoot).not.toContain(join('/', 'tmp'));
    expect(windowsMkdtempCalls).toBe(1);

    const lexicalTemp = posix.join(posix.sep, 'var', 'folders', 'wx', 'abc');
    const physicalRoot = posix.join(posix.sep, 'private', 'var', 'folders', 'wx', 'abc');
    const darwinFs = {
      realpathSync: (path: string) => path === lexicalTemp ? physicalRoot : path,
      mkdtempSync: (prefix: string) => `${prefix}fixture`,
    };
    const darwinRoot = canonicalTempRoot({ platform: 'darwin', tmpdir: () => lexicalTemp, fs: darwinFs });
    expect(darwinRoot).toBe(physicalRoot);
    expect(makeCanonicalTempDir('fixture', { platform: 'darwin', tmpdir: () => lexicalTemp, fs: darwinFs }))
      .toBe(posix.join(physicalRoot, 'fixture-fixture'));
  });
});
