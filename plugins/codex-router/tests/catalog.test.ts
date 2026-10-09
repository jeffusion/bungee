import {expect,test} from 'bun:test';
import {CatalogView,capabilitiesServiceOf} from '../../models-dev/server/local';
import {buildCatalogIndex} from '../../models-dev/server/catalog';
import {parseBindings,bindingSource} from '../server/config';
import {mergeCatalog,catalogEtag} from '../server/catalog';
const view=new CatalogView();
view.apply(buildCatalogIndex({version:1,fetchedAt:1,catalog:{lab:{models:{'org/model':{name:'Model',limit:{context:32000,output:4000},tool_call:true,reasoning:true,modalities:{input:['text','image']}}}}}}));
const service=capabilitiesServiceOf(view);
const bindings=parseBindings([{provider:'lab',model:'org/model',target:{type:'service',id:'target',protocol:'responses'},capabilityOverrides:{contextWindow:16000,images:false,reasoning:false}}]);
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
  const alias=parseBindings([{...bindings[0],alias:'my-model'}]);expect((mergeCatalog({models:[]},alias,service) as any).models[0]).toMatchObject({slug:'my-model',display_name:'Model'});
});
test('catalog validators reject malformed inputs and ETag includes catalog/client versions',()=>{
  expect(()=>parseBindings([{...bindings[0],capabilityOverrides:{images:'yes'}}])).toThrow();
  expect(catalogEtag({},1,'a')).not.toBe(catalogEtag({},2,'a'));expect(catalogEtag({},1,'a')).not.toBe(catalogEtag({},1,'b'));
});
test('explicit source replaces one native model using target capabilities while preserving other entries',()=>{
  const binding=parseBindings([{...bindings[0],source:'gpt-native'}]);
  const native={models:[{slug:'gpt-native',context_window:999999,supports_search_tool:true},{slug:'untouched',extra:'keep'}],other:'keep'};
  const result=mergeCatalog(native,binding,service) as any;
  expect(result.models).toHaveLength(2);
  expect(result.models[0]).toMatchObject({slug:'gpt-native',context_window:16000,supports_search_tool:false});
  expect(result.models[0].display_name).toBe('Model');
  expect(result.models[1]).toEqual(native.models[1]);expect(result.other).toBe('keep');
  expect(native.models[0].context_window).toBe(999999);
  expect((mergeCatalog({data:[{id:'gpt-native'}]},binding,service) as any).data).toEqual([{id:'gpt-native',object:'model',owned_by:'lab'}]);
});
test('source is explicit and legacy alias/model bindings retain their match without ambiguity',()=>{
  expect(bindingSource(parseBindings([{...bindings[0],source:'original'}])[0])).toBe('original');
  expect(bindingSource(parseBindings([{...bindings[0],alias:'legacy'}])[0])).toBe('legacy');
  expect(bindingSource(bindings[0])).toBe('org/model');
  expect(()=>parseBindings([{...bindings[0],source:'same'},{...bindings[0],alias:'same'}])).toThrow('conflict');
  expect(()=>parseBindings([{...bindings[0],source:'a',alias:'b'}])).toThrow('invalid_bindings');
  expect(()=>parseBindings([{...bindings[0],source:' '}])).toThrow('invalid_bindings');
});
test('source provider is optional catalog metadata and does not change model matching or target capabilities',()=>{
  const selected=parseBindings([{...bindings[0],source:'original',sourceProvider:'original-provider'}]);
  expect(selected[0].sourceProvider).toBe('original-provider');
  expect(bindingSource(selected[0])).toBe('original');
  expect((mergeCatalog({models:[]},selected,service) as any).models[0]).toMatchObject({slug:'original',context_window:16000});
  expect(()=>parseBindings([{...selected[0]},{...selected[0],sourceProvider:'another-provider'}])).toThrow('conflict');
  for(const sourceProvider of ['', ' ', 42, 'bad\nprovider', 'x'.repeat(513)])expect(()=>parseBindings([{...selected[0],sourceProvider}])).toThrow('invalid_bindings');
  expect(()=>parseBindings([{...bindings[0],sourceProvider:'original-provider'}])).toThrow('invalid_bindings');
});
test('unavailable explicit replacements cannot advertise native capabilities or restore native routing',()=>{
  const binding=parseBindings([{...bindings[0],source:'gpt-native'}]);
  for(const info of [null,{...service.model(bindings[0])!,contextWindow:null},{...service.model(bindings[0])!,inputModalities:['audio']}]){
    const unavailable={...service,model:()=>info} as any;
    const original={models:[{slug:'gpt-native',context_window:999999,input_modalities:['text','image'],supports_search_tool:true},{slug:'untouched'}]};
    expect((mergeCatalog(original,binding,unavailable) as any).models).toEqual([{slug:'untouched'}]);
    expect((mergeCatalog({data:[{id:'gpt-native'},{id:'untouched'}]},binding,unavailable) as any).data).toEqual([{id:'untouched'}]);
    expect(original.models).toHaveLength(2);
  }
});

test('source protocol defaults to Responses and binding target accepts only supported receiving protocols', () => {
  for (const protocol of ['responses', 'chat_completions', 'anthropic_messages']) {
    expect(parseBindings([{ ...bindings[0], sourceProtocol: 'responses', target: { ...bindings[0].target, protocol } }])[0].target.protocol).toBe(protocol);
  }
  expect(() => parseBindings([{ ...bindings[0], target: { type: 'service', id: 'target' } }])).toThrow('target_protocol_required');
  expect(() => parseBindings([{ ...bindings[0], sourceProtocol: 'chat_completions' }])).toThrow('source_protocol_unsupported');
  expect(() => parseBindings([{ ...bindings[0], target: { ...bindings[0].target, protocol: 'unknown' } }])).toThrow('target_protocol_invalid');
});
