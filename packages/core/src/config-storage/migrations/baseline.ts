import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { CONFIG_SCHEMA_STATEMENTS } from '../schema';
import { hashConfigurationContent } from '../content-hash';
import { replaceActiveMaterialization } from '../materialize';

export const CONFIG_BASELINE_VERSION = 1;
export const CONFIG_BASELINE_NAME = 'current_storage_baseline';
export const CONFIG_BASELINE = {
  version: CONFIG_BASELINE_VERSION,
  name: CONFIG_BASELINE_NAME,
  up(db: Database): void {
    for (const statement of CONFIG_SCHEMA_STATEMENTS) db.run(statement);
    const aggregate = { logical_configuration: { services: [], routes: [], plugins: [] }, plugin_activations: [] };
    replaceActiveMaterialization(db, aggregate);
    db.run("INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES(1,?,'config',0)", [hashConfigurationContent(aggregate)]);
    db.run('INSERT INTO configuration_state(id,schema_version,active_revision,created_at,updated_at) VALUES(1,4,1,0,0)');
    db.run('INSERT INTO supervision_state(id,instance_id,controller_epoch,current_controller_id,updated_at) VALUES(1,?,0,NULL,0)', [randomUUID()]);
  },
} as const;
