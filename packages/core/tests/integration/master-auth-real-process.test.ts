import { fileURLToPath } from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {hashConfigurationContent} from '../../src/config-storage/content-hash';
import {initializeConfigurationDatabase} from '../../src/master-runtime/initialize-configuration';
import {test} from 'bun:test';
import {DaemonManager} from '../../../cli/src/daemon/manager';
import {captureProcessIdentity,probeProcessIdentity,type CapturedProcessIdentity} from '../../src/master-runtime/process-identity';
import {Database} from 'bun:sqlite';
import {createSignedWorkerRpcClient,WORKER_STATE_RPC_PATH} from '../../src/data-admission/rpc';
import {deriveWorkerTransportSecret} from '../../src/supervision';
import {waitForAuthPublication} from '../../../../tests/support/auth-publication-readiness';
import {FIXTURE_STARTUP_WAIT_MS,FIXTURE_PUBLICATION_WAIT_MS} from '../../../../tests/support/publication-fixture';
test('real master publishes credential ACKs and guards every account mode mutation entry', async()=>{
const root=await mkdtemp(join(tmpdir(),'bungee-auth-smoke-'));let child: ReturnType<typeof spawn> | undefined;let output='';let childExitObserved=false;let childCloseObserved=false;let testFailure:unknown;let spawnError:Error|undefined;let manager:DaemonManager|undefined;const ownedWorkers=new Map<string,CapturedProcessIdentity>();const ports=[];
const childExited=()=>child!==undefined&&(childExitObserved||child.exitCode!==null||child.signalCode!==null||spawnError!==undefined);
const childDiagnostic=()=>({exitCode:child?.exitCode,signal:child?.signalCode,exitObserved:childExitObserved,closeObserved:childCloseObserved,spawnError:spawnError?.message,outputTail:output});
for(let i=0;i<4;i++){const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});ports.push(s.port!);await s.stop(true);}
try{await initializeConfigurationDatabase({configDbPath:join(root,'config.db')});
const launchEnvironment={...process.env,HOME:root,USERPROFILE:root,BUNGEE_CONFIG_DB_PATH:join(root,'config.db'),BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),WORKER_COUNT:'1',HOST:'127.0.0.1',PORT:String(ports[0]),BUNGEE_MANAGEMENT_PORT:String(ports[1]),BUNGEE_MASTER_CONTROL_PORT:String(ports[2]),BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3]),BUNGEE_PLUGIN_SECRETS_KEY:Buffer.alloc(32,7).toString('base64'),BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../../../plugins', import.meta.url)),LOG_LEVEL:'info'};
manager=new DaemonManager((executable,args,options)=>{
child=spawn(executable,[...args],{...options,env:{...options.env,PLUGINS_DIR:launchEnvironment.PLUGINS_DIR},stdio:['ignore','pipe','pipe']});
const capture=(chunk:Buffer)=>{output=(output+chunk.toString('utf8')).slice(-8192);};
child.stdout!.on('data',capture);child.stderr!.on('data',capture);
child.once('exit',()=>{childExitObserved=true;});child.once('close',()=>{childCloseObserved=true;});child.once('error',error=>{spawnError=error;});
return child;
},undefined,{runtimeDirectory:join(root,'.bungee','run'),dataDirectory:root,logsDirectory:root,configDirectory:join(root,'.bungee'),pidFile:join(root,'.bungee','bungee.pid'),logFile:join(root,'.bungee','bungee.log'),errorLogFile:join(root,'.bungee','bungee.error.log'),directLaunch:{executable:process.execPath,entrypoint:fileURLToPath(new URL('../../src/main.ts',import.meta.url))},inheritedEnvironment:launchEnvironment,startupTimeoutMs:FIXTURE_STARTUP_WAIT_MS});
try{await manager.start({workers:'1'});}catch(error){throw new Error('auth fixture startup failed '+JSON.stringify(childDiagnostic()),{cause:error});}
const base='http://127.0.0.1:'+ports[1];
const waitServing=async(headers:HeadersInit={},expectedRevision?:number,timeoutMs=FIXTURE_PUBLICATION_WAIT_MS)=>{
  const body=await waitForAuthPublication({base,headers,revision:expectedRevision,timeoutMs,childExited,childDiagnostic});
  if(body.workers?.length!==1)throw Error('auth fixture worker inventory is incomplete');
  for(const worker of body.workers){
    if(!ownedWorkers.has(worker.worker_instance_id))ownedWorkers.set(worker.worker_instance_id,await captureProcessIdentity(worker.pid,worker.worker_instance_id));
  }
  return body;
};
await waitServing({},1,FIXTURE_STARTUP_WAIT_MS);
const mutateWhenReady=async(path:string,init:RequestInit)=>{
  let last:unknown;
  for(let attempt=0;attempt<100;attempt++){
    const response=await fetch(base+path,init);
    if(response.status!==503)return response;
    const body=await response.clone().json();last=body;
    // Serving evidence can converge before the mutation admission gate clears.
    // These readiness refusals happen before commit; keep the same mutation ID.
    if(body.error!=='control_recovering'
      ||!['admission_recovering','retired_pending','lease_margin'].includes(body.reason))return response;
    await Bun.sleep(100);
  }
  throw Error('mutation admission did not become ready '+path+' '+JSON.stringify(last)+' '+output);
};
const mode=await (await fetch(base+'/api/auth/mode')).json();if(mode.mode!=='anonymous')throw Error('mode');
const removed=await fetch(base+'/api/keys');if(removed.status!==404)throw Error('legacy key API remains');
const initial=await (await fetch(base+'/api/config',{})).json();
const nextAggregate={...initial.config,plugin_activations:[{plugin_name:'local-accounts'}]};
const fullPut=await fetch(base+'/api/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:1,mutation_id:crypto.randomUUID(),aggregate:nextAggregate})});if(fullPut.status!==422)throw Error('full PUT bypass '+fullPut.status);
const envelopeBase={format:'bungee-config-snapshot',format_version:1,schema_version:2,exported_at:Date.now(),source_revision:1,content_hash:hashConfigurationContent(nextAggregate),aggregate:nextAggregate};
const imported=await fetch(base+'/api/config/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:1,mutation_id:crypto.randomUUID(),envelope:{...envelopeBase,envelope_hash:hashConfigurationContent(envelopeBase)}})});if(imported.status!==422)throw Error('import bypass '+imported.status);
const setup={username:'owner',password:'Owner password 123!',passwordConfirmation:'Owner password 123!'};
const missing=await fetch(base+'/api/plugins/local-accounts/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:1,mutation_id:crypto.randomUUID()})});if(missing.status!==422)throw Error('setup missing '+missing.status);
const enabled=await fetch(base+'/api/plugins/local-accounts/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:1,mutation_id:crypto.randomUUID(),managementSetup:setup})});if(enabled.status!==202)throw Error('enable '+enabled.status+' '+await enabled.text());
const accountMode=await (await fetch(base+'/api/auth/mode')).json();if(accountMode.mode!=='plugin'||accountMode.provider.loginComponent!=='LocalAccountsLogin')throw Error('account mode '+JSON.stringify(accountMode));
const refused=await fetch(base+'/api/config');if(refused.status!==401)throw Error('base bypass account mode');
const signed=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password:setup.password,transport:'bearer'})});const session=await signed.json();if(!session.success)throw Error('login '+JSON.stringify(session));
const members=await fetch(base+'/api/plugins/local-accounts/control/self',{headers:{authorization:'Bearer '+session.token}});if(members.status!==200)throw Error('members '+members.status+' '+await members.text());
await waitServing({authorization:'Bearer '+session.token},initial.revision+1);
const snapshot=await (await fetch(base+'/api/config',{headers:{authorization:'Bearer '+session.token}})).json();
const disabled=await mutateWhenReady('/api/plugins/local-accounts/disable',{method:'POST',headers:{authorization:'Bearer '+session.token,'content-type':'application/json'},body:JSON.stringify({expected_revision:snapshot.revision,mutation_id:crypto.randomUUID()})});if(disabled.status!==202)throw Error('disable '+disabled.status+' '+await disabled.text());
const restored=await fetch(base+'/api/config',{});if(restored.status!==200)throw Error('restore key '+restored.status);

