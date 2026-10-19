import {conversionService} from '../../../llm-protocol-adapter/server/service';
import {expect,test} from 'bun:test';
import {CatalogView,capabilitiesServiceOf} from '../../../models-dev/server/local';
import {buildCatalogIndex} from '../../../models-dev/server/catalog';
import {parseBindings,bindingSource} from '../../server/config';
import {mergeCatalog,catalogEtag,CatalogSnapshots} from '../../server/catalog';
const view=new CatalogView();
view.apply(buildCatalogIndex({version:1,fetchedAt:1,catalog:{lab:{models:{'org/model':{name:'Model',limit:{context:32000,output:4000},tool_call:true,reasoning:true,modalities:{input:['text','image']}}}}}}));
const catalog=capabilitiesServiceOf(view);const service=conversionService(catalog,true);
const bindings=parseBindings([{provider:'lab',model:'org/model',target:{type:'service',id:'target',protocol:'responses'},capabilityOverrides:{contextWindow:16000,images:false,reasoning:false}}]);
test('rich native metadata is preserved; original slash ID and intersected capabilities are advertised',()=>{
  const native={models:[{slug:'native',visibility:'hidden',supported_in_api:false,extra:{x:1}}],other:'keep'};
  const result=mergeCatalog(native,bindings,service) as any;
  expect(result.models[0]).toEqual(native.models[0]);expect(result.other).toBe('keep');
  expect(result.models[1]).toMatchObject({slug:'org/model',context_window:16000,input_modalities:['text'],supported_reasoning_levels:[],supports_search_tool:false});
  expect(native.models).toHaveLength(1);
});
test('generic directory stays data[], refresh failure retains capability view and an empty view adds nothing',()=>{
  view.fail('network');expect(catalog.status().state).toBe('stale');
  expect((mergeCatalog({data:[]},bindings,service) as any).data[0].id).toBe('org/model');
  expect(mergeCatalog({models:[]},bindings,conversionService(capabilitiesServiceOf(new CatalogView()),true))).toEqual({models:[]});
});
test('aliases are optional, duplicate and native-conflicting identifiers fail closed',()=>{
  expect(()=>parseBindings([bindings[0],bindings[0]])).toThrow('conflict');
  expect(()=>mergeCatalog({models:[{slug:'org/model'}]},bindings,service)).toThrow('conflict');
  const alias=parseBindings([{...bindings[0],alias:'my-model'}]);expect((mergeCatalog({models:[]},alias,service) as any).models[0]).toMatchObject({slug:'my-model',display_name:'Model'});
});
test('catalog validators reject malformed inputs and ETag hashes the exact serialized body',()=>{
  expect(()=>parseBindings([{...bindings[0],capabilityOverrides:{images:'yes'}}])).toThrow();
  expect(catalogEtag('{}')).toBe('"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"');
  expect(catalogEtag('{}')).toBe(catalogEtag('{}'));
  expect(catalogEtag('{}')).not.toBe(catalogEtag('{ }'));
  const native={models:[{slug:'native'}]};
  const before=catalogEtag(JSON.stringify(mergeCatalog(native,bindings,service)));
  view.apply(buildCatalogIndex({version:2,fetchedAt:2,catalog:{lab:{models:{'org/model':{name:'Model',limit:{context:32000,output:4000},tool_call:true,reasoning:true,modalities:{input:['text','image']}}}}}}));
  expect(catalogEtag(JSON.stringify(mergeCatalog(native,bindings,service)))).toBe(before);
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
  for(const info of [null,{...service.resolveCapabilities({...bindings[0],targetProtocol:bindings[0].target.protocol})!,contextWindow:null},{...service.resolveCapabilities({...bindings[0],targetProtocol:bindings[0].target.protocol})!,inputModalities:['audio']}]){
    const unavailable={...service,resolveCapabilities:()=>info} as any;
    const original={models:[{slug:'gpt-native',context_window:999999,input_modalities:['text','image'],supports_search_tool:true},{slug:'untouched'}]};
    expect((mergeCatalog(original,binding,unavailable) as any).models).toEqual([{slug:'untouched'}]);
    expect((mergeCatalog({data:[{id:'gpt-native'},{id:'untouched'}]},binding,unavailable) as any).data).toEqual([{id:'untouched'}]);
    expect(original.models).toHaveLength(2);
  }
});

