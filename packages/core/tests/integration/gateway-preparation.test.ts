import {afterAll,expect,test} from 'bun:test';
import {createDataPlaneRuntime} from '../helpers/data-plane-runtime';
const runtime=await createDataPlaneRuntime();
const {gatewayPreparationFixture}=await import('../helpers/gateway-preparation');
const {executeAuxiliaryRequest,auxiliaryCredentialIdentity}=await import('../../src/gateway/auxiliary-request');
afterAll(()=>runtime.close());
const auxiliary={target:{type:'route' as const,id:'aux'},protocol:'responses' as const,model:'relay-model',body:{input:'relay'}};

test('preparation follows access checks, runs once, and both calls have independent admission and settlement',async()=>{
  let auxiliaryId='';let parentId='';let resultIdentity:any;
  const env=gatewayPreparationFixture({credential:'Bearer fixture-upstream',prepare:async input=>{
    parentId=input.context.requestId;
    expect(env.operations.some(value=>value.operation==='inspect'&&value.target.routeId==='final')).toBe(true);
    const result=await input.executeAuxiliary(auxiliary);expect(result.kind).toBe('response');
    if(result.kind==='response'){
      auxiliaryId=result.requestId;resultIdentity=result.identity;
      const [first,second]=await Promise.all([result.bodyHandle.json(),result.bodyHandle.json()]);expect(first).toBe(second);
      expect(first).toMatchObject({output:'auxiliary value'});expect((await result.completion).status).toBe('completed');result.dispose();
    }
    input.context.body={model:'main-model',input:'prepared'};return {};
  }});
  try{const response=await env.send();expect(response.status).toBe(200);await response.text();
    expect(env.prepares).toBe(1);expect(env.dispatches).toBe(1);expect(env.calls.map(call=>call.body.model)).toEqual(['relay-model','main-model']);
    expect(env.calls[1].body.input).toBe('prepared');expect(auxiliaryId).not.toBe(parentId);expect(resultIdentity).toMatchObject({model:'relay-model',upstreamId:'aux-up'});
    expect(resultIdentity.scope).not.toContain('fixture-upstream');expect(env.budgets).toHaveLength(2);expect(new Set(env.budgets.map(value=>value.requestId)).size).toBe(2);
    expect(env.settlements).toHaveLength(2);expect(env.settlements.every(value=>value.sent&&value.outcome==='completed')).toBe(true);
  }finally{await env.close();}
});
for(const [name,options] of [['denied final',{deniedRoute:'final'}],['WS hard budget',{wsBudget:true}]] as const)test(`${name} prevents preparation and all upstream calls`,async()=>{
  const env=gatewayPreparationFixture({...options,prepare:async()=>{throw Error('must not prepare');}});
  try{const response=await env.send(options.wsBudget?'websocket':undefined);expect(response.status).toBe(options.wsBudget?422:403);await response.text();expect(env.prepares).toBe(0);expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);}finally{await env.close();}
});
test('undeclared target and denied auxiliary target cannot call network or final upstream',async()=>{
  for(const deniedRoute of [undefined,'aux']){
    const env=gatewayPreparationFixture({deniedRoute,prepare:async input=>{await input.executeAuxiliary({...auxiliary,target:{type:'route',id:deniedRoute?'aux':'unbound'}});return {};}});
    try{const response=await env.send();expect(response.status).toBe(403);await response.text();expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);}finally{await env.close();}
  }
});
test('reuse follows authorization and actual credential identity, and skips model budgets and network',async()=>{
  let reuseCount=0;
  const env=gatewayPreparationFixture({credential:'Bearer actual',prepare:async input=>{
    const result=await input.executeAuxiliary({...auxiliary,reuse:async identity=>{reuseCount++;expect(identity.scope).toBeTruthy();return {cached:'value'};}});
    expect(result).toMatchObject({kind:'reused',value:{cached:'value'}});return {};
  }});
  try{const response=await env.send();await response.text();expect(response.status).toBe(200);expect(reuseCount).toBe(1);expect(env.calls).toHaveLength(1);expect(env.budgets).toHaveLength(1);const settlement=env.settlements.find(value=>value.sent);if(!settlement)throw Error('missing sent settlement');expect(env.budgets[0].requestId).toBe(settlement.requestId);}finally{await env.close();}
});
test('client account metadata cannot establish a credential scope; null scope is explicit to the reuse consumer',async()=>{
  const headers=new Headers({authorization:'Bearer credential','account-id':'untrusted'});
  const first=auxiliaryCredentialIdentity(headers,'m','up');headers.set('account-id','other');expect(auxiliaryCredentialIdentity(headers,'m','up')).toEqual(first);
  expect(auxiliaryCredentialIdentity(new Headers({'account-id':'attacker'}),'m','up').scope).toBeNull();
  let reuse=0;const env=gatewayPreparationFixture({prepare:async input=>{
    const result=await input.executeAuxiliary({...auxiliary,reuse:async identity=>{reuse++;expect(identity.scope).toBeNull();return undefined;}});
    expect(result.kind).toBe('response');if(result.kind==='response'){await result.bodyHandle.json();await result.completion;result.dispose();}return {};
  }});
  try{await (await env.send()).text();expect(reuse).toBe(1);expect(env.calls).toHaveLength(2);}finally{await env.close();}
});
test('internal auxiliary recursion is rejected without executing any provider',async()=>{
  const env=gatewayPreparationFixture({prepare:async()=>({})});
  try{await expect(executeAuxiliaryRequest(env.request(),env.config,env.config.routes[0],{auxiliary:{target:auxiliary.target,onIdentity:async()=>false}},auxiliary,new AbortController().signal,[auxiliary.target])).rejects.toMatchObject({code:'auxiliary_recursion_forbidden'});expect(env.calls).toHaveLength(0);}finally{await env.close();}
});

