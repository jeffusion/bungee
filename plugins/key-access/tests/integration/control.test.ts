import {initializePluginStateDatabase} from '../../../../packages/core/src/plugin-state/schema';
import {createSecretStore} from '../../../../packages/core/src/plugin-control/secret-store';
import {Database} from 'bun:sqlite';
import {expect, test} from 'bun:test';
import {PLUGIN_DURABLE_STATE_SCHEMA_SQL, PluginDurableStateStore} from '../../../../packages/core/src/plugin-durable-state';
import {createControl, readAdmissionRequirements, verifyDataPrincipal} from '../../server/control';
import {createIngress} from '../../server/policy';
import type {ControlHostContext} from '../../../../packages/core/src/plugin-control/contracts';

test('plugin manages credentials and protections; publication failures preserve changes and recoverable encrypted credential', async () => {
  const db = new Database(':memory:'); initializePluginStateDatabase(db);
  const material = {keyId:'test',key:new Uint8Array(32).fill(8)}; const secretStore = createSecretStore(db,'key-access',material);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  let fail = false;
  const host = {secretStore, signal: new AbortController().signal, durableState: state, validateRouteReferences: (ids: string[]) => ids.every(id => ['r', 's'].includes(id)), validateKeyPolicyReferences: (_id: string, p: any) => p === null || p.routes === null || p.routes.every((id: string) => ['r', 's'].includes(id)), publishPolicy: async () => {if (fail) throw Error('publication failed');}} as unknown as ControlHostContext;
  const control = createControl(host);
  const invoke = async (handler: string, method: string, path: string, value?: unknown) => control.api.find(api => api.handler === handler)!.invoke({...host, requestSignal: host.signal, request: new Request('http://localhost'+path, {method, ...(value === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(value)})})});
  try {
    await control.start();
    expect((await readAdmissionRequirements(state))).toEqual([]);
    const response = await invoke('credentials', 'POST', '/credentials', {name: 'first'});
    expect(response.status).toBe(201); const issued = await response.json();
    expect(issued.token).toMatch(/^bng_data_/); expect(issued.key.token).toBeUndefined();
    const reveal = await invoke('credential','GET','/credentials/'+issued.key.id);
    expect(reveal.headers.get('cache-control')).toBe('no-store');
    expect((await reveal.json()).token).toBe(issued.token);
    expect((await createSecretStore(db,'key-access',material).get('credential:'+issued.key.id))!.value).toBe(issued.token);
    const row = db.query('SELECT envelope FROM secret_store_objects WHERE key=?').get('credential:'+issued.key.id) as {envelope:Uint8Array};
    expect(Buffer.from(row.envelope).includes(Buffer.from(issued.token))).toBe(false);
    const edited = await invoke('credential','PUT','/credentials/'+issued.key.id,{name:'edited',expiresAt:Date.now()+86400000,routes:['r'],models:['m']});
    expect(edited.status).toBe(200); expect((await edited.json()).key.name).toBe('edited');
    expect((await (await invoke('credential','GET','/credentials/'+issued.key.id)).json()).token).toBe(issued.token);
    await invoke('keyPolicy','PUT','/keys/'+issued.key.id,{routes:[],models:null});

    const principal = {domain: 'data', keyId: issued.key.id, credentialVersion: 1};
    expect((await verifyDataPrincipal(principal, state))).toBe(true);
    expect(JSON.stringify((await state.list()))).not.toContain(issued.token);
    expect(JSON.stringify(await (await invoke('credentials', 'GET', '/credentials')).json())).not.toContain(issued.token);
    expect((await invoke('routeProtection', 'PUT', '/routes', {protectedRouteIds: ['missing']})).status).toBe(422);
    expect((await invoke('routeProtection', 'PUT', '/routes', {protectedRouteIds: ['r', 's']})).status).toBe(200);
    const admission = createIngress();
    const plan = (routeId: string, key = principal) => admission.plan({requestId:'request',attemptId:'attempt',principal:key,routeId,serviceId:null,upstreamId:'up',url:'http://example.test',model:'m',now:Date.now()},control.policy!().value,null);
    // No follow-up (connection lost), or rejected scope write, leaves no authority.
    expect(plan('s').denial).toMatchObject({status:403});
    expect((await invoke('keyPolicy','PUT','/keys/'+issued.key.id,{routes:['missing'],models:null})).status).toBe(422);
    expect(plan('r').denial).toMatchObject({status:403});
    expect(plan('s').denial).toMatchObject({status:403});
    expect((await invoke('keyPolicy', 'PUT', '/keys/'+issued.key.id, {routes: ['r'], models: ['m']})).status).toBe(200);
    expect(plan('r').denial).toBeUndefined();
    expect(plan('s').denial).toMatchObject({status:403});
    expect((await invoke('credential', 'DELETE', '/credentials/'+issued.key.id)).status).toBe(200);
    expect((await verifyDataPrincipal(principal, state))).toBe(false);
    expect((await (await invoke('credentials','GET','/credentials')).json()).keys).toHaveLength(0);
    expect(await secretStore.get('credential:'+issued.key.id)).toBeNull();
    expect((await invoke('credential','GET','/credentials/'+issued.key.id)).status).toBe(404);
    expect((await invoke('credential','DELETE','/credentials/'+issued.key.id)).status).toBe(200);

    expect((await readAdmissionRequirements(state))).toEqual(['r','s']);
    const writeSecret = secretStore.compareAndSet;
    secretStore.compareAndSet = async () => {throw Error('storage down');};
    expect((await invoke('credentials','POST','/credentials',{name:'must not create'})).status).toBe(503);
    expect((await (await invoke('credentials','GET','/credentials')).json()).keys).toHaveLength(0);
    secretStore.compareAndSet = writeSecret;
    fail = true;
    const pending = await invoke('credentials', 'POST', '/credentials', {name: 'pending'});
    expect(pending.status).toBe(503); const saved = await pending.json();
    expect(saved).toMatchObject({persisted: true, ready: false, published: false}); expect(saved.token).toMatch(/^bng_data_/);
    expect(plan('s',{domain:'data',keyId:saved.key.id,credentialVersion:1}).denial).toMatchObject({status:403});
    const routes = await (await invoke('routeProtection', 'GET', '/routes')).json(); expect(routes.ready).toBe(false);
    const policyPending = await invoke('keyPolicy', 'PUT', '/keys/'+saved.key.id, {routes: null, models: null});
    expect(await policyPending.json()).toMatchObject({active: false, published: false});
    fail = false;
    expect((await invoke('routeProtection', 'PUT', '/routes', {protectedRouteIds: ['r', 's']})).status).toBe(200);
    expect((await (await invoke('routeProtection', 'GET', '/routes')).json()).ready).toBe(true);
    const stored = await secretStore.get('credential:'+saved.key.id); await secretStore.delete('credential:'+saved.key.id,stored!.version);
    expect((await invoke('credential','GET','/credentials/'+saved.key.id)).status).toBe(409);
    expect((await verifyDataPrincipal({domain:'data',keyId:saved.key.id,credentialVersion:1},state))).toBe(true);
    const cleanupKey = await (await invoke('credentials','POST','/credentials',{name:'cleanup failure'})).json();
    const removeSecret = secretStore.delete;
    secretStore.delete = async () => {throw Error('storage down');};
    const cleanup = await invoke('credential','DELETE','/credentials/'+cleanupKey.key.id);
    expect(cleanup.status).toBe(503);
    expect(await cleanup.json()).toMatchObject({deleted:true,persisted:true,published:true,ready:true,error:'key_secret_cleanup_pending'});
    expect((await invoke('credential','GET','/credentials/'+cleanupKey.key.id)).status).toBe(404);
    expect((await verifyDataPrincipal({domain:'data',keyId:cleanupKey.key.id,credentialVersion:1},state))).toBe(false);
    secretStore.delete = removeSecret;
    expect((await invoke('credential','DELETE','/credentials/'+cleanupKey.key.id)).status).toBe(200);
    expect(await secretStore.get('credential:'+cleanupKey.key.id)).toBeNull();


  } finally {await control.dispose(); db.close();}
});

