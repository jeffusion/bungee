import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {migrateConfigurationDatabase,CONFIG_MIGRATIONS} from '../../src/config-storage/migrations';
import {migrateAccessDatabase} from '../../src/migrations/migration-manager';
import {migrations} from '../../src/migrations';
import {initializePluginStateDatabase,PLUGIN_STATE_MIGRATIONS,validatePluginStateDatabase} from '../../src/plugin-state/schema';
import {databaseSchemaDescriptor} from '../../src/database-schema';

test.each(['config','access','plugin'] as const)('%s baseline supports future incremental migration and idempotent reopening',kind=>{
 const db=new Database(':memory:');
 try {
  const up=(database:Database)=>database.run('CREATE TABLE next_version(id INTEGER PRIMARY KEY, value TEXT)');
  const run=()=>kind==='config'?migrateConfigurationDatabase(db,[...CONFIG_MIGRATIONS,{version:2,name:'next',up}]):kind==='access'?migrateAccessDatabase(db,[...migrations,{version:'002',name:'next',up}]):initializePluginStateDatabase(db,[...PLUGIN_STATE_MIGRATIONS,{version:2,name:'next',up}]);
  run();db.run("INSERT INTO next_version VALUES(1,'retained')");run();
  expect(db.query('SELECT * FROM next_version').get()).toEqual({id:1,value:'retained'});
  if(kind==='plugin')expect(db.query('PRAGMA user_version').get()).toEqual({user_version:2});
  else expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toHaveLength(2);
 }finally{db.close();}
});
test.each(['config','access','plugin'] as const)('%s incremental failure rolls back schema, business writes and version',kind=>{
 const db=new Database(':memory:');
 try {
  if(kind==='config')migrateConfigurationDatabase(db);else if(kind==='access')migrateAccessDatabase(db);else initializePluginStateDatabase(db);
  const before=databaseSchemaDescriptor(db);
  const up=(database:Database)=>{database.run('CREATE TABLE unfinished(id INTEGER)');database.run('INSERT INTO unfinished VALUES(1)');throw new Error('injected failure');};
  expect(()=>kind==='config'?migrateConfigurationDatabase(db,[...CONFIG_MIGRATIONS,{version:2,name:'next',up}]):kind==='access'?migrateAccessDatabase(db,[...migrations,{version:'002',name:'next',up}]):initializePluginStateDatabase(db,[...PLUGIN_STATE_MIGRATIONS,{version:2,name:'next',up}])).toThrow();
  expect(databaseSchemaDescriptor(db)).toBe(before);expect(db.inTransaction).toBe(false);
  if(kind==='plugin')expect(db.query('PRAGMA user_version').get()).toEqual({user_version:1});else expect(db.query('SELECT * FROM schema_migrations').all()).toHaveLength(1);
 }finally{db.close();}
});
test.each(['config','access','plugin'] as const)('%s rejects unknown future version and corrupted schema without repair',kind=>{
 const db=new Database(':memory:');
 try {
  const run=()=>kind==='config'?migrateConfigurationDatabase(db):kind==='access'?migrateAccessDatabase(db):initializePluginStateDatabase(db);
  run();db.run('CREATE TABLE unexpected(id INTEGER)');expect(run).toThrow();expect(db.query("SELECT name FROM sqlite_schema WHERE name='unexpected'").get()).not.toBeNull();
  db.run('DROP TABLE unexpected');if(kind==='plugin')db.run('PRAGMA user_version=2');else db.run('UPDATE schema_migrations SET version=?',[kind==='config'?2:'002']);expect(run).toThrow();
 }finally{db.close();}
});
test('plugin baseline refuses a missing table instead of recreating an incomplete library',()=>{
 const db=new Database(':memory:');try{initializePluginStateDatabase(db);db.run('DROP TABLE plugin_storage');expect(()=>initializePluginStateDatabase(db)).toThrow('plugin_state_schema_corrupt');expect(()=>validatePluginStateDatabase(db)).toThrow();}finally{db.close();}
});
test('schema descriptor normalizes formatting while preserving quoted literal meaning',()=>{
 const a=new Database(':memory:'),b=new Database(':memory:'),c=new Database(':memory:');
 try{a.exec("CREATE TABLE t (value TEXT CHECK(value='x  y'))");b.exec("CREATE TABLE t (value TEXT\n  CHECK(value='x  y'))");c.exec("CREATE TABLE t (value TEXT CHECK(value='x y'))");expect(databaseSchemaDescriptor(a)).toBe(databaseSchemaDescriptor(b));expect(databaseSchemaDescriptor(a)).not.toBe(databaseSchemaDescriptor(c));}finally{a.close();b.close();c.close();}
});