test('auxiliary processing failure prevents the final upstream and releases the independent request',async()=>{
  const {DataAdmissionError}=await import('../../src/data-admission/errors');
  const {snapshotBodyResources}=await import('../../src/gateway/body-resources');
  const baseline=snapshotBodyResources().retainedBytes;
  const env=gatewayPreparationFixture({upstream:()=>Response.json({error:'provider rejected'},{status:502}),prepare:async input=>{
    const result=await input.executeAuxiliary(auxiliary);expect(result.kind).toBe('response');
    if(result.kind==='response'){try{expect(result.status).toBe(502);await result.bodyHandle.json();await result.completion;throw new DataAdmissionError(502,'auxiliary_provider_rejected');}finally{result.dispose();}}
    return {};
  }});
  try{const response=await env.send();expect(response.status).toBe(502);expect(await response.json()).toMatchObject({error:'auxiliary_provider_rejected'});
    expect(env.calls).toHaveLength(1);expect(env.settlements).toHaveLength(1);expect(env.operations.filter(value=>value.operation==='release')).toHaveLength(1);
    expect(snapshotBodyResources().retainedBytes).toBe(baseline);
  }finally{await env.close();}
});

test('disposing an unread auxiliary body cancels its completion and releases admission before failure returns',async()=>{
  const {DataAdmissionError}=await import('../../src/data-admission/errors');
  const env=gatewayPreparationFixture({prepare:async input=>{
    const result=await input.executeAuxiliary(auxiliary);expect(result.kind).toBe('response');
    if(result.kind==='response'){result.dispose();result.dispose();expect((await result.completion).status).toBe('cancelled');}
    throw new DataAdmissionError(422,'preparation_stopped');
  }});
  try{const response=await env.send();expect(response.status).toBe(422);await response.text();expect(env.calls).toHaveLength(1);expect(env.settlements).toHaveLength(1);expect(env.settlements[0]).toMatchObject({sent:true,outcome:'cancelled'});expect(env.operations.filter(value=>value.operation==='release')).toHaveLength(1);}finally{await env.close();}
});