await waitServing({},snapshot.revision+1);
const budgetEnable=await mutateWhenReady('/api/plugins/token-budget/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID()})});if(budgetEnable.status!==202)throw Error('budget enable '+budgetEnable.status+' '+await budgetEnable.text()+' '+output);
const serving=await waitServing();
const issued=await fetch(base+'/api/plugins/key-access/control/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Budget'})});const issuedBody=await issued.json();if(issued.status!==201)throw Error('issued '+issued.status+' '+JSON.stringify(issuedBody));const budgetKey=issuedBody.key;
const policy=await fetch(base+'/api/plugins/token-budget/control/keys/'+budgetKey.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'cumulative',limit:100})});if(policy.status!==200)throw Error('policy '+policy.status+' '+await policy.text());
const read=new Database(join(root,'config.db'),{readonly:true});
const instance=(read.query('SELECT instance_id FROM supervision_state').get() as any).instance_id;
const expected=JSON.parse((read.query("SELECT value_json FROM plugin_durable_records WHERE namespace='core-master-state-rpc' AND key='identity'").get() as any).value_json);read.close();
const currentWorker=serving.workers[0];const worker={role:'worker' as const,master_generation:currentWorker.master_generation,process_instance_id:currentWorker.worker_instance_id,boot_nonce:currentWorker.boot_nonce,worker_slot:currentWorker.slot};
const rpc=createSignedWorkerRpcClient({transportSecret:deriveWorkerTransportSecret(new Uint8Array(32).fill(7),instance),worker,expectedServer:{role:'ingress',...expected},url:'http://127.0.0.1:'+ports[2]+WORKER_STATE_RPC_PATH});
const target={requestId:crypto.randomUUID(),attemptId:crypto.randomUUID(),principal:{domain:'data' as const,keyId:budgetKey.id,credentialVersion:budgetKey.credentialVersion},routeId:crypto.randomUUID(),serviceId:null,upstreamId:crypto.randomUUID(),url:'https://upstream.example/v1/chat/completions',model:'example',now:Date.now()};
const input={plugin:'token-budget',target};const budgetSnapshot={keyId:budgetKey.id,requestId:target.requestId,month:new Date().toISOString().slice(0,7),policy:{mode:'cumulative',limit:100},version:0};
await rpc('plugin-state',{...input,method:'prepare',payload:{snapshot:budgetSnapshot}});
await rpc('plugin-state',{...input,method:'settle',payload:{result:{requestId:target.requestId,attemptId:target.attemptId,inputTokens:4,outputTokens:6,inputSource:'official',outputSource:'official',complete:true,settlementVersion:1}}});
const policyRead=await (await fetch(base+'/api/plugins/token-budget/control/keys/'+budgetKey.id,{})).json();if(policyRead.value.cumulative!==10)throw Error('settlement not durable '+JSON.stringify(policyRead));
const forged=createSignedWorkerRpcClient({transportSecret:deriveWorkerTransportSecret(new Uint8Array(32).fill(7),instance),worker:{...worker,process_instance_id:crypto.randomUUID()},expectedServer:{role:'ingress',...expected},url:'http://127.0.0.1:'+ports[2]+WORKER_STATE_RPC_PATH});
let rejected=false;try{await forged('plugin-state',{...input,method:'status',payload:null});}catch{rejected=true;}if(!rejected)throw Error('unknown worker accepted');
console.log('REAL_MASTER_PASS anonymous management, plugin keys, account switch guards, dependency activation, dynamic key policy, signed state prepare/settle, rejected unknown worker');


}catch(error){testFailure=error;throw error;}finally{
  try{
    if(child){
      if(!childExited())await manager!.stop();
      const deadline=Date.now()+15000;
      while((!childExited()||!childCloseObserved)&&Date.now()<deadline)await Bun.sleep(50);
      if(!childExited()||!childCloseObserved||child.exitCode!==0||child.signalCode!==null)throw Error('master graceful shutdown was not proven '+JSON.stringify(childDiagnostic()));
      if(ownedWorkers.size===0)throw Error('owned worker inventory was never captured');
      for(const identity of ownedWorkers.values()){
        const state=await probeProcessIdentity(identity);
        if(state!=='dead'&&state!=='mismatch')throw Error('owned worker exit was not proven '+JSON.stringify({pid:identity.pid,state}));
      }
      // Rebind every fixture endpoint after authenticated shutdown: a surviving
      // ingress or worker listener must fail cleanup, rather than be hidden by rm.
      for(const port of ports){
        const probe=Bun.serve({hostname:'127.0.0.1',port,reusePort:false,fetch:()=>new Response('')});
        await probe.stop(true);
      }
    }
    await rm(root,{recursive:true,force:true});
  }catch(error){
    const cleanupError=new Error('auth fixture cleanup failed; evidence retained at '+root,{cause:error});
    throw testFailure===undefined?cleanupError:new AggregateError([testFailure,cleanupError],'auth fixture assertion and cleanup both failed');
  }
}

},FIXTURE_STARTUP_WAIT_MS+3*FIXTURE_PUBLICATION_WAIT_MS+60000);
