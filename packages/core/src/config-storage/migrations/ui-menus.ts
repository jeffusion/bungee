import type { ConfigMigration } from './plan';

export const UI_MENUS_MIGRATION: ConfigMigration = {
  version: 3,
  name: 'instance_ui_menus',
  up(db) {
    db.run(`CREATE TABLE ui_menu_layout (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL CHECK(revision >= 0 AND revision <= 9007199254740991),
      layout_json TEXT CHECK(layout_json IS NULL OR (json_valid(layout_json) AND json_type(layout_json)='array'
        AND length(CAST(layout_json AS BLOB)) <= 262144)),
      CHECK((revision=0 AND layout_json IS NULL) OR (revision>0 AND layout_json IS NOT NULL))
    ) STRICT`);
    db.run('INSERT INTO ui_menu_layout(id,revision,layout_json) VALUES(1,0,NULL)');
    db.run("CREATE TRIGGER ui_menu_layout_no_delete BEFORE DELETE ON ui_menu_layout BEGIN SELECT RAISE(ABORT,'menu singleton cannot be deleted'); END");
    db.run("CREATE TRIGGER ui_menu_layout_no_replace BEFORE INSERT ON ui_menu_layout WHEN EXISTS(SELECT 1 FROM ui_menu_layout) BEGIN SELECT RAISE(ABORT,'menu singleton cannot be replaced'); END");
    db.run("CREATE TRIGGER ui_menu_layout_fixed_identity BEFORE UPDATE OF id ON ui_menu_layout BEGIN SELECT RAISE(ABORT,'menu singleton identity is immutable'); END");
  },
};
