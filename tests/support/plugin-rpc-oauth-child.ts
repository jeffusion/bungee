import {PluginServiceHost} from '../../packages/core/src/plugin-services';
import {WorkerPeerBroker, pluginPeerLifecycleIdentity} from '../../packages/core/src/plugin-services/peer-broker';
import {ScopedPluginRegistry} from '../../packages/core/src/scoped-plugin-registry';
import {PluginDependencyGraph} from '../../packages/core/src/plugin-dependencies';
import {deriveWorkerSupervisionCredential, importWorkerSupervisionSeed} from '../../packages/core/src/supervision';
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
registry.setServiceDependencies(graph.declarations());
try {
  broker.start(); await broker.waitUntilDirectoryLoaded({timeoutMs:5000});
  await registry.createInstance({type:'upstream',routeId:'/oauth-peer',upstreamId:facts.endpointId}, {id:facts.bindingId,name:'chatgpt-oauth',path:new URL('../../plugins/chatgpt-oauth/server/index.ts',import.meta.url).pathname,enabled:true,options:{accountRef:'forged-worker-options'}} as any);
  const binding={plugin:'chatgpt-oauth',contributionId:'upstream',bindingId:facts.bindingId,bindingOptions:{accountRef:'forged-worker-options'}};
  const attempt={revision:1,endpointId:facts.endpointId,attemptId:crypto.randomUUID()};
  const signal=new AbortController().signal;
  const owner=registry.getBoundControlOwners('/oauth-peer',facts.endpointId)[0]!;
  const lease=host.acquireLease(owner.pluginName,owner.scopeKey);
  try { await registry.runWithRequestLeases(new Map([[`${owner.pluginName}\0${owner.scopeKey}`,lease]]), async () => {
  const credential=await registry.invokeBoundControl(binding,attempt,'getCredential',{},signal) as any;
  // Late response credential rejection remains authorized by the original
  // request lease even when this worker owner has begun draining.
  host.retire(owner.pluginName,owner.scopeKey);
  broker.retire();
  const stale=await registry.invokeBoundControl(binding,attempt,'rejectAccess',{version:credential.version+1},signal) as any;
  const rejected=await registry.invokeBoundControl(binding,attempt,'rejectAccess',{version:credential.version},signal) as any;
  let forgedCode='',fencedCode='';
  try {await registry.invokeBoundControl(binding,attempt,'getCredential',{accountRef:'forged'},signal);} catch(error:any) {forgedCode=error.code;}
  try {await registry.invokeBoundControl(binding,attempt,'getCredential',{},signal);} catch(error:any) {fencedCode=error.code;}
  process.stdout.write(JSON.stringify({event:'oauth_peer_result',pid:process.pid,version:credential.version,credentialCorrect:credential.headers.Authorization==='Bearer test-peer-access',accountCorrect:credential.headers['Chatgpt-Account-Id']==='trusted-peer-account',stale:stale.rejected,rejected:rejected.rejected,forgedCode,fencedCode})+'\n');
  }); } finally {lease();}
} finally {await registry.destroy();broker.dispose();await host.rpc?.dispose();}
