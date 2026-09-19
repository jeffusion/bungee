import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { createLaunchingDaemonMetadataFile, readDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import {
  DAEMON_BOOTSTRAP_ENV_NAMES,
  takeOverDaemonBootstrap,
} from '../../src/daemon-control/bootstrap';
import { startMasterProcess } from '../../src/master';
import type { MasterProcessDependencies } from '../../src/master-runtime/composition';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import { createMemoryWindowsAcl } from '../../../cli/src/daemon/test-support';

const BOOT = 'abcdef12-3456-7890-abcd-ef1234567890';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function fixture() {
  const dir = makeCanonicalTempDir('bungee-daemon-bootstrap', { daemonSafe: true });
  dirs.push(dir);
  const path = join(dir, 'daemon.json');
  const file = { runtimeDirectory: dir, platform: process.platform, windowsAcl: createMemoryWindowsAcl() };
  const metadata: DaemonMetadataV1 = {
    schema: 'bungee-daemon-metadata-v1', state: 'launching', launcher_pid: process.pid,
    boot_nonce: BOOT, shutdown_secret: SECRET, executable: process.execPath, entrypoint: null,
    pid: null, instance_id: null, management_host: null, management_port: null,
  };
  await createLaunchingDaemonMetadataFile(path, metadata, file);
  return { path, file, metadata };
}

function env(path: string, secret = SECRET): Record<string, string | undefined> {
  return {
    [DAEMON_BOOTSTRAP_ENV_NAMES.metadataPath]: path,
    [DAEMON_BOOTSTRAP_ENV_NAMES.bootNonce]: BOOT,
    [DAEMON_BOOTSTRAP_ENV_NAMES.shutdownSecret]: secret,
  };
}

describe('daemon bootstrap takeover', () => {
  test('takes over launching metadata, validates identity, and clears secrets', async () => {
    const { path, file } = await fixture();
    const environment = env(path);
    const result = await takeOverDaemonBootstrap({
      env: environment, marker: BOOT, pid: 4321, file,
      identity: { executable: process.execPath, entrypoint: null },
      runtimeDirectory: dirname(path),
      readMetadata: async (metadataPath) => {
        expect(Object.values(DAEMON_BOOTSTRAP_ENV_NAMES).every((name) => environment[name] === undefined)).toBeTrue();
        return readDaemonMetadataFile(metadataPath, file);
      },
    });
    expect(result).toMatchObject({ metadata: { state: 'starting', pid: 4321 }, pid: 4321, store: { file: { runtimeDirectory: dirname(path) } } });
    expect(result?.store.transition).toBeFunction();
    expect(Object.values(DAEMON_BOOTSTRAP_ENV_NAMES).every((name) => environment[name] === undefined)).toBeTrue();
  });

  test('rejects partial, marker, secret, and identity mismatches before any composition dependency', async () => {
    const { path, file } = await fixture();
    const partial = env(path);
    delete partial[DAEMON_BOOTSTRAP_ENV_NAMES.shutdownSecret];
    await expect(takeOverDaemonBootstrap({ env: partial, marker: null, file, runtimeDirectory: dirname(path) })).rejects.toThrow();
    expect(partial[DAEMON_BOOTSTRAP_ENV_NAMES.metadataPath]).toBeUndefined();

    const mismatch = env(path);
    await expect(takeOverDaemonBootstrap({ env: mismatch, marker: '00000000-0000-0000-0000-000000000000', file, runtimeDirectory: dirname(path) })).rejects.toThrow();
    const badSecret = env(path, 'AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
    await expect(takeOverDaemonBootstrap({ env: badSecret, marker: BOOT, file, runtimeDirectory: dirname(path) })).rejects.toThrow();
    const badIdentity = env(path);
    await expect(takeOverDaemonBootstrap({ env: badIdentity, marker: BOOT, file, runtimeDirectory: dirname(path), identity: { executable: '/other', entrypoint: null } })).rejects.toThrow();
  });

  test('leaves starting metadata when transition confirmation fails', async () => {
    const { path, file } = await fixture();
    const environment = env(path);
    let reads = 0;
    await expect(takeOverDaemonBootstrap({
      env: environment, marker: BOOT, file, runtimeDirectory: dirname(path),
      identity: { executable: process.execPath, entrypoint: null },
      readMetadata: async (metadataPath) => {
        reads += 1;
        if (reads === 2) throw new Error('confirmation unavailable');
        return readDaemonMetadataFile(metadataPath, file);
      },
    })).rejects.toThrow();
    const metadata = await readDaemonMetadataFile(path, file);
    expect(metadata.state).toBe('starting');
    expect(Object.values(DAEMON_BOOTSTRAP_ENV_NAMES).every((name) => environment[name] === undefined)).toBeTrue();
  });

  test('rejects takeover before composition, repository, or listener access', async () => {
    const names = Object.values(DAEMON_BOOTSTRAP_ENV_NAMES);
    const previous = names.map((name) => process.env[name]);
    process.env[DAEMON_BOOTSTRAP_ENV_NAMES.metadataPath] = '/not-trusted';
    delete process.env[DAEMON_BOOTSTRAP_ENV_NAMES.bootNonce];
    delete process.env[DAEMON_BOOTSTRAP_ENV_NAMES.shutdownSecret];
    let repository = 0;
    let listener = 0;
    try {
      const dependencies = {
        openRepository: () => { repository += 1; throw new Error('must not open'); },
        createManagementListener: () => { listener += 1; throw new Error('must not listen'); },
      } as unknown as MasterProcessDependencies;
      await expect(startMasterProcess(dependencies)).rejects.toThrow();
      expect(repository).toBe(0);
      expect(listener).toBe(0);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
});
