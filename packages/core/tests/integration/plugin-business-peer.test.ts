import {expect,test} from 'bun:test';
import {PluginServiceHost} from '../../src/plugin-services';
import {ControlPeerBroker,pluginPeerLifecycleIdentity} from '../../src/plugin-services/peer-broker';
import {PluginDependencyGraph} from '../../src/plugin-dependencies';
import {deriveWorkerSupervisionSeed,deriveWorkerSupervisionCredential,serializeWorkerSupervisionSeed} from '../../src/supervision';
import {createManagementListener} from '../../src/management-listener';
import {readHostRpcCalleeFrame} from '../../src/plugin-services/host-rpc';
import {createControl} from '../../../../plugins/chatgpt-oauth/server/control';
import {AccountStore} from '../../../../plugins/chatgpt-oauth/server/accounts';
import type {SecretStore,SecretValue} from '../../src/plugin-control/contracts';

// Physical membership and binding projection are explicit fixtures. The worker,
// authenticated socket, canonical registry and OAuth business/CAS are real.
test('a real worker binding consumes its global OAuth provider over typed peer RPC', async () => {
  const worker={master_generation:crypto.randomUUID(),worker_instance_id:crypto.randomUUID(),worker_slot:0,boot_nonce:crypto.randomUUID()};
  const authority={controller_epoch:1,controller_id:crypto.randomUUID()},catalog=`sha256:${'b'.repeat(64)}`;
  const seed=deriveWorkerSupervisionSeed(new Uint8Array(32).fill(42),worker.master_generation,worker.worker_instance_id,0);
  const credential=deriveWorkerSupervisionCredential(seed,worker.boot_nonce);
  const manifest=JSON.parse(await Bun.file(new URL('../../../../plugins/chatgpt-oauth/manifest.json',import.meta.url)).text());
  const graph=new PluginDependencyGraph([manifest]);
  let value:SecretValue|null=null;
  const store:SecretStore={namespace:'chatgpt-oauth',get:async()=>value&&{...value},compareAndSet:async(_key,expected,next)=>{if((value?.version??null)!==expected)throw Object.assign(new Error('conflict'),{code:'version_conflict'});const version=(value?.version??0)+1;value={version,value:next};return version;},delete:async()=>{value=null;}};
  const account=await new AccountStore(store).create('Peer Account',{accessToken:'test-peer-access',refreshToken:'test-peer-refresh',expiresAt:Date.now()+3600000,identity:{accountId:'trusted-peer-account'},identityStatus:'parsed'});
  const endpointId=crypto.randomUUID(),bindingId=crypto.randomUUID();
  let broker!:ControlPeerBroker;
  const host:PluginServiceHost=new PluginServiceHost('control',{identity:(plugin,scope)=>pluginPeerLifecycleIdentity({process:'control',instance:worker.master_generation,generation:1,catalog},plugin,scope),resolvePlacement:request=>broker.placementResolver(request),resolveJournal:()=>null,resolveCallee:()=>host.currentInvocation()?.callee??null});
  host.setDeclarations(graph.serviceDeclarations());
  let projected=0;
  broker=new ControlPeerBroker({services:host,instance:()=>worker.master_generation,authority:()=>authority,catalog:()=>catalog,resolvePeer:identity=>Object.entries(worker).every(([key,value])=>(identity as any)[key]===value)?{credential,activatedPlugins:['chatgpt-oauth'],configurationTarget:{revision:1,content_hash:catalog,plugin_catalog_hash:catalog}}:null,projectInvocation:async(identity,metadata,signal)=>{
    expect(identity).toEqual(worker);expect(metadata.caller.subject).toBe(`chatgpt-oauth@upstream:/oauth-peer#${endpointId}`);expect(metadata.caller.scope).toBe('binding');expect(metadata.host).toMatchObject({kind:'bound',revision:1,endpointId});projected++;
    return {binding:{plugin:'chatgpt-oauth',contributionId:'upstream',bindingId,bindingOptions:{accountRef:account.id}},attempt:{attemptId:(metadata.host as any).attemptId,clientStreaming:false,signal,boundClient:{call:async()=>{throw new Error('nested unavailable');}}}};
  }});
  const services=host.createContext('chatgpt-oauth','global');
  const lifetime=new AbortController();
  const control=createControl({signal:lifetime.signal,secretStore:store,storage:{} as any,services,resolveRpcCallee:readHostRpcCalleeFrame});
  await control.start();host.markReady('chatgpt-oauth');
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null)});const port=probe.port!;await probe.stop(true);
  const listener=createManagementListener({profile:'master-control',hostname:'127.0.0.1',port,shutdownTimeoutMs:1000,controlApi:{handle:async()=>null},internalPluginPeer:broker.websocket});listener.start();listener.ready();
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try {
    child=Bun.spawn([process.execPath,new URL('../../../../tests/fixtures/plugin-rpc-oauth-child.ts',import.meta.url).pathname],{env:{...process.env,BUSINESS_PEER_FACTS:JSON.stringify({...worker,authority,catalog,port,endpointId,bindingId}),BUSINESS_PEER_SEED:serializeWorkerSupervisionSeed(seed)},stdout:'pipe',stderr:'pipe'});
    const output=await new Response(child.stdout as ReadableStream<Uint8Array>).text(),errors=await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    expect(await child.exited,errors).toBe(0);
    const result=output.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.event==='oauth_peer_result');
    expect(result).toMatchObject({version:1,credentialCorrect:true,accountCorrect:true,stale:false,rejected:true,forgedCode:'invalid_input',fencedCode:'failed'});
    expect(result.pid).not.toBe(process.pid);expect(projected).toBe(4);
    expect((await new AccountStore(store).get(account.id)).status).toBe('reauth_required');
  } finally {
    if(child&&child.exitCode===null){child.kill();await child.exited;}
    await control.dispose();await host.dispose('chatgpt-oauth','global',services);await host.rpc?.dispose();await broker.dispose();await listener.stop();
  }
},20000);

