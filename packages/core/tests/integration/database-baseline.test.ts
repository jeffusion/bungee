import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrateConfigurationDatabase,CONFIG_MIGRATIONS,CONFIG_SCHEMA_VERSION} from '../../src/config-storage/migrations';
import {migrateAccessDatabase} from '../../src/migrations/migration-manager';
import {migrations} from '../../src/migrations';
import {initializePluginStateDatabase,PLUGIN_STATE_MIGRATIONS,validatePluginStateDatabase} from '../../src/plugin-state/schema';
import {databaseSchemaDescriptor} from '../../src/database-schema';

test.each(['config','access','plugin'] as const)('%s baseline supports future incremental migration and idempotent reopening',kind=>{
 const db=new Database(':memory:');
 try {
  const up=(database:Database)=>database.run('CREATE TABLE next_version(id INTEGER PRIMARY KEY, value TEXT)');
  const run=()=>kind==='config'?migrateConfigurationDatabase(db,[...CONFIG_MIGRATIONS,{version:CONFIG_SCHEMA_VERSION+1,name:'next',up}]):kind==='access'?migrateAccessDatabase(db,[...migrations,{version:String(Number(migrations.at(-1)!.version)+1).padStart(3,'0'),name:'next',up}]):initializePluginStateDatabase(db,[...PLUGIN_STATE_MIGRATIONS,{version:2,name:'next',up}]);
  run();db.run("INSERT INTO next_version VALUES(1,'retained')");run();
  expect(db.query('SELECT * FROM next_version').get()).toEqual({id:1,value:'retained'});
  if(kind==='plugin')expect(db.query('PRAGMA user_version').get()).toEqual({user_version:2});
  else expect(db.query('SELECT * FROM schema_migrations ORDER BY version').all()).toHaveLength(kind==='config'?CONFIG_MIGRATIONS.length+1:migrations.length+1);
 }finally{db.close();}
});
test.each(['config','access','plugin'] as const)('%s incremental failure rolls back schema, business writes and version',kind=>{
 const db=new Database(':memory:');
 try {
  if(kind==='config')migrateConfigurationDatabase(db);else if(kind==='access')migrateAccessDatabase(db);else initializePluginStateDatabase(db);
  const before=databaseSchemaDescriptor(db);
  const up=(database:Database)=>{database.run('CREATE TABLE unfinished(id INTEGER)');database.run('INSERT INTO unfinished VALUES(1)');throw new Error('injected failure');};
  expect(()=>kind==='config'?migrateConfigurationDatabase(db,[...CONFIG_MIGRATIONS,{version:CONFIG_SCHEMA_VERSION+1,name:'next',up}]):kind==='access'?migrateAccessDatabase(db,[...migrations,{version:String(Number(migrations.at(-1)!.version)+1).padStart(3,'0'),name:'next',up}]):initializePluginStateDatabase(db,[...PLUGIN_STATE_MIGRATIONS,{version:2,name:'next',up}])).toThrow();
  expect(databaseSchemaDescriptor(db)).toBe(before);expect(db.inTransaction).toBe(false);
  if(kind==='plugin')expect(db.query('PRAGMA user_version').get()).toEqual({user_version:1});else expect(db.query('SELECT * FROM schema_migrations').all()).toHaveLength(kind==='config'?CONFIG_MIGRATIONS.length:migrations.length);
 }finally{db.close();}
});
test.each(['config','access','plugin'] as const)('%s rejects unknown future version and corrupted schema without repair',kind=>{
 const db=new Database(':memory:');
 try {
  const run=()=>kind==='config'?migrateConfigurationDatabase(db):kind==='access'?migrateAccessDatabase(db):initializePluginStateDatabase(db);
  run();db.run('CREATE TABLE unexpected(id INTEGER)');expect(run).toThrow();expect(db.query("SELECT name FROM sqlite_schema WHERE name='unexpected'").get()).not.toBeNull();
  db.run('DROP TABLE unexpected');if(kind==='plugin')db.run('PRAGMA user_version=2');else db.run('UPDATE schema_migrations SET version=? WHERE version=(SELECT max(version) FROM schema_migrations)',[kind==='config'?CONFIG_SCHEMA_VERSION+1:'999']);expect(run).toThrow();
 }finally{db.close();}
});
test('plugin baseline refuses a missing table instead of recreating an incomplete library',()=>{
 const db=new Database(':memory:');try{initializePluginStateDatabase(db);db.run('DROP TABLE plugin_storage');expect(()=>initializePluginStateDatabase(db)).toThrow('plugin_state_schema_corrupt');expect(()=>validatePluginStateDatabase(db)).toThrow();}finally{db.close();}
});
test('schema descriptor normalizes formatting while preserving quoted literal meaning',()=>{
 const a=new Database(':memory:'),b=new Database(':memory:'),c=new Database(':memory:');
 try{a.exec("CREATE TABLE t (value TEXT CHECK(value='x  y'))");b.exec("CREATE TABLE t (value TEXT\n  CHECK(value='x  y'))");c.exec("CREATE TABLE t (value TEXT CHECK(value='x y'))");expect(databaseSchemaDescriptor(a)).toBe(databaseSchemaDescriptor(b));expect(databaseSchemaDescriptor(a)).not.toBe(databaseSchemaDescriptor(c));}finally{a.close();b.close();c.close();}
});