test('source protocol defaults to Responses and binding target accepts only supported receiving protocols', () => {
  for (const protocol of ['responses', 'chat_completions', 'anthropic_messages'] as const) {
    expect(parseBindings([{ ...bindings[0], sourceProtocol: 'responses', target: { ...bindings[0].target, protocol } }])[0].target.protocol).toBe(protocol);
  }
  expect(() => parseBindings([{ ...bindings[0], target: { type: 'service', id: 'target' } }])).toThrow('target_protocol_required');
  expect(() => parseBindings([{ ...bindings[0], sourceProtocol: 'chat_completions' }])).toThrow('source_protocol_unsupported');
  expect(() => parseBindings([{ ...bindings[0], target: { ...bindings[0].target, protocol: 'unknown' } }])).toThrow('target_protocol_invalid');
});

test('equal source and destination IDs add a model while preserving the native directory', () => {
  const added = parseBindings([{ ...bindings[0], source: 'org/model' }]);
  const native = { models: [{ slug: 'gpt-native', extra: 'keep' }] };
  const result = mergeCatalog(native, added, service) as any;
  expect(result.models[0]).toEqual(native.models[0]);
  expect(result.models[1]).toMatchObject({ slug: 'org/model', display_name: 'Model', context_window: 16000 });
  expect(bindingSource(added[0])).toBe(added[0].model);
  expect((mergeCatalog({ data: [{ id: 'gpt-native' }] }, added, service) as any).data)
    .toEqual([{ id: 'gpt-native' }, { id: 'org/model', object: 'model', owned_by: 'lab' }]);
});


test('upstream snapshots retain ETags for revalidation after ten minutes without extending TTL on reads', () => {
  let now = 0;
  const snapshots = new CatalogSnapshots(() => now);
  snapshots.put('account-a', {models: []}, 'W/"upstream"');
  const first = snapshots.get('account-a')!;
  expect(first.upstreamEtag).toBe('W/"upstream"');
  now = 599_999; expect(snapshots.fresh(first)).toBe(true);
  expect(snapshots.get('account-b')).toBeUndefined();
  now = 600_000; expect(snapshots.fresh(first)).toBe(false);
  expect(snapshots.get('account-a')).toBe(first);
  snapshots.put('account-a', first.native, first.upstreamEtag);
  expect(snapshots.fresh(snapshots.get('account-a')!)).toBe(true);
  snapshots.invalidate('account-a'); expect(snapshots.get('account-a')).toBeUndefined();
  snapshots.put('account-a', {}, null); snapshots.clear();
  expect(snapshots.get('account-a')).toBeUndefined();
});

test('upstream snapshot storage is bounded and evicts the least recently used identity', () => {
  const snapshots = new CatalogSnapshots();
  for (let i = 0; i < 32; i++) snapshots.put(String(i), {}, null);
  snapshots.get('0'); snapshots.put('32', {}, null);
  expect(snapshots.get('0')).toBeDefined(); expect(snapshots.get('1')).toBeUndefined();
});

test('snapshot byte budget counts UTF-8, evicts LRU entries and releases replaced, invalidated and cleared bytes', () => {
  const snapshots = new CatalogSnapshots(Date.now, 10);
  snapshots.put('a', '中', null); snapshots.put('b', '中', null); // Five serialized UTF-8 bytes each.
  snapshots.get('a'); snapshots.put('c', 'a', null);
  expect(snapshots.get('b')).toBeUndefined(); expect(snapshots.get('a')?.native).toBe('中');
  snapshots.put('a', 'a', null); snapshots.put('d', 'a', null);
  for (const key of ['a', 'c', 'd']) expect(snapshots.get(key)).toBeDefined();
  snapshots.invalidate('c'); snapshots.put('e', 'a', null);
  for (const key of ['a', 'd', 'e']) expect(snapshots.get(key)).toBeDefined();
  snapshots.clear(); snapshots.put('full', '12345678', '"boundary"');
  expect(snapshots.get('full')?.upstreamEtag).toBe('"boundary"');
  snapshots.put('full', '123456789', null);
  expect(snapshots.get('full')).toBeUndefined();
  snapshots.put('next', '12345678', null);
  expect(snapshots.get('next')).toBeDefined();
});
