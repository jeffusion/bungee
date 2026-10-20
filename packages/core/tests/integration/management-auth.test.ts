import {fileURLToPath} from 'node:url';
import {afterEach,describe,expect,spyOn,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../src/plugin-durable-state';
import {createPluginControlHost} from '../../src/plugin-control/host';
import {createControl,prepareInitialization,readManagementSetup} from '../../../../plugins/user-auth/server/control';
import {loadPluginManifestRecord} from '../../src/plugin-manifest-catalog/manifest-filesystem';
import {ManagementAuthentication,validateManagementTransition} from '../../src/master-runtime/management-auth';
import {createConfigControlApi} from '../../src/master-runtime/control-api';
import {createMasterPluginCatalogApi} from '../../src/master-runtime/master-plugin-catalog-api';
import {hashConfigurationContent,type ManagementProtection} from '../../src/config-storage';
import type {ConfigurationAggregate} from '@jeffusion/bungee-types';
const PASSWORD='Administrator password 123!';
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
const request=(path:string,body?:unknown,extra:Record<string,string>={},method=body===undefined?'GET':'POST')=>new Request('http://localhost'+path,{method,headers:extra,...(body===undefined?{}:{body:JSON.stringify(body)})});
async function fixture(prepare = true) {
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const state=new PluginDurableStateStore(db),namespace=state.forNamespace('user-auth');
 const prepared=prepare ? await prepareInitialization({durableState:namespace}) : undefined;
 const raw=await loadPluginManifestRecord(fileURLToPath(new URL('../../../../plugins/user-auth', import.meta.url)));
 const record={...raw,runtimeHash:'sha256:'+'0'.repeat(64)} as any;
 const host=createPluginControlHost({records:[record],loadControl:async()=>({createControl,readManagementSetup}),
  secretStores:{create:()=>({namespace:'user-auth',get:async()=>null,compareAndSet:async()=>1,delete:async()=>{}}),revoke(){},clear(){}},
  storage:{create:()=>({}) as any},durableState:name=>state.forNamespace(name)});
 let aggregate:ConfigurationAggregate={logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[]};
 let guard:ManagementProtection={required:false,selectedProvider:null,generation:0};
 const auth=new ManagementAuthentication(host,()=>aggregate,new Set(['user-auth']),undefined,()=>guard);
 const snapshot=()=>({aggregate,revision:1,content_hash:'sha256:'+'0'.repeat(64)}) as any;
 const api=createConfigControlApi({repository:{getSnapshot:snapshot,getActivePublication:async()=>null,getOperationState:async()=>null,commit:()=>{throw Error('unexpected');}},
  admission:{snapshot:()=>[]},workerCount:1,clock:{now:Date.now},resolveAuthToken:()=>null,
  parseAggregate:value=>({ok:true,value:value as ConfigurationAggregate}),publicationTasks:{enqueue(){}},isMutationReady:()=>true,
  managementAuth:auth,managementProviderMetadata:name=>({name,loginComponent:'Login',setupComponent:'Setup'}),
  validateManagementTransition:(req,active,next)=>validateManagementTransition(req,active,next,auth,host),
  pluginControlApi:host.api,pluginCapability:()=> 'self.password',
  pluginCatalogApi:createMasterPluginCatalogApi({catalog:{records:()=>[record]},readManagementSetup:name=>host.readManagementSetup(name)})});
 disposals.push(async()=>{await host.dispose();db.close();});
 const select=async()=>{await host.activate('user-auth');aggregate={...aggregate,plugin_activations:[{plugin_name:'user-auth'}]};guard={required:true,selectedProvider:'user-auth',generation:guard.generation+1};};
 const setupBody={setupCode:prepared?.code,username:'admin',password:PASSWORD,passwordConfirmation:PASSWORD};
 const initialize=()=>api.handle(request('/api/auth/setup',setupBody,{origin:'http://localhost','x-bungee-auth-provider':'user-auth'}));
 const enable=async()=>{await select();expect((await initialize())!.status).toBe(200);};
 const sign=async(transport='cookie')=>{
  const response=await api.handle(request('/api/auth/login',{username:'admin',password:PASSWORD,transport},{origin:'http://localhost','x-bungee-auth-provider':'user-auth'}));
  expect(response!.status).toBe(200);return {cookie:response!.headers.get('set-cookie')?.split(';')[0]!,body:await response!.json()};
 };
 return {db,state,host,auth,api,select,initialize,enable,sign,setupBody,active:()=>aggregate,
  setGuard:(next:ManagementProtection)=>{guard=next;},guard:()=>guard,setAggregate:(next:ConfigurationAggregate)=>{aggregate=next;}};
}
describe('management authentication and selected-provider initialization',()=>{
 test('inactive provider status is read-only and independent of removed plugins; protected reads require a session',async()=>{
  const f=await fixture(false),path='/api/plugins/user-auth/management-setup';
  const own=f.state.forNamespace('user-auth'),other=f.state.forNamespace('local-accounts');
  await other.transact([{key:'setup',expectedVersion:0,value:{schema:3,setup:{phase:'ready'}}}]);
  const before=await other.list();
  expect(await (await f.api.handle(request(path)))!.json()).toEqual({initialized:false});
  expect(await own.list()).toEqual([]);
  expect(await other.list()).toEqual(before);
  expect(f.host.status('user-auth')).not.toBe('ready');
  const issued=await prepareInitialization({durableState:own});
  await f.select();
  expect((await f.api.handle(request(path)))!.status).toBe(401);
  expect((await f.api.handle(request('/api/auth/setup',{...f.setupBody,setupCode:issued.code},{origin:'http://localhost','x-bungee-auth-provider':'user-auth'})))!.status).toBe(200);
  const session=await f.sign();
  expect(await (await f.api.handle(request(path,undefined,{cookie:session.cookie})))!.json()).toEqual({initialized:true});
  expect(await other.list()).toEqual(before);
 });
 test('anonymous mode is explicit and setup has no arbitrary plugin selector',async()=>{
  const f=await fixture();
  expect((await f.api.handle(request('/api/config')))!.status).toBe(200);
  expect(await (await f.api.handle(request('/api/auth/mode')))!.json()).toMatchObject({mode:'anonymous',initialized:true,publicOrigin:'http://localhost'});
  expect((await f.api.handle(request('/api/auth/setup')))!.status).toBe(404);
  expect((await f.api.handle(request('/api/auth/setup?plugin=user-auth')))!.status).toBe(400);
  expect(f.host.status('user-auth')).not.toBe('ready');
 });
 test('selected uninitialized provider starts and exposes public setup without opening management',async()=>{
  const f=await fixture();await f.select();
  expect((await f.api.handle(request('/api/config')))!.status).toBe(401);
  expect(await (await f.api.handle(request('/api/auth/mode')))!.json()).toMatchObject({mode:'plugin',initialized:false,provider:{name:'user-auth',setupComponent:'Setup'}});
  expect(await (await f.api.handle(request('/api/auth/setup')))!.json()).toMatchObject({initialized:false,provider:{name:'user-auth'}});
  expect((await f.initialize())!.status).toBe(200);
  expect(await (await f.api.handle(request('/api/auth/setup')))!.json()).toMatchObject({initialized:true});
  expect((await f.api.handle(request('/api/config')))!.status).toBe(401);
  expect((await f.initialize())!.status).toBe(409);
 });
 test('setup POST binds current origin and provider before dispatch; status read failure returns 503',async()=>{
  const f=await fixture();await f.select();const provider=f.auth.provider()!,initialize=spyOn(provider,'initialize');
  for(const headers of [{},{origin:'http://attacker','x-bungee-auth-provider':'user-auth'},{origin:'http://localhost'}] as Record<string,string>[]) {
   const response=await f.api.handle(request('/api/auth/setup',f.setupBody,headers));
   expect([403,409]).toContain(response!.status);
  }
  expect(initialize).not.toHaveBeenCalled();
  spyOn(provider,'setupStatus').mockRejectedValue(new Error('sensitive path'));
  for(const path of ['/api/auth/setup','/api/auth/mode']) {
   const response=await f.api.handle(request(path));expect(response!.status).toBe(503);expect(await response!.text()).not.toContain('sensitive');
  }
 });
 test('all live provider sessions have full capabilities and cookie writes require origin plus CSRF',async()=>{
  const f=await fixture();await f.enable();const session=await f.sign();
  const verify=await f.api.handle(request('/api/auth/verify',undefined,{cookie:session.cookie}));
  expect(await verify!.json()).toMatchObject({success:true,mode:'plugin',subject:{provider:'user-auth'}});
  for(const capability of ['config.read','config.write','auth.mode','plugins.code','keys.write']) {
   const req=request('/api/config',undefined,{cookie:session.cookie});await f.auth.authenticate(req);expect(await f.auth.authorized(req,capability)).toBe(true);
  }
  expect((await f.api.handle(request('/api/auth/logout',{}, {cookie:session.cookie,origin:'http://localhost'})))!.status).toBe(403);
  const other=await f.sign();
  expect((await f.api.handle(request('/api/auth/logout',{}, {cookie:session.cookie,origin:'http://localhost','x-csrf-token':session.body.csrfToken})))!.status).toBe(200);
  expect((await f.api.handle(request('/api/auth/verify',undefined,{cookie:session.cookie})))!.status).toBe(401);
  expect((await f.api.handle(request('/api/config',undefined,{cookie:other.cookie})))!.status).toBe(200);
 });
 test('missing provider, absent catalog, and guard disagreement never grant anonymous access',async()=>{
  const f=await fixture();await f.enable();await f.host.deactivate('user-auth');
  expect((await f.api.handle(request('/api/config')))!.status).toBe(503);
  const missing=new ManagementAuthentication(f.host,f.active,new Set(),undefined,f.guard);
  expect(missing.selected()).toBe('user-auth');await expect(missing.authenticate(request('/api/config'))).rejects.toThrow('management_provider_unavailable');
  f.setAggregate({...f.active(),plugin_activations:[]});
  expect((await f.api.handle(request('/api/config')))!.status).toBe(503);
  expect((await f.api.handle(request('/api/auth/mode')))!.status).toBe(503);
 });
 test('normal commits and validation cannot disable or replace protected management',async()=>{
  const f=await fixture();await f.enable();const session=await f.sign(),active=f.active();
  const disabled={...active,plugin_activations:[]};
  expect((await validateManagementTransition(request('/'),active,disabled,f.auth,f.host))!.status).toBe(422);
  const headers={cookie:session.cookie,origin:'http://localhost','x-csrf-token':session.body.csrfToken};
  for(const [path,body,method] of [
   ['/api/config/validate',{aggregate:disabled},'POST'],
   ['/api/config',{expected_revision:1,aggregate:disabled},'PUT'],
   ['/api/config',{expected_revision:2,aggregate:disabled},'PUT'],
   ['/api/plugins/user-auth/disable',{},'POST'],
  ] as const) expect((await f.api.handle(request(path,body,headers,method)))!.status).toBe(422);
  const base={format:'bungee-config-snapshot',format_version:1,schema_version:1,exported_at:0,source_revision:1,content_hash:hashConfigurationContent(disabled),aggregate:disabled};
  const envelope={...base,envelope_hash:hashConfigurationContent(base)};
  for(const [path,body] of [['/api/config/import',{expected_revision:1,mutation_id:'protected-import',envelope}],['/api/config/validate',{envelope}]] as const)
   expect((await f.api.handle(request(path,body,headers)))!.status).toBe(422);
 });
 test('login binding and late provider changes never return stale session cookies',async()=>{
  const f=await fixture();await f.enable();const provider=f.auth.provider()!,login=spyOn(provider,'login');
  expect((await f.api.handle(request('/api/auth/login',{}, {'x-bungee-auth-provider':'other'})))!.status).toBe(409);expect(login).not.toHaveBeenCalled();
  let finish!:(response:Response)=>void;login.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.api.handle(request('/api/auth/login',{}, {'x-bungee-auth-provider':'user-auth'}));
  await Promise.resolve();f.setGuard({...f.guard(),generation:f.guard().generation+1});
  finish(Response.json({success:true},{headers:{'set-cookie':'session=must-not-escape'}}));
  const response=await pending;expect(response!.status).toBe(409);expect(response!.headers.get('set-cookie')).toBeNull();
 });
 test('generation and transition latch invalidate already authenticated requests',async()=>{
  const f=await fixture();const old=request('/api/config');await f.auth.authenticate(old);
  const transition=f.auth.beginTransition('original-operation');
  expect(f.auth.identity(old)).toBeNull();await expect(f.auth.authenticate(request('/api/config'))).rejects.toThrow('management_transition_pending');
  expect(()=>f.auth.completeTransition({mutationId:'original-operation'})).toThrow('management_transition_mismatch');
  f.auth.completeTransition(transition);expect(await f.auth.recheck(old)).toBe(false);
  expect(await f.auth.authenticate(request('/api/config'))).not.toBeNull();
 });
 test('verification does not return a renewed cookie after its generation changes while the provider is renewing it',async()=>{
  const f=await fixture();await f.enable();const session=await f.sign(),provider=f.auth.provider()!;
  let entered!:()=>void,finish!:(cookie:string)=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  spyOn(provider,'sessionCookie').mockImplementation(async()=>{entered();return new Promise(resolve=>{finish=resolve;});});
  const pending=f.api.handle(request('/api/auth/verify',undefined,{cookie:session.cookie}));await started;
  f.setGuard({...f.guard(),generation:f.guard().generation+1});finish('session=must-not-escape');
  const response=await pending;expect(response!.status).toBe(409);expect(response!.headers.get('set-cookie')).toBeNull();
 });

});
