import { afterAll as afterDataPlaneTests } from 'bun:test';
import { createDataPlaneRuntime } from '../helpers/data-plane-runtime';
const dataPlaneRuntime = await createDataPlaneRuntime();
import {afterEach,expect,test} from 'bun:test';
const { ScopedPluginRegistry, setScopedPluginRegistry, getScopedPluginRegistry } = await import('../../src/scoped-plugin-registry');
const { handleRequest } = await import('../../src/worker/request/handler');
const { createIngress } = await import('../../../../plugins/key-access/server/policy');
const { ANONYMOUS_PRINCIPAL } = await import('../../src/plugin-extensions');
const originalFetch=globalThis.fetch,previous=getScopedPluginRegistry();
afterEach(()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);});
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
const path=new URL('../fixtures/dispatch-plugin.ts',import.meta.url).pathname;
const plugin=(mark:string,target?:any)=>({name:'dispatch-fixture',path,options:{mark,target}});
for(const type of ['route','service'] as const) for(const trailing of [false,true]) test(`one native request dispatches to ${type} with final scoped plugins (${trailing?'trailing slash':'plain prefix'})`,async()=>{
  const config:any={routes:[{id:'entry',path:trailing?'/codex/':'/codex',path_rewrite:{'^/codex':'/backend-api/codex'},plugins:[plugin('entry',{type,id:type==='route'?'target':'service-target'})],endpoints:[{id:'old',target:'http://old.test'}]},
    {id:'target',path:trailing?'/target/':'/target',plugins:[plugin('route')],endpoints:[{id:'target-up',target:'http://route.test',plugins:[plugin('upstream')]}]}],
    services:[{id:'service-target',name:'service',plugins:[plugin('service')],endpoints:[{id:'service-up',target:'http://service.test',plugins:[plugin('upstream')]}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const {initializeRuntimeState,runtimeState}=await import('../../src/worker/state/runtime-state');
  initializeRuntimeState(config);
  const seen:any[]=[];globalThis.fetch=Object.assign(async(input:any,init:any)=>{seen.push({url:String(input),headers:new Headers(init.headers),body:JSON.parse(await new Response(init.body).text())});return Response.json({object:'response',id:'r',output:[]});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'alias',input:'hello',target:{type:'route',id:'evil'}})}),config,{logging});
    expect(response.status).toBe(200);await response.text();expect(seen).toHaveLength(1);expect(seen[0].body.model).toBe('actual');
    expect(seen[0].url).toContain(type==='route'?'route.test/target/responses':'service.test/responses');
    expect(seen[0].headers.get('x-upstream')).toBe('yes');expect(seen[0].headers.get(type==='route'?'x-route':'x-service')).toBe('yes');
    expect(seen[0].headers.get('x-entry')).toBe(type==='route'?null:'yes');
  }finally{runtimeState.clear();await registry.destroy();}
});
test('dispatch annotations cross route, service and replacement upstream contexts with frozen independent failover attempts',async()=>{
  const {initializeRuntimeState,runtimeState}=await import('../../src/worker/state/runtime-state');
  const key=`dispatch-annotations-${crypto.randomUUID()}`;
  const state={before:[] as any[],attempts:[] as any[],validations:[] as any[],frozen:[] as boolean[][],mutations:[] as boolean[]};
  (globalThis as any)[key]=state;
  const scoped=(mark:string,target?:any)=>({...plugin(mark,target),options:{mark,target,key}});
  const config:any={routes:[
    {id:'entry',path:'/entry',plugins:[scoped('entry',{type:'route',id:'target'})],endpoints:[{target:'http://unused.test'}]},
    {id:'target',path:'/target',service_references:[{id:'ref-'+('annotation-service'),service_id:'annotation-service',position:0,weight:100,priority:1,is_disabled:false}],plugins:[scoped('route')]}],
    services:[{id:'annotation-service', name:'annotation-service',plugins:[scoped('service')],failover:{enabled:true,retry_on:[503]},endpoints:[
      {id:'primary',target:'http://primary.test',priority:0,plugins:[scoped('upstream')]},
      {id:'secondary',target:'http://secondary.test',priority:1,plugins:[scoped('upstream')]}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);
  expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);initializeRuntimeState(config);
  const fetched:string[]=[];
  globalThis.fetch=Object.assign(async(input:any)=>{fetched.push(String(input));return Response.json({ok:true},{status:String(input).includes('primary.test')?503:200});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/entry/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'alias',input:'hello'})}),config,{logging});
    expect(response.status).toBe(200);await response.text();expect(fetched).toHaveLength(2);
    expect(state.before.map(record=>record.mark)).toEqual(['route','service','upstream','upstream']);
    expect(state.before[0].annotations).toEqual({trace:{stages:['dispatch'],detail:{value:'baseline'}}});
    expect(state.before[1].annotations.trace.stages).toEqual(['dispatch','route:before','route:intercept']);
    expect(state.attempts).toEqual([{upstreamId:'primary',value:'baseline'},{upstreamId:'secondary',value:'baseline'}]);
    expect(state.validations).toHaveLength(2);
    for(const [index,context] of state.validations.entries()){
      expect(context.annotations.trace.stages).toEqual(['dispatch','route:before','route:intercept','service:before','service:intercept','upstream:before','upstream:intercept']);
      expect(context.annotations.trace.detail.value).toBe(index===0?'primary':'secondary');
    }
    expect(state.validations[0].annotations).not.toBe(state.validations[1].annotations);
    expect(state.frozen).toEqual([Array(5).fill(true),Array(5).fill(true)]);expect(state.mutations).toEqual([false,false]);
  }finally{runtimeState.clear();await registry.destroy();delete (globalThis as any)[key];}
});
test('key admission checks and pins both protected route scopes without a second plan',()=>{
  const ingress=createIngress();const principal={domain:'data',keyId:'k',credentialVersion:1};
  const publication:any={protectedRouteIds:['entry','target'],byKey:{k:{routes:['entry'],models:null}},credentials:[{...principal,id:'k',digest:'0'.repeat(64),expiresAt:null,revokedAt:null}]};
  const target:any={requestId:'r',attemptId:'a',entryRouteId:'entry',routeId:'target',serviceId:null,upstreamId:'u',url:'http://up/responses',model:'m',now:1,principal};
  expect(ingress.plan(target,publication,null).denial?.status).toBe(403);
  publication.byKey.k.routes.push('target');const plan=ingress.plan(target,publication,null);expect(plan.denial).toBeUndefined();expect(ingress.beforeAttempt!({...target,entryRouteId:'other'},plan.snapshot!)).toMatchObject({status:403});
  publication.protectedRouteIds=['entry'];expect(ingress.resolveIdentity!(target,publication)).toEqual(principal);
  expect(()=>ingress.resolveIdentity!({...target,principal:ANONYMOUS_PRINCIPAL},publication)).toThrow('unauthorized');
});

