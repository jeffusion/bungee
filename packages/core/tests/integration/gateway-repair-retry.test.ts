import { afterAll as afterDataPlaneTests } from 'bun:test';
import { createDataPlaneRuntime } from '../helpers/data-plane-runtime';
const dataPlaneRuntime = await createDataPlaneRuntime();
import {afterEach,expect,test} from 'bun:test';
import type {AppConfig} from '@jeffusion/bungee-types';
import {gzipSync} from 'node:zlib';
const { ScopedPluginRegistry, getScopedPluginRegistry, setScopedPluginRegistry } = await import('../../src/scoped-plugin-registry');
const { handleRequest } = await import('../../src/worker/request/handler');
const { generateWorkerTransportSecret, restoreWorkerTransportRequest } = await import('../../src/config-worker/private-transport');
const { privateRequestHeaders } = await import('../../src/public-listener/headers');
const { setWorkerAdmissionSession } = await import('../../src/data-admission/worker');
const { bodyMetrics } = await import('../../src/gateway/body-resources');
const { getPluginRegistry, setPluginRegistry } = await import('../../src/worker/state/plugin-manager');
const { setBoundControlClientProvider } = await import('../../src/config-worker/runtime-dependencies');
const previous=getScopedPluginRegistry();const originalFetch=globalThis.fetch;
const previousMetadata=getPluginRegistry();
afterEach(()=>{globalThis.fetch=originalFetch;setScopedPluginRegistry(previous);setWorkerAdmissionSession(null);setPluginRegistry(previousMetadata);setBoundControlClientProvider(null);});

