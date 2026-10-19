import {expect,test} from 'bun:test';
import {createConfigControlApi,type ConfigControlApiOptions} from '../../src/master-runtime/control-api';
import {ManagementAuthentication,validateManagementTransition} from '../../src/master-runtime/management-auth';
import {ConfigRepositoryError,hashConfigurationContent,type ManagementProtection,type CommitConfigurationResult,type RepositorySnapshot} from '../../src/config-storage';
import type {ConfigurationAggregate} from '@jeffusion/bungee-types';
import type {PluginControlHost} from '../../src/plugin-control';
import type {ManagementProvider} from '../../src/plugin-extensions';
const initial:ConfigurationAggregate={logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[]};
const protectedAggregate={...initial,plugin_activations:[{plugin_name:'user-auth'}]};
const mutationId='9d63fe14-f3ea-4465-a2bb-66ef46f0b1df';
const req=(path:string,body?:unknown,method=body===undefined?'GET':'POST')=>new Request('http://localhost'+path,{method,headers:{origin:'http://localhost','x-bungee-auth-provider':'user-auth'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const put=(expected_revision=1)=>req('/api/config',{aggregate:protectedAggregate,expected_revision,mutation_id:mutationId},'PUT');
function fixture() {
 let current:RepositorySnapshot={aggregate:initial,revision:1,content_hash:hashConfigurationContent(initial)};
 let durable=current,guard:ManagementProtection={required:false,selectedProvider:null,generation:0},durableGuard=guard;
 const provider:ManagementProvider={setupStatus:async()=> 'uninitialized',initialize:async()=>Response.json({initialized:true}),authenticate:async()=>null,authorize:async()=>true,login:async()=>Response.json({}),logout:async()=>Response.json({}),bootstrap:async()=>{},hasIdentity:async()=>false,revokeSessions:async()=>{}};
 let ready=false,deactivations=0;
 const host={get:()=>ready ? {status:'ready',admission:true,control:{management:provider}}:undefined} as unknown as PluginControlHost;
 const auth=new ManagementAuthentication(host,()=>current.aggregate,new Set(['user-auth']),undefined,()=>guard);
 const committedRevisions:number[]=[];
 const commands:Parameters<ConfigControlApiOptions['repository']['commit']>[0][]=[];
 const operation={mutation_id:mutationId,committed_revision:2,state:'committed'} as any;
 let commit:(command:typeof commands[number])=>Promise<CommitConfigurationResult>=async()=>({kind:'committed',operation,snapshot:durable});
 let refreshFails=false;
 const options:ConfigControlApiOptions={repository:{getSnapshot:()=>current,
  refreshControlProjection:async()=>{if(refreshFails)throw Error('storage unavailable');current=durable;guard=durableGuard;return{snapshot:current,managementProtection:guard};},
  getOperationState:async()=>({operation,workers:[]}) as any,getActivePublication:async()=>null,
  commit:async command=>{commands.push(command);return commit(command);}},
  onConfigurationCommitted:async snapshot=>{committedRevisions.push(snapshot.revision);},
  managementAuth:auth,admission:{snapshot:()=>[]},workerCount:1,clock:{now:()=>100},resolveAuthToken:()=>null,
  parseAggregate:value=>({ok:true,value:value as ConfigurationAggregate}),publicationTasks:{enqueue(){}},isMutationReady:()=>true,
  validateManagementTransition:(request,active,next)=>validateManagementTransition(request,active,next,auth,host),
  pluginControlPreflight:{controlNames:new Set(['user-auth']),status:()=>ready?'ready':'stopped',activate:async()=>{ready=true;},deactivate:async()=>{ready=false;deactivations++;}},
 };
 const api=createConfigControlApi(options);
 return {api,auth,commands,provider,options,committedRevisions,
  advance:()=>{durable={...durable,revision:3};},
  commit:(handler:typeof commit)=>{commit=handler;},deactivations:()=>deactivations,current:()=>current,
  persist:()=>{durable={aggregate:protectedAggregate,revision:2,content_hash:hashConfigurationContent(protectedAggregate)};durableGuard={required:true,selectedProvider:'user-auth',generation:1};return durable;},
  ready:()=>{ready=true;},refreshFails:(value:boolean)=>{refreshFails=value;},
 };
}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

test('first protection closes anonymous admission before commit and invalidates older authenticated requests',async()=>{
 const f=fixture(),entered=deferred<void>(),finish=deferred<void>();
 const old=req('/api/config');await f.auth.authenticate(old);
 f.commit(async()=>{entered.resolve();await finish.promise;return{kind:'committed',operation:{} as any,snapshot:f.persist()};});
 const pending=f.api.handle(put());await entered.promise;
 expect(f.auth.identity(old)).toBeNull();expect((await f.api.handle(req('/api/config')))!.status).toBe(503);
 finish.resolve();expect((await pending)!.status).toBe(202);
 expect(await f.auth.recheck(old)).toBe(false);
 expect((await f.api.handle(req('/api/config')))!.status).toBe(401);
 expect(await (await f.api.handle(req('/api/auth/setup')))!.json()).toMatchObject({initialized:false,provider:{name:'user-auth'}});
});

test('unknown commit stays closed, reconciles only its original command and confirms current projection before reopening',async()=>{
 const f=fixture();let calls=0;
 f.commit(async()=>{calls++;if(calls===1){f.persist();throw new ConfigRepositoryError('result_unknown','lost acknowledgement');}
  if(calls===2)throw new ConfigRepositoryError('result_unknown','still unknown');
  return{kind:'duplicate',operation:{mutation_id:mutationId,committed_revision:2} as any};});
 expect((await f.api.handle(put()))!.status).toBe(503);
 expect(f.current().revision).toBe(1);expect(f.auth.available()).toBe(false);
 expect((await f.api.handle(req('/api/auth/setup')))!.status).toBe(503);expect(f.auth.available()).toBe(false);
 expect((await f.api.handle(req('/api/auth/setup')))!.status).toBe(200);
 expect(f.current().revision).toBe(2);expect(f.auth.selected()).toBe('user-auth');
 expect(f.commands).toHaveLength(3);expect(f.commands.every(command=>command===f.commands[0])).toBe(true);
 expect(f.deactivations()).toBe(0);
 expect((await f.api.handle(req('/api/config')))!.status).toBe(401);
});

test('acknowledged commit with failed projection refresh remains closed until exact-command reconciliation succeeds',async()=>{
 const f=fixture();let calls=0;
 f.commit(async()=>{calls++;const snapshot=f.persist();return calls===1?{kind:'committed',operation:{} as any,snapshot}:{kind:'duplicate',operation:{mutation_id:mutationId,committed_revision:2} as any};});
 f.refreshFails(true);expect((await f.api.handle(put()))!.status).toBe(503);
 expect(f.auth.available()).toBe(false);
 f.refreshFails(false);expect((await f.api.handle(req('/api/auth/setup')))!.status).toBe(200);
 expect(f.commands).toHaveLength(2);expect(f.auth.selected()).toBe('user-auth');
});

test('stale revision path uses the protection latch and unknown reconciliation too',async()=>{
 const f=fixture();f.ready();let calls=0;
 f.commit(async()=>{calls++;if(calls===1)throw new ConfigRepositoryError('result_unknown','unknown');return{kind:'stale_revision',expected_revision:2,active_revision:1};});
 expect((await f.api.handle(put(2)))!.status).toBe(503);expect(f.auth.available()).toBe(false);
 expect((await f.api.handle(req('/api/auth/mode')))!.status).toBe(200);
 expect(f.auth.selected()).toBeNull();expect(f.commands).toHaveLength(2);
});

test('confirmed rejection rolls back preflight and releases the latch without enabling protection',async()=>{
 const f=fixture();f.commit(async()=>({kind:'stale_revision',expected_revision:1,active_revision:1}));
 expect((await f.api.handle(put()))!.status).toBe(409);
 expect(f.deactivations()).toBe(1);expect(f.auth.available()).toBe(true);expect(f.auth.selected()).toBeNull();
});

test('preflight failure does not reach storage or leave an anonymous transition latch',async()=>{
 const f=fixture();const api=createConfigControlApi({...f.options,pluginControlPreflight:{controlNames:new Set(['user-auth']),activate:async()=>{throw Error('not prepared');},deactivate:async()=>{}}});
 expect((await api.handle(put()))!.status).toBe(503);expect(f.commands).toHaveLength(0);expect(f.auth.available()).toBe(true);
});


test('duplicate reconciliation uses the current pair and never publishes a historical snapshot to commit observers',async()=>{
 const f=fixture();let calls=0;
 f.commit(async()=>{calls++;if(calls===1){f.persist();f.advance();throw new ConfigRepositoryError('result_unknown','unknown');}
  return{kind:'duplicate',operation:{mutation_id:mutationId,committed_revision:2} as any};});
 expect((await f.api.handle(put()))!.status).toBe(503);
 expect((await f.api.handle(req('/api/auth/setup')))!.status).toBe(200);
 expect(f.current().revision).toBe(3);expect(f.committedRevisions).toEqual([3]);expect(f.auth.selected()).toBe('user-auth');
});

test('a management read already awaiting a plugin cannot return its response after the transition invalidates its identity',async()=>{
 const f=fixture(),entered=deferred<void>(),finish=deferred<void>();
 const api=createConfigControlApi({...f.options,statsApi:{matches:path=>path==='/api/stats',handle:async()=>{entered.resolve();await finish.promise;return Response.json({private:'must-not-escape'});}}});
 const pending=api.handle(req('/api/stats'));await entered.promise;
 const transition=f.auth.beginTransition(mutationId);finish.resolve();
 const response=await pending;expect(response!.status).toBe(401);expect(await response!.text()).not.toContain('must-not-escape');
 f.auth.completeTransition(transition);
});


test('an unreadable or missing authoritative guard cannot be treated as anonymous',async()=>{
 for(const getter of [()=>null as any,()=>undefined as any,()=>{throw Error('unavailable');}]) {
  const auth=new ManagementAuthentication({} as PluginControlHost,()=>initial,new Set(),undefined,getter);
  await expect(auth.authenticate(req('/api/config'))).rejects.toThrow();expect(auth.available()).toBe(false);
 }
});

test('production async client keeps the Host closed when its ACK projection refresh fails',async()=>{
 const {AsyncConfigRepository}=await import('../../src/config-storage/async-config-repository');
 let persisted=false,readFails=true;
 const protectedSnapshot={aggregate:protectedAggregate,revision:2,content_hash:hashConfigurationContent(protectedAggregate)};
 const guard={required:true,selectedProvider:'user-auth',generation:1};
 class Transport {
  listeners=new Map<string,((event:any)=>void)[]>();
  addEventListener(type:string,fn:(event:any)=>void){this.listeners.set(type,[...this.listeners.get(type)??[],fn]);}
  postMessage(message:any){queueMicrotask(()=>{
   let result:unknown;
   if(message.method==='open') result={snapshot:{aggregate:initial,revision:1,content_hash:hashConfigurationContent(initial)},managementProtection:{required:false,selectedProvider:null,generation:0},supervision:{}};
   else if(message.method==='commitPrepared'){result={kind:persisted?'duplicate':'committed',snapshot:protectedSnapshot,operation:{mutation_id:mutationId,committed_revision:2}};persisted=true;}
   else if(message.method==='getControlProjection') {
    if(readFails){this.emit({id:message.id,ok:false,error:{code:'repository_failure',message:'projection unavailable'}});return;}
    result={snapshot:protectedSnapshot,managementProtection:guard};
   }
   else if(message.method!=='close') throw Error('unexpected method');
   this.emit({id:message.id,ok:true,result});
  });}
  emit(data:any){for(const fn of this.listeners.get('message')??[])fn({data});}
  terminate(){}
 }
 const client=await AsyncConfigRepository.open('fixture',{workerFactory:()=>new Transport(),compileOptions:{pluginSchemas:new Map([['user-auth',[]]]),managementProviders:new Set(['user-auth'])}});
 const f=fixture();let ready=false;
 const host={get:()=>ready?{status:'ready',admission:true,control:{management:f.provider}}:null} as unknown as PluginControlHost;
 const auth=new ManagementAuthentication(host,()=>client.getSnapshot().aggregate,new Set(['user-auth']),undefined,()=>client.getManagementProtection());
 const api=createConfigControlApi({...f.options,managementAuth:auth,repository:{...f.options.repository,getSnapshot:()=>client.getSnapshot(),commit:command=>client.commit(command),refreshControlProjection:()=>client.refreshControlProjection()},
  pluginControlPreflight:{controlNames:new Set(['user-auth']),activate:async()=>{ready=true;},deactivate:async()=>{ready=false;}}});
 try {
  expect((await api.handle(put()))!.status).toBe(503);expect(persisted).toBe(true);
  expect(client.getSnapshot().revision).toBe(1);expect(auth.available()).toBe(false);
  expect((await api.handle(req('/api/config')))!.status).toBe(503);expect(auth.available()).toBe(false);
  readFails=false;
  expect((await api.handle(req('/api/config')))!.status).toBe(401);
  expect(client.getSnapshot().revision).toBe(2);expect(auth.selected()).toBe('user-auth');
 }finally{await client.close();}
});