test('an explicit aggregate signal keeps one shared auxiliary wire alive when its first parent cancels',async()=>{
  const {DataAdmissionError}=await import('../../src/data-admission/errors');
  const aggregate=new AbortController();const firstController=new AbortController();
  let openWire!:()=>void;let started!:()=>void;let joined!:()=>void;
  const auxiliaryStarted=new Promise<void>(resolve=>{started=resolve;});
  const secondJoined=new Promise<void>(resolve=>{joined=resolve;});
  let shared:Promise<unknown>|undefined;let waiters=0;let done=false;
  const env=gatewayPreparationFixture({credential:'Bearer shared-credential',upstream:request=>{
    if(new URL(request.url).pathname!='/responses')throw Error('unexpected path');
    if(env.calls.at(-1)?.body.model!=='relay-model')return Response.json({ok:true});
    return new Response(new ReadableStream<Uint8Array>({start(controller){
      controller.enqueue(new TextEncoder().encode('{"output":"'));
      openWire=()=>{controller.enqueue(new TextEncoder().encode('shared"}'));controller.close();};started();
    }}),{headers:{'content-type':'application/json'}});
  },prepare:async input=>{
    waiters++;if(waiters===2)joined();
    shared??=(async()=>{
      const result=await input.executeAuxiliary({...auxiliary,signal:aggregate.signal});
      if(result.kind!=='response')throw Error('unexpected reuse');
      try{const value=await result.bodyHandle.json();expect((await result.completion).status).toBe('completed');done=true;return value;}finally{result.dispose();}
    })();
    let abort!:()=>void;
    try{
      const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new DataAdmissionError(422,'waiter_cancelled'));input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();});
      const value=await Promise.race([shared,cancelled]);expect(value).toMatchObject({output:'shared'});return {};
    }finally{input.signal.removeEventListener('abort',abort);if(--waiters===0&&!done)aggregate.abort();}
  }});
  try{
    const first=env.send(undefined,firstController.signal);await auxiliaryStarted;
    const second=env.send();await secondJoined;firstController.abort('first waiter cancelled');
    const rejected=await first;expect(rejected.status).toBe(422);await rejected.text();expect(aggregate.signal.aborted).toBe(false);
    openWire();const successful=await second;expect(successful.status).toBe(200);await successful.text();
    expect(env.calls.filter(call=>call.body.model==='relay-model')).toHaveLength(1);expect(env.calls.filter(call=>call.body.model==='main-model')).toHaveLength(1);
    expect(env.budgets).toHaveLength(2);expect(env.settlements.every(value=>value.sent&&value.outcome==='completed')).toBe(true);
  }finally{aggregate.abort();await env.close();}
});

test('parent cancellation aborts a default auxiliary body, settles once, and prevents final upstream',async()=>{
  const {DataAdmissionError}=await import('../../src/data-admission/errors');
  const {snapshotBodyResources}=await import('../../src/gateway/body-resources');
  const baseline=snapshotBodyResources().retainedBytes;const controller=new AbortController();
  const env=gatewayPreparationFixture({upstream:()=>new Response(new ReadableStream<Uint8Array>({start(output){output.enqueue(new TextEncoder().encode('{"unfinished":'));}}),{headers:{'content-type':'application/json'}}),prepare:async input=>{
    const result=await input.executeAuxiliary(auxiliary);if(result.kind!=='response')throw Error('expected response');
    const read=result.bodyHandle.json();controller.abort('parent cancelled');await expect(read).rejects.toBeDefined();expect((await result.completion).status).toBe('cancelled');
    throw new DataAdmissionError(422,'parent_cancelled');
  }});
  try{const response=await env.send(undefined,controller.signal);expect(response.status).toBe(422);await response.text();
    expect(env.calls).toHaveLength(1);expect(env.settlements).toHaveLength(1);expect(env.settlements[0].outcome).toBe('cancelled');expect(env.operations.filter(value=>value.operation==='release')).toHaveLength(1);
    expect(snapshotBodyResources().retainedBytes).toBe(baseline);
  }finally{await env.close();}
});

test('a local preparation error leaves the final upstream health and active counters unchanged',async()=>{
  const {DataAdmissionError}=await import('../../src/data-admission/errors');
  const {runtimeState,getActiveRequestCount}=await import('../../src/worker/state/runtime-state');
  const previous=runtimeState.get('/final');
  const selected:any={upstream_id:'final-up',target:'http://unused.invalid',status:'HEALTHY',consecutive_failures:2,consecutive_successes:4,recovery_attempt_count:0};
  runtimeState.set('/final',{upstreams:[selected]});const before=structuredClone(selected);
  const env=gatewayPreparationFixture({prepare:async()=>{throw new DataAdmissionError(422,'invalid_preparation');}});
  try{const response=await env.send();expect(response.status).toBe(422);await response.text();expect(selected).toEqual(before);expect(getActiveRequestCount('/final','final-up')).toBe(0);expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);}finally{await env.close();if(previous)runtimeState.set('/final',previous);else runtimeState.delete('/final');}
});

