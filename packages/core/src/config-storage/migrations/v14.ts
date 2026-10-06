import type { Database } from 'bun:sqlite';
import { PLUGIN_COMMUNICATION_SCHEMA_SQL } from '../../plugin-services/persistence';
import { COMMAND_JOURNAL_RETENTION_SCHEMA_SQL } from '../../plugin-services/command-journal';

/** Communication storage is part of the configuration database's audited schema. */
export const CONFIG_MIGRATION_V14 = {
  version: 14,
  name: 'plugin_communication_and_command_journal',
  up(db: Database): void {
    db.exec(PLUGIN_COMMUNICATION_SCHEMA_SQL);
    db.exec(COMMAND_JOURNAL_RETENTION_SCHEMA_SQL);
    db.run('INSERT INTO schema_migrations(version,name) VALUES (?,?)', [this.version, this.name]);
  },
} as const;
