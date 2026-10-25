import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncConfigRepository } from '../../src/config-storage/async-config-repository';
import { CONFIG_MIGRATIONS, migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { canonicalJson, hashConfigurationContent, hashConfigurationRequest } from '../../src/config-storage/content-hash';
import { readRepositorySnapshot, verifyRepositoryIntegrity } from '../../src/config-storage/repository-snapshot';
import { prepareCommitCommand } from '../../src/config-storage/prepared-command';
import { commitTransaction } from '../../src/config-storage/commit-transaction';
import { createAutomaticRecovery, createStoppedRecovery, createManualRecovery, claimRecoveryAttempt, succeedRecovery } from '../../src/config-storage/recovery-store';
import { getServingSnapshot } from '../../src/config-storage/serving-snapshot';
import { parseNormalizeCompileAggregate } from '../../src/config-storage/aggregate';
import type { ConfigurationAggregate } from '@jeffusion/bungee-types';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const catalogHash=`sha256:${'a'.repeat(64)}` as const;
const roots:string[]=[];
const handles=new Set<Database>();
afterEach(()=>{for(const db of handles)db.close(true);handles.clear();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function open(path:string):Database {const db=new Database(path,{create:true,strict:true});db.run('PRAGMA foreign_keys=ON');handles.add(db);return db;}
function fixture(withReference=true, publicationState: 'converged' | 'committed' | 'degraded'='converged'){
  const root=mkdtempSync(join(tmpdir(),'bungee-service-references-'));roots.push(root);
  const path=join(root,'bungee.db'),db=open(path);
  migrateConfigurationDatabase(db,CONFIG_MIGRATIONS.slice(0,4));
  const aggregate={logical_configuration:{services:[{id:id(1),position:0,name:'primary',endpoints:[{id:id(2),position:0,target:'https://example.com',weight:100,priority:1,is_disabled:false,plugins:[]}],plugins:[{id:id(9),position:0,name:'audit',enabled:true,options:{accountRef:'account-stable'}}]}],routes:withReference?[{id:id(3),position:0,path:'/',service_id:id(1),plugins:[]}]:[],plugins:[]},plugin_activations:[{plugin_name:'audit'}]};
  const hash=hashConfigurationContent(aggregate);
  db.transaction(()=>{
    db.run("INSERT INTO services(id,position,name,policy_json) VALUES(?,0,'primary','{}')",[id(1)]);
    db.run("INSERT INTO plugin_activations(plugin_name) VALUES('audit')");
    db.run("INSERT INTO plugin_bindings(id,scope_kind,scope_owner,service_id,position,plugin_name,options_json,enabled) VALUES(?,'service',?,?,0,'audit',?,1)",[id(9),id(1),id(1),canonicalJson({accountRef:'account-stable'})]);
    db.run("INSERT INTO upstreams(id,owner_kind,service_id,route_id,position,target,weight,priority,is_disabled,policy_json) VALUES(?,'service',?,NULL,0,'https://example.com',100,1,0,'{}')",[id(2),id(1)]);
    if(withReference)db.run("INSERT INTO routes(id,position,path,service_id,policy_json) VALUES(?,0,'/',?,'{}')",[id(3),id(1)]);
    db.run("INSERT INTO configuration_revisions(revision,content_hash,kind,created_at) VALUES(2,?,'config',1)",[hash]);
    db.run(`INSERT INTO configuration_operations(mutation_id,request_hash,expected_revision,committed_revision,kind,target_worker_count,state,result_status,error_code,error_detail,created_at,updated_at)
      VALUES(?,?,1,2,'config',0,?,?,?,?,1,1)`,[id(4),hashConfigurationRequest({kind:'config',expected_revision:1,aggregate:aggregate as unknown as ConfigurationAggregate,target_worker_slots:[]}),publicationState,publicationState==='converged'?200:publicationState==='degraded'?202:null,publicationState==='degraded'?'control_readiness_failed':null,publicationState==='degraded'?'control unavailable':null]);
    db.run('UPDATE configuration_state SET active_revision=2,updated_at=1 WHERE id=1');
    db.run('INSERT INTO configuration_serving_snapshots(revision,content_hash,plugin_catalog_hash,aggregate_json) VALUES(2,?,?,?)',[hash,catalogHash,canonicalJson(aggregate)]);
  }).immediate();
  return {db,path,hash,aggregate};
}
function close(db:Database){db.close(true);handles.delete(db);}

describe('service reference SQLite migration',()=>{
  test('catalog-backed production commits reject mixed plugin and Service cycles before writing',async()=>{
    const root=mkdtempSync(join(tmpdir(),'bungee-reference-catalog-'));roots.push(root);
    const repository=await AsyncConfigRepository.open(join(root,'bungee.db'),{compileOptions:{pluginSchemas:new Map([
      ['dispatch',[{name:'target',type:'gateway_target',label:'Target'}]],
    ])}});
    try {
      const aggregate=parseNormalizeCompileAggregate({plugin_activations:[{plugin_name:'dispatch'}],logical_configuration:{plugins:[],
        services:[{id:id(1),name:'leaf',endpoints:[{id:id(2),target:'https://example.com',plugins:[{id:id(9),name:'dispatch',options:{target:{type:'route',id:id(3),protocol:'responses'}}}]}]},
          {id:id(5),name:'branch',endpoints:[],service_references:[{id:id(6),service_id:id(1)}]}],
        routes:[{id:id(3),path:'/',service_references:[{id:id(7),service_id:id(5)}]}]}});
      expect(aggregate.ok).toBe(true);if(!aggregate.ok)return;
      await expect(repository.commit({mutation_id:id(8),expected_revision:1,kind:'config',created_at:1,target_worker_slots:[],aggregate:aggregate.value})).rejects.toMatchObject({
        code:'invalid_configuration',cause:expect.arrayContaining([expect.objectContaining({message:'Internal dispatch cycle'})]),
      });
      expect(repository.getSnapshot().revision).toBe(1);await repository.verify();
    } finally {await repository.close();}
  },{timeout:30_000});
  test('converts a scalar reference atomically and preserves all historical identities and snapshot bytes',()=>{
    const {db,hash,aggregate}=fixture();
    const history=db.query('SELECT * FROM configuration_revisions ORDER BY revision').all();
    migrateConfigurationDatabase(db);
    const snapshot=readRepositorySnapshot(db);
    expect(snapshot.revision).toBe(3);expect(snapshot.content_hash).toBe(hashConfigurationContent(snapshot.aggregate));
    expect(snapshot.content_hash).not.toBe(hash);
    expect(snapshot.aggregate.logical_configuration.routes[0]!.service_references).toEqual([{id:expect.any(String),position:0,service_id:id(1),weight:100,priority:1,is_disabled:false}]);
    expect(snapshot.aggregate.logical_configuration.services[0]!.id).toBe(id(1));
    expect(snapshot.aggregate.logical_configuration.services[0]!.plugins).toEqual([{id:id(9),position:0,name:'audit',enabled:true,options:{accountRef:'account-stable'}}]);
    expect(snapshot.aggregate.logical_configuration.services[0]!.endpoints[0]!.id).toBe(id(2));
    expect(db.query('SELECT * FROM configuration_revisions WHERE revision<=2 ORDER BY revision').all()).toEqual(history);
    expect(db.query<{aggregate_json:string},[]>('SELECT aggregate_json FROM configuration_serving_snapshots').get()!.aggregate_json).toBe(canonicalJson(aggregate));
    expect(db.query<{name:string},[]>('PRAGMA table_info(routes)').all().map(row=>row.name)).not.toContain('service_id');
    expect(()=>getServingSnapshot(db,{revision:2,content_hash:hash,plugin_catalog_hash:catalogHash})).toThrow('current configuration schema');
    verifyRepositoryIntegrity(db);
  }, {timeout:30_000});

  test('the production configuration storage Worker upgrades the database before returning its startup snapshot',async()=>{
    const {db,path,hash}=fixture();close(db);
    const worker=await AsyncConfigRepository.open(path);
    const snapshot=worker.getSnapshot();
    try {
      expect(snapshot.revision).toBe(3);
      expect(snapshot.content_hash).not.toBe(hash);
      expect(snapshot.aggregate.logical_configuration.routes[0]!.service_references![0]!.service_id).toBe(id(1));
      await worker.verify();
    } finally {await worker.close();}
    const reopened=await AsyncConfigRepository.open(path);
    try {expect(reopened.getSnapshot()).toEqual(snapshot);}finally{await reopened.close();}
  }, {timeout:30_000});

  test('reopening is idempotent and an unreferenced Service keeps its hash and revision',()=>{
    for(const withReference of [true,false]){
      const {db,path,hash}=fixture(withReference);migrateConfigurationDatabase(db);
      const first=readRepositorySnapshot(db);close(db);const reopened=open(path);migrateConfigurationDatabase(reopened);
      expect(readRepositorySnapshot(reopened)).toEqual(first);
      expect(first.revision).toBe(withReference?3:2);if(!withReference){
        expect(first.content_hash).toBe(hash);
        expect(getServingSnapshot(reopened,{revision:2,content_hash:hash,plugin_catalog_hash:catalogHash})!.aggregate).toEqual(first.aggregate);
      }
      expect(first.aggregate.logical_configuration.services[0]!.service_references).toBeUndefined();
    }
  }, {timeout:30_000});

  test('rolls back DDL, converted rows, revision, operation and migration marker on failure',()=>{
    const {db,hash}=fixture();
    expect(()=>migrateConfigurationDatabase(db,undefined,{faultInjection(stage){if(stage==='after_targets')throw new Error('injected migration failure');}})).toThrow();
    expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()!.version).toBe(4);
    expect(db.query("SELECT name FROM sqlite_schema WHERE name='service_references'").get()).toBeNull();
    expect(db.query<{service_id:string},[]>('SELECT service_id FROM routes').get()!.service_id).toBe(id(1));
    expect(db.query<{content_hash:string},[]>('SELECT content_hash FROM configuration_revisions WHERE revision=2').get()!.content_hash).toBe(hash);
    expect(db.query<{count:number},[]>('SELECT count(*) AS count FROM configuration_operations').get()!.count).toBe(1);
    migrateConfigurationDatabase(db);expect(readRepositorySnapshot(db).revision).toBe(3);
  }, {timeout:30_000});

  test('reports unfinished publication and retirement identities without changing the old schema',()=>{
    for(const kind of ['publication','retirement']){
      const {db}=fixture(true,kind==='publication'?'committed':'converged');
      if(kind==='retirement')db.run("INSERT INTO configuration_retirements(mutation_id,generation,members_json,state,updated_at) VALUES(?,0,'[]','stopped',1)",[id(4)]);
      expect(()=>migrateConfigurationDatabase(db)).toThrow(`${kind} ${id(4)}`);
      expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()!.version).toBe(4);
      expect(db.query<{service_id:string},[]>('SELECT service_id FROM routes').get()!.service_id).toBe(id(1));
    }
  }, {timeout:30_000});

  test('reports scheduled and stopped recovery identities and retains the previous schema',()=>{
    for(const state of ['scheduled','stopped']){
      const {db}=fixture(true,'degraded');
      if(state==='scheduled')createAutomaticRecovery(db,id(10),id(4),2,2);
      else createStoppedRecovery(db,id(10),id(4),2,'deterministic_control_failure','control unavailable',2);
      expect(()=>migrateConfigurationDatabase(db)).toThrow(`recovery ${id(10)} (${state})`);
      expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()!.version).toBe(4);
      expect(db.query<{state:string},[]>('SELECT state FROM configuration_recoveries').get()!.state).toBe(state);
    }
  }, {timeout:30_000});

  test('rejects tampered pre-upgrade content before committing a conversion',()=>{
    const {db}=fixture();db.run("UPDATE services SET name='tampered'");
    expect(()=>migrateConfigurationDatabase(db)).toThrow('pre-upgrade configuration content hash');
    expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()!.version).toBe(4);
  }, {timeout:30_000});

  test('a later successful recovery supersedes a historical stopped recovery for upgrade readiness',()=>{
    const {db}=fixture(true,'degraded');
    createStoppedRecovery(db,id(10),id(4),2,'deterministic_control_failure','control unavailable',2);
    createManualRecovery(db,id(11),id(4),2,3);claimRecoveryAttempt(db,id(11),0,4);
    succeedRecovery(db,id(11),1,'target_serving','control recovered',5);
    migrateConfigurationDatabase(db);
    expect(readRepositorySnapshot(db).revision).toBe(3);
    expect(db.query<{state:string},[]>('SELECT state FROM configuration_recoveries ORDER BY recovery_sequence').all()).toEqual([{state:'stopped'},{state:'succeeded'}]);
  },{timeout:30_000});

  test('audits historical snapshot hashes without parsing them as runtime input',()=>{
    const {db,hash}=fixture();
    db.run('INSERT INTO configuration_serving_snapshots(revision,content_hash,plugin_catalog_hash,aggregate_json) VALUES(2,?,?,?)',
      [hash,`sha256:${'b'.repeat(64)}`,canonicalJson({})]);
    expect(()=>migrateConfigurationDatabase(db)).toThrow('historical serving snapshot content is invalid');
    expect(db.query<{version:number},[]>('SELECT max(version) AS version FROM schema_migrations').get()!.version).toBe(4);
    expect(db.query<{count:number},[]>('SELECT count(*) AS count FROM configuration_serving_snapshots').get()!.count).toBe(2);
  }, {timeout:30_000});

  test('round-trips a Route that owns both upstreams and service references across reopen',async()=>{
    const root=mkdtempSync(join(tmpdir(),'bungee-mixed-route-'));roots.push(root);
    const path=join(root,'bungee.db');
    const aggregate=parseNormalizeCompileAggregate({plugin_activations:[],logical_configuration:{
      services:[{id:id(1),position:0,name:'leaf',endpoints:[{id:id(2),position:0,target:'https://example.com'}],plugins:[]}],
      routes:[{id:id(3),position:0,path:'/mixed',
        service_references:[{id:id(4),position:3,service_id:id(1),weight:100,priority:1,is_disabled:false}],
        endpoints:[{id:id(5),position:0,target:'https://direct.example'}],plugins:[]}],
      plugins:[]}});
    expect(aggregate.ok).toBe(true);if(!aggregate.ok)return;
    const repository=await AsyncConfigRepository.open(path);
    try{
      const committed=await repository.commit({mutation_id:id(20),expected_revision:1,kind:'config',created_at:1,target_worker_slots:[],aggregate:aggregate.value});
      expect(committed.kind).toBe('committed');
      const route=repository.getSnapshot().aggregate.logical_configuration.routes[0]!;
      expect(route.service_references?.[0]?.service_id).toBe(id(1));
      expect(route.endpoints?.[0]?.target).toBe('https://direct.example');
    }finally{await repository.close();}
    const reopened=await AsyncConfigRepository.open(path);
    try{
      const snapshot=reopened.getSnapshot();
      const route=snapshot.aggregate.logical_configuration.routes[0]!;
      expect(route.service_references?.[0]?.service_id).toBe(id(1));
      expect(route.endpoints?.[0]?.target).toBe('https://direct.example');
      expect(snapshot.content_hash).toBe(hashConfigurationContent(aggregate.value));
    }finally{await reopened.close();}
  },{timeout:30_000});
  test('preserves hash across JSON export/import and enforces CAS after nested references are materialized',()=>{
    const {db}=fixture();migrateConfigurationDatabase(db);const before=readRepositorySnapshot(db);
    const parsed=parseNormalizeCompileAggregate({...before.aggregate,logical_configuration:{...before.aggregate.logical_configuration,
      services:[...before.aggregate.logical_configuration.services,{id:id(5),position:1,name:'nested',endpoints:[],plugins:[],service_references:[{id:id(6),position:1,service_id:id(1),weight:50,priority:2,is_disabled:false}]}]}});
    expect(parsed.ok).toBe(true);if(!parsed.ok)return;
    const decoded=parseNormalizeCompileAggregate(JSON.parse(canonicalJson(parsed.value)));expect(decoded).toEqual(parsed);
    const prepared=prepareCommitCommand({mutation_id:id(7),expected_revision:before.revision,kind:'config',created_at:Date.now(),target_worker_slots:[],aggregate:parsed.value});
    const result=db.transaction(()=>commitTransaction(db,prepared,{},before)).immediate();expect(result.kind).toBe('committed');
    const after=readRepositorySnapshot(db);expect(after.content_hash).toBe(hashConfigurationContent(parsed.value));expect(after.aggregate).toEqual(parsed.value);
    expect(()=>prepareCommitCommand({mutation_id:id(12),expected_revision:after.revision,kind:'config',created_at:Date.now(),target_worker_slots:[],aggregate:{...after.aggregate,logical_configuration:{...after.aggregate.logical_configuration,services:after.aggregate.logical_configuration.services.filter(service=>service.id!==id(1))}}})).toThrow('configuration aggregate is invalid');
    const stale=prepareCommitCommand({mutation_id:id(8),expected_revision:before.revision,kind:'config',created_at:Date.now(),target_worker_slots:[],aggregate:parsed.value});
    expect(db.transaction(()=>commitTransaction(db,stale,{},after)).immediate().kind).toBe('stale_revision');
  }, {timeout:30_000});
});
