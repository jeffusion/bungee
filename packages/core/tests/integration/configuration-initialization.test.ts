import {fileURLToPath} from 'node:url';
import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeConfigurationDatabase} from '../../src/master-runtime/initialize-configuration';
import {acquireMasterInstanceLock} from '../../src/master-runtime/instance-lock';
import {PluginStateClient} from '../../src/plugin-state/client';
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
  const repository=ConfigRepository.open(path);try{expect(repository.getDatabase().query("SELECT name FROM sqlite_master WHERE name IN ('api_keys','plugin_durable_records','secret_store_objects')").all()).toEqual([]);}finally{repository.close();}
  const plugin=await PluginStateClient.open(join(dir,'plugin-state.db'));try{expect(await plugin.durableState('local-accounts').list()).toEqual([]);}finally{await plugin.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('built core exports inert storage initialization SDK and local CLI never emits management credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bungee-built-init-'));
 try {
  const build=await Bun.build({entrypoints:[fileURLToPath(new URL('../../src/main.ts', import.meta.url))],outdir:dir,target:'bun',format:'esm'});expect(build.success).toBe(true);
  for(const [entry,name] of [['config-storage/storage-worker.ts','config-storage-worker.js'],['plugin-state/worker.ts','plugin-state-worker.js'],['master-runtime/observability-worker.ts','observability-worker.js']] as const) {
   const worker=await Bun.build({entrypoints:[fileURLToPath(new URL('../../src/'+entry,import.meta.url))],outdir:dir,naming:name,target:'bun'});expect(worker.success).toBe(true);
  }
  const entry=join(dir,'main.js');const sdk=await import(entry);expect(typeof sdk.initializeConfigurationDatabase).toBe('function');
  const database=join(dir,'cli.db');const run=()=>Bun.spawn([process.execPath,entry,'--initialize-config',database],{stdout:'pipe',stderr:'pipe',env:{...process.env,BUNGEE_ROLE:'master'}});
  const first=run();const output=await new Response(first.stdout).text();expect(await first.exited).toBe(0);expect(output).not.toContain('bng_management_');
  const second=run();const repeated=await new Response(second.stdout).text();expect(await second.exited).toBe(0);expect(repeated).not.toContain('bng_management_');
  const binary=join(dir,'bungee-runtime');
  const compile=Bun.spawn([process.execPath,'build',entry,join(dir,'config-storage-worker.js'),join(dir,'plugin-state-worker.js'),join(dir,'observability-worker.js'),'--compile','--outfile',binary],{stdout:'pipe',stderr:'pipe'});expect(await compile.exited).toBe(0);
  const native=Bun.spawn([binary,'--initialize-config',join(dir,'native','bungee.db')],{stdout:'pipe',stderr:'pipe',env:{...process.env,BUNGEE_ROLE:'master'}});const nativeOutput=await new Response(native.stdout).text()+await new Response(native.stderr).text();expect(await native.exited).toBe(0);expect(nativeOutput).not.toContain('bng_management_');
  const state=await PluginStateClient.open(join(dir,'native','plugin-state.db'));try{expect(await state.durableState('local-accounts').list()).toEqual([]);}finally{await state.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
},30000);