test('public access changes preserve explicit and arbitrary Key grants, including expired keys', async () => {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  const credential = (id:string, expiresAt:number|null) => ({id,domain:'data',name:id,prefix:'bng_data_',digest:'a'.repeat(64),createdAt:1,expiresAt,revokedAt:null,credentialVersion:1});
  (await state.transact([{key:'policies',expectedVersion:0,value:{protectedRouteIds:['r','s'],credentials:[credential('expired',1),credential('any',null)],byKey:{expired:{routes:['r'],models:[]},any:{routes:null,models:null}}}}]));
  let publications = 0;
  const host = {signal:new AbortController().signal,durableState:state,validateRouteReferences:()=>true,validateKeyPolicyReferences:()=>true,publishPolicy:async()=>{publications++;}} as unknown as ControlHostContext;
  const control = createControl(host);
  const invoke = (handler:string, method:string, path:string, body?:unknown) => control.api.find(api=>api.handler===handler)!.invoke({...host,requestSignal:host.signal,request:new Request('http://localhost'+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})})});
  try {
    await control.start();
    const read = await (await invoke('routeProtection','GET','/routes')).json();
    expect(read.routeKeyBindings.r.map((key:any)=>key.id)).toEqual(['expired','any']);
    expect(read.routeKeyBindings.s.map((key:any)=>key.id)).toEqual(['any']);
    const version = (await state.get('policies'))!.version;
    const before = (await state.get('policies'))!.value as any;
    const opened = await invoke('routeProtection','PUT','/routes',{protectedRouteIds:[]});
    expect(opened.status).toBe(200);
    expect((await opened.json()).routeKeyBindings.r.map((key:any)=>key.id)).toEqual(['expired','any']);
    expect((await state.get('policies'))!.version).toBe(version+1); expect(publications).toBe(2);
    expect((await readAdmissionRequirements(state))).toEqual([]);
    expect(((await state.get('policies'))!.value as any).byKey).toEqual(before.byKey);
    expect(((await state.get('policies'))!.value as any).credentials).toEqual(before.credentials);
    // Independent concurrent writes preserve both the Key scope and public access choice.
    await invoke('routeProtection','PUT','/routes',{protectedRouteIds:['r']});
    const results = await Promise.all([invoke('keyPolicy','PUT','/keys/any',{routes:['s'],models:null}),invoke('routeProtection','PUT','/routes',{protectedRouteIds:[]})]);
    expect(results.map(result=>result.status)).toEqual([200,200]);
    expect((await readAdmissionRequirements(state))).toEqual([]);
    expect(((await state.get('policies'))!.value as any).byKey.any).toEqual({routes:['s'],models:null});
  } finally {await control.dispose();db.close();}
});

