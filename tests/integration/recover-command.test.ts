import {runRecoveryInTerminal, identityRecoveryAnswers} from '../helpers/recovery-terminal';
import {setPolicy,publication,stateRpc,readKey} from '../../plugins/token-budget/server/ledger';
import {createIngress} from '../../plugins/token-budget/server/policy';
import {PluginStateClient} from '../../packages/core/src/plugin-state/client';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {expect,test} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {__testEnsureWindowsAcl,__testReadWindowsAcl} from '../../packages/types/src/daemon-file';
import {readRecoveryInput} from '../../packages/core/src/master-runtime/offline-recovery';
import {initializePluginSecretsKey} from '../../packages/cli/src/config/plugin-secrets-key';

test('recovery input accepts 8192 bytes and closes oversized iterators before parsing',async()=>{
 const json='{"kind":"identity"}';
 const body=Buffer.from(json+' '.repeat(8192-Buffer.byteLength(json)));
 async function* valid(){yield body.subarray(0,4096);yield body.subarray(4096);}
 await expect(readRecoveryInput(valid())).resolves.toEqual({kind:'identity'});
 let closed=false,readBeyondLimit=false;
 async function* oversized(){try{yield Buffer.alloc(8193);readBeyondLimit=true;}finally{closed=true;}}
 await expect(readRecoveryInput(oversized())).rejects.toThrow('recovery_input_too_large');
 expect(closed).toBe(true);expect(readBeyondLimit).toBe(false);
});

