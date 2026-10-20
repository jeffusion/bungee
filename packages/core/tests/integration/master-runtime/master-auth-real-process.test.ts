import { AsyncConfigRepository } from '../../../src/config-storage';
import { fileURLToPath } from 'node:url';
import {rm} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {hashConfigurationContent} from '../../../src/config-storage/content-hash';
import {initializeConfigurationDatabase} from '../../../src/master-runtime/initialize-configuration';
import {test} from 'bun:test';
import {DaemonManager} from '../../../../cli/src/daemon/manager';
import {initializePluginSecretsKey} from '../../../../cli/src/config/plugin-secrets-key';
import {captureProcessIdentity,probeProcessIdentity,type CapturedProcessIdentity} from '../../../src/master-runtime/process-identity';
import {makeCanonicalTempDir} from '../../../../../tests/helpers/canonical-temp';
import {waitForAuthPublication} from '../../../../../tests/helpers/auth-publication-readiness';
import {FIXTURE_STARTUP_WAIT_MS,FIXTURE_PUBLICATION_WAIT_MS} from '../../../../../tests/helpers/publication-fixture';
test('real master publishes credential ACKs and guards every account mode mutation entry', async()=>{
const root=makeCanonicalTempDir('bungee-auth-smoke',{daemonSafe:true});let child: ReturnType<typeof spawn> | undefined;let output='';let childExitObserved=false;let childCloseObserved=false;let testFailure:unknown;let spawnError:Error|undefined;let manager:DaemonManager|undefined;const ownedWorkers=new Map<string,CapturedProcessIdentity>();const ports=[];
const childExited=()=>child!==undefined&&(childExitObserved||child.exitCode!==null||child.signalCode!==null||spawnError!==undefined);
const childDiagnostic=()=>({exitCode:child?.exitCode,signal:child?.signalCode,exitObserved:childExitObserved,closeObserved:childCloseObserved,spawnError:spawnError?.message,outputTail:output});
for(let i=0;i<4;i++){const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('')});ports.push(s.port!);await s.stop(true);}
try{await initializeConfigurationDatabase({configDbPath:join(root,'config.db')});
const launchEnvironment={...process.env,HOME:root,USERPROFILE:root,BUNGEE_CONFIG_DB_PATH:join(root,'config.db'),BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),WORKER_COUNT:'1',HOST:'127.0.0.1',PORT:String(ports[0]),BUNGEE_MANAGEMENT_PORT:String(ports[1]),BUNGEE_MASTER_CONTROL_PORT:String(ports[2]),BUNGEE_INGRESS_SUPERVISION_PORT:String(ports[3]),BUNGEE_PLUGIN_SECRETS_KEY:Buffer.alloc(32,7).toString('base64'),BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../../../../plugins', import.meta.url)),LOG_LEVEL:'info'};
await initializePluginSecretsKey(join(root,'config.db'),launchEnvironment.BUNGEE_PLUGIN_SECRETS_KEY);
manager=new DaemonManager((executable,args,options)=>{
childExitObserved=false;childCloseObserved=false;spawnError=undefined;
child=spawn(executable,[...args],{...options,env:{...options.env,PLUGINS_DIR:launchEnvironment.PLUGINS_DIR},stdio:['ignore','pipe','pipe']});
const capture=(chunk:Buffer)=>{output=(output+chunk.toString('utf8')).slice(-8192);};
child.stdout!.on('data',capture);child.stderr!.on('data',capture);
const launched=child;
child.once('exit',()=>{if(child===launched)childExitObserved=true;});child.once('close',()=>{if(child===launched)childCloseObserved=true;});child.once('error',error=>{if(child===launched)spawnError=error;});
return child;
},undefined,{runtimeDirectory:join(root,'.bungee','run'),dataDirectory:root,logsDirectory:root,configDirectory:join(root,'.bungee'),pidFile:join(root,'.bungee','bungee.pid'),logFile:join(root,'.bungee','bungee.log'),errorLogFile:join(root,'.bungee','bungee.error.log'),directLaunch:{executable:process.execPath,entrypoint:fileURLToPath(new URL('../../../src/main.ts',import.meta.url))},inheritedEnvironment:launchEnvironment,startupTimeoutMs:FIXTURE_STARTUP_WAIT_MS});
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
const mutateWhenReady=async(path:string,init:RequestInit)=>{
  let last:unknown;
  for(let attempt=0;attempt<100;attempt++){
    const response=await fetch(base+path,init);
    if(response.status!==503)return response;
    const body=await response.clone().json();last=body;
    // These readiness refusals happen before commit; preserve the mutation ID.
    if(body.error!=='control_recovering'||!['admission_recovering','retired_pending','lease_margin'].includes(body.reason))return response;
    await Bun.sleep(100);
  }
  throw Error('mutation admission did not become ready '+path+' '+JSON.stringify(last)+' '+output);
};
await waitServing();
const mode=await (await fetch(base+'/api/auth/mode')).json();if(mode.mode!=='anonymous')throw Error('initial mode '+JSON.stringify(mode));
const removed=await fetch(base+'/api/keys');if(removed.status!==404)throw Error('legacy key API remains');
const setup={username:'owner',password:'Owner password 123!',passwordConfirmation:'Owner password 123!'};
if((await fetch(base+'/api/config')).status!==200)throw Error('anonymous configuration unavailable');
for(const invalidSetup of [
 {operation:'initialize',...setup,password:'tiny',passwordConfirmation:'tiny'},
 {operation:'initialize',...setup,passwordConfirmation:'Wrong confirmation'},
 {operation:'initialize',...setup,username:'invalid user'},
]){
 const rejected=await mutateWhenReady('/api/plugins/user-auth/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID(),managementSetup:invalidSetup})});
 if(rejected.status!==422)throw Error('initialization validation '+rejected.status+' '+await rejected.text());
 if((await fetch(base+'/api/config')).status!==200)throw Error('invalid initialization changed management mode');
}
const enabled=await mutateWhenReady('/api/plugins/user-auth/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID(),managementSetup:{operation:'initialize',...setup}})});
if(enabled.status!==202)throw Error('online initialization '+enabled.status+' '+await enabled.text());
if((await fetch(base+'/api/config')).status!==401)throw Error('initialized protection bypass');
const accountMode=await (await fetch(base+'/api/auth/mode')).json();if(accountMode.mode!=='plugin'||accountMode.initialized!==true||accountMode.provider.loginComponent!=='UserAuthLogin')throw Error('account mode '+JSON.stringify(accountMode));
const signed=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password:setup.password,transport:'bearer'})});const session=await signed.json();if(!session.success)throw Error('login '+JSON.stringify(session));
const authHeaders={authorization:'Bearer '+session.token};
const members=await fetch(base+'/api/plugins/user-auth/control/self',{headers:authHeaders});if(members.status!==200)throw Error('self '+members.status+' '+await members.text());
await waitServing(authHeaders);
const initial=await (await fetch(base+'/api/config',{headers:authHeaders})).json();
const nextAggregate={...initial.config,plugin_activations:[]};
const fullPut=await mutateWhenReady('/api/config',{method:'PUT',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({expected_revision:initial.revision,mutation_id:crypto.randomUUID(),aggregate:nextAggregate})});if(fullPut.status!==422)throw Error('full PUT bypass '+fullPut.status);
const envelopeBase={format:'bungee-config-snapshot',format_version:1,schema_version:1,exported_at:Date.now(),source_revision:initial.revision,content_hash:hashConfigurationContent(nextAggregate),aggregate:nextAggregate};
const imported=await mutateWhenReady('/api/config/import',{method:'POST',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({expected_revision:initial.revision,mutation_id:crypto.randomUUID(),envelope:{...envelopeBase,envelope_hash:hashConfigurationContent(envelopeBase)}})});if(imported.status!==422)throw Error('import bypass '+imported.status);
const disabled=await mutateWhenReady('/api/plugins/user-auth/disable',{method:'POST',headers:{...authHeaders,'content-type':'application/json'},body:JSON.stringify({expected_revision:initial.revision,mutation_id:crypto.randomUUID()})});if(disabled.status!==422)throw Error('online disable '+disabled.status+' '+await disabled.text());
if((await fetch(base+'/api/config')).status!==401)throw Error('online protection lost');
await manager.stop();
const offline=await AsyncConfigRepository.open(join(root,'config.db'),{offline:true});
let releasedRevision:number;
try{releasedRevision=(await offline.setManagementProviderOffline(null,crypto.randomUUID(),Date.now())).snapshot.revision;}finally{await offline.close();}
await manager.start({workers:'1'});
await waitServing({},releasedRevision);
const restored=await fetch(base+'/api/config');if(restored.status!==200)throw Error('offline release '+restored.status);
const budgetEnable=await mutateWhenReady('/api/plugins/token-budget/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID()})});if(budgetEnable.status!==202)throw Error('budget enable '+budgetEnable.status+' '+await budgetEnable.text()+' '+output);
const serving=await waitServing();
const issued=await fetch(base+'/api/plugins/key-access/control/credentials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Budget'})});const issuedBody=await issued.json();if(issued.status!==201)throw Error('issued '+issued.status+' '+JSON.stringify(issuedBody));const budgetKey=issuedBody.key;
const policy=await fetch(base+'/api/plugins/token-budget/control/keys/'+budgetKey.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'cumulative',limit:100})});if(policy.status!==200)throw Error('policy '+policy.status+' '+await policy.text());
const policyRead=await (await fetch(base+'/api/plugins/token-budget/control/keys/'+budgetKey.id,{})).json();if(policyRead.value.policy.limit!==100)throw Error('policy not persisted '+JSON.stringify(policyRead));
const duplicateInitialization=await mutateWhenReady('/api/plugins/user-auth/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID(),managementSetup:{operation:'initialize',...setup}})});
if(duplicateInitialization.status!==409)throw Error('duplicate initialization '+duplicateInitialization.status+' '+await duplicateInitialization.text());
if((await fetch(base+'/api/config')).status!==200)throw Error('duplicate initialization changed management mode');
const rejectedEnable=await mutateWhenReady('/api/plugins/user-auth/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID(),managementSetup:{operation:'verify',username:setup.username,password:'Wrong password for reenable'}})});
if(rejectedEnable.status!==422)throw Error('existing identity verification '+rejectedEnable.status+' '+await rejectedEnable.text());
if((await fetch(base+'/api/config')).status!==200)throw Error('rejected enable changed anonymous mode');
const reenabled=await mutateWhenReady('/api/plugins/user-auth/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mutation_id:crypto.randomUUID(),managementSetup:{operation:'verify',username:setup.username,password:setup.password}})});
if(reenabled.status!==202)throw Error('verified reenable '+reenabled.status+' '+await reenabled.text());
const reauthenticated=await (await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:setup.username,password:setup.password,transport:'bearer'})})).json();
if(!reauthenticated.success)throw Error('reenabled login failed');
await waitServing({authorization:'Bearer '+reauthenticated.token});
if((await fetch(base+'/api/config')).status!==401)throw Error('reenabled protection missing');
for(const path of ['/__bungee/internal/plugin-control/v1','/__bungee/internal/worker-state/v1']){const response=await fetch('http://127.0.0.1:'+ports[2]+path,{method:'POST'});if(response.status!==404)throw Error('removed business transport '+path+' '+response.status);}
console.log('REAL_MASTER_PASS online first activation, protected full PUT/import/disable, offline release, anonymous management, dependency activation, dynamic key policy');


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