test('quick route binding preserves public access and existing scopes, including legacy protect requests', async () => {
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  const credential = (id:string) => ({id,domain:'data',name:id,prefix:'bng_data_',digest:'a'.repeat(64),createdAt:1,expiresAt:null,revokedAt:null,credentialVersion:1});
  (await state.transact([{key:'policies',expectedVersion:0,value:{protectedRouteIds:['r'],credentials:[credential('one'),credential('any')],byKey:{one:{routes:['r'],models:['gpt-*']},any:{routes:null,models:[]}}}}]));
  let fail = false;
  const host = {signal:new AbortController().signal,durableState:state,validateRouteReferences:(ids:string[])=>ids.every(id=>['r','s','t'].includes(id)),validateKeyPolicyReferences:()=>true,publishPolicy:async()=>{if(fail)throw Error('offline');}} as unknown as ControlHostContext;
  const control = createControl(host);
  const apply = (keyId:string,routeId:string,protect?:boolean) => control.api.find(api=>api.handler==='applyRouteKey')!.invoke({...host,requestSignal:host.signal,request:new Request('http://localhost/route-key',{method:'PUT',body:JSON.stringify({keyId,routeId,protect})})});
  const value = async () => (await state.get('policies'))!.value as any;
  try {
    await control.start(); const version = (await state.get('policies'))!.version;
    expect((await apply('missing','s',true)).status).toBe(404);
    expect((await apply('one','missing',true)).status).toBe(422);
    expect((await state.get('policies'))!.version).toBe(version);
    expect((await apply('one','s',true)).status).toBe(200);
    expect((await value()).byKey.one).toEqual({routes:['r','s'],models:['gpt-*']});
    expect((await value()).protectedRouteIds).toEqual(['r']);
    expect((await state.get('policies'))!.version).toBe(version+1);
    expect((await apply('one','s')).status).toBe(200);
    expect((await value()).protectedRouteIds).toEqual(['r']);
    expect((await value()).byKey.one.routes).toEqual(['r','s']);
    expect((await apply('any','s')).status).toBe(200);
    expect((await value()).byKey.any).toEqual({routes:null,models:[]});
    expect((await value()).protectedRouteIds).toEqual(['r']);
    const bindings = (await (await control.api.find(api=>api.handler==='routeProtection')!.invoke({...host,requestSignal:host.signal,request:new Request('http://localhost/routes')})).json()).routeKeyBindings;
    expect(bindings.s.map((key:any)=>key.id)).toEqual(['one','any']);
    fail = true;
    const pending = await apply('one','t',true);
    expect(pending.status).toBe(503); expect(await pending.json()).toMatchObject({persisted:true,ready:false});
    expect((await value()).protectedRouteIds).toEqual(['r']);
    expect((await value()).byKey.one.routes).toEqual(['r','s','t']);
  } finally {await control.dispose();db.close();}
});

