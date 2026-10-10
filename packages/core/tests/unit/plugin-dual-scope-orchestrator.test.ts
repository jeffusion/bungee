import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PluginRuntimeOrchestrator } from '../../src/plugin-runtime-orchestrator';
import { cleanupCatalogRoots, manifest, tempRoot, writePlugin } from './plugin-manifest-catalog-fixtures';

afterEach(cleanupCatalogRoots);
test('dual provider failure rejects runtime hot reload and retains the serving generation',async()=>{
  const root=tempRoot();const plugins=join(root,'plugins');
  const schema=[{name:'source',type:'string',label:'Source',required:true},{name:'fail',type:'boolean',label:'Fail'}];
  writePlugin(plugins,'dual-provider',manifest('dual-provider',{runtimeScope:'global-and-scoped',configSchema:schema,services:{provides:[{id:'convert',version:1,process:'worker'}]}}),`
export default class Provider {
  static name='dual-provider';static version='1.0.0';static configSchema=${JSON.stringify(schema)};
  static async createHandler(config,context) {
    if(context.scope.type==='global') {
      context.services.publish('convert',1,{read:()=>42});
      if(config.fail) throw new Error('new provider failed');
    }
    return {pluginName:'dual-provider',config,bodyRequirements(){return {request:'none'};},register(){}};
  }
}
`);
  writePlugin(plugins,'dual-consumer',manifest('dual-consumer',{dependencies:{'dual-provider':'^1.0.0'},services:{consumes:[{plugin:'dual-provider',id:'convert',version:1,process:'worker'}]}}),`
export default class Consumer {
  static name='dual-consumer';static version='1.0.0';
  static async createHandler(config,context) {
    const service=context.services.consume('dual-provider','convert',1);
    return {pluginName:'dual-consumer',config,read:()=>service.read(),bodyRequirements(){return {request:'none'};},register(){}};
  }
}
`);
  const orchestrator=new PluginRuntimeOrchestrator(root,undefined,['dual-provider','dual-consumer']);
  try {
    const first=await orchestrator.applyConfig({plugins:[{name:'dual-consumer'}],routes:[{path:'/r',plugins:[{name:'dual-provider',options:{source:'a'}}],endpoints:[{target:'http://test'}]}]});
    expect(first.runtime).toEqual({success:3,failed:0});
    const original=orchestrator.getScopedRegistry()!;original.setHotReloadDestroyDelayMs(0);
    const consumer=original.getGlobalInstances().find(instance=>instance.handler.pluginName==='dual-consumer')!;
    const read=(consumer.handler as unknown as {read():number}).read;
    expect(read()).toBe(42);
    await expect(orchestrator.applyConfig({plugins:[{name:'dual-consumer'},{name:'dual-provider',options:{source:'a',fail:true}}],routes:[]})).rejects.toThrow('Activated global plugins failed to start: dual-provider');
    expect(orchestrator.getScopedRegistry()).toBe(original);expect(orchestrator.getStatusReport().generation).toBe(1);expect(read()).toBe(42);
    const next=await orchestrator.applyConfig({plugins:[{name:'dual-consumer'},{name:'dual-provider',options:{source:'a'}}],routes:[]});
    expect(next.generation).toBe(2);
    await new Promise(resolve=>setTimeout(resolve,20));
    expect(()=>read()).toThrow('revoked');
    const nextConsumer=orchestrator.getScopedRegistry()!.getGlobalInstances().find(instance=>instance.handler.pluginName==='dual-consumer')!;
    expect((nextConsumer.handler as unknown as {read():number}).read()).toBe(42);
  } finally {await orchestrator.destroy();}
});
