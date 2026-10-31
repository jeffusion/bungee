import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getAssetName, getBinaryName } from '../../../src/updates/names';
import { DaemonManager } from '../../../../cli/src/daemon/manager';
import { readDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import { createBinaryArchive } from '../../../../../scripts/build/build-binaries';
import { buildExternalPlugins } from '../../../../../scripts/build/build-external-plugins';
import { BinaryManager } from '../../../../cli/src/binary/manager';
import { PluginStateClient } from '../../../src/plugin-state/client';
import { makeCanonicalTempDir } from '../../../../../tests/helpers/daemon-fixture';

let root: string, bytes: Buffer, server: ReturnType<typeof Bun.serve>;
let origin: string;
let downloadGate: Promise<void> | null = null;
let releaseDownload: (() => void) | null = null;
let downloadRequests = 0;
const binary = getBinaryName();
const project = resolve(import.meta.dir,'../../../../..');

beforeAll(async () => {
  root=makeCanonicalTempDir('bungee-runtime-updates');
  const workers=['config-storage-worker.js','plugin-state-worker.js','observability-worker.js'].map(name=>join(project,'packages/core/dist',name));
  await buildExternalPlugins({outputDirectory:join(root,'plugins')});
  for (const version of ['6.6.0','6.6.1']) {
    mkdirSync(join(root,version));
    const staging=join(root,version,'build');mkdirSync(staging);
    const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'../../fixtures/updates-runtime.ts')],
      outdir:staging,naming:'main.js',target:'bun',
      plugins:[{name:'fixture-release-identity',setup(builder){builder.onLoad({filter:/[/\\]core-version\.ts$/},()=>({contents:`export const CORE_HOST_VERSION = '${version}';`,loader:'ts'}));}}]});
    if(!result.success) throw new Error(result.logs.join('\n'));
    for(const worker of workers)cpSync(worker,join(staging,worker.split('/').at(-1)!));
    const compiler=Bun.spawn([process.execPath,'build','--compile',join(staging,'main.js'),...workers.map(worker=>join(staging,worker.split('/').at(-1)!)),
      '--outfile',join(root,version,binary)],{stdout:'pipe',stderr:'pipe'});
    if(await compiler.exited!==0)throw new Error(await new Response(compiler.stderr).text());
    rmSync(staging,{recursive:true,force:true});
    cpSync(join(root,'plugins'),join(root,version,'plugins'),{recursive:true});
  }
  const archive=join(root,'release.tar.gz');
  await createBinaryArchive({binaryPath:join(root,'6.6.1',binary),pluginsDirectory:join(root,'6.6.1','plugins'),archivePath:archive,binaryName:binary});
  bytes=readFileSync(archive);
  server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    if(new URL(request.url).pathname==='/archive'){downloadRequests++;await downloadGate;return new Response(new Uint8Array(bytes));}
    if(new URL(request.url).pathname==='/latest')return Response.json({tag_name:'v6.6.1',draft:false,prerelease:false,published_at:'2026-10-26T00:00:00Z',
      html_url:'https://github.com/jeffusion/bungee/releases/tag/v6.6.1',assets:[{name:getAssetName(),state:'uploaded',size:bytes.length,
        digest:`sha256:${createHash('sha256').update(bytes).digest('hex')}`,browser_download_url:`https://github.com/jeffusion/bungee/releases/download/v6.6.1/${getAssetName()}`}]});
    return new Response('unexpected fixture request',{status:501});
  }});origin=server.url.origin;
},120_000);
afterAll(async()=>{await server?.stop(true);if(root)rmSync(root,{recursive:true,force:true});});

async function port():Promise<number>{const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});const value=probe.port!;await probe.stop(true);return value;}
async function until<T>(read:()=>Promise<T>,valid:(value:T)=>boolean,timeout=45_000):Promise<T>{
  const end=performance.now()+timeout;let failure:unknown;
  while(performance.now()<end){try{const value=await read();if(valid(value))return value;}catch(error){failure=error;}await Bun.sleep(100);}
  throw new Error(`Update runtime did not converge: ${String(failure)}`);
}