test('CLI file recovery rejects public files, symlinks and identity JSON; plugin state and terminal reset succeed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-file-'));
 const entry=fileURLToPath(new URL('../../packages/core/src/main.ts', import.meta.url));
 const command=fileURLToPath(new URL('../../packages/cli/src/commands/recover.ts', import.meta.url));
 try {
  await mkdir(join(dir,'.bungee','data'),{recursive:true});
  const file=join(dir,'recovery.json'),link=join(dir,'linked.json');
  await writeFile(file,JSON.stringify({kind:'identity',plugin:'user-auth',payload:{operation:'reset',username:'admin',password:'File recovery password 2026!',passwordConfirmation:'File recovery password 2026!',reason:'Recover test administrator'}}),{mode:0o644});await symlink(file,link);
  if(process.platform==='win32') {
   const grant=Bun.spawn(['icacls.exe',file,'/grant','*S-1-1-0:(R)'],{stdout:'pipe',stderr:'pipe'});
   const output=await new Response(grant.stdout).text()+await new Response(grant.stderr).text();
   expect(await grant.exited,output).toBe(0);
  }
  const env={...process.env,HOME:dir,USERPROFILE:dir,BUNGEE_CONFIG_DB_PATH:join(dir,'config.db'),BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../plugins', import.meta.url))};
  const run=async(path?:string,body?:string)=>{
   const source=`import {recoverCommand} from ${JSON.stringify(pathToFileURL(command).href)};await recoverCommand({file:process.argv[1],directLaunch:{executable:process.execPath,entrypoint:${JSON.stringify(entry)}}});`;
   const child=Bun.spawn([process.execPath,'-e',source,...(path?[path]:[])],{stdin:body?new Blob([body]):'ignore',stdout:'pipe',stderr:'pipe',env});
   const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
   return {code:await child.exited,stdout,stderr};
  };
  expect((await run(file)).code).toBe(1);expect(await Bun.file(join(dir,'config.db')).exists()).toBe(false);
  if(process.platform==='win32') {
   // An elevated Windows runner can create files owned by Administrators.
   // DACL repair intentionally preserves ownership, so establish it explicitly.
   const {currentSid}=await __testReadWindowsAcl(file);
   const owner=Bun.spawn(['icacls.exe',file,'/setowner','*'+currentSid],{stdout:'pipe',stderr:'pipe'});
   const output=await new Response(owner.stdout).text()+await new Response(owner.stderr).text();
   expect(await owner.exited,output).toBe(0);
   await __testEnsureWindowsAcl(file,'file');
   const acl=await __testReadWindowsAcl(file);
   expect(acl.ownerSid).toBe(acl.currentSid);
  }else await chmod(file,0o600);
  expect((await run(link)).code).toBe(1);expect(await Bun.file(join(dir,'config.db')).exists()).toBe(false);
  const missingKey=await run();expect(missingKey.code).toBe(1);expect(missingKey.stderr).toContain('Plugin secrets key is missing');
  expect(await Bun.file(join(dir,'config.db')).exists()).toBe(false);
  const persistedKey=await initializePluginSecretsKey(join(dir,'config.db'));
  const initialize=Bun.spawn([process.execPath,entry,'--initialize-config',join(dir,'config.db')],{stdout:'pipe',stderr:'pipe',env});
  const [initError,initOutput]=await Promise.all([new Response(initialize.stderr).text(),new Response(initialize.stdout).text()]);
  expect(await initialize.exited,initError+initOutput).toBe(0);
  const denied=await run(file);expect(denied.code).toBe(1);expect(denied.stdout+denied.stderr).not.toContain('recovery password');
  const pipedPassword='Piped synthetic recovery password 2026!';
  const piped=await run(undefined,JSON.stringify({kind:'identity',plugin:'user-auth',payload:{operation:'reset',username:'admin',password:pipedPassword,passwordConfirmation:pipedPassword,reason:'Rejected stdin reset'}}));
  expect(piped.code).toBe(1);expect(piped.stdout+piped.stderr).not.toContain(pipedPassword);
  const unchanged=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect(await unchanged.durableState('user-auth').list()).toEqual([]);}finally{await unchanged.close();}
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{
   const budget=state.durableState('token-budget');
   const target={requestId:'request',attemptId:'attempt',principal:{domain:'data' as const,keyId:'key',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'upstream',url:'https://example.test',model:null,now:Date.UTC(2026,0,31)};
   await setPolicy(budget,'key',{mode:'monthly',limit:100});
   const snapshot=createIngress().plan(target,(await publication(budget)).value,null).snapshot!;
   await stateRpc('prepare',{snapshot},{state:budget,...target});
  }finally{await state.close();}
  await writeFile(file,JSON.stringify({kind:'plugin-state',plugin:'token-budget',payload:{keyId:'key',requestId:'request',attemptId:'attempt',inputTokens:3,outputTokens:4,reason:'Verified upstream usage'}}));
  const reconciled=await run(file);expect(reconciled.code,reconciled.stderr).toBe(0);
  const settled=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect(await readKey(settled.durableState('token-budget'),'key')).toMatchObject({cumulative:7,monthly:{'2026-01':7},unresolved:{}});}finally{await settled.close();}
  const checkedEntry=join(dir,'checked-recovery.ts');
  await writeFile(checkedEntry,`if(process.env.BUNGEE_PLUGIN_SECRETS_KEY!==await Bun.file(${JSON.stringify(join(dir,'plugin-secrets.key'))}).text())throw new Error('Recovery did not use the instance key');
const child=Bun.spawn([process.execPath,${JSON.stringify(entry)},...process.argv.slice(2)],{stdin:'inherit',stdout:'inherit',stderr:'inherit',env:process.env});process.exit(await child.exited);`);
  const interactive=`import {recoverCommand} from ${JSON.stringify(pathToFileURL(command).href)};await recoverCommand({plugin:'user-auth',action:'reset',directLaunch:{executable:process.execPath,entrypoint:${JSON.stringify(checkedEntry)}}});`;
  const password='File recovery password 2026!';
  const inheritedKey=Buffer.alloc(32,91).toString('base64');
  const result=await runRecoveryInTerminal([process.execPath,'-e',interactive],{env:{...env,BUNGEE_PLUGIN_SECRETS_KEY:inheritedKey}},identityRecoveryAnswers('admin',password,'Recover test administrator'));
  expect(result.code,result.output).toBe(0);expect(result.output).toContain('"username":"admin"');expect(result.output).not.toContain(password);
  expect(result.output).not.toContain(persistedKey);expect(result.output).not.toContain(inheritedKey);
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);