test('two real proxy routes sharing one OAuth endpoint preserve exact caller scope and retained leases', async () => {
  const worker={master_generation:crypto.randomUUID(),worker_instance_id:crypto.randomUUID(),worker_slot:0,boot_nonce:crypto.randomUUID()};
  const authority={controller_epoch:1,controller_id:crypto.randomUUID()},catalog=`sha256:${'c'.repeat(64)}`;
  const seed=deriveWorkerSupervisionSeed(new Uint8Array(32).fill(43),worker.master_generation,worker.worker_instance_id,0);
  const credential=deriveWorkerSupervisionCredential(seed,worker.boot_nonce);
  const manifest=JSON.parse(await Bun.file(new URL('../../../../plugins/chatgpt-oauth/manifest.json',import.meta.url)).text());
  const graph=new PluginDependencyGraph([manifest]);
  let value:SecretValue|null=null;
  const store:SecretStore={namespace:'chatgpt-oauth',get:async()=>value&&{...value},compareAndSet:async(_key,expected,next)=>{if((value?.version??null)!==expected)throw Object.assign(new Error('conflict'),{code:'version_conflict'});const version=(value?.version??0)+1;value={version,value:next};return version;},delete:async()=>{value=null;}};
  const account=await new AccountStore(store).create('Shared Peer Account',{accessToken:'test-peer-access',refreshToken:'test-peer-refresh',expiresAt:Date.now()+3600000,identity:{accountId:'trusted-peer-account'},identityStatus:'parsed'});
  const endpointId=crypto.randomUUID(),bindingId=crypto.randomUUID();
  const scopes=['/v1/chat/completions','/v1/responses'].map(route=>`upstream:${route}#${endpointId}`);
  const projected:Array<{scope:string;method:string}>=[];
  let broker!:ControlPeerBroker;
  const host:PluginServiceHost=new PluginServiceHost('control',{identity:(plugin,scope)=>pluginPeerLifecycleIdentity({process:'control',instance:worker.master_generation,generation:1,catalog},plugin,scope),resolvePlacement:request=>broker.placementResolver(request),resolveJournal:()=>null,resolveCallee:()=>host.currentInvocation()?.callee??null});
  host.setDeclarations(graph.serviceDeclarations());
  broker=new ControlPeerBroker({services:host,instance:()=>worker.master_generation,authority:()=>authority,catalog:()=>catalog,resolvePeer:identity=>Object.entries(worker).every(([key,value])=>(identity as any)[key]===value)?{credential,activatedPlugins:['chatgpt-oauth'],configurationTarget:{revision:1,content_hash:catalog,plugin_catalog_hash:catalog}}:null,projectInvocation:async(identity,metadata,signal)=>{
    expect(identity).toEqual(worker);
    expect(metadata.caller.scope).toBe('binding');
    const scope=metadata.caller.subject.slice('chatgpt-oauth@'.length);
    expect(scopes).toContain(scope);
    expect(metadata.caller.subject).toBe(`chatgpt-oauth@${scope}`);
    expect(metadata.host).toMatchObject({kind:'bound',revision:1,endpointId});
    projected.push({scope,method:metadata.target.method});
    // Binding authority comes from the trusted control fixture, never the
    // forged worker/client account option or incoming Authorization header.
    return {binding:{plugin:'chatgpt-oauth',contributionId:'chatgpt',bindingId,bindingOptions:{accountRef:account.id}},attempt:{attemptId:(metadata.host as any).attemptId,clientStreaming:false,signal,boundClient:{call:async()=>{throw new Error('nested unavailable');}}}};
  }});
  const services=host.createContext('chatgpt-oauth','global');
  const control=createControl({signal:new AbortController().signal,secretStore:store,storage:{} as any,services,resolveRpcCallee:readHostRpcCalleeFrame});
  await control.start();host.markReady('chatgpt-oauth');
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(null)});const port=probe.port!;await probe.stop(true);
  const listener=createManagementListener({profile:'master-control',hostname:'127.0.0.1',port,shutdownTimeoutMs:1000,controlApi:{handle:async()=>null},internalPluginPeer:broker.websocket});listener.start();listener.ready();
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try {
    child=Bun.spawn([process.execPath,new URL('../../../../tests/fixtures/plugin-rpc-shared-route-child.ts',import.meta.url).pathname],{env:{...process.env,BUSINESS_PEER_FACTS:JSON.stringify({...worker,authority,catalog,port,endpointId,bindingId}),BUSINESS_PEER_SEED:serializeWorkerSupervisionSeed(seed)},stdout:'pipe',stderr:'pipe'});
    const [output,errors]=await Promise.all([new Response(child.stdout as ReadableStream<Uint8Array>).text(),new Response(child.stderr as ReadableStream<Uint8Array>).text()]);
    expect(await child.exited,errors).toBe(0);
    const result=output.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.event==='shared_route_peer_result');
    expect(result).toMatchObject({statuses:[200,401],seen:[{credentialCorrect:true,accountCorrect:true},{credentialCorrect:true,accountCorrect:true}],stale:false,fenced:'failed',released:'unauthorized',ownerScopes:scopes});
    expect(result.pid).not.toBe(process.pid);
    expect(result.refusals).toEqual({ambiguous:'bound control caller is unavailable',missing:'bound control caller is unavailable',multiple:'bound control caller is unavailable',binding:'bound control caller is unavailable',endpoint:'bound control caller is unavailable',wrongProof:'unauthorized',forgedPayload:'invalid_input'});
    expect(projected).toEqual([
      {scope:scopes[0]!,method:'rejectAccess'},
      {scope:scopes[0]!,method:'getCredential'},
      {scope:scopes[1]!,method:'getCredential'},
      {scope:scopes[1]!,method:'rejectAccess'},
      {scope:scopes[0]!,method:'getCredential'},
    ]);
    expect((await new AccountStore(store).get(account.id)).status).toBe('reauth_required');
  } finally {
    if(child&&child.exitCode===null){child.kill();await child.exited;}
    await control.dispose();await host.dispose('chatgpt-oauth','global',services);await host.rpc?.dispose();await broker.dispose();await listener.stop();
  }
},30000);
