import {fileURLToPath, pathToFileURL} from 'node:url';
import {expect,test} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {__testEnsureWindowsAcl,__testReadWindowsAcl} from '../../packages/types/src/daemon-file';
import {readRecoveryInput} from '../../packages/core/src/master-runtime/offline-recovery';

test('native recovery input accepts 8192 bytes and cancels oversized streams before parsing',async()=>{
 const json='{"kind":"identity"}';
 const body=Buffer.from(json+' '.repeat(8192-Buffer.byteLength(json)));
 const valid=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(body.subarray(0,4096));controller.enqueue(body.subarray(4096));controller.close();}});
 await expect(readRecoveryInput(valid)).resolves.toEqual({kind:'identity'});
 expect(valid.locked).toBe(false);
 let cancelled=false;
 const oversized=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(Buffer.alloc(8193));},cancel(){cancelled=true;}});
 await expect(readRecoveryInput(oversized)).rejects.toThrow('recovery_input_too_large');
 expect(cancelled).toBe(true);expect(oversized.locked).toBe(false);
});

test('CLI recovery file input rejects public files and symlinks, accepts owner-only stdin FD',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-file-'));
 const entry=fileURLToPath(new URL('../../packages/core/src/main.ts', import.meta.url));
 const command=fileURLToPath(new URL('../../packages/cli/src/commands/recover.ts', import.meta.url));
 try {
  await mkdir(join(dir,'.bungee','data'),{recursive:true});
  const file=join(dir,'recovery.json'),link=join(dir,'linked.json');
  await writeFile(file,JSON.stringify({kind:'identity',plugin:'local-accounts',payload:{username:'admin',password:'File recovery password 2026!',reason:'Recover test administrator'}}),{mode:0o644});await symlink(file,link);
  if(process.platform==='win32') {
   const grant=Bun.spawn(['icacls.exe',file,'/grant','*S-1-1-0:(R)'],{stdout:'pipe',stderr:'pipe'});
   const output=await new Response(grant.stdout).text()+await new Response(grant.stderr).text();
   expect(await grant.exited,output).toBe(0);
  }
  const env={...process.env,HOME:dir,USERPROFILE:dir,BUNGEE_CONFIG_DB_PATH:join(dir,'config.db'),BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../plugins', import.meta.url))};
  const run=async(path:string)=>{
   const source=`import {recoverCommand} from ${JSON.stringify(pathToFileURL(command).href)};await recoverCommand({file:process.argv[1],directLaunch:{executable:process.execPath,entrypoint:${JSON.stringify(entry)}}});`;
   const child=Bun.spawn([process.execPath,'-e',source,path],{stdout:'pipe',stderr:'pipe',env});
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
  const result=await run(file);expect(result.code,result.stderr).toBe(0);expect(result.stdout).toContain('"username":"admin"');expect(result.stdout+result.stderr).not.toContain('recovery password');
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);

test('compiled native core recovers plugin identity and keeps secrets out of logs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-native-recover-'));
 try {
  const binary=join(dir,process.platform==='win32'?'core.exe':'core');
  const built=await Bun.build({entrypoints:[fileURLToPath(new URL('../../packages/core/src/main.ts', import.meta.url))],compile:{outfile:binary}});
  expect(built.success).toBe(true);
  const db=join(dir,'config.db');
  const env={...process.env,BUNGEE_ROLE:'master',BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:fileURLToPath(new URL('../../plugins', import.meta.url))};
  // This rejects before reading stdin: a pass establishes the compiled entrypoint
  // and argv path separately from the pipe reader's lifecycle.
  const invalidArgs=Bun.spawn([binary,'--recover'],{stdin:'ignore',stdout:'pipe',stderr:'pipe',env});
  const invalidArgsOut=await new Response(invalidArgs.stdout).text(),invalidArgsError=await new Response(invalidArgs.stderr).text();
  expect(await invalidArgs.exited,'Compiled recovery entrypoint must reject missing database arguments before reading stdin').toBe(1);
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
  const result=await run({kind:'identity',plugin:'local-accounts',payload:{username:'admin',password:'Native recovery password 2026!',reason:'Recover test administrator'}});
  expect(result.code,result.stderr).toBe(0);
  expect(await Bun.file(db).exists(),'Recovery must reach durable storage before reporting success').toBe(true);
  expect(result.stdout).toContain('"username":"admin"');expect(result.stdout+result.stderr).not.toContain('recovery password');
  const denied=await run({kind:'identity',plugin:'local-accounts',payload:{password:'RECOVERY-SECRET-MUST-NOT-LEAK'}});
  expect(denied.code).toBe(1);expect(denied.stdout+denied.stderr).not.toContain('RECOVERY-SECRET-MUST-NOT-LEAK');
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);
