import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ConfigRepository, AsyncConfigRepository } from '../../src/config-storage';
import { CONFIG_MIGRATIONS, migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { verifySchemaFingerprint } from '../../src/config-storage/schema-fingerprint';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-retirement-store-'));
  const path = join(directory, 'config.db');
  return { directory, path, repository: ConfigRepository.open(path) };
}
const BOOT = 'kernel-monotonic-v1:linux:11111111-1111-4111-8111-111111111111';

test('cleanup retry acceptance survives reopen and cannot change attempt identity or deadlines',()=>{
  const {directory,path,repository}=fixture(); const requestId=randomUUID();
  try {
    repository.commit({mutation_id:'cleanup-request',expected_revision:1,kind:'config',created_at:1,target_worker_slots:[],
      aggregate:{logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[]}});
    repository.beginPublication('cleanup-request',2);repository.markDraining('cleanup-request',3);
    const member={identity:{master_generation:randomUUID(),worker_instance_id:randomUUID(),worker_slot:0},boot_nonce:randomUUID(),pid:123,
      private_port:4567,revision:1,content_hash:repository.getSnapshot().content_hash,plugin_catalog_hash:repository.getSnapshot().content_hash,
      publication:null,guard:null,drain_id:randomUUID(),deadline_boot_id:BOOT,start_deadline_ns:'987654321'};
    repository.freezePublicationRetirement('cleanup-request',0,[member],3);
    repository.stopPublicationRetirement('cleanup-request','exit_unknown',4);
    expect(()=>repository.requestPublicationRetirementRetry(requestId,'cleanup-request',1,5)).toThrow('revision changed');
    const result=repository.requestPublicationRetirementRetry(requestId,'cleanup-request',2,5);
    expect(result).toEqual({request_id:requestId,source_mutation_id:'cleanup-request',target_revision:2,status:'accepted'});
    expect(repository.getPublicationRetirement('cleanup-request')).toMatchObject({state:'pending',members:[{start_deadline_ns:'987654321'}]});
    repository.stopPublicationRetirement('cleanup-request','exit_unknown',6);
    expect(repository.requestPublicationRetirementRetry(requestId,'cleanup-request',2,7)).toEqual(result);
    expect(repository.getPublicationRetirement('cleanup-request')?.state).toBe('stopped');
    expect(repository.getOperation('cleanup-request')?.drain_recovery_generation).toBe(0);
    repository.close();const reopened=ConfigRepository.open(path);
    try {
      expect(reopened.getPublicationRetirementRetry(requestId)).toEqual(result);
      expect(reopened.requestPublicationRetirementRetry(requestId,'cleanup-request',2,8)).toEqual(result);
      expect(()=>reopened.requestPublicationRetirementRetry(requestId,'another-operation',2,8)).toThrow('identity was reused');
    } finally {reopened.close();}
  } finally {try{repository.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});

test('migration 2 preserves baseline data and rolls back a failed upgrade', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-retirement-migration-')); const path = join(directory, 'config.db');
  let db: Database | null = new Database(path, { create: true });
  try {
    migrateConfigurationDatabase(db, CONFIG_MIGRATIONS.slice(0, 1));
    const before = db.query('SELECT * FROM configuration_revisions').all();
    const broken = { ...CONFIG_MIGRATIONS[1]!, up(database: Database) { CONFIG_MIGRATIONS[1]!.up(database); throw new Error('injected upgrade failure'); } };
    expect(() => migrateConfigurationDatabase(db!, [CONFIG_MIGRATIONS[0]!, broken])).toThrow('migration failed');
    expect(db.query('SELECT * FROM schema_migrations').all()).toHaveLength(1);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='runtime_recovery_budget'").get()).toBeNull();
    expect(db.query('SELECT * FROM configuration_revisions').all()).toEqual(before);
    db.close(); db = null;
    const repository = ConfigRepository.open(path);
    expect(repository.getDatabase().query('SELECT * FROM configuration_revisions').all()).toEqual(before);
    expect(repository.getDatabase().query('SELECT * FROM schema_migrations').all()).toHaveLength(CONFIG_MIGRATIONS.length);
    expect(repository.getSnapshot().revision).toBe(1);
    repository.close();
    const reopened = ConfigRepository.open(path);
    expect(reopened.getRuntimeRecoveryBudget().tickets).toBe(0); reopened.close();
  } finally { db?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('migration 2 rollback and reopen preserve multiple operation, worker and recovery histories', () => {
  const { directory, path, repository } = fixture();
  let db: Database | null = null;
  try {
    // Build representative business history through the actual repository API.
    for (let round = 0; round < 3; round += 1) {
      const now = 1_700_000_000_000 + round * 10_000;
      const mutation = `migration-history-${round}`;
      expect(repository.commit({ mutation_id: mutation, expected_revision: round + 1, kind: 'config', created_at: now,
        target_worker_slots: [0, 1], aggregate: { logical_configuration: { services: [], routes: [], plugins: [],
          auth: { enabled: true, tokens: [`fixture-token-${round}`] } }, plugin_activations: [] } }).kind).toBe('committed');
      repository.appendServingSnapshot(repository.getSnapshot(), repository.getSnapshot().content_hash);
      repository.beginPublication(mutation, now + 1);
      for (const slot of [0, 1]) {
        repository.beginWorkerAttempt(mutation, slot, 0, 'initial', now + 2);
      }
      for (const slot of [0, 1]) {
        repository.recordWorkerResult(mutation, slot, slot === 0
          ? { kind: 'failed', attempt_no: 1, error: 'fixture rejection' }
          : { kind: 'converged', attempt_no: 1, applied_revision: round + 2 }, now + 3);
      }
      repository.finalizePublication(mutation, { outcome: 'degraded', error_code: 'replacement_convergence_failed',
        error_detail: 'fixture rejection', recovery_disposition: 'retryable' }, now + 4);
      const automatic = repository.getCurrentRecovery();
      if (automatic === null) throw new Error('automatic recovery missing');
      repository.claimRecoveryAttempt(automatic.recovery_id, 0, now + 1_000);
      repository.scheduleRecoveryRetry(automatic.recovery_id, 1, now + 2_000, now + 1_001);
      repository.claimRecoveryAttempt(automatic.recovery_id, 1, now + 2_000);
      repository.stopRecovery(automatic.recovery_id, 2, 'deterministic_worker_rejection', 'fixture stop', now + 2_001);
      const manual = randomUUID();
      repository.createManualRecovery(manual, mutation, round + 2, now + 2_002);
      repository.claimRecoveryAttempt(manual, 0, now + 2_003);
      repository.succeedRecovery(manual, 1, 'target_serving', 'fixture succeeded', now + 2_004);
    }
    repository.close();
    db = new Database(path, { readwrite: true, strict: true });
    // Remove the later schema additions around unchanged baseline business rows.
    db.run('DROP TABLE management_protection');
    db.run('ALTER TABLE configuration_operations DROP COLUMN management_provider');
    db.run('ALTER TABLE configuration_operations DROP COLUMN offline_management');
    for (const table of ['ui_menu_layout', 'configuration_retirement_retry_requests','configuration_retirement_evidence', 'configuration_retirements', 'configuration_publication_serving_sets', 'runtime_recovery_tickets', 'runtime_recovery_budget']) {
      db.run(`DROP TABLE ${table}`);
    }
    db.run('DELETE FROM schema_migrations WHERE version>=2');
    verifySchemaFingerprint(db, 1);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    const columns = new Map(tables.map(table => [table, db!.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name).join(',')]));
    const snapshot = (database: Database) => Object.fromEntries(tables.map(table => [table,
      database.query(`SELECT ${columns.get(table)} FROM ${table}`).all().map(row => JSON.stringify(row)).sort()]));
    const before = snapshot(db);
    expect(db.query('SELECT * FROM configuration_operations').all()).toHaveLength(3);
    expect(db.query('SELECT * FROM configuration_operation_workers').all()).toHaveLength(6);
    expect(db.query('SELECT * FROM configuration_recoveries').all()).toHaveLength(6);
    const broken = { ...CONFIG_MIGRATIONS[1]!, up(database: Database) {
      CONFIG_MIGRATIONS[1]!.up(database);
      database.run("UPDATE configuration_state SET updated_at=updated_at+1 WHERE id=1");
      throw new Error('injected upgrade failure after business write');
    } };
    expect(() => migrateConfigurationDatabase(db!, [CONFIG_MIGRATIONS[0]!, broken])).toThrow('migration failed');
    expect(snapshot(db)).toEqual(before);
    verifySchemaFingerprint(db, 1);
    db.close(); db = null;
    const upgraded = ConfigRepository.open(path);
    try {
      const actual = snapshot(upgraded.getDatabase());
      // Only the migration ledger gains an entry; all existing business/history rows remain byte-for-byte equivalent.
      expect({ ...actual, schema_migrations: before.schema_migrations } as Record<string, unknown>).toEqual(before as Record<string, unknown>);
      expect(upgraded.getSnapshot().revision).toBe(4);
      upgraded.verify();
    } finally { upgraded.close(); }
    const reopened = ConfigRepository.open(path);
    try { expect({ ...snapshot(reopened.getDatabase()), schema_migrations: before.schema_migrations } as Record<string, unknown>).toEqual(before as Record<string, unknown>); reopened.verify(); }
    finally { reopened.close(); }
  } finally { db?.close(); try { repository.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test('retirement membership and confirmed exit stay immutable across stopped retries and reopen', () => {
  const { directory, path, repository } = fixture();
  try {
    repository.commit({ mutation_id: 'retirement', expected_revision: 1, kind: 'config', created_at: 1, target_worker_slots: [],
      aggregate: { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] } });
    const instance = randomUUID();
    const member = { identity: { master_generation: randomUUID(), worker_instance_id: instance, worker_slot: 0 },
      boot_nonce: randomUUID(), pid: 123, private_port: 4567, revision: 1, content_hash: repository.getSnapshot().content_hash,
      plugin_catalog_hash: repository.getSnapshot().content_hash, publication: null, guard: null,
      drain_id: randomUUID(), deadline_boot_id: BOOT, start_deadline_ns: '987654321' };
    repository.freezePublicationRetirement('retirement', 0, [member], 1);
    expect(() => repository.freezePublicationRetirement('retirement', 0, [{ ...member, start_deadline_ns: '987654322' }], 2)).toThrow('already frozen');
    repository.recordPublicationRetirementEvidence('retirement', instance, 'unknown', 'unknown', 2);
    repository.stopPublicationRetirement('retirement', 'exit_unknown', 3);
    const resumed = repository.retryPublicationRetirement('retirement', 4);
    expect(resumed.members[0]?.start_deadline_ns).toBe('987654321');
    expect(repository.getOperation('retirement')?.drain_recovery_generation).toBe(0);
    expect(() => repository.markPublicationRetirementReleased('retirement', 5)).toThrow('every durable exit fence');
    repository.recordPublicationRetirementEvidence('retirement', instance, 'confirmed', 'unknown', 5);
    expect(() => repository.recordPublicationRetirementEvidence('retirement', instance, 'live', 'success', 6)).toThrow('cannot be revoked');
    repository.markPublicationRetirementReleased('retirement', 6);
    repository.close();
    const reopened = ConfigRepository.open(path);
    expect(reopened.getRetiredWorkerInstanceIds()).toEqual([instance]);
    expect(reopened.getPublicationRetirement('retirement')).toMatchObject({ state: 'released', evidence: [{ exit_state: 'confirmed', cleanup_state: 'unknown' }] });
    reopened.close();
  } finally { try { repository.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test('restart budget is durable, idempotent, bounded and independent of config revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-restart-budget-')); const path = join(directory, 'config.db');
  let repository = await AsyncConfigRepository.open(path);
  const owner = randomUUID(); const sample = (seconds: number) => ({ owner, boot_id: BOOT, monotonic_ns: (BigInt(seconds) * 1_000_000_000n).toString() });
  try {
    const first = randomUUID();
    expect((await repository.consumeRuntimeRecoveryRestartTicket(first, sample(0))).tickets).toBe(1);
    expect((await repository.consumeRuntimeRecoveryRestartTicket(first, sample(0))).tickets).toBe(1);
    expect(await repository.getRuntimeRecoveryStartupGate(sample(1))).toMatchObject({ kind: 'waiting', remaining_ms: 4_000 });
    await repository.close(); repository = await AsyncConfigRepository.open(path);
    expect((await repository.getRuntimeRecoveryBudget()).tickets).toBe(1);
    expect(await repository.getRuntimeRecoveryStartupGate(sample(5))).toMatchObject({ kind: 'ready' });
    expect((await repository.consumeRuntimeRecoveryRestartTicket(randomUUID(), sample(5))).tickets).toBe(2);
    expect((await repository.consumeRuntimeRecoveryRestartTicket(first, sample(6))).tickets).toBe(2);
    expect(await repository.getRuntimeRecoveryStartupGate(sample(34))).toMatchObject({ kind: 'waiting', remaining_ms: 1_000 });
    expect(await repository.getRuntimeRecoveryStartupGate(sample(35))).toMatchObject({ kind: 'ready' });
    await repository.close();
    const backend = ConfigRepository.open(path);
    try { expect(() => backend.consumeRuntimeRecoveryRestartTicket(randomUUID(), sample(35))).toThrow('budget is exhausted'); } finally { backend.close(); }
    expect(repository.getSnapshot().revision).toBe(1);
  } finally { await repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('only continuous healthy samples from one physical owner and kernel clock reset tickets', () => {
  const { directory, path, repository } = fixture(); const owner = randomUUID();
  const sample = (seconds: number, runtimeOwner = owner, boot = BOOT) => ({ owner: runtimeOwner, boot_id: boot, monotonic_ns: (BigInt(seconds) * 1_000_000_000n).toString() });
  try {
    const first = randomUUID(); const second = randomUUID();
    repository.consumeRuntimeRecoveryRestartTicket(first, sample(0));
    repository.consumeRuntimeRecoveryRestartTicket(second, sample(5));
    expect(repository.consumeRuntimeRecoveryRestartTicket(first, sample(6)).tickets).toBe(2);
    expect(() => repository.consumeRuntimeRecoveryRestartTicket(first, sample(6, randomUUID()))).toThrow('another owner');
    expect(() => repository.consumeRuntimeRecoveryRestartTicket(first, sample(6, owner, 'another-kernel-boot'))).toThrow('kernel boot');
    repository.observeRuntimeRecoveryHealth(sample(5), true);
    repository.observeRuntimeRecoveryHealth(sample(1_805), true); // a gap is not continuous uptime
    expect(repository.getRuntimeRecoveryBudget().tickets).toBe(2);
    for (let second = 1_806; second <= 2_705; second += 30) repository.observeRuntimeRecoveryHealth(sample(second), true);
    repository.observeRuntimeRecoveryHealth(sample(2_706, randomUUID()), true); // normal restart cannot reset
    expect(repository.getRuntimeRecoveryBudget().tickets).toBe(2);
    repository.observeRuntimeRecoveryHealth(sample(10), true); // monotonic rewind begins a fresh window
    expect(repository.getRuntimeRecoveryBudget().tickets).toBe(2);
    for (let second = 40; second <= 1_810; second += 30) repository.observeRuntimeRecoveryHealth(sample(second), true);
    expect(repository.getRuntimeRecoveryBudget().tickets).toBe(0);
    expect(repository.consumeRuntimeRecoveryRestartTicket(first, sample(1_811)).tickets).toBe(0);
    expect(repository.consumeRuntimeRecoveryRestartTicket(second, sample(1_812)).tickets).toBe(0);
    expect(() => repository.consumeRuntimeRecoveryRestartTicket(first, sample(1_813, randomUUID()))).toThrow('another owner');
    expect(repository.consumeRuntimeRecoveryRestartTicket(randomUUID(), sample(1_814)).tickets).toBe(1);
    expect(repository.getDatabase().query('SELECT * FROM runtime_recovery_tickets').all()).toHaveLength(3);
    expect(() => repository.getDatabase().run('DELETE FROM runtime_recovery_tickets WHERE ticket_id=?', [first])).toThrow('immutable');
    expect(() => repository.getDatabase().run('UPDATE runtime_recovery_tickets SET owner=? WHERE ticket_id=?', [randomUUID(), first])).toThrow('immutable');
    expect(repository.getSnapshot().revision).toBe(1);
    repository.close();
    const reopened = ConfigRepository.open(path);
    try {
      expect(reopened.consumeRuntimeRecoveryRestartTicket(first, sample(1_815)).tickets).toBe(1);
      expect(reopened.consumeRuntimeRecoveryRestartTicket(second, sample(1_816)).tickets).toBe(1);
      expect(() => reopened.consumeRuntimeRecoveryRestartTicket(first, sample(1_817, randomUUID()))).toThrow('another owner');
    } finally { reopened.close(); }
  } finally { try { repository.close(); } catch {} rmSync(directory, { recursive: true, force: true }); }
});

test('C deadline starts once after handoff and survives stopped retry and reopen',()=>{
  const {directory,path,repository}=fixture();
  try {
    repository.commit({mutation_id:'drain-start',expected_revision:1,kind:'config',created_at:1,target_worker_slots:[],aggregate:{logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[]}});
    repository.beginPublication('drain-start',2);repository.markDraining('drain-start',3);
    const member={identity:{master_generation:randomUUID(),worker_instance_id:randomUUID(),worker_slot:0},boot_nonce:randomUUID(),pid:123,private_port:4567,revision:1,
      content_hash:repository.getSnapshot().content_hash,plugin_catalog_hash:repository.getSnapshot().content_hash,publication:null,guard:null,
      drain_id:randomUUID(),deadline_boot_id:BOOT,start_deadline_ns:null};
    expect(repository.freezePublicationRetirement('drain-start',0,[member],3).evidence[0]?.start_deadline_ns).toBeNull();
    expect(repository.freezePublicationRetirementDrainStart('drain-start',member.identity.worker_instance_id,BOOT,'123456',4).evidence[0]?.start_deadline_ns).toBe('123456');
    repository.stopPublicationRetirement('drain-start','exit_unknown',5);repository.retryPublicationRetirement('drain-start',6);
    repository.close();const reopened=ConfigRepository.open(path);
    try {
      expect(reopened.freezePublicationRetirementDrainStart('drain-start',member.identity.worker_instance_id,BOOT,'999999',7).evidence[0]).toMatchObject({start_boot_id:BOOT,start_deadline_ns:'123456'});
      expect(()=>reopened.freezePublicationRetirementDrainStart('drain-start',member.identity.worker_instance_id,'foreign-boot','999999',8)).toThrow('drain start is invalid');
    } finally {reopened.close();}
  } finally {try{repository.close();}catch{}rmSync(directory,{recursive:true,force:true});}
});
