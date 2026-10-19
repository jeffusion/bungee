import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginStateClient} from '../../../../packages/core/src/plugin-state/client';
import {STATEFUL_INTEGRATION_TEST_TIMEOUT_MS} from '../../../../packages/core/tests/helpers/test-budgets';
import {createControl,recoverIdentity} from '../../server/control';

test('parallel cookie requests make progress against the real asynchronous state worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'user-auth-worker-'));
 const state=await PluginStateClient.open(join(dir,'plugin-state.db'),{initialize:true});
 const durableState=state.durableState('user-auth'),password='Worker concurrency password 2026';
 const control=createControl({signal:new AbortController().signal,durableState,storage:{} as never,secretStore:{} as never});
 try {
  await recoverIdentity({operation:'reset',username:'admin',password,passwordConfirmation:password,reason:'Test fixture'},{durableState});
  await control.start();
  const logged=await control.login(new Request('http://localhost/api/auth/login',{method:'POST',headers:{origin:'http://localhost'},body:JSON.stringify({username:'admin',password})}));
  expect(logged.status).toBe(200);
  const cookie=logged.headers.get('set-cookie')!.split(';')[0]!;
  await Promise.all(Array.from({length:24},async()=>{
   const request=new Request('http://localhost/api/auth/verify',{headers:{cookie}});
   const subject=await control.authenticate(request);expect(subject).not.toBeNull();
   expect(await control.authorize(subject!,'config.read')).toBe(true);
   expect(await control.sessionCookie(request)).toContain('bungee_user_session=');
  }));
  await control.revokeSessions();
  expect(await control.authenticate(new Request('http://localhost/api/auth/verify',{headers:{cookie}}))).toBeNull();
 } finally {control.dispose();await state.close();await rm(dir,{recursive:true,force:true});}
},STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);

test('provider connections, verified identities and sessions survive a real storage worker restart', async () => {
 const {loginProvider} = await import('../fixtures/login-provider');
 const {PUBLIC_ORIGIN, request} = await import('../helpers/auth-fixture');
 const dir = await mkdtemp(join(tmpdir(),'user-auth-provider-worker-'));
 const path = join(dir,'plugin-state.db'), material = {keyId:'fixture-key',key:new Uint8Array(32).fill(7)};
 let state = await PluginStateClient.open(path,{initialize:true,material});
 const providers = [loginProvider('google'),loginProvider('microsoft'),loginProvider('github')];
 const transport = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input), provider = providers.find(item=>url.startsWith(item.authority)) ?? providers[2]!;
  return provider.transport(input,init);
 };
 const host = () => ({signal:new AbortController().signal,managementOrigin:PUBLIC_ORIGIN,durableState:state.durableState('user-auth'),secretStore:state.secretStore('user-auth'),storage:{} as never});
 let context = host(), control = createControl(context,{fetch:transport});
 const password = 'Worker restart password';
 const call = async (token:string,path:string,method='GET',body?:unknown) => {
  const req=request(path,method,body,{authorization:'Bearer '+token}), subject=await control.authenticate(req);
  const handler=control.api.find(item=>item.path===path && item.methods.includes(method))!;
  return handler.invoke({...context,request:req,requestSignal:req.signal,subject:subject??undefined});
 };
 try {
  await recoverIdentity({operation:'reset',username:'admin',password,passwordConfirmation:password,reason:'Worker fixture'},{durableState:context.durableState});
  await control.start();
  const login=await control.login(request('/login','POST',{username:'admin',password,transport:'bearer'}));
  const owner=(await login.json() as {token:string}).token;
  const settings=await(await call(owner,'/login-settings')).json() as {version:number};
  expect((await call(owner,'/login-settings','PUT',{version:settings.version,autoCreateUsers:true})).status).toBe(200);
  const cookies:string[]=[]; const ids:string[]=[];
  for (const [index,provider] of providers.entries()) {
   const kind=['google','microsoft','github'][index]!;
   const saved=await call(owner,'/login-connections','POST',{id:crypto.randomUUID(),label:kind,provider:kind,clientId:'provider-client',clientSecret:'provider-secret',enabled:true,configuration:kind==='microsoft'?{accountType:'common'}:{}});
   expect(saved.status).toBe(201);const connection=(await saved.json() as {connection:{id:string}}).connection;ids.push(connection.id);
   const start=await control.beginLogin(request('/start','POST',{methodId:connection.id},{origin:PUBLIC_ORIGIN}));
   const flow=await start.json() as {authorizationUrl:string};
   const completed=await control.completeLogin(new Request(provider.authorize(flow.authorizationUrl),{headers:{cookie:start.headers.get('set-cookie')!.split(';')[0]!}}));
   expect(completed.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/');
   cookies.push(completed.headers.getSetCookie().find(value=>value.startsWith('bungee_user_session='))!.split(';')[0]!);
  }
  const manual={id:crypto.randomUUID(),label:'Manual',provider:'oidc',clientId:'manual-client',clientSecret:'manual-secret',configuration:{mode:'manual',issuer:'https://custom.example',authorizationEndpoint:'https://custom.example/auth',tokenEndpoint:'https://custom.example/token',jwksUri:'https://custom.example/keys'}};
  expect((await call(owner,'/login-connections','POST',manual)).status).toBe(201);
  control.dispose();await state.close();
  state=await PluginStateClient.open(path,{material});context=host();control=createControl(context,{fetch:transport});await control.start();
  const stored=await(await call(owner,'/login-connections')).json() as {connections:{id:string;provider:string;hasSecret:boolean;version:number;configuration:unknown}[]};
  expect(stored.connections.map(item=>item.provider).sort()).toEqual(['github','google','microsoft','oidc']);
  expect(stored.connections.every(item=>item.hasSecret)).toBe(true);
  expect(stored.connections.find(item=>item.id===manual.id)!.configuration).toEqual(manual.configuration);
  const identities=await(await call(owner,'/identities')).json() as {identities:{issuer:string;protocol:string}[]};
  expect(identities.identities).toHaveLength(3);
  expect(identities.identities).toContainEqual(expect.objectContaining({issuer:'https://github.com',protocol:'oauth2'}));
  for (const cookie of cookies) expect(await control.authenticate(request('/verify','GET',undefined,{cookie}))).not.toBeNull();
  const ms=stored.connections.find(item=>item.provider==='microsoft')!;
  expect((await call(owner,'/login-connections','PUT',{id:ms.id,version:ms.version,label:'microsoft',provider:'microsoft',clientId:'provider-client',enabled:false,configuration:ms.configuration})).status).toBe(200);
  expect(await control.authenticate(request('/verify','GET',undefined,{cookie:cookies[1]!}))).toBeNull();
  for (const index of [0,2]) expect(await control.authenticate(request('/verify','GET',undefined,{cookie:cookies[index]!}))).not.toBeNull();
 } finally {control.dispose();await state.close();await rm(dir,{recursive:true,force:true});}
},STATEFUL_INTEGRATION_TEST_TIMEOUT_MS);
