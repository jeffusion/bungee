import {afterEach,beforeEach,describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigRepository} from '../../src/config-storage';
import {acquireMasterInstanceLock} from '../../src/master-runtime/instance-lock';
import {initializeConfigurationDatabase} from '../../src/master-runtime/initialize-configuration';
import {prepareRuntimeUpgrade} from '../../src/master-runtime/runtime-upgrade';
import {PluginStateClient} from '../../src/plugin-state/client';

describe('offline runtime upgrade preparation',()=>{
  let dir:string,path:string,pluginPath:string;
  let locks:Record<'configuration'|'access'|'plugin-state'|'ingress',string>;
  let previousEnv:Record<string,string|undefined>;
  const clients:PluginStateClient[]=[];
  const envNames=['BUNGEE_ACCESS_DB_PATH','BUNGEE_INGRESS_INSTANCE_LOCK_PATH','BUNGEE_PLUGIN_SECRETS_KEY'];
  beforeEach(()=>{
    dir=mkdtempSync(join(tmpdir(),'bungee-runtime-upgrade-'));path=join(dir,'config.db');pluginPath=join(dir,'plugin-state.db');
    locks={configuration:path+'.lock',access:join(dir,'access.db.lock'),'plugin-state':pluginPath+'.lock',ingress:join(dir,'ingress.lock')};
    previousEnv=Object.fromEntries(envNames.map(name=>[name,process.env[name]]));
    process.env.BUNGEE_ACCESS_DB_PATH=join(dir,'access.db');
    process.env.BUNGEE_INGRESS_INSTANCE_LOCK_PATH=locks.ingress;
    delete process.env.BUNGEE_PLUGIN_SECRETS_KEY;
  });
  afterEach(async()=>{
    try {for(const client of clients.splice(0))await client.close();}
    finally {
      for(const name of envNames) {
        if(previousEnv[name]===undefined)delete process.env[name];else process.env[name]=previousEnv[name];
      }
      rmSync(dir,{recursive:true,force:true});
    }
  });
  test.each(['configuration','access','plugin-state','ingress'] as const)(
    'a held %s lock refuses preparation before either database is opened',async(kind)=>{
      const held=await acquireMasterInstanceLock(locks[kind]);
      try {
        await expect(prepareRuntimeUpgrade(path)).rejects.toMatchObject({code:'held',path:locks[kind]});
        expect(await Bun.file(path).exists()).toBe(false);
        expect(await Bun.file(pluginPath).exists()).toBe(false);
        // Acquisition failure must also release any preceding instance locks.
        for(const [name,lockPath] of Object.entries(locks)) {
          if(name===kind)continue;
          const available=await acquireMasterInstanceLock(lockPath);await available.release();
        }
      }finally{await held.release();}
    },
  );
  test('all proof pages are prepared once while configuration and business state survive',async()=>{
    await initializeConfigurationDatabase({configDbPath:path});
    const repository=ConfigRepository.open(path);
    const snapshot=repository.getSnapshot();repository.close();
    const state=await PluginStateClient.open(pluginPath);clients.push(state);
    await state.durableState('owner').transact([{key:'business',expectedVersion:0,value:{balance:19}}]);
    const store=state.channelStore('host:rpc:executors');
    const saved=[];
    for(let n=0;n<129;n++) {
      const source={process:'control' as const,instance:`owner-${n}`,catalog:'catalog',generation:1};
      const key=createHash('sha256').update(JSON.stringify(['control',source.instance,'catalog',1])).digest('hex');
      const physical={pid:123,startToken:'fixture-start',executable:'/fixture/control',processInstanceId:'00000000-0000-4000-8000-000000000001'};
      const boot='linux:00000000-0000-4000-8000-000000000002';
      await store.put(key,new TextEncoder().encode(JSON.stringify({source,physical,boot})),{required:true});
      saved.push({key,source,physical,boot});
    }
    await state.close();
    expect(await prepareRuntimeUpgrade(path)).toEqual({converted_executor_proofs:129});
    expect(await prepareRuntimeUpgrade(path)).toEqual({converted_executor_proofs:0});
    const checked=ConfigRepository.open(path);
    try{expect(checked.getSnapshot()).toEqual(snapshot);}finally{checked.close();}
    const reopened=await PluginStateClient.open(pluginPath);clients.push(reopened);
    expect(await reopened.durableState('owner').get('business')).toEqual({key:'business',version:1,value:{balance:19}});
    const prepared=reopened.channelStore('host:rpc:executors');
    for(const {key,source,physical,boot} of saved) {
      const record=await prepared.get(key);
      expect(record?.required).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(record!.payload))).toEqual({source,physical,boot,guard:null,retired:false});
    }
    await reopened.close();
    for(const lockPath of Object.values(locks)) {
      const available=await acquireMasterInstanceLock(lockPath);await available.release();
    }
  });
});
