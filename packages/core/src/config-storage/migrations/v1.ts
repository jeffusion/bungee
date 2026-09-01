import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { Database } from 'bun:sqlite';
import { hashConfigurationContent } from '../content-hash';
import { replaceActiveMaterialization } from '../materialize';
import { CONFIG_SCHEMA_V1_STATEMENTS } from '../schema-v1';

const EMPTY_AGGREGATE: ConfigurationAggregateV2 = {
  logical_configuration: { services: [], routes: [], plugins: [] },
  plugin_activations: [],
};

export const CONFIG_MIGRATION_V1 = {
  version: 1,
  name: 'initial_normalized_configuration',
  up(db: Database): void {
    for (const statement of CONFIG_SCHEMA_V1_STATEMENTS) db.run(statement);
    replaceActiveMaterialization(db, EMPTY_AGGREGATE);
    db.run(`INSERT INTO configuration_revisions
      (revision,content_hash,kind,created_at) VALUES (1,?,'config',0)`, [hashConfigurationContent(EMPTY_AGGREGATE)]);
    db.run('INSERT INTO configuration_state (id,schema_version,active_revision,bootstrap_mode) VALUES (1,1,1,1)');
    db.run('INSERT INTO schema_migrations (version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
