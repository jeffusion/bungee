import {expect,test} from 'bun:test';
import {CatalogView,capabilitiesServiceOf} from '../../models-dev/server/local';
import {buildCatalogIndex} from '../../models-dev/server/catalog';
import {parseBindings} from '../server/config';
import {mergeCatalog,catalogEtag} from '../server/catalog';
const view=new CatalogView();
view.apply(buildCatalogIndex({version:1,fetchedAt:1,catalog:{lab:{models:{'org/model':{name:'Model',limit:{context:32000,output:4000},tool_call:true,reasoning:true,modalities:{input:['text','image']}}}}}}));
const service=capabilitiesServiceOf(view);
const bindings=parseBindings([{provider:'lab',model:'org/model',target:{type:'service',id:'target'},capabilityOverrides:{contextWindow:16000,images:false,reasoning:false}}]);
test('rich native metadata is preserved; original slash ID and intersected capabilities are advertised',()=>{
  const native={models:[{slug:'native',visibility:'hidden',supported_in_api:false,extra:{x:1}}],other:'keep'};
  const result=mergeCatalog(native,bindings,service) as any;
  expect(result.models[0]).toEqual(native.models[0]);expect(result.other).toBe('keep');
  expect(result.models[1]).toMatchObject({slug:'org/model',context_window:16000,input_modalities:['text'],supported_reasoning_levels:[],supports_search_tool:false});
  expect(native.models).toHaveLength(1);
});
test('generic directory stays data[], refresh failure retains capability view and an empty view adds nothing',()=>{
  view.fail('network');expect(service.status().state).toBe('stale');
  expect((mergeCatalog({data:[]},bindings,service) as any).data[0].id).toBe('org/model');
  expect(mergeCatalog({models:[]},bindings,capabilitiesServiceOf(new CatalogView()))).toEqual({models:[]});
});
test('aliases are optional, duplicate and native-conflicting identifiers fail closed',()=>{
  expect(()=>parseBindings([bindings[0],bindings[0]])).toThrow('conflict');
  expect(()=>mergeCatalog({models:[{slug:'org/model'}]},bindings,service)).toThrow('conflict');
  const alias=parseBindings([{...bindings[0],alias:'my-model'}]);expect((mergeCatalog({models:[]},alias,service) as any).models[0].slug).toBe('my-model');
});
test('catalog validators reject malformed inputs and ETag includes catalog/client versions',()=>{
  expect(()=>parseBindings([{...bindings[0],capabilityOverrides:{images:'yes'}}])).toThrow();
  expect(catalogEtag({},1,'a')).not.toBe(catalogEtag({},2,'a'));expect(catalogEtag({},1,'a')).not.toBe(catalogEtag({},1,'b'));
});
