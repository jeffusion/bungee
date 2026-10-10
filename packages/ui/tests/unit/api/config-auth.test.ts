import { afterEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { api, ApiError } from '../../../src/api/client';
import { getToken, login, logout, restoreSession, csrfToken, clearLegacyCredential } from '../../../src/stores/auth';
import { readAuthMode, verifyToken } from '../../../src/api/auth';
import { keysApi } from '../../../src/api/keys';
import { setPluginEnabled } from '../../../src/api/plugins';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;logout();});
test('legacy browser credential is removed; transient bearer remains in memory and logout erases it',()=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');const values=new Map([['bungee_auth_token','legacy']]);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{removeItem:(key:string)=>values.delete(key),setItem:()=>{throw Error('secret persistence');}}});
  clearLegacyCredential();login('transient-bearer');expect(values.has('bungee_auth_token')).toBe(false);expect(getToken()).toBe('transient-bearer');logout();expect(getToken()).toBeNull();
  if(original)Object.defineProperty(globalThis,'localStorage',original);else delete (globalThis as any).localStorage;
});
test('cookie session restores CSRF; writes send CSRF without bearer',async()=>{
  const requests:RequestInit[]=[];
  globalThis.fetch=(async(_url,init)=>{requests.push(init!);return Response.json(requests.length===1?{success:true,mode:'plugin',subject:{id:'u',provider:'local-accounts',},csrfToken:'csrf-secret'}:{ok:true});}) as typeof fetch;
  await verifyToken();await api.post('/config/validate',{});
  expect(get(csrfToken)).toBe('csrf-secret');
  expect(requests[1]?.credentials).toBe('same-origin');expect(new Headers(requests[1]?.headers).get('x-csrf-token')).toBe('csrf-secret');expect(new Headers(requests[1]?.headers).has('authorization')).toBe(false);
});
test('provider outage never changes mode or clears an existing session',async()=>{
  restoreSession({success:true,csrfToken:'csrf',});
  globalThis.fetch=(async()=>Response.json({error:'management_provider_unavailable'},{status:503})) as typeof fetch;
  await expect(readAuthMode()).rejects.toBeInstanceOf(ApiError);expect(get(csrfToken)).toBe('csrf');
});
test('Key lifecycle creates, reveals and deletes credentials through the access control plugin',async()=>{
  const requests:{url:string;method:string}[]=[];
  globalThis.fetch=(async(url,init)=>{requests.push({url:String(url),method:init?.method ?? 'GET'});return Response.json({key:{id:'key'},token:'stored-secret',ready:true,published:true});}) as typeof fetch;
  const created=await keysApi.create({name:'App'});expect(created.token).toBe('stored-secret');
  expect((await keysApi.reveal('key')).token).toBe('stored-secret');
  await keysApi.remove('key');
  expect(requests).toEqual([
    {url:'/api/plugins/key-access/control/credentials',method:'POST'},
    {url:'/api/plugins/key-access/control/credentials/key',method:'GET'},
    {url:'/api/plugins/key-access/control/credentials/key',method:'DELETE'},
  ]);
});
test('single administrator setup and disable use exact envelopes',async()=>{
  const requests:{url:string;init?:RequestInit}[]=[];
  globalThis.fetch=(async(url,init)=>{requests.push({url:String(url),init});return Response.json({unchanged:true});}) as typeof fetch;
  const setup={username:'owner',password:'long-new-password',passwordConfirmation:'long-new-password'};
  await setPluginEnabled('local-accounts',true,{managementSetup:setup});await setPluginEnabled('local-accounts',false,{});
  expect(JSON.parse(String(requests[0]!.init!.body))).toEqual({managementSetup:setup});expect(new Headers(requests[1]!.init!.headers).get('x-bungee-next-authorization')).toBeNull();
});
test('unauthorized clears credentials and CSRF',async()=>{
  login('key');restoreSession({success:true,csrfToken:'csrf'});
  globalThis.fetch=(async()=>Response.json({error:'unauthorized'},{status:401})) as typeof fetch;
  await expect(api.get('/config')).rejects.toBeInstanceOf(ApiError);
  expect(getToken()).toBeNull();expect(get(csrfToken)).toBeNull();
});
test('extension history is read using the Host endpoint, not an inactive plugin API',async()=>{
  const urls:string[]=[];
  globalThis.fetch=(async url=>{urls.push(String(url));return Response.json({extensions:[{plugin:'test-policy',component:'TestPolicy',path:'/keys/:keyId',active:false,ready:false,value:{kept:true}}]});}) as typeof fetch;
  expect((await keysApi.extensions('key/id')).extensions[0]?.value).toEqual({kept:true});
  expect(urls).toEqual(['/api/resources/api-key/key%2Fid/extensions']);
});
test('clearing a plugin policy transmits explicit null instead of an empty object',async()=>{
  let body:unknown;
  globalThis.fetch=(async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({value:null});}) as typeof fetch;
  const {requestPluginControl}=await import('../../../src/api/client');await requestPluginControl('test-policy','/keys/k','PUT',null);
  expect(body).toBeNull();
});
