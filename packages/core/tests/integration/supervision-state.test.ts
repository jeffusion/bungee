import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigRepository, ConfigRepositoryError } from '../../src/config-storage';
import { CONFIG_MIGRATION_V1 } from '../../src/config-storage/migrations/v1';
import { CONFIG_MIGRATION_V2 } from '../../src/config-storage/migrations/v2';
import { CONFIG_MIGRATION_V3 } from '../../src/config-storage/migrations/v3';
import { CONFIG_MIGRATION_V4 } from '../../src/config-storage/migrations/v4';
import { CONFIG_MIGRATION_V5 } from '../../src/config-storage/migrations/v5';
import { CONFIG_MIGRATION_V6 } from '../../src/config-storage/migrations/v6';
import { acquireMasterInstanceLock, mintControllerClaimCapability } from '../../src/master-runtime/instance-lock';

const roots: string[] = [];
const repositories: ConfigRepository[] = [];
const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-supervision-state-'));
  roots.push(root);
  return join(root, 'config.db');
}

async function claim(repository: ConfigRepository, dbPath: string, controllerId: string, updatedAt: number) {
  const configLock = await acquireMasterInstanceLock(`${dbPath}.config.lock`);
  const accessLock = await acquireMasterInstanceLock(`${dbPath}.access.lock`);
  try {
    const capability = mintControllerClaimCapability(configLock, accessLock);
    return repository.claimControllerWithCapability(capability, controllerId, updatedAt);
  } finally {
    await accessLock.release();
    await configLock.release();
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('persistent supervision state', () => {
  test('fresh init and v6 upgrade create one stable state row and atomically advance epochs', async () => {
    const freshPath = path();
    const fresh = ConfigRepository.open(freshPath);
    repositories.push(fresh);
    const initial = fresh.getSupervisionState();
    expect(fresh.getDatabase().query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('supervision_state') ORDER BY cid",
    ).all().map(({ name }) => name)).toEqual(['id', 'instance_id', 'controller_epoch', 'current_controller_id', 'updated_at']);
    expect(initial.controller_epoch).toBe(0);
    expect(initial.current_controller_id).toBeNull();
    expect(await claim(fresh, freshPath, FIRST, 10)).toMatchObject({ controller_epoch: 1, current_controller_id: FIRST, updated_at: 10 });
    const peer = ConfigRepository.open(freshPath);
    repositories.push(peer);
    expect(await claim(peer, freshPath, SECOND, 11)).toMatchObject({ controller_epoch: 2, current_controller_id: SECOND, updated_at: 11 });
    expect(await claim(peer, freshPath, FIRST, 5)).toMatchObject({ controller_epoch: 3, updated_at: 11 });
    const stableId = initial.instance_id;
    fresh.close();
    peer.close();
    repositories.splice(repositories.indexOf(fresh), 1);
    repositories.splice(repositories.indexOf(peer), 1);
    const reopened = ConfigRepository.open(freshPath);
    repositories.push(reopened);
    expect(reopened.getSupervisionState().instance_id).toBe(stableId);
    reopened.getDatabase().run('UPDATE supervision_state SET controller_epoch=?', [Number.MAX_SAFE_INTEGER - 1]);
    await expect(claim(reopened, freshPath, SECOND, 12)).rejects.toBeInstanceOf(ConfigRepositoryError);
    expect(reopened.getSupervisionState().controller_epoch).toBe(Number.MAX_SAFE_INTEGER - 1);

    const oldPath = path();
    const old = new Database(oldPath, { create: true, readwrite: true, strict: true });
    old.transaction(() => {
      CONFIG_MIGRATION_V1.up(old); CONFIG_MIGRATION_V2.up(old); CONFIG_MIGRATION_V3.up(old);
      CONFIG_MIGRATION_V4.up(old); CONFIG_MIGRATION_V5.up(old); CONFIG_MIGRATION_V6.up(old);
    }).immediate();
    old.close(true);
    const upgraded = ConfigRepository.open(oldPath);
    repositories.push(upgraded);
    expect(upgraded.getSupervisionState().controller_epoch).toBe(0);
  });

  test('fails closed for a corrupted singleton row', () => {
    const dbPath = path();
    const repository = ConfigRepository.open(dbPath);
    repository.close();
    const db = new Database(dbPath, { readwrite: true, strict: true });
    db.run('PRAGMA ignore_check_constraints=ON');
    db.run("UPDATE supervision_state SET instance_id='not-a-uuid'");
    db.close(true);
    try {
      ConfigRepository.open(dbPath);
      throw new Error('corrupt database unexpectedly opened');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigRepositoryError);
      if (error instanceof ConfigRepositoryError) expect(error.code).toBe('schema_corrupt');
    }
  });

  test('rejects a structurally forged claim capability without advancing the epoch', async () => {
    const dbPath = path();
    const repository = ConfigRepository.open(dbPath);
    repositories.push(repository);
    const forged = { __controllerClaimCapability: Symbol('forged') } as never;

    expect(() => repository.claimControllerWithCapability(forged, FIRST, 10)).toThrow(ConfigRepositoryError);
    expect(repository.getSupervisionState().controller_epoch).toBe(0);
  });
});
