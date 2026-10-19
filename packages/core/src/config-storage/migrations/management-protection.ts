import type { ConfigMigration } from './plan';

export const MANAGEMENT_PROTECTION_MIGRATION: ConfigMigration = {
  version: 4,
  name: 'management_protection',
  up(db) {
    db.run(`CREATE TABLE management_protection (
      id INTEGER PRIMARY KEY CHECK(id=1),
      required INTEGER NOT NULL CHECK(required IN (0,1)),
      selected_provider TEXT REFERENCES plugin_activations(plugin_name) DEFERRABLE INITIALLY DEFERRED,
      generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
      CHECK((required=0 AND selected_provider IS NULL) OR (required=1 AND selected_provider IS NOT NULL))
    ) STRICT`);
    db.run('INSERT INTO management_protection(id,required,selected_provider,generation) VALUES(1,0,NULL,0)');
    db.run("CREATE TRIGGER management_protection_no_delete BEFORE DELETE ON management_protection BEGIN SELECT RAISE(ABORT,'management protection cannot be deleted'); END");
    db.run("CREATE TRIGGER management_protection_no_replace BEFORE INSERT ON management_protection WHEN EXISTS(SELECT 1 FROM management_protection) BEGIN SELECT RAISE(ABORT,'management protection cannot be replaced'); END");
    db.run("CREATE TRIGGER management_protection_fixed_identity BEFORE UPDATE OF id ON management_protection BEGIN SELECT RAISE(ABORT,'management protection identity is immutable'); END");
    db.run('ALTER TABLE configuration_operations ADD COLUMN management_provider TEXT');
    db.run('ALTER TABLE configuration_operations ADD COLUMN offline_management INTEGER NOT NULL DEFAULT 0 CHECK(offline_management IN (0,1))');
  },
};