test.each(['HEALTHY','HALF_OPEN'] as const)('a failed child Endpoint keeps one parent failover log chain (%s)',async(status)=>{
  const {initializeRuntimeState,runtimeState}=await import('../../src/worker/state/runtime-state');
  const references=['first','second'].map((service_id,position)=>({id:`ref-${service_id}`,service_id,position,weight:100,priority:position+1,is_disabled:false}));
  const config:any={routes:[{id:'entry',path:'/entry',service_references:references,failover:{enabled:true,retry_on:[503]}}],
    services:['first','second'].map(id=>({id,name:id,endpoints:[{id:`endpoint-${id}`,target:`http://${id}.test`}]}))};
  const registry=new ScopedPluginRegistry(import.meta.dir);await registry.initializeFromConfig(config);setScopedPluginRegistry(registry);initializeRuntimeState(config);
  runtimeState.get('first')!.upstreams[0].status=status;
  const rows:any[]=[];
  globalThis.fetch=Object.assign(async(input:any)=>{if(String(input).includes('first.test'))throw Object.assign(new Error('fixture refused'),{code:'ECONNREFUSED'});return Response.json({ok:true});},{preconnect(){}}) as any;
  try{
    let completion:Promise<unknown>|undefined;
    const response=await handleRequest(new Request('http://local/entry'),config,{logTransportType:'websocket',logging:{...logging,accessLogWriter:{...logging.accessLogWriter,write(row:any){rows.push(row);}}},onCompletion:value=>{completion=value;}});
    expect(response.status).toBe(200);await response.text();await completion;
    const completed=rows.filter(row=>row.protocolOutcome!==undefined);
    expect(completed.map(row=>[row.status,row.requestType])).toEqual([[503,status==='HALF_OPEN'?'recovery':'retry'],[200,'final']]);
    expect(rows.every(row=>row.transportType==='websocket')).toBe(true);
    expect(new Set(completed.map(row=>row.parentRequestId)).size).toBe(1);expect(completed.every(row=>row.isFailoverAttempt)).toBe(true);
  }finally{runtimeState.clear();await registry.destroy();}
});

afterDataPlaneTests(() => dataPlaneRuntime.close());
