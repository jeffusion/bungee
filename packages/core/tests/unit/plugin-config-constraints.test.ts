import { afterEach, describe, expect, test } from 'bun:test';
import { pluginConfigConstraintSatisfied, type PluginConfigConstraint } from '@jeffusion/bungee-types';
import { parsePluginManifestText } from '../../src/plugin-manifest-catalog/manifest-parser';
import { buildPluginManifestCatalog } from '../../src/plugin-manifest-catalog';
import { ConfigRepository, ConfigRepositoryError, parseNormalizeCompile, parseNormalizeCompileAggregate } from '../../src/config-storage';
import { createMasterPluginCatalogApi } from '../../src/master-runtime/master-plugin-catalog-api';
import { cleanupCatalogRoots, manifest, tempRoot, writePlugin } from './plugin-manifest-catalog-fixtures';

const schema = ['source','target'].map(name=>({name,type:'select',label:name,required:true,options:['a','b','c'].map(value=>({label:value,value}))}));
const constraints: readonly PluginConfigConstraint[] = [{type:'allowed-tuples',fields:['source','target'],tuples:[['a','b'],['b','c']],message:'Unsupported conversion'}];
const pluginManifest = () => manifest('adapter',{runtimeScope:'global-and-scoped',configSchema:schema,configConstraints:constraints});
const binding = (id: number, options = {source:'a',target:'c'}) => ({id:`10000000-0000-4000-8000-${String(id).padStart(12,'0')}`,name:'adapter',options});
const uuid = (id:number)=>`20000000-0000-4000-8000-${String(id).padStart(12,'0')}`;
afterEach(cleanupCatalogRoots);

describe('independent-field tuple whitelist',()=>{
  test('strict manifest parses and freezes constraints without combining config fields',()=>{
    const parsed=parsePluginManifestText(JSON.stringify(pluginManifest()));
    expect(parsed.configSchema.map(field=>field.name)).toEqual(['source','target']);
    expect(parsed.configConstraints).toEqual(constraints);expect(Object.isFrozen(parsed.configConstraints![0]!.tuples[0])).toBe(true);
  });
  test.each([
    {type:'other',fields:['source','target'],tuples:[['a','b']]},
    {type:'allowed-tuples',fields:['source','missing'],tuples:[['a','b']]},
    {type:'allowed-tuples',fields:['source','source'],tuples:[['a','a']]},
    {type:'allowed-tuples',fields:['source'],tuples:[['a']]},
    {type:'allowed-tuples',fields:['source','target'],tuples:[]},
    {type:'allowed-tuples',fields:['source','target'],tuples:[['a']]},
    {type:'allowed-tuples',fields:['source','target'],tuples:[['a','unknown']]},
    {type:'allowed-tuples',fields:['source','target'],tuples:[['a','b'],['a','b']]},
    {type:'allowed-tuples',fields:['source','target'],tuples:[['a',{}]]},
  ])('rejects malformed or unreachable constraint declarations %#',constraint=>{
    expect(()=>parsePluginManifestText(JSON.stringify({...pluginManifest(),configConstraints:[constraint]}))).toThrow('configConstraints');
  });
  test('compiler rejects unsupported tuples at all owners and accepts supported tuples',async()=>{
    const root=tempRoot();writePlugin(root,'adapter',pluginManifest());const catalog=await buildPluginManifestCatalog({scanDirectories:[root]});
    const input={plugins:[binding(1)],services:[{id:uuid(1),name:'service',plugins:[binding(2)],endpoints:[{id:uuid(2),target:'http://test',plugins:[binding(3)]}]}],routes:[{id:uuid(3),path:'/route',plugins:[binding(4)],endpoints:[{id:uuid(4),target:'http://test',plugins:[binding(5)]}]}]};
    const compiled=parseNormalizeCompile(input,catalog.toCompileOptions());expect(compiled.ok).toBe(false);
    if(!compiled.ok) expect(compiled.errors.map(error=>error.path)).toEqual(['plugins[0].options','services[0].plugins[0].options','services[0].endpoints[0].plugins[0].options','routes[0].plugins[0].options','routes[0].endpoints[0].plugins[0].options']);
    expect(parseNormalizeCompile({plugins:[binding(1,{source:'a',target:'b'})]},catalog.toCompileOptions()).ok).toBe(true);
    expect(parseNormalizeCompile({plugins:[binding(1,{source:'b',target:'c'})]},catalog.toCompileOptions()).ok).toBe(true);
  });
  test('repository save/publication rejects a forged uncompiled unsupported tuple before revision or operation changes',async()=>{
    const root=tempRoot();writePlugin(root,'adapter',pluginManifest());const catalog=await buildPluginManifestCatalog({scanDirectories:[root]});
    const repository=ConfigRepository.open(`${tempRoot()}/config.db`,{compileOptions:catalog.toCompileOptions()});
    try {
      const compiled=parseNormalizeCompileAggregate({logical_configuration:{plugins:[binding(1,{source:'a',target:'b'})]},plugin_activations:[{plugin_name:'adapter'}]},catalog.toCompileOptions());
      if(!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
      const forged={...compiled.value,logical_configuration:{...compiled.value.logical_configuration,plugins:compiled.value.logical_configuration.plugins.map(plugin=>({...plugin,options:{source:'a',target:'c'}}))}};
      const before=repository.getSnapshot().revision;
      let caught: unknown;
      try {repository.commit({mutation_id:'bad-tuples',expected_revision:before,aggregate:forged as typeof compiled.value,kind:'config',created_at:Date.now(),target_worker_slots:[0]});} catch(error) {caught=error;}
      expect(caught).toBeInstanceOf(ConfigRepositoryError);
      expect((caught as ConfigRepositoryError).cause).toContainEqual(expect.objectContaining({code:'invalid_plugin_option',message:'Unsupported conversion'}));
      expect(repository.getSnapshot().revision).toBe(before);expect(repository.getActivePublication()).toBeNull();
    } finally {repository.close();}
  });
  test('directory API exposes new scope and constraints at global and every application boundary',async()=>{
    const root=tempRoot();writePlugin(root,'adapter',pluginManifest());const catalog=await buildPluginManifestCatalog({scanDirectories:[root]});
    const api=createMasterPluginCatalogApi({catalog});const state={aggregate:{plugin_activations:[{plugin_name:'adapter'}]}} as never;
    for(const scope of ['global','route','service','upstream']) {
      const response=await api.handle(new Request(`http://test/api/plugins/schemas?enabledOnly=true&scope=${scope}`),state);const result=await response.json();
      expect(result.adapter.runtimeScope).toBe('global-and-scoped');expect(result.adapter.configConstraints).toEqual(constraints);
    }
  });
  test('shared UI predicate matches scalar tuples exactly and treats partial groups as invalid',()=>{
    const rule=constraints[0]!;expect(pluginConfigConstraintSatisfied({source:'a',target:'b'},rule)).toBe(true);
    expect(pluginConfigConstraintSatisfied({source:'a',target:'c'},rule)).toBe(false);
    expect(pluginConfigConstraintSatisfied({source:'a'},rule)).toBe(false);
    expect(pluginConfigConstraintSatisfied({},rule)).toBe(true);
    const scalar:PluginConfigConstraint={type:'allowed-tuples',fields:['enabled','count'],tuples:[[false,0],[true,1]]};
    expect(pluginConfigConstraintSatisfied({enabled:false,count:0},scalar)).toBe(true);
    expect(pluginConfigConstraintSatisfied({enabled:'false',count:0},scalar)).toBe(false);
  });
});
