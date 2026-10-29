import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncConfigRepository, ConfigRepository, type ConfigurationCompileOptions, type ConfigRepositoryOptions,
  type CommitConfigurationCommandV1, type RepositorySnapshot } from '../../src/config-storage';
import { migrateConfigurationDatabase, CONFIG_MIGRATIONS } from '../../src/config-storage/migrations';
import { prepareCommitCommand } from '../../src/config-storage/prepared-command';
import { CONFIG_SCHEMA_STATEMENTS } from '../../src/config-storage/schema';

const roots: string[] = [];
const backends: ConfigRepository[] = [];
const clients: AsyncConfigRepository[] = [];
const catalog: ConfigurationCompileOptions = {
  pluginSchemas: new Map([['identity-one', []], ['identity-two', []], ['audit', []]]),
  managementProviders: new Set(['identity-one', 'identity-two']),
};
const empty = { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } as const;
function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'bungee-management-protection-')); roots.push(root);
  return join(root, 'bungee.db');
}
function open(dbPath = path(), options: ConfigRepositoryOptions = {}): ConfigRepository {
  const repository = ConfigRepository.open(dbPath, { compileOptions: catalog, ...options });
  backends.push(repository); return repository;
}
function command(snapshot: RepositorySnapshot, id: string, names: readonly string[], slots: readonly number[] = []): CommitConfigurationCommandV1 {
  return { mutation_id: id, expected_revision: snapshot.revision, kind: 'config', created_at: 100,
    aggregate: { ...snapshot.aggregate, plugin_activations: names.map(plugin_name => ({ plugin_name })) }, target_worker_slots: slots };
}
function finish(repository: ConfigRepository, id: string): void {
  repository.beginPublication(id, 101); repository.markDraining(id, 102);
  repository.finalizePublication(id, { outcome: 'converged', old_workers_exited: true }, 103);
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const repository of backends.splice(0)) repository.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('durable management protection', () => {
  test('migration 4 preserves existing revisions and menus and initializes an independent singleton', () => {
    const dbPath = path(), previous = open(dbPath);
    previous.commit(command(previous.getSnapshot(), 'before-upgrade', [])); finish(previous, 'before-upgrade');
    const layout = [{kind: 'page', pageId: 'builtin:dashboard', visible: false}] as const;
    previous.putMenuLayout(0, layout, ['builtin:dashboard']);
    previous.close(); backends.splice(backends.indexOf(previous), 1);
    const db = new Database(dbPath, { strict: true });
    // Reconstruct and validate the published prefix around real repository history.
    db.run('ALTER TABLE settings DROP COLUMN websocket_max_connections_json');
    db.run('DROP TABLE service_references');
    db.run('DROP TABLE routes');
    db.run(CONFIG_SCHEMA_STATEMENTS.find(statement=>statement.startsWith('CREATE TABLE routes'))!);
    db.run('DROP TABLE management_protection');
    db.run('ALTER TABLE configuration_operations DROP COLUMN management_provider');
    db.run('ALTER TABLE configuration_operations DROP COLUMN offline_management');
    db.run('DELETE FROM schema_migrations WHERE version>=4');
    migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.slice(0, 3));
    const revisions = db.query('SELECT * FROM configuration_revisions').all();
    db.close();
    const repository = open(dbPath);
    expect(repository.getManagementProtection()).toEqual({ required: false, selectedProvider: null, generation: 0 });
    expect(repository.getSnapshot().revision).toBe(2);
    expect(repository.getDatabase().query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(CONFIG_MIGRATIONS.map(({version})=>({version})));
    expect(repository.getSnapshot().aggregate).toEqual(empty);
    expect(repository.getDatabase().query('SELECT * FROM configuration_revisions').all()).toEqual(revisions);
    expect(repository.getMenuLayout()).toEqual({revision: 1, layout});
    expect(repository.getDatabase().query('SELECT management_provider,offline_management FROM configuration_operations').all()).toEqual([{management_provider: null, offline_management: 0}]);
    repository.close(); backends.splice(backends.indexOf(repository), 1);
    expect(open(dbPath).getMenuLayout()).toEqual({revision: 1, layout});
  });

  test('migration 4 failure rolls back DDL and migration history without changing menus before a successful reopen', () => {
    const dbPath = path(); const db = new Database(dbPath, { strict: true });
    migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.slice(0, 3));
    const layout = [{kind: 'page', pageId: 'builtin:dashboard', visible: false}] as const;
    db.run('UPDATE ui_menu_layout SET revision=9,layout_json=? WHERE id=1', [JSON.stringify(layout)]);
    const menu = db.query('SELECT * FROM ui_menu_layout').all();
    const before = db.query('SELECT * FROM configuration_revisions').all();
    const broken = { ...CONFIG_MIGRATIONS[3]!, up(database: Database) {
      CONFIG_MIGRATIONS[3]!.up(database); throw new Error('injected migration failure');
    } };
    expect(() => migrateConfigurationDatabase(db, [...CONFIG_MIGRATIONS.slice(0, 3), broken])).toThrow();
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='management_protection'").get()).toBeNull();
    expect(db.query('PRAGMA table_info(configuration_operations)').all().map(column => (column as {name: string}).name)).not.toContain('management_provider');
    expect(db.query('SELECT * FROM configuration_revisions').all()).toEqual(before);
    expect(db.query('SELECT * FROM ui_menu_layout').all()).toEqual(menu);
    expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    db.close();
    const repository = open(dbPath);
    expect(repository.getManagementProtection()).toEqual({ required: false, selectedProvider: null, generation: 0 });
    expect(repository.getMenuLayout()).toEqual({revision: 9, layout});
    expect(repository.getDatabase().query('SELECT * FROM configuration_revisions').all()).toEqual(before);
  });

  test('latches first selection, rejects disable/replacement, and preserves ordinary configuration', () => {
    const repository = open();
    expect(repository.commit(command(repository.getSnapshot(), 'enable', ['identity-one', 'audit'])).kind).toBe('committed');
    expect(repository.getManagementProtection()).toEqual({ required: true, selectedProvider: 'identity-one', generation: 1 });
    finish(repository, 'enable');
    const protectedSnapshot = repository.getSnapshot();
    for (const names of [[], ['identity-two'], ['identity-one', 'identity-two']]) {
      expect(() => repository.commit(command(protectedSnapshot, `rejected-${names.join('-')}`, names))).toThrow();
    }
    const next = command(protectedSnapshot, 'ordinary', ['identity-one', 'audit']);
    expect(repository.commit({ ...next, aggregate: { ...next.aggregate, logical_configuration: { ...next.aggregate.logical_configuration, log_level: 'warn' } } }).kind).toBe('committed');
    expect(repository.getManagementProtection().generation).toBe(1);
    expect(repository.getSnapshot().aggregate.logical_configuration.log_level).toBe('warn');
    expect(Object.keys(repository.getSnapshot().aggregate).sort()).toEqual(['logical_configuration', 'plugin_activations']);
  });

  test('selection is part of request identity and missing catalog cannot clear an existing guard', () => {
    const repository = open(); const input = command(repository.getSnapshot(), 'enable', ['identity-one']);
    const withCatalog = prepareCommitCommand(input, catalog);
    expect(withCatalog.requestHash).not.toBe(prepareCommitCommand(input).requestHash);
    repository.commit(input); finish(repository, 'enable');
    expect(() => repository.commitPrepared(prepareCommitCommand(command(repository.getSnapshot(), 'missing-catalog', ['identity-one'])))).toThrow();
    expect(repository.getManagementProtection().required).toBe(true);
  });

  test.each(['after_materialization', 'after_targets'] as const)('rolls back protection and activation at %s', stage => {
    const repository = open(undefined, { faultInjection(current) { if (current === stage) throw new Error('injected'); } });
    expect(() => repository.commit(command(repository.getSnapshot(), 'rollback', ['identity-one']))).toThrow();
    expect(repository.getControlProjection()).toMatchObject({ snapshot: { revision: 1, aggregate: empty }, managementProtection: { required: false, generation: 0 } });
    expect(repository.getOperation('rollback')).toBeNull();
  });

  test('offline initialize, replacement, clear and replay retain current configuration and durable generations', () => {
    const dbPath = path(); const repository = open(dbPath, { offline: true });
    const initial = command(repository.getSnapshot(), 'settings', ['audit']);
    repository.commit({ ...initial, aggregate: { ...initial.aggregate, logical_configuration: { ...initial.aggregate.logical_configuration, log_level: 'warn' } } });
    finish(repository, 'settings');
    const enabled = repository.setManagementProviderOffline('identity-one', 'offline-enable', 200);
    expect(enabled.managementProtection).toEqual({ required: true, selectedProvider: 'identity-one', generation: 1 });
    expect(repository.getOperation('offline-enable')).toMatchObject({ state: 'converged', target_worker_count: 0 });
    expect(repository.setManagementProviderOffline('identity-one', 'offline-enable', 201)).toEqual(enabled);
    expect(() => repository.setManagementProviderOffline('identity-two', 'offline-enable', 202)).toThrow();
    expect(() => repository.setManagementProviderOffline('audit', 'invalid', 202)).toThrow();
    const replaced = repository.setManagementProviderOffline('identity-two', 'offline-replace', 203);
    expect(replaced.snapshot.aggregate.plugin_activations).toEqual([{ plugin_name: 'audit' }, { plugin_name: 'identity-two' }]);
    const cleared = repository.setManagementProviderOffline(null, 'offline-clear', 204);
    expect(cleared.managementProtection).toEqual({ required: false, selectedProvider: null, generation: 3 });
    expect(cleared.snapshot.aggregate.logical_configuration.log_level).toBe('warn');
    expect(cleared.snapshot.aggregate.plugin_activations).toEqual([{ plugin_name: 'audit' }]);
    expect(repository.setManagementProviderOffline('identity-one', 'offline-enable', 205)).toEqual(cleared);
    repository.close(); backends.splice(backends.indexOf(repository), 1);
    expect(open(dbPath).getControlProjection()).toEqual(cleared);
  });

  test('normal open and normal commit on offline open cannot exercise the clear authority', () => {
    const dbPath = path(); const offline = open(dbPath, { offline: true });
    offline.setManagementProviderOffline('identity-one', 'offline-enable', 1);
    expect(() => offline.commit(command(offline.getSnapshot(), 'normal-clear', []))).toThrow();
    const ordinary = open(dbPath);
    expect(() => ordinary.setManagementProviderOffline(null, 'denied', 2)).toThrow();
    expect(ordinary.getManagementProtection().required).toBe(true);
  });

  test('offline changes reject pending operation and recovery without overwriting either', () => {
    const repository = open(undefined, { offline: true });
    repository.commit(command(repository.getSnapshot(), 'pending', [], [0]));
    expect(() => repository.setManagementProviderOffline('identity-one', 'denied-pending', 200)).toThrow();
    repository.beginPublication('pending', 101); repository.beginWorkerAttempt('pending', 0, 0, 'initial', 102);
    repository.recordWorkerResult('pending', 0, { kind: 'failed', attempt_no: 1, error: 'unavailable' }, 103);
    repository.finalizePublication('pending', { outcome: 'degraded', error_code: 'replacement_convergence_failed', error_detail: 'unavailable', recovery_disposition: 'retryable' }, 104);
    const recovery = repository.getCurrentRecovery();
    expect(() => repository.setManagementProviderOffline('identity-one', 'denied-recovery', 200)).toThrow();
    expect(repository.getCurrentRecovery()).toEqual(recovery);
    expect(repository.getManagementProtection().required).toBe(false);
  });

  test('offline failure is atomic and two stale openers operate on the actual current revision', () => {
    const dbPath = path(); const first = open(dbPath, { offline: true }); const second = open(dbPath, { offline: true });
    first.setManagementProviderOffline('identity-one', 'first', 1);
    expect(() => second.setManagementProviderOffline('identity-two', 'first', 2)).toThrow();
    const cleared = second.setManagementProviderOffline(null, 'second', 2);
    expect(cleared.snapshot.revision).toBe(3);
    expect(first.getControlProjection()).toEqual(cleared);
    const failing = open(undefined, { offline: true, faultInjection(stage) { if (stage === 'after_targets') throw new Error('injected'); } });
    expect(() => failing.setManagementProviderOffline('identity-one', 'failed-offline', 1)).toThrow();
    expect(failing.getControlProjection().snapshot.revision).toBe(1);
    expect(failing.getManagementProtection()).toEqual({ required: false, selectedProvider: null, generation: 0 });
  });

  test('corrupt guard and missing activation are rejected on reopening', () => {
    for (const sql of ['UPDATE management_protection SET generation=-1', "UPDATE management_protection SET required=1,selected_provider='missing'"]) {
      const dbPath = path(); const repository = open(dbPath); repository.close(); backends.splice(backends.indexOf(repository), 1);
      const db = new Database(dbPath); db.run('PRAGMA ignore_check_constraints=ON'); db.run(sql); db.close();
      expect(() => ConfigRepository.open(dbPath)).toThrow();
    }
  });

  test('real worker installs startup protection, propagates offline authority, and duplicate returns current pair', async () => {
    const dbPath = path();
    const client = await AsyncConfigRepository.open(dbPath, { compileOptions: catalog, offline: true }); clients.push(client);
    const input = command(client.getSnapshot(), 'worker-enable', ['identity-one']);
    expect((await client.commit(input)).kind).toBe('committed');
    expect(client.getManagementProtection()).toEqual({ required: true, selectedProvider: 'identity-one', generation: 1 });
    await client.beginPublication('worker-enable', 101); await client.markDraining('worker-enable', 102);
    await client.finalizePublication('worker-enable', { outcome: 'converged', old_workers_exited: true }, 103);
    await client.setManagementProviderOffline(null, 'worker-clear', 200);
    const current = client.getControlProjection();
    expect((await client.commit(input)).kind).toBe('duplicate');
    expect(client.getControlProjection()).toEqual(current);
    expect(current).toMatchObject({ snapshot: { revision: 3 }, managementProtection: { required: false, generation: 2 } });
    const ordinary = await AsyncConfigRepository.open(dbPath, { compileOptions: catalog }); clients.push(ordinary);
    const denied = await ordinary.setManagementProviderOffline('identity-one', 'worker-denied', 201).catch(error => error);
    expect(denied).toMatchObject({ code: 'invalid_command' });
    await client.setManagementProviderOffline('identity-two', 'worker-reenable', 202);
    expect((await ordinary.refreshControlProjection()).managementProtection.selectedProvider).toBe('identity-two');
    await ordinary.close(); clients.splice(clients.indexOf(ordinary), 1);
    const reopened = await AsyncConfigRepository.open(dbPath); clients.push(reopened);
    expect(reopened.getControlProjection()).toEqual(client.getControlProjection());
  });
});
