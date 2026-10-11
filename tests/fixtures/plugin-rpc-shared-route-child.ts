// Real request routing and OAuth RPC in an isolated authenticated worker process.
import '../../packages/core/tests/helpers/data-plane-runtime';
import {PluginServiceHost} from '../../packages/core/src/plugin-services';
import {WorkerPeerBroker, pluginPeerLifecycleIdentity} from '../../packages/core/src/plugin-services/peer-broker';
import {ScopedPluginRegistry, setScopedPluginRegistry} from '../../packages/core/src/scoped-plugin-registry';
import {PluginDependencyGraph} from '../../packages/core/src/plugin-dependencies';
import {deriveWorkerSupervisionCredential, importWorkerSupervisionSeed} from '../../packages/core/src/supervision';
import {setBoundControlClientProvider} from '../../packages/core/src/config-worker/runtime-dependencies';
import {createWorkerPluginControlPeerProvider} from '../../packages/core/src/config-worker/http-provider';
import {setPluginRegistry} from '../../packages/core/src/worker/state/plugin-manager';
import {initializeRuntimeState, runtimeState} from '../../packages/core/src/worker/state/runtime-state';

const {handleRequest} = await import('../../packages/core/src/worker/request/handler');
const {accessLogWriter} = await import('../../packages/core/src/logger/access-log-writer');
const {fileLogWriter} = await import('../../packages/core/src/logger/file-log-writer');
const facts = JSON.parse(process.env.BUSINESS_PEER_FACTS!);
const manifest = JSON.parse(await Bun.file(new URL('../../plugins/chatgpt-oauth/manifest.json', import.meta.url)).text());
const graph = new PluginDependencyGraph([manifest]);
let broker!: WorkerPeerBroker;
const host: PluginServiceHost = new PluginServiceHost('worker', {
  identity: (plugin, scope) => pluginPeerLifecycleIdentity({process:'worker', instance:facts.worker_instance_id, generation:1, catalog:facts.catalog}, plugin, scope),
  resolvePlacement: request => broker.placementResolver(request), resolveJournal: () => null,
  resolveCallee: () => host.currentInvocation()?.callee ?? null, ensureRemoteRoute: input => broker.ensureRemoteRoute(input),
});
host.setDeclarations(graph.serviceDeclarations());
broker = new WorkerPeerBroker({services:host, credential:deriveWorkerSupervisionCredential(importWorkerSupervisionSeed(process.env.BUSINESS_PEER_SEED!),facts.boot_nonce), masterGeneration:facts.master_generation, workerInstanceId:facts.worker_instance_id, bootNonce:facts.boot_nonce,workerSlot:0,masterControlPort:()=>facts.port,catalog:()=>facts.catalog,authority:()=>facts.authority});
const registry = new ScopedPluginRegistry(process.cwd(),host);
const provider = createWorkerPluginControlPeerProvider();
const routes = ['/v1/chat/completions','/v1/responses'];
const binding = {plugin:'chatgpt-oauth',contributionId:'chatgpt',bindingId:facts.bindingId,bindingOptions:{accountRef:'forged-worker-options'}};
const attempt = {revision:1,endpointId:facts.endpointId,attemptId:crypto.randomUUID()};
const signal = new AbortController().signal;
const plugin = {id:facts.bindingId,name:'chatgpt-oauth',path:new URL('../../plugins/chatgpt-oauth/server/index.ts',import.meta.url).pathname,enabled:true,options:binding.bindingOptions};
const config = {plugins:[],services:[{name:'shared-oauth',endpoints:[{id:facts.endpointId,target:'https://chatgpt.com',weight:100,priority:1,plugins:[plugin],managedBy:{plugin:binding.plugin,contributionId:binding.contributionId,bindingId:binding.bindingId}}]}],routes:routes.map(path=>({path,service:'shared-oauth',timeouts:{request_ms:5000}}))} as any;
const originalFetch = global.fetch;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let ingress: ReturnType<typeof Bun.serve> | undefined;
const releases: Array<()=>void> = [];
const refusal = async (run: ()=>Promise<unknown>) => {
  try {await run();return 'accepted';} catch(error:any) {return error.code??error.message;}
};
try {
  broker.start(); await broker.waitUntilDirectoryLoaded({timeoutMs:5000});
  const initialized = await registry.initializeFromConfig(config,graph);
  if(initialized.success!==2||initialized.failed!==0) throw new Error('shared route initialization failed');
  setScopedPluginRegistry(registry);
  setPluginRegistry({getPluginStateSnapshot:()=>({pluginName:binding.plugin,discovery:'discovered',validation:'validated',persistedEnabled:'enabled',manifest})} as any);
  setBoundControlClientProvider(provider.provider);
  initializeRuntimeState(config);
  const owners = routes.map(route=>registry.getBoundControlOwners(route,facts.endpointId)[0]!);
  const leases = owners.map(owner=>{
    const release=host.acquireLease(owner.pluginName,owner.scopeKey);releases.push(release);
    return new Map([[`${owner.pluginName}\0${owner.scopeKey}`,release]]);
  });
  const refusals = {
    ambiguous:await refusal(()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal)),
    missing:await refusal(()=>registry.runWithRequestLeases(new Map(),()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal))),
    multiple:await refusal(()=>registry.runWithRequestLeases(new Map([...leases[0]!,...leases[1]!]),()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal))),
    binding:await refusal(()=>registry.runWithRequestLeases(leases[0]!,()=>registry.invokeBoundControl({...binding,bindingId:crypto.randomUUID()},attempt,'getCredential',{},signal))),
    endpoint:await refusal(()=>registry.runWithRequestLeases(leases[0]!,()=>registry.invokeBoundControl(binding,{...attempt,endpointId:crypto.randomUUID()},'getCredential',{},signal))),
    wrongProof:await refusal(()=>registry.runWithRequestLeases(new Map([[`${owners[0]!.pluginName}\0${owners[0]!.scopeKey}`,leases[1]!.values().next().value!]]),()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal))),
    forgedPayload:await refusal(()=>registry.runWithRequestLeases(leases[0]!,()=>registry.invokeBoundControl(binding,attempt,'getCredential',{accountRef:'forged'},signal))),
  };
  const stale = await registry.runWithRequestLeases(leases[0]!,()=>registry.invokeBoundControl(binding,attempt,'rejectAccess',{version:2},signal)) as any;
  const seen: Array<{credentialCorrect:boolean;accountCorrect:boolean}> = [];
  upstream = Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
    await request.arrayBuffer();
    seen.push({credentialCorrect:request.headers.get('authorization')==='Bearer test-peer-access',accountCorrect:request.headers.get('chatgpt-account-id')==='trusted-peer-account'});
    if(seen.length===1) return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',{headers:{'content-type':'text/event-stream'}});
    // Real proxy response rejection must reuse the owner retained before fetch.
    host.retire(owners[1]!.pluginName,owners[1]!.scopeKey);broker.retire();
    return Response.json({error:{message:'fixture denial',type:'authentication_error'}},{status:401});
  }});
  // Preserve the real manifest's closed origin/path checks. Only the technical
  // upstream socket is redirected; no external network or real credential is used.
  global.fetch = ((input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    if(url.origin==='https://chatgpt.com') return originalFetch(new URL(`${url.pathname}${url.search}`,upstream!.url),init);
    return originalFetch(input,init);
  }) as typeof fetch;
  const logging = {accessLogWriter:{write:()=>{},updateResponseBodyId:()=>{},updateProtocolOutcome:()=>{}},fileLogWriter:{write:async()=>{}}} as any;
  ingress = Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>handleRequest(request,config,{logging,servingRevision:1})});
  const statuses: number[] = [];
  for(const route of routes) {
    const response=await originalFetch(new URL(route,ingress.url),{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer forged-client'},body:JSON.stringify(route===routes[0]?{model:'codex',messages:[{role:'user',content:'test'}]}:{model:'codex',input:'test'})});
    statuses.push(response.status);await response.text();
  }
  const fenced = await registry.runWithRequestLeases(leases[0]!,()=>refusal(()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal)));
  // Released retained proof cannot mint fresh authority, even on a ready owner.
  releases[0]!();
  const released = await registry.runWithRequestLeases(leases[0]!,()=>refusal(()=>registry.invokeBoundControl(binding,attempt,'getCredential',{},signal)));
  process.stdout.write(JSON.stringify({event:'shared_route_peer_result',pid:process.pid,statuses,seen,stale:stale.rejected,refusals,fenced,released,ownerScopes:owners.map(owner=>owner.scopeKey)})+'\n');
} finally {
  global.fetch=originalFetch;
  await ingress?.stop(true);await upstream?.stop(true);
  for(const release of releases) release();
  provider.dispose();setBoundControlClientProvider(null);setScopedPluginRegistry(null);setPluginRegistry(null);runtimeState.clear();
  await registry.destroy();broker.dispose();await host.rpc?.dispose();
  await accessLogWriter.close();await fileLogWriter.close();
}