test('native and managed credential scopes are stable across independently initialized workers',async()=>{
  const {credentialIdentityFromWorker}=await import('../helpers/gateway-preparation');
  const input={headers:{authorization:'Bearer fixture-high-entropy-credential'},model:'relay-model',upstreamId:'aux-up'};
  const local=auxiliaryCredentialIdentity(new Headers(input.headers),input.model,input.upstreamId);
  const workers=await Promise.all([credentialIdentityFromWorker(input),credentialIdentityFromWorker(input)]);
  expect(workers).toEqual([local,local]);expect(local.scope).not.toContain('fixture-high-entropy-credential');
  const managed={...input,headers:{},managedCredentials:['credential-value','trusted-account-binding']};
  const managedFirst=await credentialIdentityFromWorker(managed);
  const managedSecond=await credentialIdentityFromWorker({...managed,managedCredentials:[...managed.managedCredentials].reverse()});
  expect(managedFirst).toEqual(managedSecond);expect(managedFirst.scope).not.toBe(local.scope);
  expect(auxiliaryCredentialIdentity(new Headers({authorization:'Bearer other-credential'}),input.model,input.upstreamId).scope).not.toBe(local.scope);
  for(const header of ['chatgpt-account-id','openai-organization','openai-project']) {
    const account=auxiliaryCredentialIdentity(new Headers({...input.headers,[header]:'account-a'}),input.model,input.upstreamId);
    expect(account.scope).not.toBe(local.scope);
    expect(auxiliaryCredentialIdentity(new Headers({...input.headers,[header]:'account-b'}),input.model,input.upstreamId).scope).not.toBe(account.scope);
    expect(auxiliaryCredentialIdentity(new Headers({[header]:'account-a'}),input.model,input.upstreamId).scope).toBeNull();
  }
});

test.each([undefined,'websocket'] as const)('configured body logging preserves ingress type %s without auxiliary bodies or transport changes',async transport=>{
  const {flushBodyCaptures}=await import('../../src/logger/body-capture');
  const saved:{requestId:string;value:unknown;type:string}[]=[];const access:any[]=[];const files:any[]=[];
  const cipher='fixture-private-cipher';const payload='fixture-private-tool-arguments';let parentId='';
  const logging={bodyStorage:{async save(requestId:string,value:unknown,type:any){saved.push({requestId,value,type});return `body-${saved.length}`;}},
    accessLogWriter:{write(value:any){access.push(structuredClone(value));},updateResponseBodyId(){},updateProtocolOutcome(){},updateTransportOutcome(){}},
    fileLogWriter:{write(value:any){files.push(structuredClone(value));}}};
  const env=gatewayPreparationFixture({bodyLogging:true,logging,upstream:()=>env.calls.at(-1)?.body.model==='relay-model'
    ? Response.json({output:[{type:'function_call',arguments:payload}],usage:{input_tokens:2,output_tokens:3}}):Response.json({ordinary:'public response'}),prepare:async input=>{
      parentId=input.context.requestId;
      const result=await input.executeAuxiliary({...auxiliary,body:{input:cipher}});if(result.kind!=='response')throw Error('expected response');
      try{expect(await result.bodyHandle.json()).toMatchObject({output:[{arguments:payload}]});expect((await result.completion).status).toBe('completed');}finally{result.dispose();}return {};
    }});
  env.config.routes.find((route:any)=>route.id==='aux').websocket={enabled:true};
  try{const response=await env.send(transport);expect(response.status).toBe(200);await response.text();await flushBodyCaptures();
    expect(saved.length).toBeGreaterThan(0);expect(saved.some(value=>JSON.stringify(value.value).includes('hello'))).toBe(true);
    const auxiliaryAccess=access.filter(value=>value.parentRequestId===parentId);
    const auxiliaryFiles=files.filter(value=>value.parentRequestId===parentId);
    expect(auxiliaryAccess.length).toBeGreaterThan(0);expect(auxiliaryFiles.length).toBeGreaterThan(0);
    expect(access.length).toBeGreaterThan(auxiliaryAccess.length);expect(files.length).toBeGreaterThan(auxiliaryFiles.length);
    for(const entry of [...access,...files])expect(entry.transportType).toBe(transport??'http');
    for(const entry of [...auxiliaryAccess,...auxiliaryFiles]){expect(entry.reqBodyId).toBeUndefined();expect(entry.originalReqBodyId).toBeUndefined();expect(entry.respBodyId).toBeUndefined();}
    expect(auxiliaryAccess.some(value=>value.status===200&&value.protocolOutcome==='completed')).toBe(true);
    for(const sink of [saved,access,files]){const serialized=JSON.stringify(sink);expect(serialized).not.toContain(cipher);expect(serialized).not.toContain(payload);}
    expect(env.budgets).toHaveLength(2);expect(env.settlements.every(value=>value.sent&&value.outcome==='completed')).toBe(true);
  }finally{await env.close();}
});

