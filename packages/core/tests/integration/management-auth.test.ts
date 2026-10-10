import {fileURLToPath} from 'node:url';
import {afterEach,describe,expect,spyOn,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL,PluginDurableStateStore} from '../../src/plugin-durable-state';
import {createPluginControlHost} from '../../src/plugin-control/host';
import {createControl} from '../../../../plugins/local-accounts/server/control';
import {loadPluginManifestRecord} from '../../src/plugin-manifest-catalog/manifest-filesystem';
import {ManagementAuthentication,validateManagementTransition} from '../../src/master-runtime/management-auth';
import {createConfigControlApi} from '../../src/master-runtime/control-api';
import type {ConfigurationAggregateV2} from '@jeffusion/bungee-types';
const PASSWORD='Administrator password 123!';
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
async function fixture() {
 const db=new Database(':memory:');db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
 const state=new PluginDurableStateStore(db);
 const raw=await loadPluginManifestRecord(fileURLToPath(new URL('../../../../plugins/local-accounts', import.meta.url)));
 const record={...raw,runtimeHash:'sha256:'+'0'.repeat(64)} as any;
 const host=createPluginControlHost({records:[record],loadControl:async()=>({createControl}),
  secretStores:{create:()=>({namespace:'local-accounts',get:async()=>null,compareAndSet:async()=>1,delete:async()=>{}}),revoke(){},clear(){}},
  storage:{create:()=>({}) as any},durableState:name=>state.forNamespace(name)});
 let aggregate:ConfigurationAggregateV2={logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[]};
 const auth=new ManagementAuthentication(host,()=>aggregate,new Set(['local-accounts']));
 await auth.initialize();
 const snapshot=()=>({aggregate,revision:1,content_hash:'sha256:'+'0'.repeat(64)}) as any;
 const api=createConfigControlApi({repository:{getSnapshot:snapshot,getActivePublication:async()=>null,getOperationState:async()=>null,commit:()=>{throw Error('unexpected');}},
  admission:{snapshot:()=>[]},workerCount:1,clock:{now:Date.now},resolveAuthToken:()=>null,
  parseAggregate:value=>({ok:true,value:value as ConfigurationAggregateV2}),publicationTasks:{enqueue(){}},isMutationReady:()=>true,
  managementAuth:auth,
  validateManagementTransition:(request,active,next)=>validateManagementTransition(request,active,next,auth,host),
  pluginControlApi:host.api,pluginCapability:()=> 'self.password'});
 disposals.push(async()=>{await host.dispose();db.close();});
 const request=(path:string,token?:string,body?:unknown,method=body===undefined?'GET':'POST',extra:Record<string,string>={})=>new Request('http://localhost'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const enable=async()=>{const handle=await host.activate('local-accounts');await handle.control.management!.bootstrap({username:'admin',password:PASSWORD,passwordConfirmation:PASSWORD});aggregate={...aggregate,plugin_activations:[{plugin_name:'local-accounts'}]};return handle;};
 const disable=()=>{aggregate={...aggregate,plugin_activations:[]};};
 const sign=async()=>{const response=await api.handle(request('/api/auth/login',undefined,{username:'admin',password:PASSWORD,transport:'bearer'}));expect(response!.status).toBe(200);return (await response!.json()).token as string;};
 return {db,state,host,auth,api,request,enable,disable,sign,active:()=>aggregate};
}
describe('personal management authentication',()=>{
 test('host cookie logout delegates to provider, requires CSRF and revokes only the current session',async()=>{
  const f=await fixture();await f.enable();
  async function cookieSession(){
   const response=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD,transport:'cookie'},'POST',{origin:'http://localhost'}));
   expect(response!.status).toBe(200);
   return {cookie:response!.headers.get('set-cookie')!.split(';')[0]!,csrf:(await response!.json()).csrfToken as string};
  }
  const current=await cookieSession(),other=await cookieSession();
  const denied=await f.api.handle(f.request('/api/auth/logout',undefined,{},'POST',{cookie:current.cookie,origin:'http://localhost'}));
  expect(denied!.status).toBe(403);
  const stillValid=await f.api.handle(f.request('/api/auth/verify',undefined,undefined,'GET',{cookie:current.cookie}));
  expect(stillValid!.status).toBe(200);
  const response=await f.api.handle(f.request('/api/auth/logout',undefined,{},'POST',{cookie:current.cookie,origin:'http://localhost','x-csrf-token':current.csrf}));
  expect(response!.status).toBe(200);expect(response!.headers.get('set-cookie')).toContain('Max-Age=0');
  const revoked=await f.api.handle(f.request('/api/auth/verify',undefined,undefined,'GET',{cookie:current.cookie}));
  expect(revoked!.status).toBe(401);
  const cleared=await f.api.handle(f.request('/api/auth/verify'));
  expect(cleared!.status).toBe(200);expect(await cleared!.json()).toEqual({success:false,mode:'plugin'});
  const unaffected=await f.api.handle(f.request('/api/auth/verify',undefined,undefined,'GET',{cookie:other.cookie}));
  expect(unaffected!.status).toBe(200);
 });
 test('anonymous management opens by default without key initialization, regardless of stale credentials',async()=>{
  const f=await fixture();expect(f.db.query("SELECT name FROM sqlite_master WHERE name='api_keys'").get()).toBeNull();
  for(const token of [undefined,'invalid-stale-key']) expect((await f.api.handle(f.request('/api/config',token)))!.status).toBe(200);
  const mode=await (await f.api.handle(f.request('/api/auth/mode')))!.json();expect(mode.mode).toBe('anonymous');
  const verify=await (await f.api.handle(f.request('/api/auth/verify')))!.json();expect(verify.success).toBe(true);expect(verify.mode).toBe('anonymous');
  const req=f.request('/api/config',undefined,{},'PUT',{cookie:'stale=1'});await f.auth.authenticate(req);expect(()=>f.auth.validateWrite(req)).not.toThrow();
 });
 test('selected plugin protects every management request; administrator has a single full-access identity',async()=>{
  const f=await fixture();await f.enable();
  expect((await f.api.handle(f.request('/api/config')))!.status).toBe(401);
  const token=await f.sign();
  const verified=await (await f.api.handle(f.request('/api/auth/verify',token)))!.json();expect(verified.mode).toBe('plugin');expect(verified.subject).not.toHaveProperty('role');
  expect((await f.api.handle(f.request('/api/config',token)))!.status).toBe(200);
  const self=await (await f.api.handle(f.request('/api/plugins/local-accounts/control/self',token)))!.json();expect(self.administrator.username).toBe('admin');expect(self).not.toHaveProperty('member');
  expect((await f.api.handle(f.request('/api/plugins/local-accounts/control/members',token)))!.status).toBe(404);
 });
  test('login binds dispatch to the expected management provider while keeping legacy and anonymous calls compatible',async()=>{
   const f=await fixture();const anonymous=await f.api.handle(f.request('/api/auth/login',undefined,{},'POST'));
   expect(await anonymous!.json()).toEqual({success:true,mode:'anonymous'});
   expect((await f.api.handle(f.request('/api/config')))!.status).toBe(200);
   expect((await f.api.handle(f.request('/api/auth/mode')))!.status).toBe(200);
   expect((await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'})))!.status).toBe(409);

   await f.enable();const provider=f.auth.provider()!;const login=spyOn(provider,'login');
   const mismatch=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'another-provider'}));
   expect(mismatch!.status).toBe(409);expect(await mismatch!.json()).toEqual({success:false,error:'authentication_provider_changed'});
   expect(login).not.toHaveBeenCalled();
   const invalid=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':''}));
   expect(invalid!.status).toBe(400);expect(login).not.toHaveBeenCalled();
   const bound=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD,transport:'bearer'},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   expect(bound!.status).toBe(200);expect((await bound!.json()).success).toBe(true);
   expect(login).toHaveBeenCalledTimes(1);
   const legacy=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD,transport:'bearer'}));
   expect(legacy!.status).toBe(200);
  });
  test('login does not return provider cookies after selection or provider instance changes in flight',async()=>{
   const f=await fixture();await f.enable();const provider=f.auth.provider()!;
   let finish!: (response:Response)=>void;
   spyOn(provider,'login').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
   const pending=f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   await Promise.resolve();f.disable();finish(Response.json({token:'must-not-escape'},{headers:{'set-cookie':'session=secret'}}));
   const changed=await pending;expect(changed!.status).toBe(409);expect(changed!.headers.get('set-cookie')).toBeNull();
  });
  test('login rechecks provider after asynchronously parsing the response body',async()=>{
   const delayedResponse=()=>{
    let release!:()=>void,started!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const reading=new Promise<void>(resolve=>{started=resolve;});
    const response=new Response(new ReadableStream<Uint8Array>({async pull(controller){await gate;controller.enqueue(new TextEncoder().encode('{"token":"must-not-escape"}'));controller.close();}}),
     {headers:{'content-type':'application/json','set-cookie':'session=secret'}});
    const parseJson=response.json.bind(response);
    response.json=async()=>{const parsed=parseJson();started();return await parsed;};
    return {response,reading,release};
   };

   const selectedFixture=await fixture();await selectedFixture.enable();
   const selectedBody=delayedResponse(),selectedProvider=selectedFixture.auth.provider()!;
   const selectedLogin=spyOn(selectedProvider,'login').mockImplementation(async()=>selectedBody.response);
   const selectedPending=selectedFixture.api.handle(selectedFixture.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   await selectedBody.reading;expect(selectedLogin).toHaveBeenCalledTimes(1);selectedFixture.disable();selectedBody.release();
   const selectionChanged=await selectedPending;
   expect(selectionChanged!.status).toBe(409);expect(selectionChanged!.headers.get('set-cookie')).toBeNull();

   const unavailableFixture=await fixture();await unavailableFixture.enable();
   const unavailableBody=delayedResponse(),unavailableProvider=unavailableFixture.auth.provider()!;
   const unavailableLogin=spyOn(unavailableProvider,'login').mockImplementation(async()=>unavailableBody.response);
   const unavailablePending=unavailableFixture.api.handle(unavailableFixture.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   await unavailableBody.reading;expect(unavailableLogin).toHaveBeenCalledTimes(1);await unavailableFixture.host.deactivate('local-accounts');unavailableBody.release();
   const providerUnavailable=await unavailablePending;
   expect(providerUnavailable!.status).toBe(503);expect(providerUnavailable!.headers.get('set-cookie')).toBeNull();
  });
  test('login rejects late cookies when the selected provider becomes unavailable or is replaced under the same name',async()=>{
   const f=await fixture();await f.enable();const provider=f.auth.provider()!;
   let finish!: (response:Response)=>void;
   spyOn(provider,'login').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
   const pending=f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   await Promise.resolve();await f.host.deactivate('local-accounts');
   finish(Response.json({token:'must-not-escape'},{headers:{'set-cookie':'session=secret'}}));
   const unavailable=await pending;expect(unavailable!.status).toBe(503);expect(unavailable!.headers.get('set-cookie')).toBeNull();

   const replacement=await f.host.activate('local-accounts');
   expect(replacement.status).toBe('ready');
   let finishReplacement!: (response:Response)=>void;
   spyOn(replacement.control.management!,'login').mockImplementation(()=>new Promise(resolve=>{finishReplacement=resolve;}));
   const replacedPending=f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{'x-bungee-auth-provider':'local-accounts'}));
   await Promise.resolve();await f.host.deactivate('local-accounts');await f.host.activate('local-accounts');
   expect(f.auth.provider()).not.toBe(replacement.control.management);
   finishReplacement(Response.json({token:'must-not-escape'},{headers:{'set-cookie':'session=secret'}}));
   const replaced=await replacedPending;expect(replaced!.status).toBe(409);expect(replaced!.headers.get('set-cookie')).toBeNull();
  });
 test('cookie management writes enforce same origin and CSRF',async()=>{
  const f=await fixture();await f.enable();
  const login=await f.api.handle(f.request('/api/auth/login',undefined,{username:'admin',password:PASSWORD},'POST',{origin:'http://localhost'}));
  const cookie=login!.headers.get('set-cookie')!.split(';')[0]!;const body=await login!.json();
  const denied=await f.api.handle(f.request('/api/plugins/local-accounts/control/logout',undefined,{},'POST',{cookie}));expect(denied!.status).toBe(403);
  const allowed=await f.api.handle(f.request('/api/plugins/local-accounts/control/logout',undefined,{},'POST',{cookie,origin:'http://localhost','x-csrf-token':body.csrfToken}));expect(allowed!.status).toBe(200);
  expect((await f.api.handle(f.request('/api/config',undefined,undefined,'GET',{cookie})))!.status).toBe(401);
 });
 test('selected but unloaded provider rejects requests instead of falling back to anonymous',async()=>{
  const f=await fixture();await f.enable();await f.host.deactivate('local-accounts');
  await expect(f.auth.authenticate(f.request('/api/config'))).rejects.toThrow('management_provider_unavailable');
  expect((await f.api.handle(f.request('/api/config')))!.status).toBe(503);
 });
 test('durable selected provider survives a missing catalog instead of becoming anonymous',async()=>{
  const f=await fixture();await f.enable();
  const selection=f.state.forNamespace('core-management-auth');
  const first=new ManagementAuthentication(f.host,f.active,new Set(['local-accounts']),undefined,selection);
  await first.initialize();
  expect(first.selected()).toBe('local-accounts');
  await f.host.deactivate('local-accounts');
  const restarted=new ManagementAuthentication(f.host,f.active,new Set(),undefined,selection);
  await restarted.initialize();
  expect(restarted.selected()).toBe('local-accounts');
  await expect(restarted.authenticate(f.request('/api/config'))).rejects.toThrow('management_provider_unavailable');
  f.disable();
  expect(()=>restarted.selected()).toThrow('management_selection_mismatch');
 });
 test('disabling requires current live identity and returns directly to anonymous; re-enable verifies stored administrator',async()=>{
  const f=await fixture();const staleAnonymous=f.request('/disable');await f.auth.authenticate(staleAnonymous);
  await f.enable();const before=f.active();const after={...before,plugin_activations:[]};
  expect((await validateManagementTransition(staleAnonymous,before,after,f.auth,f.host))?.status).toBe(401);
  expect((await validateManagementTransition(f.request('/disable'),before,after,f.auth,f.host))?.status).toBe(401);
  const token=await f.sign(),req=f.request('/disable',token);await f.auth.authenticate(req);
  expect(await validateManagementTransition(req,before,after,f.auth,f.host)).toBeNull();
  await f.host.get('local-accounts')!.control.management!.revokeSessions();
  expect((await validateManagementTransition(req,before,after,f.auth,f.host))?.status).toBe(401);
  f.disable();expect((await f.api.handle(f.request('/api/config')))!.status).toBe(200);
  await f.host.deactivate('local-accounts');const restarted=await f.host.activate('local-accounts');expect(await restarted.control.management!.hasIdentity()).toBe(true);
  await expect(restarted.control.management!.bootstrap({username:'replacement',password:PASSWORD,passwordConfirmation:PASSWORD})).rejects.toThrow('invalid_credentials');
  await f.enable();expect((await f.api.handle(f.request('/api/config')))!.status).toBe(401);expect(await f.sign()).toBeString();
 });
 test('cannot publish management activation until configured identity exists',async()=>{
  const f=await fixture();const before=f.active(),after={...before,plugin_activations:[{plugin_name:'local-accounts'}]};
  expect((await validateManagementTransition(f.request('/enable'),before,after,f.auth,f.host))?.status).toBe(422);
  await f.host.activate('local-accounts');expect((await validateManagementTransition(f.request('/enable'),before,after,f.auth,f.host))?.status).toBe(422);
  await f.enable();expect(await validateManagementTransition(f.request('/enable'),before,after,f.auth,f.host)).toBeNull();
 });
});