test('access 001 upgrades to TPS 002 while preserving existing rows and supports reopening',()=>{
  const db=new Database(':memory:');
  try {
    migrateAccessDatabase(db,[migrations[0]!]);
    db.run("INSERT INTO access_logs(request_id,timestamp,method,path,status,duration,created_at) VALUES('retained',1,'GET','/',200,1,1)");
    migrateAccessDatabase(db);
    db.run("INSERT INTO llm_tps_samples VALUES('attempt','request','route','endpoint',1000,12,250.5,'official')");
    migrateAccessDatabase(db);
    expect(db.query('SELECT request_id FROM access_logs').all()).toEqual([{request_id:'retained'}]);
    expect(db.query('SELECT output_tokens,generation_duration_ms FROM llm_tps_samples').all()).toEqual([{output_tokens:12,generation_duration_ms:250.5}]);
    expect(()=>db.run("INSERT INTO llm_tps_samples VALUES('bad','request','route','endpoint',1000,1,0,'official')")).toThrow();
    expect(()=>db.run("INSERT INTO llm_tps_samples VALUES('bad','request','route','endpoint',1000,1,1,'partial')")).toThrow();
    expect(db.query('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{version:'001'},{version:'002'}]);
  }finally{db.close();}
});


test('TPS migration failure rolls back 002 and a real access database reopens without data loss',async()=>{
 const root=await mkdtemp(join(tmpdir(),'bungee-tps-migration-'));const path=join(root,'access.db');
 let db:Database|undefined;
 try {
  db=new Database(path);migrateAccessDatabase(db,[migrations[0]!]);
  db.run("INSERT INTO access_logs(request_id,timestamp,method,path,status,duration,created_at) VALUES('preserve',1,'GET','/',200,1,1)");
  const migration=migrations[1]!;
  expect(()=>migrateAccessDatabase(db!,[migrations[0]!,{...migration,up(database){migration.up(database);throw new Error('injected TPS migration failure');}}])).toThrow('injected TPS migration failure');
  expect(db.query('SELECT version FROM schema_migrations').all()).toEqual([{version:'001'}]);
  expect(db.query("SELECT name FROM sqlite_schema WHERE name='llm_tps_samples'").get()).toBeNull();
  migrateAccessDatabase(db);db.run("INSERT INTO llm_tps_samples VALUES('a','r','route','endpoint',1,2,5,'estimated')");db.close();
  db=new Database(path);migrateAccessDatabase(db);
  expect(db.query('SELECT request_id FROM access_logs').all()).toEqual([{request_id:'preserve'}]);
  expect(db.query('SELECT output_source FROM llm_tps_samples').all()).toEqual([{output_source:'estimated'}]);
 }finally{db?.close();await rm(root,{recursive:true,force:true});}
});