for(const trigger of ['page','defaults','stop'] as const)test(`real update lifecycle: ${trigger}`,async()=>{
  const instance=join(root,trigger),data=join(instance,'data'),logs=join(instance,'logs'),run=join(instance,'run');
  mkdirSync(data,{recursive:true});mkdirSync(logs);mkdirSync(run);
  cpSync(join(root,'6.6.0'),join(instance,'bin','6.6.0'),{recursive:true});
  writeFileSync(join(instance,'version.txt'),'6.6.0\n');
  const key=Buffer.alloc(32,7).toString('base64');writeFileSync(join(data,'plugin-secrets.key'),key,{mode:0o600});
  const ports=new Set<number>();while(ports.size<4)ports.add(await port());const [publicPort,managementPort,controlPort,ingressPort]=[...ports];
  const env={...process.env,NODE_ENV:'test',BUNGEE_INSTALL_ROOT:instance,BUNGEE_TEST_UPDATE_ORIGIN:origin,
    BUNGEE_CONFIG_DB_PATH:join(data,'bungee.db'),BUNGEE_ACCESS_DB_PATH:join(logs,'access.db'),BUNGEE_MANAGEMENT_HOST:'127.0.0.1',
    BUNGEE_MANAGEMENT_PORT:String(managementPort),BUNGEE_MASTER_CONTROL_PORT:String(controlPort),BUNGEE_INGRESS_SUPERVISION_PORT:String(ingressPort),
    BUNGEE_PLUGIN_SECRETS_KEY:key,WORKER_COUNT:'1',PORT:String(publicPort),BUNGEE_ROLE:'master'};
  const executable=join(instance,'bin','6.6.0',binary);chmodSync(executable,0o755);
  const init=Bun.spawn([executable,'--initialize-config',join(data,'bungee.db')],{cwd:data,env,stdout:'pipe',stderr:'pipe'});
  const initialized=await init.exited;
  const initOutput=await new Response(init.stdout).text()+await new Response(init.stderr).text();
  if(initialized!==0)throw new Error(`Fixture init failed (${initialized}, ${init.signalCode}): ${initOutput}`);
  expect(initOutput).not.toContain('bng_management_');
  const state=await PluginStateClient.open(join(data,'plugin-state.db'));
  try{expect(await state.durableState('user-auth').list()).toEqual([]);}finally{await state.close();}
  let child:ChildProcess|undefined;
  const manager=new DaemonManager((file,args,options)=>child=spawn(file,[...args],options),undefined,{configDirectory:instance,dataDirectory:data,logsDirectory:logs,runtimeDirectory:run,
    pidFile:join(instance,'bungee.pid'),logFile:join(logs,'daemon.log'),errorLogFile:join(logs,'daemon-error.log'),
    inheritedEnvironment:env,directLaunch:{executable,entrypoint:null}});
  const endpoint=`http://127.0.0.1:${managementPort}`;
  const metadataPath=join(run,'daemon.json');
  try{
    if(trigger==='defaults'){
      const launch=Bun.spawn(['node',join(project,'packages/cli/dist/index.js'),'start','--workers','1','--port',String(publicPort)],
        {cwd:data,env,stdout:'pipe',stderr:'pipe'});
      if(await launch.exited!==0)throw new Error(`Default CLI start failed: ${await new Response(launch.stdout).text()} ${await new Response(launch.stderr).text()}`);
    }else await manager.start({workers:'1',port:String(publicPort)});
    const prior=await readDaemonMetadataFile(join(run,'daemon.json'),{runtimeDirectory:run});
    await until(async()=>fetch(`${endpoint}/api/system/updates`).then(response=>response.json()),value=>value.latest?.version==='6.6.1');
    if(trigger==='stop')downloadGate=new Promise<void>(resolve=>releaseDownload=resolve);
    const priorDownloads=downloadRequests;
    if(trigger==='defaults'){
      const upgrade=Bun.spawn(['node',join(project,'packages/cli/dist/index.js'),'upgrade'],{cwd:data,env,stdout:'pipe',stderr:'pipe'});
      if(await upgrade.exited!==0)throw new Error(`Default CLI upgrade failed: ${await new Response(upgrade.stdout).text()} ${await new Response(upgrade.stderr).text()}`);
    }else{
      const response=await fetch(`${endpoint}/api/system/updates`,{method:'POST',headers:{origin:endpoint,'content-type':'application/json'},
        body:JSON.stringify({operation_id:crypto.randomUUID(),current_version:'6.6.0',target_version:'6.6.1'})});
      expect(response.status).toBe(202);
    }
    if(trigger==='stop'){
      await until(async()=>downloadRequests,value=>value>priorDownloads);
      await manager.stop();releaseDownload!();downloadGate=null;
      expect(JSON.parse(readFileSync(join(instance,'update.json'),'utf8')).phase).toBe('cancelled');
      expect(readFileSync(join(instance,'version.txt'),'utf8').trim()).toBe('6.6.0');
      return;
    }
    if(trigger==='page'){
      const waiting=await until(async()=>fetch(`${endpoint}/api/system/updates`).then(response=>response.json()),value=>value.operation?.phase==='awaiting_confirmation');
      expect((await fetch(`${endpoint}/health/data`)).status).toBe(200);
      expect(readFileSync(join(instance,'version.txt'),'utf8').trim()).toBe('6.6.0');
      expect((await readDaemonMetadataFile(metadataPath,{runtimeDirectory:run})).boot_nonce).toBe(prior.boot_nonce);
      const confirmed=await fetch(`${endpoint}/api/system/updates/confirm`,{method:'POST',headers:{origin:endpoint,'content-type':'application/json'},
        body:JSON.stringify({operation_id:waiting.operation.id,current_version:'6.6.0',target_version:'6.6.1'})});
      expect(confirmed.status).toBe(202);
    }
    const status=await until(async()=>fetch(`${endpoint}/api/system/updates`).then(response=>response.json()),value=>['succeeded','failed','cancelled'].includes(value.operation?.phase));
    expect(status.operation.phase).toBe('succeeded');
    expect(status.running_version).toBe('6.6.1');expect(readFileSync(join(instance,'version.txt'),'utf8').trim()).toBe('6.6.1');
    const next=await readDaemonMetadataFile(join(run,'daemon.json'),{runtimeDirectory:run});
    expect(next.pid).toBe(prior.pid);expect(next.boot_nonce).not.toBe(prior.boot_nonce);expect(next.executable).toBe(join(instance,'bin','6.6.1',binary));
    const runtime=await fetch(`${endpoint}/api/config/runtime`).then(response=>response.json());expect(runtime.workers).toHaveLength(1);
    expect((await fetch(`${endpoint}/health/data`)).status).toBe(200);
    await manager.stop();
    const priorRoot=process.env.BUNGEE_INSTALL_ROOT;
    try{process.env.BUNGEE_INSTALL_ROOT=instance;expect(await BinaryManager.ensureBinary()).toBe(next.executable);}
    finally{if(priorRoot===undefined)delete process.env.BUNGEE_INSTALL_ROOT;else process.env.BUNGEE_INSTALL_ROOT=priorRoot;}
    const installed=new DaemonManager(undefined,undefined,{configDirectory:instance,dataDirectory:data,logsDirectory:logs,runtimeDirectory:run,
      pidFile:join(instance,'bungee.pid'),logFile:join(logs,'daemon.log'),errorLogFile:join(logs,'daemon-error.log'),inheritedEnvironment:env,
      directLaunch:{executable:next.executable,entrypoint:null}});
    await installed.start({workers:'1',port:String(publicPort)});await installed.stop();
  }catch(error){
    const output=existsSync(join(logs,'daemon-error.log'))?readFileSync(join(logs,'daemon-error.log'),'utf8'):'';throw new Error(`${String(error)}\n${output}`);
  }finally{
    releaseDownload?.();releaseDownload=null;downloadGate=null;
    try{await manager.stop();}catch(error){if(child?.pid){child.kill('SIGTERM');await until(async()=>{try{process.kill(child!.pid!,0);return false;}catch{return true;}},Boolean,5_000);}else throw error;}
  }
},120_000);