test('unrestricted grants are returned for public routes with no explicit bindings',async()=>{
  const db = new Database(':memory:'); db.exec(PLUGIN_DURABLE_STATE_SCHEMA_SQL);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  (await state.transact([{key:'policies',expectedVersion:0,value:{protectedRouteIds:[],credentials:[{id:'any',domain:'data',name:'any',prefix:'bng_data_',digest:'a'.repeat(64),createdAt:1,expiresAt:null,revokedAt:null,credentialVersion:1}],byKey:{any:{routes:null,models:null}}}}]));
  const host = {signal:new AbortController().signal,durableState:state,validateRouteReferences:()=>true,validateKeyPolicyReferences:()=>true,publishPolicy:async()=>{}} as unknown as ControlHostContext;
  const control = createControl(host);
  const invoke = (handler:string,method:string,body?:unknown) => control.api.find(api=>api.handler===handler)!.invoke({...host,requestSignal:host.signal,request:new Request('http://localhost/routes',{method,...(body===undefined?{}:{body:JSON.stringify(body)})})});
  try {
    await control.start();
    const expectAccess = async(response:Response) => {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({protectedRouteIds:[],routeKeyBindings:{},unrestrictedKeyIds:['any']});
    };
    await expectAccess(await invoke('routeProtection','GET'));
    await expectAccess(await invoke('applyRouteKey','PUT',{routeId:'public',keyId:'any'}));
    await expectAccess(await invoke('routeProtection','GET'));
    expect(((await state.get('policies'))!.value as any).byKey.any).toEqual({routes:null,models:null});
  } finally {await control.dispose();db.close();}
});