const {DataAdmissionHost}=await import('../../src/data-admission/host');
const {createIngress:accessIngress}=await import('../../../../plugins/key-access/server/policy');
const accessCatalogHash='a'.repeat(64);
const accessPolicy=(routes:string[],models:string[]|null)=>({protectedRouteIds:['entry','final','aux'],byKey:{key:{routes,models}},credentials:[{id:'key',domain:'data',name:'fixture',prefix:'fixture',digest:'a'.repeat(64),createdAt:1,expiresAt:null,revokedAt:null,credentialVersion:1}]});
async function actualAccessHost(routes:string[],models:string[]|null){
  const host=new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=>accessCatalogHash,loadPlugin:async()=>({createIngress:accessIngress})});
  await host.publish({version:1,plugins:[{name:'key-access',entry:'access',catalogHash:accessCatalogHash,policy:accessPolicy(routes,models) as any}],routeRequirements:[{plugin:'key-access',routeIds:['entry','final','aux']}]});
  return host;
}
for(const [name,routes,models,dispatchModel] of [
  ['entry route',['final','aux'],null,undefined],
  ['final route',['entry','aux'],null,undefined],
  ['mapped final model',['entry','final','aux'],['main-model','relay-model'],'mapped-model'],
] as const)test(`real host access policy denies ${name} before preparation or any model call`,async()=>{
  const host=await actualAccessHost([...routes],models?[...models]:null);
  const env=gatewayPreparationFixture({admissionHost:host,dispatchModel,prepare:async input=>{await input.executeAuxiliary(auxiliary);return {};}});
  try{const response=await env.send();expect(response.status).toBe(403);await response.text();expect(env.prepares).toBe(0);expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);
    expect(env.operations.some(row=>row.operation==='authorize')).toBe(true);
    expect(env.operations.some(row=>['preview','admit'].includes(row.operation))).toBe(false);
  }finally{await env.close();host.dispose();}
});
for(const [name,routes,models] of [
  ['relay route',['entry','final'],null],
  ['actual relay model',['entry','final','aux'],['main-model']],
] as const)test(`real host denies ${name} before reuse callback and all wire calls`,async()=>{
  const host=await actualAccessHost([...routes],models?[...models]:null);let reused=0;
  const env=gatewayPreparationFixture({admissionHost:host,credential:'Bearer fixture',prepare:async input=>{
    await input.executeAuxiliary({...auxiliary,reuse:async()=>{reused++;return 'cached';}});return {};
  }});
  try{const response=await env.send();expect(response.status).toBe(403);await response.text();expect(env.prepares).toBe(1);expect(reused).toBe(0);expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);
  }finally{await env.close();host.dispose();}
});
test('reuse rechecks real access policy after credential selection and cannot use a revoked cached target',async()=>{
  const host=await actualAccessHost(['entry','final','aux'],null);let reused=0,auxiliaryInspections=0;
  const env=gatewayPreparationFixture({admissionHost:host,credential:'Bearer fixture',onInspection:async target=>{
    if(target.routeId==='aux' && ++auxiliaryInspections===2)await host.publish({version:2,plugins:[{name:'key-access',entry:'access',catalogHash:accessCatalogHash,policy:accessPolicy(['entry','final'],null) as any}],routeRequirements:[{plugin:'key-access',routeIds:['entry','final','aux']}]});
  },prepare:async input=>{
    await input.executeAuxiliary({...auxiliary,reuse:async()=>{reused++;return 'cached';}});return {};
  }});
  try{const response=await env.send();expect(response.status).toBe(409);await response.text();expect(auxiliaryInspections).toBe(2);expect(reused).toBe(0);expect(env.calls).toHaveLength(0);expect(env.budgets).toHaveLength(0);
  }finally{await env.close();host.dispose();}
});

test('auxiliary requests start without parent annotations and cannot mutate the parent declaration',async()=>{
 const seen:any[]=[];
 const env=gatewayPreparationFixture({onAnnotations:context=>{
   seen.push({routeId:context.routeId,annotations:structuredClone(context.annotations)});
   if(context.routeId==='/aux')context.annotations={child:{value:'independent'}};
 },prepare:async input=>{
   input.context.annotations={identity:{wireModel:'main-model',catalog:{provider:'p',model:'main'}}};
   const result=await input.executeAuxiliary(auxiliary);if(result.kind!=='response')throw Error('expected auxiliary response');
   try{await result.bodyHandle.json();await result.completion;}finally{result.dispose();}
   expect(input.context.annotations).toEqual({identity:{wireModel:'main-model',catalog:{provider:'p',model:'main'}}});return {};
 }});
 try{const response=await env.send();expect(response.status).toBe(200);await response.text();
   expect(seen).toEqual([{routeId:'/aux',annotations:undefined},{routeId:'/final',annotations:{identity:{wireModel:'main-model',catalog:{provider:'p',model:'main'}}}}]);
 }finally{await env.close();}
});
