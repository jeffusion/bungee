import {afterEach,expect,test} from 'bun:test';
import {ScopedPluginRegistry,setScopedPluginRegistry,getScopedPluginRegistry} from '../src/scoped-plugin-registry';
import {handleRequest} from '../src/worker/request/handler';
import {createIngress} from '../../../plugins/key-access/server/policy';
import {ANONYMOUS_PRINCIPAL} from '../src/plugin-extensions';
const originalFetch=globalThis.fetch,previous=getScopedPluginRegistry();
afterEach(()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);});
const logging={accessLogWriter:{write(){},updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{async write(){}}};
const path=new URL('./fixtures/dispatch-plugin.ts',import.meta.url).pathname;
const plugin=(mark:string,target?:any)=>({name:'dispatch-fixture',path,options:{mark,target}});
for(const type of ['route','service'] as const) test(`one native request dispatches to ${type} with final scoped plugins`,async()=>{
  const config:any={routes:[{id:'entry',path:'/codex',plugins:[plugin('entry',{type,id:'target'})],endpoints:[{id:'old',target:'http://old.test'}]},
    {id:'target',path:'/target',llm_protocol:'responses',plugins:[plugin('route')],endpoints:[{id:'target-up',target:'http://route.test',plugins:[plugin('upstream')]}]}],
    services:[{id:'target',name:'service',llm_protocol:'responses',plugins:[plugin('service')],endpoints:[{id:'service-up',target:'http://service.test',plugins:[plugin('upstream')]}]}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const seen:any[]=[];globalThis.fetch=Object.assign(async(input:any,init:any)=>{seen.push({url:String(input),headers:new Headers(init.headers),body:JSON.parse(await new Response(init.body).text())});return Response.json({object:'response',id:'r',output:[]});},{preconnect(){}}) as any;
  try{
    const response=await handleRequest(new Request('http://local/codex/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'alias',input:'hello',target:{type:'route',id:'evil'}})}),config,{logging});
    expect(response.status).toBe(200);await response.text();expect(seen).toHaveLength(1);expect(seen[0].body.model).toBe('actual');
    expect(seen[0].url).toContain(type==='route'?'route.test/target/responses':'service.test/codex/responses');
    expect(seen[0].headers.get('x-upstream')).toBe('yes');expect(seen[0].headers.get(type==='route'?'x-route':'x-service')).toBe('yes');
    expect(seen[0].headers.get('x-entry')).toBe(type==='route'?null:'yes');
  }finally{await registry.destroy();}
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