test('credential names are unique for concurrent creates and renames, excluding the current key', async () => {
  const db = new Database(':memory:'); initializePluginStateDatabase(db);
  const state = new PluginDurableStateStore(db).forNamespace('key-access');
  const host = {signal:new AbortController().signal,durableState:state,secretStore:createSecretStore(db,'key-access',{keyId:'test',key:new Uint8Array(32).fill(8)}),validateKeyPolicyReferences:()=>true,publishPolicy:async()=>{}} as unknown as ControlHostContext;
  const control = createControl(host);
  const invoke = (method:string, id:string|null, body?:unknown) => control.api.find(api=>api.handler===(id ? 'credential' : 'credentials'))!.invoke({...host,requestSignal:host.signal,request:new Request('http://localhost/credentials'+(id ? '/'+id : ''),{method,...(body===undefined?{}:{body:JSON.stringify(body)})})});
  try {
    await control.start();
    const results = await Promise.all([invoke('POST',null,{name:'应用'}),invoke('POST',null,{name:' 应用 '})]);
    expect(results.map(r=>r.status)).toEqual([201,409]);
    expect(await results[1]!.json()).toEqual({error:'key_name_exists'});
    const first = (await results[0]!.json()).key;
    const second = (await (await invoke('POST',null,{name:'另一个应用'})).json()).key;
    const before = (await state.get('policies'));
    expect((await invoke('PUT',second.id,{name:' 应用 ',routes:null,models:null})).status).toBe(409);
    expect((await state.get('policies'))).toEqual(before);
    expect((db.query('SELECT COUNT(*) AS count FROM secret_store_objects').get() as {count:number}).count).toBe(2);
    expect((await invoke('PUT',first.id,{name:' 应用 ',routes:[],models:null})).status).toBe(200);
    expect((await invoke('DELETE',first.id)).status).toBe(200);
    expect((await invoke('PUT',second.id,{name:'应用',routes:[],models:null})).status).toBe(200);
    const concurrent = await Promise.all([invoke('PUT',second.id,{name:'新名称',routes:[],models:null}),invoke('POST',null,{name:'新名称'})]);
    expect(concurrent.map(r=>r.status)).toEqual([200,409]);
  } finally {await control.dispose();db.close();}
});

test('real PluginStateClient deeply frozen publications support second create, update, grant and delete',async()=>{
  const {PluginStateClient}=await import('../../../../packages/core/src/plugin-state/client');
  const client=await PluginStateClient.open(':memory:',{initialize:true,material:{keyId:'actual',key:new Uint8Array(32).fill(8)}});
  const state=client.durableState('key-access');
  const host={durableState:state,secretStore:client.secretStore('key-access'),signal:new AbortController().signal,
    validateRouteReferences:()=>true,validateKeyPolicyReferences:()=>true,publishPolicy:async()=>{}} as unknown as ControlHostContext;
  const control=createControl(host);
  const invoke=(handler:string,method:string,path:string,value?:unknown)=>control.api.find(api=>api.handler===handler)!.invoke({...host,requestSignal:host.signal,
    request:new Request('http://localhost'+path,{method,...(value===undefined?{}:{body:JSON.stringify(value)})})});
  try{
    await control.start();
    const first=await invoke('credentials','POST','/credentials',{name:'first'});expect(first.status).toBe(201);const issued=await first.json();
    const frozen=(await state.get('policies'))!;expect(Object.isFrozen(frozen.value)).toBe(true);
    expect(Object.isFrozen((frozen.value as any).credentials[0])).toBe(true);expect(Object.isFrozen((frozen.value as any).byKey)).toBe(true);
    expect((await invoke('credentials','POST','/credentials',{name:'second'})).status).toBe(201);
    expect((await invoke('credential','PUT','/credentials/'+issued.key.id,{name:'updated',routes:['r'],models:null})).status).toBe(200);
    expect((await invoke('keyPolicy','PUT','/keys/'+issued.key.id,{routes:['r','s'],models:['gpt-*']})).status).toBe(200);
    expect((await invoke('routeProtection','PUT','/routes',{protectedRouteIds:['r']})).status).toBe(200);
    expect((await invoke('credential','DELETE','/credentials/'+issued.key.id)).status).toBe(200);
    expect((await (await invoke('credentials','GET','/credentials')).json()).keys).toHaveLength(1);
    expect((frozen.value as any).credentials[0].name).toBe('first');expect((frozen.value as any).byKey[issued.key.id].routes).toEqual([]);
    expect(await host.secretStore.get('credential:'+issued.key.id)).toBeNull();
  }finally{await control.dispose();await client.close();}
});
