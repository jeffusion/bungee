import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeConfigurationDatabase} from '../../src/master-runtime/initialize-configuration';
import {acquireMasterInstanceLock} from '../../src/master-runtime/instance-lock';
import {ConfigRepository} from '../../src/config-storage';
test('local init migrates exact database without credentials and refuses a live database lock',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-management-init-'));const path=join(dir,'override.db');
 try {
  expect(await initializeConfigurationDatabase({configDbPath:path})).toBeUndefined();
  expect(await initializeConfigurationDatabase({configDbPath:path})).toBeUndefined();
  const lock=await acquireMasterInstanceLock(path+'.lock');
  try {await expect(initializeConfigurationDatabase({configDbPath:path})).rejects.toThrow();}finally{await lock.release();}
  const ingress=await acquireMasterInstanceLock(join(dir,'ingress.instance.lock'));
  try {await expect(initializeConfigurationDatabase({configDbPath:path})).rejects.toThrow('held');}finally{await ingress.release();}
  const repository=ConfigRepository.open(path);try{expect(repository.getDatabase().query('SELECT COUNT(*) AS count FROM api_keys').get()).toEqual({count:0});}finally{repository.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('built core exports inert storage initialization SDK and local CLI never emits management credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-built-init-'));
 try {
  const build=await Bun.build({entrypoints:[new URL('../../src/main.ts',import.meta.url).pathname],outdir:dir,target:'bun',format:'esm'});expect(build.success).toBe(true);
  const entry=join(dir,'main.js');const sdk=await import(entry);expect(typeof sdk.initializeConfigurationDatabase).toBe('function');
  const database=join(dir,'cli.db');const run=()=>Bun.spawn([process.execPath,entry,'--initialize-config',database],{stdout:'pipe',stderr:'pipe',env:{...process.env,BUNGEE_ROLE:'master'}});
  const first=run();const output=await new Response(first.stdout).text();expect(await first.exited).toBe(0);expect(output).not.toContain('bng_management_');
  const second=run();const repeated=await new Response(second.stdout).text();expect(await second.exited).toBe(0);expect(repeated).not.toContain('bng_management_');
 }finally{await rm(dir,{recursive:true,force:true});}
},10000);
