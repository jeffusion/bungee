import {expect,test} from 'bun:test';
import {mkdtemp,rm,mkdir,writeFile,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('CLI recovery file input rejects public files and symlinks, accepts 0600 stdin FD',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-recover-file-'));
 const entry=new URL('../../packages/core/src/main.ts',import.meta.url).pathname;
 const command=new URL('../../packages/cli/src/commands/recover.ts',import.meta.url).pathname;
 try {
  await mkdir(join(dir,'.bungee','data'),{recursive:true});
  const file=join(dir,'recovery.json'),link=join(dir,'linked.json');
  await writeFile(file,JSON.stringify({kind:'identity',plugin:'local-accounts',payload:{username:'admin',password:'File recovery password 2026!',reason:'Recover test administrator'}}),{mode:0o644});await symlink(file,link);
  const env={...process.env,HOME:dir,BUNGEE_CONFIG_DB_PATH:join(dir,'config.db'),BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:new URL('../../plugins',import.meta.url).pathname};
  const run=async(path:string)=>{
   const source=`import {recoverCommand} from ${JSON.stringify(command)};await recoverCommand({file:process.argv[1],directLaunch:{executable:process.execPath,entrypoint:${JSON.stringify(entry)}}});`;
   const child=Bun.spawn([process.execPath,'-e',source,path],{stdout:'pipe',stderr:'pipe',env});
   const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
   return {code:await child.exited,stdout,stderr};
  };
  expect((await run(file)).code).toBe(1);expect(await Bun.file(join(dir,'config.db')).exists()).toBe(false);
  await chmod(file,0o600);
  expect((await run(link)).code).toBe(1);expect(await Bun.file(join(dir,'config.db')).exists()).toBe(false);
  const result=await run(file);expect(result.code).toBe(0);expect(result.stdout).toContain('"username":"admin"');expect(result.stdout+result.stderr).not.toContain('recovery password');
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);

test('compiled native core recovers plugin identity and keeps secrets out of logs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-native-recover-'));
 try {
  const binary=join(dir,'core');
  const built=await Bun.build({entrypoints:[new URL('../../packages/core/src/main.ts',import.meta.url).pathname],compile:{outfile:binary}});
  expect(built.success).toBe(true);
  const env={...process.env,BUNGEE_ROLE:'master',BUNGEE_INCLUDE_SYSTEM_PLUGINS:'false',PLUGINS_DIR:new URL('../../plugins',import.meta.url).pathname};
  const run=async(value:unknown)=>{
   const child=Bun.spawn([binary,'--recover',join(dir,'config.db')],{stdin:new Blob([JSON.stringify(value)]),stdout:'pipe',stderr:'pipe',env});
   const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();
   return {code:await child.exited,stdout,stderr};
  };
  const result=await run({kind:'identity',plugin:'local-accounts',payload:{username:'admin',password:'Native recovery password 2026!',reason:'Recover test administrator'}});expect(result.code).toBe(0);expect(result.stdout).toContain('"username":"admin"');expect(result.stdout+result.stderr).not.toContain('recovery password');
  const denied=await run({kind:'identity',plugin:'local-accounts',payload:{password:'RECOVERY-SECRET-MUST-NOT-LEAK'}});
  expect(denied.code).toBe(1);expect(denied.stdout+denied.stderr).not.toContain('RECOVERY-SECRET-MUST-NOT-LEAK');
 }finally{await rm(dir,{recursive:true,force:true});}
},15000);
