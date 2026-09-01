import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createDaemonRuntime } from './runtime';

describe('createDaemonRuntime', () => {
  test('uses stable absolute SQLite paths and explicit process options', () => {
    // Given
    const dataDirectory = '/home/test/.bungee/data';
    const logsDirectory = '/home/test/.bungee/logs';

    // When
    const runtime = createDaemonRuntime({
      dataDirectory,
      logsDirectory,
      workers: '3',
      port: '9090',
      inheritedEnvironment: {
        PATH: '/usr/bin',
        CONFIG_PATH: '/tmp/legacy.json',
        PLUGINS_DIR: '/tmp/unsafe-plugins',
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
      PATH: '/usr/bin',
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
    const runtime = createDaemonRuntime({
      dataDirectory: '/home/test/.bungee/data',
      logsDirectory: '/home/test/.bungee/logs',
      inheritedEnvironment,
    });

    // Then
    expect(runtime.env).toEqual({
      BUNGEE_CONFIG_DB_PATH: '/home/test/.bungee/data/bungee.db',
      BUNGEE_ACCESS_DB_PATH: '/home/test/.bungee/logs/access.db',
      WORKER_COUNT: '2',
      DAEMON_MODE: 'true',
      CUSTOM_SETTING: 'enabled',
    });
  });

  test('uses daemon defaults without optional port', () => {
    // Given
    const options = {
      dataDirectory: '/home/test/.bungee/data',
      logsDirectory: '/home/test/.bungee/logs',
    };

    // When
    const runtime = createDaemonRuntime(options);

    // Then
    expect(runtime).toEqual({
      cwd: '/home/test/.bungee/data',
      env: {
        BUNGEE_CONFIG_DB_PATH: '/home/test/.bungee/data/bungee.db',
        BUNGEE_ACCESS_DB_PATH: '/home/test/.bungee/logs/access.db',
        WORKER_COUNT: '2',
        DAEMON_MODE: 'true',
      },
    });
  });
});
