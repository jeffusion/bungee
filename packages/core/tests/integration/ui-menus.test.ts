import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, type MenuLayout, type MenuSnapshot } from '@jeffusion/bungee-types';
import { ConfigRepository, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { AsyncConfigRepository } from '../../src/config-storage/async-config-repository';
import { CONFIG_MIGRATIONS, migrateConfigurationDatabase } from '../../src/config-storage/migrations';
import { createMenuApi } from '../../src/master-runtime/menu-api';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { createManagementAuthFixture } from '../helpers/management-auth';
import { configurationRepositoryFixture } from '../helpers/config-repository';
import type { PluginManifestRecord } from '../../src/plugin-manifest-catalog/types';

const roots: string[] = [];
const clients: Array<{close(): Promise<void> | void}> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});
});
function databasePath() { const root=mkdtempSync(join(tmpdir(),'bungee-menus-'));roots.push(root);return join(root,'bungee.db'); }
function track<T extends {close(): Promise<void> | void}>(client:T): T { clients.push(client);return client; }

describe('menu persistence authority', () => {
  test('upgrades an existing migration prefix preserving data, and rolls back failed DDL', () => {
    const path = databasePath();
    let db = new Database(path);
    migrateConfigurationDatabase(db,CONFIG_MIGRATIONS.slice(0,2));
    db.run('UPDATE supervision_state SET updated_at=123 WHERE id=1');
    db.close();
    const repository = track(ConfigRepository.open(path));
    expect(repository.getSupervisionState().updated_at).toBe(123);
    expect(repository.getMenuLayout()).toEqual({revision:0,layout:null});
    const failed = new Database(':memory:');
    try {
      const failing = [...CONFIG_MIGRATIONS.slice(0,2),{version:3,name:'failing_menu_migration',up(db:Database){CONFIG_MIGRATIONS[2]!.up(db);throw new Error('rollback');}}];
      migrateConfigurationDatabase(failed,CONFIG_MIGRATIONS.slice(0,2));
      expect(()=>migrateConfigurationDatabase(failed,failing)).toThrow();
      expect(failed.query("SELECT name FROM sqlite_schema WHERE name='ui_menu_layout'").get()).toBeNull();
      expect(failed.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({version:2});
    } finally { failed.close(); }
  });
  test('storage Worker CAS survives reopen without changing proxy revision or publication', async () => {
    const path = databasePath();
    const repository = track(await AsyncConfigRepository.open(path));
    const before = repository.getSnapshot();
    expect(await repository.getMenuLayout()).toEqual({revision:0,layout:null});
    const layout = createDefaultMenuLayout(BUILTIN_MENU_PAGES);
    const ids = BUILTIN_MENU_PAGES.map(page=>page.id);
    const peer = track(await AsyncConfigRepository.open(path));
    const [a,b] = await Promise.all([repository.putMenuLayout(0,layout,ids),peer.putMenuLayout(0,layout,ids)]);
    expect([a.kind,b.kind].sort()).toEqual(['committed','stale_revision']);
    expect(repository.getSnapshot()).toEqual(before);
    expect(await repository.getCurrentOperationState()).toBeNull();
    expect(await repository.getActivePublication()).toBeNull();
    await peer.close();clients.splice(clients.indexOf(peer),1);
    await repository.close();clients.splice(clients.indexOf(repository),1);
    const reopened = track(await AsyncConfigRepository.open(path));
    expect(await reopened.getMenuLayout()).toEqual({revision:1,layout});
    expect(reopened.getSnapshot()).toEqual(before);
  });
  test('explicit integrity verification rejects noncanonical stored menu data', () => {
    const repository = track(ConfigRepository.open(databasePath()));
    repository.putMenuLayout(0,[],[]);
    repository.getDatabase().run("UPDATE ui_menu_layout SET layout_json='[ ]' WHERE id=1");
    expect(() => repository.verify()).toThrow('stored menu layout is invalid');
  });
  test('storage validation forbids new unknown ids but retains pages removed from manifest', () => {
    const repository = track(ConfigRepository.open(databasePath()));
    const stale = [{kind:'page',pageId:'plugin:removed:%2Fpage',visible:false}] as const;
    expect(()=>repository.putMenuLayout(0,stale,[])).toThrow();
    expect(repository.putMenuLayout(0,stale,[stale[0].pageId]).kind).toBe('committed');
    expect(repository.putMenuLayout(1,stale,[]).kind).toBe('committed');
    expect(()=>repository.putMenuLayout(2,[...stale,{kind:'page',pageId:'plugin:unknown:%2Fpage',visible:true}],[])).toThrow();
    expect(repository.getMenuLayout().revision).toBe(2);
  });
  test('a retired icon remains readable and editable after reopening the database', () => {
    const path = databasePath();
    const repository = track(ConfigRepository.open(path));
    const layout = [{kind:'page',pageId:'builtin:dashboard',visible:true,icon:'retired:example'}] as const;
    repository.putMenuLayout(0,[],[]);
    repository.getDatabase().run('UPDATE ui_menu_layout SET layout_json=? WHERE id=1', [JSON.stringify(layout)]);
    expect(repository.getMenuLayout().layout).toEqual(layout);
    repository.close(); clients.splice(clients.indexOf(repository),1);
    const reopened = track(ConfigRepository.open(path));
    expect(reopened.getMenuLayout().layout).toEqual(layout);
    expect(() => reopened.putMenuLayout(1,layout,['builtin:dashboard'])).toThrow();
    expect(reopened.putMenuLayout(1,[{kind:'page',pageId:'builtin:dashboard',visible:true}],['builtin:dashboard']).kind).toBe('committed');
  });
});

function fixture() {
  const repository=track(ConfigRepository.open(databasePath()));
  const auth=createManagementAuthFixture(()=>repository.getSnapshot().aggregate,{provider:true});
  let publicationCalls=0;
  let records: readonly PluginManifestRecord[] = [];
  const menuApi=createMenuApi({catalog:{records:()=>records},repository:{
    getMenuLayout:async()=>repository.getMenuLayout(),putMenuLayout:async(...args)=>repository.putMenuLayout(...args),
  }});
  const api=createConfigControlApi({repository:configurationRepositoryFixture(repository),managementAuth:auth.managementAuth,
    menuApi,admission:{snapshot:()=>[]},workerCount:1,clock:{now:()=>0},resolveAuthToken:v=>v,parseAggregate:parseNormalizeCompileAggregate,
    publicationTasks:{enqueue(){publicationCalls++;}},isMutationReady:()=>true});
  const send=(path:string,init:RequestInit={},authenticated=true)=>api.handle(new Request(`http://control.test${path}`,{
    ...init,headers:{...(authenticated ? {authorization:`Bearer ${auth.current.token}`} : {}),...init.headers},
  }));
  const put=(expected_revision:number,layout:MenuLayout)=>send('/api/ui/menus',{method:'PUT',body:JSON.stringify({expected_revision,layout})});
  return {repository,auth,api,send,put,publications:()=>publicationCalls,setRecords(value:readonly PluginManifestRecord[]){records=value;}};
}
describe('protected menu production API dispatch', () => {
  test('a fresh instance does not insert menus from installed but disabled plugins', async () => {
    const f = fixture();
    f.setRecords([{name:'disabled',manifest:{contributes:{navigation:[{label:'Disabled page',path:'/page'}]}}}] as unknown as PluginManifestRecord[]);
    const initial = await (await f.send('/api/ui/menus'))!.json() as MenuSnapshot;
    expect(initial.catalog.find(page => page.pluginName === 'disabled')?.available).toBe(false);
    expect(initial.layout).toEqual(createDefaultMenuLayout(BUILTIN_MENU_PAGES));
  });

  test('GET/PUT integrate, return 409 on stale revision and never publish workers', async () => {
    const f=fixture();
    const initial=await (await f.send('/api/ui/menus'))!.json() as MenuSnapshot;
    expect(initial.revision).toBe(0);expect(initial.catalog).toHaveLength(7);
    const layout=initial.layout.map(node=>node.kind==='page'?{...node,visible:false}:node);
    const saved=await f.put(0,layout);expect(saved!.status).toBe(200);
    expect((await saved!.json()).revision).toBe(1);
    expect((await f.put(0,layout))!.status).toBe(409);
    expect(f.repository.getSnapshot().revision).toBe(1);expect(f.publications()).toBe(0);
    expect((await f.put(1,[{kind:'page',pageId:'builtin:invented',visible:true}]))!.status).toBe(422);
    expect(f.repository.getMenuLayout().revision).toBe(1);
    f.setRecords([{name:'added',manifest:{contributes:{navigation:[{label:'nav.added',path:'/page',icon:'shield'}]}}}] as unknown as PluginManifestRecord[]);
    const refreshed=await (await f.send('/api/ui/menus'))!.json() as MenuSnapshot;
    expect(refreshed.catalog.find(p=>p.pluginName==='added')?.available).toBe(false);
    expect(refreshed.revision).toBe(1);
  });
  test('all menu/icon endpoints require authentication, config.read/write and CSRF', async () => {
    const f=fixture();
    for(const path of ['/api/ui/menus','/api/ui/icons/collections','/api/ui/icons/search?collection=lucide','/api/ui/icons/data?ids=lucide:home']) {
      expect((await f.send(path,{},false))!.status).toBe(401);
      expect((await f.send(path))!.status).toBe(200);
    }
    const calls:string[]=[];
    const authorize=f.auth.managementAuth.authorized.bind(f.auth.managementAuth);
    f.auth.managementAuth.authorized=async(request,capability)=>{calls.push(capability);return authorize(request,capability);};
    await f.send('/api/ui/menus');await f.put(0,[]);
    expect(calls).toContain('config.read');expect(calls).toContain('config.write');
    f.auth.managementAuth.authorized=async()=>false;
    expect((await f.send('/api/ui/menus'))!.status).toBe(403);
    expect((await f.put(1,[]))!.status).toBe(403);
    f.auth.managementAuth.authorized=authorize;
    f.auth.managementAuth.validateWrite=()=>{throw new Error('invalid_csrf');};
    expect((await f.put(1,[]))!.status).toBe(403);
    expect(f.repository.getMenuLayout().revision).toBe(1);
  });
  test('rechecks identity after body processing before any write', async () => {
    const f=fixture();
    f.auth.managementAuth.recheck=async()=>false;
    expect((await f.put(0,[]))!.status).toBe(401);
    expect(f.repository.getMenuLayout().revision).toBe(0);
  });
});
