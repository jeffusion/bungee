import { afterEach, describe, expect, test } from 'bun:test';
import type { AppConfig, PluginConfig } from '@jeffusion/bungee-types';
import { PluginDependencyGraph } from '../../src/plugin-dependencies';
import { createRuntimeEligibleConfig } from '../../src/plugin-runtime-config';
import type { PluginRegistry } from '../../src/plugin-registry';
import { ScopedPluginRegistry, type PluginClass } from '../../src/scoped-plugin-registry';

const records = [
  {name: 'adapter', version: '1.0.0', runtimeScope: 'global-and-scoped' as const, mainPath: '/adapter.ts', services: {provides: [{id:'convert',version:1,process:'worker' as const}]}},
  {name: 'consumer', version: '1.0.0', dependencies: {adapter: '^1.0.0'}, services: {consumes: [{plugin:'adapter',id:'convert',version:1,process:'worker' as const}]}},
];
const metadata = {getAllPluginManifests: () => new Map(records.map(value=>[value.name,value])), getPluginStateSnapshot:()=>({validation:'validated'})} as unknown as PluginRegistry;
const registries: ScopedPluginRegistry[] = [];
afterEach(async()=>{for(const registry of registries.splice(0)) await registry.destroy(10);});
function setup(failProvider = false) {
  const registry = new ScopedPluginRegistry(); registries.push(registry); registry.setRetryOptions({retryCount:0});
  const events: string[] = [];
  let handle: {read():number} | undefined;
  registry.ensurePluginClassLoaded = async (config: PluginConfig | string) => {
    const name = typeof config === 'string' ? config : config.name;
    return {name, version:'1.0.0', configSchema: name === 'adapter' ? [{name:'source',type:'string',label:'Source',required:true}] : [],
      async createHandler(config, context) {
        events.push(`${name}:${context.scope!.type}:${context.initializationKind}`);
        if(name==='adapter' && context.scope!.type==='global') {
          context.services!.publish('convert',1,{read:()=>42});
          if(failProvider) throw new Error('provider failed after publication');
        }
        if(name==='consumer') handle=context.services!.consume('adapter','convert',1);
        return {pluginName:name,config,bodyRequirements(){return {request:'none'};},register(){}};
      },
    } satisfies PluginClass;
  };
  return {registry,events,handle:()=>handle};
}
function runtime(input: AppConfig): AppConfig {return createRuntimeEligibleConfig(input,metadata,new Set(['adapter','consumer']));}

describe('global-and-scoped runtime placement',()=>{
  test('automatic provider precedes consumers and each route/service/upstream application while remaining unique',async()=>{
    const {registry,events,handle}=setup();
    const config=runtime({plugins:[{name:'consumer'}],services:[{name:'service',plugins:[{name:'adapter',options:{source:'s'}}],endpoints:[{target:'http://test',plugins:[{name:'adapter',options:{source:'u'}}]}]}],routes:[{path:'/bound',service:'service',plugins:[{name:'adapter',options:{source:'r'}}]},{path:'/unbound',endpoints:[{target:'http://test'}]}]});
    expect(await registry.initializeFromConfig(config,new PluginDependencyGraph(records))).toEqual({success:5,failed:0});
    expect(events).toEqual(['adapter:global:automatic-provider','consumer:global:configured','adapter:route:configured','adapter:service:configured','adapter:upstream:configured']);
    expect(registry.getGlobalInstances().filter(value=>value.handler.pluginName==='adapter')).toHaveLength(1);
    expect(handle()!.read()).toBe(42);
    await registry.destroy(10);
    expect(()=>handle()!.read()).toThrow('revoked');
  });
  test('an explicit global configuration reuses the provider instance and validates application fields',async()=>{
    const {registry,events}=setup();
    expect(await registry.initializeFromConfig(runtime({plugins:[{name:'adapter',options:{source:'g'}},{name:'consumer'},{name:'adapter',options:{source:'duplicate'}}],routes:[]}),new PluginDependencyGraph(records))).toEqual({success:2,failed:0});
    expect(events).toEqual(['adapter:global:configured','consumer:global:configured']);
  });
  test('a disabled explicit global binding leaves only the automatic provider enabled',async()=>{
    const {registry,events,handle}=setup();
    const config=runtime({plugins:[{name:'adapter',enabled:false,options:{source:'disabled'}},{name:'consumer'}],routes:[]});
    expect(config.plugins?.find(binding=>typeof binding==='object'&&binding.name==='adapter')).toMatchObject({enabled:true});
    expect(await registry.initializeFromConfig(config,new PluginDependencyGraph(records))).toEqual({success:2,failed:0});
    expect(events).toEqual(['adapter:global:automatic-provider','consumer:global:configured']);
    expect(registry.getGlobalInstances().find(value=>value.handler.pluginName==='adapter')?.handler.config).toEqual({});
    expect(handle()!.read()).toBe(42);
  });
  test.each(['global','route','service','upstream'] as const)('missing explicit %s application configuration is rejected',async scope=>{
    const {registry}=setup();
    await expect(registry.createInstance(scope==='global'?{type:scope}:scope==='route'?{type:scope,routeId:'/r'}:scope==='service'?{type:scope,routeId:'/r',serviceName:'s'}:{type:scope,routeId:'/r',upstreamId:'u'},{name:'adapter'})).rejects.toThrow('Required field');
  });
  test('failed publication is revoked and the dependent consumer never starts',async()=>{
    const {registry,events}=setup(true);
    expect(await registry.initializeFromConfig(runtime({plugins:[{name:'consumer'}],routes:[]}),new PluginDependencyGraph(records))).toEqual({success:0,failed:2});
    expect(events).toEqual(['adapter:global:automatic-provider']);
    expect(registry.serviceHost.isReady('adapter','global')).toBe(false);
  });
  test('new runtime generation does not share provider handles with the destroyed old generation',async()=>{
    const old=setup(),next=setup();const config=runtime({plugins:[{name:'consumer'}],routes:[]});const graph=new PluginDependencyGraph(records);
    await old.registry.initializeFromConfig(config,graph);await next.registry.initializeFromConfig(config,graph);
    await old.registry.destroy(10);
    expect(()=>old.handle()!.read()).toThrow('revoked');expect(next.handle()!.read()).toBe(42);
  });
});

test.each(['route','upstream'] as const)('legacy %s hot reload validates explicit application fields before creating a replacement',async scope=>{
  const {registry,events}=setup();
  if(scope==='route') await registry.hotReloadRoutePlugins('/r',[{name:'adapter'}]);
  else await registry.hotReloadUpstreamPlugins('/r','u',[{name:'adapter'}]);
  expect(events).toEqual([]);
  expect(registry.getPluginRuntimeStateSnapshot('adapter').servingScopes).toEqual([]);
});
