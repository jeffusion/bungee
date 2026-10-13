import type { ConfigMigration } from './plan';

/** Add durable retirement authority and a process-restart budget without changing the baseline. */
export const PUBLICATION_RETIREMENT_MIGRATION: ConfigMigration = {
  version: 2,
  name: 'publication_retirement_and_runtime_recovery',
  up(db) {
    db.run(`CREATE TABLE configuration_retirements (
      mutation_id TEXT PRIMARY KEY REFERENCES configuration_operations(mutation_id),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      members_json TEXT NOT NULL CHECK(json_valid(members_json) AND json_type(members_json)='array'),
      state TEXT NOT NULL CHECK(state IN ('pending','stopped','released')),
      reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN ('exit_unknown','cleanup_unknown','release_unknown')),
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
    ) STRICT`);
    db.run(`CREATE TABLE configuration_retirement_evidence (
      mutation_id TEXT NOT NULL REFERENCES configuration_retirements(mutation_id),
      member_id TEXT NOT NULL,
      exit_state TEXT NOT NULL CHECK(exit_state IN ('live','confirmed','unknown')),
      cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('success','failed','unknown')),
      exit_boot_id TEXT,
      exit_deadline_ns TEXT,
      start_boot_id TEXT,
      start_deadline_ns TEXT,
      updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
      CHECK((exit_boot_id IS NULL AND exit_deadline_ns IS NULL) OR (exit_boot_id IS NOT NULL AND exit_deadline_ns IS NOT NULL)),
      CHECK((start_boot_id IS NULL AND start_deadline_ns IS NULL) OR (start_boot_id IS NOT NULL AND start_deadline_ns IS NOT NULL)),
      PRIMARY KEY(mutation_id,member_id)
    ) STRICT, WITHOUT ROWID`);
    db.run("CREATE TRIGGER retirement_start_deadline_immutable BEFORE UPDATE OF start_boot_id,start_deadline_ns ON configuration_retirement_evidence WHEN OLD.start_deadline_ns IS NOT NULL AND (NEW.start_boot_id IS NOT OLD.start_boot_id OR NEW.start_deadline_ns IS NOT OLD.start_deadline_ns) BEGIN SELECT RAISE(ABORT,'retirement start deadline is immutable'); END");
    db.run(`CREATE TABLE configuration_publication_serving_sets (
      mutation_id TEXT NOT NULL REFERENCES configuration_operations(mutation_id),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      attempt_key TEXT NOT NULL CHECK(json_valid(attempt_key) AND json_type(attempt_key)='array'),
      workers_json TEXT NOT NULL CHECK(json_valid(workers_json) AND json_type(workers_json)='array'),
      exited_json TEXT NOT NULL CHECK(json_valid(exited_json) AND json_type(exited_json)='array'),
      PRIMARY KEY(mutation_id,generation,attempt_key)
    ) STRICT, WITHOUT ROWID`);
    db.run("CREATE TRIGGER publication_serving_authority_no_delete BEFORE DELETE ON configuration_publication_serving_sets BEGIN SELECT RAISE(ABORT,'publication serving authority history is immutable'); END");
    db.run("CREATE TRIGGER publication_serving_authority_no_update BEFORE UPDATE OF mutation_id,generation,attempt_key,workers_json ON configuration_publication_serving_sets BEGIN SELECT RAISE(ABORT,'publication serving attempt identity is immutable'); END");
    db.run("CREATE TRIGGER publication_serving_authority_no_replace BEFORE INSERT ON configuration_publication_serving_sets WHEN EXISTS(SELECT 1 FROM configuration_publication_serving_sets WHERE mutation_id=NEW.mutation_id AND generation=NEW.generation AND attempt_key=NEW.attempt_key) BEGIN SELECT RAISE(ABORT,'publication serving authority history is immutable'); END");
    db.run(`CREATE TABLE runtime_recovery_budget (
      id INTEGER PRIMARY KEY CHECK(id=1),
      tickets INTEGER NOT NULL CHECK(tickets BETWEEN 0 AND 2),
      ticket_id TEXT,
      ticket_boot_id TEXT,
      retry_at_ns TEXT,
      healthy_owner TEXT,
      healthy_boot_id TEXT,
      healthy_since_ns TEXT,
      healthy_last_ns TEXT,
      CHECK((tickets=0 AND ticket_id IS NULL AND ticket_boot_id IS NULL AND retry_at_ns IS NULL) OR
        (tickets>0 AND ticket_id IS NOT NULL AND ticket_boot_id IS NOT NULL AND retry_at_ns IS NOT NULL)),
      CHECK((healthy_owner IS NULL AND healthy_boot_id IS NULL AND healthy_since_ns IS NULL AND healthy_last_ns IS NULL) OR
        (healthy_owner IS NOT NULL AND healthy_boot_id IS NOT NULL AND healthy_since_ns IS NOT NULL AND healthy_last_ns IS NOT NULL))
    ) STRICT`);
    db.run('INSERT INTO runtime_recovery_budget(id,tickets) VALUES(1,0)');
    db.run(`CREATE TABLE configuration_retirement_retry_requests (
      request_id TEXT PRIMARY KEY,
      mutation_id TEXT NOT NULL REFERENCES configuration_retirements(mutation_id),
      expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
      created_at INTEGER NOT NULL CHECK(created_at>=0)
    ) STRICT, WITHOUT ROWID`);
    db.run("CREATE TRIGGER retirement_retry_no_delete BEFORE DELETE ON configuration_retirement_retry_requests BEGIN SELECT RAISE(ABORT,'retirement retry identity is immutable'); END");
    db.run("CREATE TRIGGER retirement_retry_no_update BEFORE UPDATE ON configuration_retirement_retry_requests BEGIN SELECT RAISE(ABORT,'retirement retry identity is immutable'); END");
    db.run("CREATE TRIGGER retirement_retry_no_replace BEFORE INSERT ON configuration_retirement_retry_requests WHEN EXISTS(SELECT 1 FROM configuration_retirement_retry_requests WHERE request_id=NEW.request_id) BEGIN SELECT RAISE(ABORT,'retirement retry identity is immutable'); END");
    db.run(`CREATE TABLE runtime_recovery_tickets (
      ticket_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      boot_id TEXT NOT NULL,
      consumed_at_ns TEXT NOT NULL,
      retry_at_ns TEXT NOT NULL
    ) STRICT, WITHOUT ROWID`);
    db.run("CREATE TRIGGER runtime_recovery_tickets_no_delete BEFORE DELETE ON runtime_recovery_tickets BEGIN SELECT RAISE(ABORT,'runtime recovery ticket history is immutable'); END");
    db.run("CREATE TRIGGER runtime_recovery_tickets_no_update BEFORE UPDATE ON runtime_recovery_tickets BEGIN SELECT RAISE(ABORT,'runtime recovery ticket history is immutable'); END");
    db.run("CREATE TRIGGER runtime_recovery_tickets_no_replace BEFORE INSERT ON runtime_recovery_tickets WHEN EXISTS(SELECT 1 FROM runtime_recovery_tickets WHERE ticket_id=NEW.ticket_id) BEGIN SELECT RAISE(ABORT,'runtime recovery ticket history is immutable'); END");
    db.run("CREATE TRIGGER runtime_recovery_budget_no_delete BEFORE DELETE ON runtime_recovery_budget BEGIN SELECT RAISE(ABORT,'runtime recovery budget cannot be deleted'); END");
    db.run("CREATE TRIGGER runtime_recovery_budget_no_replace BEFORE INSERT ON runtime_recovery_budget WHEN EXISTS(SELECT 1 FROM runtime_recovery_budget) BEGIN SELECT RAISE(ABORT,'runtime recovery budget cannot be replaced'); END");
    db.run("CREATE TRIGGER runtime_recovery_budget_fixed_identity BEFORE UPDATE OF id ON runtime_recovery_budget BEGIN SELECT RAISE(ABORT,'runtime recovery budget identity is immutable'); END");
  },
};