test('compiled native core recovers plugin identity and keeps secrets out of logs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-native-recover-'));
 try {
  const binary=join(dir,process.platform==='win32'?'core.exe':'core');
  // Match scripts/build/build-binaries.ts. Bun 1.4.2's CLI folds the entrypoint's
  // import.meta.main to true; its API compile path leaves a runtime path check
  // that compares mismatched Windows VFS separators and silently skips main.
  const entry=fileURLToPath(new URL('../../packages/core/dist/main.js', import.meta.url));
  const target=`bun-${process.platform==='win32'?'windows':process.platform}-${process.arch}`;
  const build=Bun.spawn([process.execPath,'build','--compile',`--target=${target}`,entry,...['config-storage-worker.js','plugin-state-worker.js','observability-worker.js'].map(name=>fileURLToPath(new URL('../../packages/core/dist/'+name,import.meta.url))),'--outfile',binary],{stdout:'pipe',stderr:'pipe'});
  const [buildOut,buildError]=await Promise.all([new Response(build.stdout).text(),new Response(build.stderr).text()]);
  expect(await build.exited,`Native recovery build failed: ${buildOut}${buildError}`).toBe(0);
  const db=join(dir,'config.db');
  const env={...process.env,BUNGEE_ROLE:'master',BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../packages/core/dist/plugins', import.meta.url))};
  // This rejects before reading stdin: a pass establishes the compiled entrypoint
  // and argv path separately from the pipe reader's lifecycle.
  const invalidArgs=Bun.spawn([binary,'--recover'],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env});
  const invalidArgsOut=await new Response(invalidArgs.stdout).text(),invalidArgsError=await new Response(invalidArgs.stderr).text();
  const invalidArgsCode=await invalidArgs.exited;
  const entrypointDiagnostic=JSON.stringify({platform:process.platform,arch:process.arch,bun:Bun.version,revision:Bun.revision,target,binary,code:invalidArgsCode,stdout:invalidArgsOut,stderr:invalidArgsError});
  expect(invalidArgsCode,`Compiled recovery entrypoint must reject missing database arguments before reading stdin: ${entrypointDiagnostic}`).toBe(1);
  expect(invalidArgsOut).not.toContain('"username"');
  expect(invalidArgsError).toContain('Offline recovery failed; no recovery input is logged.');
  expect(await Bun.file(db).exists()).toBe(false);
  const run=async(value:unknown)=>{
   const body=typeof value==='string'?value:JSON.stringify(value);
   const child=Bun.spawn([binary,'--recover',db],{stdin:new Blob([body]),stdout:'pipe',stderr:'pipe',env});
   const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
   return {code:await child.exited,stdout,stderr};
  };
  for(const body of ['{"password":"RECOVERY-SECRET-MUST-NOT-LEAK"', 'x'.repeat(8193)]) {
   const rejected=await run(body);
   expect(rejected.code,rejected.stderr).toBe(1);
   expect(await Bun.file(db).exists()).toBe(false);
   expect(rejected.stdout+rejected.stderr).not.toContain('RECOVERY-SECRET-MUST-NOT-LEAK');
  }
  const initialize=Bun.spawn([binary,'--initialize-config',db],{stdout:'pipe',stderr:'pipe',env});
  const [initError,initOutput]=await Promise.all([new Response(initialize.stderr).text(),new Response(initialize.stdout).text()]);
  expect(await initialize.exited,initError+initOutput).toBe(0);
  expect(await Bun.file(join(dir,'plugin-state.db')).exists()).toBe(true);
  const rejectedIdentity=await run({kind:'identity',plugin:'user-auth',payload:{operation:'reset',username:'admin',password:'Native recovery password 2026!',passwordConfirmation:'Native recovery password 2026!',reason:'Recover test administrator'}});
  expect(rejectedIdentity.code).toBe(1);expect(rejectedIdentity.stdout+rejectedIdentity.stderr).not.toContain('Native recovery password 2026!');
  const unchanged=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try{expect(await unchanged.durableState('user-auth').list()).toEqual([]);}finally{await unchanged.close();}
  const result=await runRecoveryInTerminal([binary,'--recover',db,'--plugin','user-auth','--action','reset'],{env},identityRecoveryAnswers('admin','Native recovery password 2026!','Recover test administrator'));
  expect(result.code,result.output).toBe(0);
  const state=await PluginStateClient.open(join(dir,'plugin-state.db'));
  try {
   const durable=state.durableState('user-auth');
   const anchor=await durable.get('recovery-anchor');
   expect(anchor?.value).toMatchObject({schema:3});
   const userId=(anchor!.value as {userId:string}).userId;
   expect(userId).toBeTruthy();
   const record=await durable.get('user:'+userId),credential=await durable.get('credential:'+userId);
   expect(record?.version,'Recovery must reach plugin durable storage before reporting success').toBe(1);
   expect(record!.value).toMatchObject({schema:3,user:{id:userId,username:'admin',disabled:false}});
   expect(credential!.value).toMatchObject({schema:3,credential:{temporary:false}});
   const hash=(credential!.value as {credential:{passwordHash:string}}).credential.passwordHash;
   expect(await Bun.password.verify('Native recovery password 2026!',hash)).toBe(true);
   const records=await durable.list();
   expect(records.filter(record=>record.key.startsWith('session:')).every(record=>(record.value as {session:unknown}).session===null)).toBe(true);
  }finally{await state.close();}
  expect(result.output).toContain('"username":"admin"');expect(result.output).not.toContain('Native recovery password 2026!');
  const denied=await run({kind:'identity',plugin:'user-auth',payload:{password:'RECOVERY-SECRET-MUST-NOT-LEAK'}});
  expect(denied.code).toBe(1);expect(denied.stdout+denied.stderr).not.toContain('RECOVERY-SECRET-MUST-NOT-LEAK');
 // All children have exited, but Windows can briefly retain executable/file handles.
 }finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
},15000);