test.each(['success','credential','http-error','network-error','cancel','deadline'] as const)('repair is a managed attempt with original-error fallback: %s',async(mode)=>{
  const success=mode==='success'||mode==='credential';const credentials:any[]=[];
  const key=`repair-${crypto.randomUUID()}`;
  const state={conversions:0,repairs:0,events:[] as any[],admissions:[] as any[],admissionResults:[] as any[],finalBody:undefined};(globalThis as any)[key]=state;
  const path=new URL('../fixtures/repair-attempt-plugin.ts',import.meta.url).pathname;
  const plugin=(pluginMode:string)=>({name:'repair-attempt-fixture',path,options:{key,mode:pluginMode}});
  const config={plugins:[plugin('admission')],routes:[{path:'/repair',path_rewrite:{'^/repair':'/rewritten'},request:{body:{add:{rule:true}}},
    timeouts:{request_ms:mode==='deadline'?50:1000},endpoints:[{id:'same-upstream',target:'http://repair.test',plugins:[plugin('convert')]}]}]} as AppConfig;
  if(mode==='credential'){
    const endpoint=config.routes[0]!.endpoints![0]! as any;endpoint.target='https://repair.test';
    Object.assign(endpoint.plugins[0],{id:'binding',enabled:true});endpoint.managedBy={plugin:'repair-attempt-fixture',contributionId:'fixture',bindingId:'binding'};
    setPluginRegistry({getPluginStateSnapshot(){return {persistedEnabled:'enabled',manifest:{control:{rpc:[{name:'getCredential',access:'bound-attempt'}]},
      contributes:{upstreamSources:[{id:'fixture',credentialPolicy:{allowedOrigins:['https://repair.test'],allowedRequests:[{pathname:'/converted',methods:['POST']}],allowedHeaderNames:['authorization']}}]}}};}} as any);
    setBoundControlClientProvider((_binding,attempt)=>({async call(){credentials.push(attempt);return {version:credentials.length,expiresAt:Date.now()+10000,headers:{authorization:`Bearer lease-${credentials.length}`}};} } as any));
  }
  const registry=new ScopedPluginRegistry(import.meta.dir);expect((await registry.initializeFromConfig(config)).failed).toBe(0);setScopedPluginRegistry(registry);
  const principal={domain:'data',keyId:'repair-key',credentialVersion:1};
  const grant={version:1,principal,snapshots:{'repair-attempt-fixture':true}};
  const admissionOps:string[]=[];
  setWorkerAdmissionSession({async admission(operation){admissionOps.push(operation);return operation==='inspect'?{policyVersion:1,requirements:{}}:grant;}});
  const entries:any[]=[];
  const transports=new Map<string,{outcome:string;code?:string}>();const fileEntries:any[]=[];
  const logging={accessLogWriter:{write(entry:any){
    const index=entries.findIndex(existing=>existing.requestId===entry.requestId);
    if(index<0)entries.push(entry);else if(entry.replacePendingTransport)entries[index]=entry;
  },updateBodyId(){},updateResponseBodyId(){},updateProtocolOutcome(){},updateTransportOutcome(id:string,outcome:string,code?:string){transports.set(id,{outcome,code});}},
    fileLogWriter:{async write(entry:any){fileEntries.push(structuredClone(entry));}}};
  const controller=new AbortController();const sent:any[]=[];
  let secondStarted!:()=>void;const secondReady=new Promise<void>(resolve=>{secondStarted=resolve;});
  globalThis.fetch=Object.assign(async(input:any,init?:RequestInit)=>{
    const body=await new Response(init!.body).text();const headers=new Headers(init!.headers);sent.push({url:String(input),body:JSON.parse(body),headers,length:Buffer.byteLength(body)});
    if(sent.length===1)return Response.json({error:{code:'signature',message:'original-error'},usage:{output_tokens:7}},{status:400});
    secondStarted();
    if(mode==='network-error')throw new Error('network reset');
    if(mode==='cancel'||mode==='deadline')return new Promise<Response>((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
    return mode==='http-error'?Response.json({error:{code:'signature',message:'replacement-error'},usage:{output_tokens:9}},{status:502}):Response.json({ok:true,usage:{output_tokens:9}});
  },{preconnect(){}}) as typeof fetch;
  const payload=Uint8Array.from(gzipSync('{"input":"hello"}'));
  const original=new Request('http://local/repair',{method:'POST',body:payload,headers:{'content-type':'application/json','content-encoding':'gzip'},signal:controller.signal});
  const secret=generateWorkerTransportSecret();
  const restored=restoreWorkerTransportRequest(new Request('http://127.0.0.1/private',{method:'POST',body:payload,
    headers:privateRequestHeaders(original,secret,undefined,{requestId:crypto.randomUUID(),principal}),signal:controller.signal}),secret);
  expect(restored.ok).toBe(true);if(!restored.ok)throw new Error('restore failed');
  try{
    const retainedBefore=bodyMetrics.retainedBytes;
    const pending=handleRequest(restored.request,config,{logging,servingRevision:7});
    if(mode==='cancel'){await secondReady;controller.abort();await expect(pending).rejects.toThrow();}
    else{
      const response=await pending;const body=await response.json();
      expect(response.status).toBe(success?200:400);
      expect(body).toEqual(success?{ok:true,usage:{output_tokens:9}}:{error:{code:'signature',message:'original-error'},usage:{output_tokens:7}});
    }
    const until=Date.now()+1000;while(!state.events.some(event=>event.phase==='request-end')&&Date.now()<until)await Bun.sleep(1);
    expect(sent).toHaveLength(2);expect(state.conversions).toBe(1);
    expect(sent.map(request=>new URL(request.url).pathname)).toEqual(['/converted','/converted']);
    expect(sent[0].body).toEqual({input:'hello',rule:true,conversions:1});expect(sent[1].body).toEqual({...sent[0].body,repaired:true});
    for(const request of sent){expect(request.headers.get('content-encoding')).toBeNull();expect(request.headers.get('content-length')).toBe(String(request.length));expect(request.headers.get('content-type')).toBe('application/json');}
    if(mode==='credential'){
      expect(credentials).toHaveLength(2);expect(new Set(credentials.map(attempt=>attempt.attemptId)).size).toBe(2);
      expect(sent.map(request=>request.headers.get('authorization'))).toEqual(['Bearer lease-1','Bearer lease-2']);
      expect(JSON.stringify(entries)).not.toContain('lease-1');expect(JSON.stringify(entries)).not.toContain('lease-2');
    }
    const selected=state.events.filter(event=>event.phase==='selected');expect(selected).toHaveLength(2);
    expect(new Set(selected.map(event=>event.attemptId)).size).toBe(2);expect(new Set(selected.map(event=>event.upstreamId))).toEqual(new Set(['same-upstream']));
    expect(state.admissions).toHaveLength(2);expect(state.admissions.map(attempt=>attempt.body)).toEqual(sent.map(request=>request.body));
    expect(admissionOps.filter(operation=>operation==='attempt')).toHaveLength(1);expect(admissionOps.filter(operation=>operation==='release')).toHaveLength(1);
    expect(state.events.filter(event=>event.phase==='end')).toHaveLength(2);expect(state.admissionResults).toHaveLength(2);
    expect(state.events.filter(event=>event.phase==='response').map(event=>event.body.usage.output_tokens)).toEqual(success||mode==='http-error'?[7,9]:[7]);
    expect(entries.map(entry=>entry.status)).toEqual([400,success?200:mode==='http-error'?502:503]);
    if(mode!=='cancel'){
      const returned=entries.find(entry=>entry.status===(success?200:400));
      expect(transports.get(returned.requestId)?.outcome).toBe('completed');
      const repaired=entries[1];
      if(mode==='network-error'||mode==='deadline')expect(transports.get(repaired.requestId)?.outcome).toBe('failed');
      expect(fileEntries.find(entry=>entry.requestId===returned.requestId)?.transportOutcome).toBe('completed');
    }
    expect(state.repairs).toBe(mode==='http-error'?2:1);
    expect(bodyMetrics.retainedBytes).toBe(retainedBefore);
  }finally{await registry.destroy();delete (globalThis as any)[key];}
});

afterDataPlaneTests(() => dataPlaneRuntime.close());
