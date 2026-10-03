import {fileURLToPath} from 'node:url';
import {expect,test} from 'bun:test';
import {compile} from 'svelte/compiler';
import manifest from '../manifest.json';
const text = (key:string,values?:Record<string,string|number>) => manifest.translations['zh-CN'][key as keyof typeof manifest.translations['zh-CN']].replace(/\{(\w+)\}/g,(_,name)=>String(values?.[name] ?? ''));

import {automaticBurst,changeCustomBurst,changeRateUnit,createRateDraft,draftPolicy,formatRate} from '../ui/rate-policy';

test('new limits default to 60 per minute with automatic capacity',()=>{
  const draft=createRateDraft();
  expect(draft).toMatchObject({unit:'minute',quantity:60,burst:60,customBurst:false});
  expect(draftPolicy(draft)).toEqual({rps:1,burst:60,unit:'minute'});
  expect(draftPolicy({...draft,quantity:0.5})).toEqual({rps:0.5/60,burst:1,unit:'minute'});
  expect(automaticBurst(1.2)).toBe(2);
});

test('legacy and saved units retain exact stored rate and capacity without edits',()=>{
  for(const policy of [{rps:0.7,burst:3},{rps:0.7,burst:42,unit:'minute' as const},{rps:1.7,burst:2,unit:'second' as const}]){
    const draft=createRateDraft(policy);
    expect(draft.unit).toBe(policy.unit??'second');
    expect(draft.quantity).toBe(draft.unit==='minute'?policy.rps*60:policy.rps);
    expect(draft.customBurst).toBe(policy.burst!==automaticBurst(draft.quantity));
    expect(draftPolicy(draft)).toEqual({...policy,unit:policy.unit??'second'});
  }
  expect(formatRate({rps:1,burst:60,unit:'minute'},text,'zh-CN')).toBe('60 次 / 分钟');
  expect(formatRate({rps:0.5,burst:1},text,'zh-CN')).toBe('0.5 次 / 秒');
});

test('switching units preserves rate and capacity and enables custom capacity when needed',()=>{
  const original=createRateDraft();
  const seconds=changeRateUnit(original,'second')!;
  expect(seconds).toMatchObject({unit:'second',quantity:1,burst:60,customBurst:true});
  expect(draftPolicy(seconds)).toEqual({rps:1,burst:60,unit:'second'});
  expect(draftPolicy(changeRateUnit(seconds,'minute')!)).toEqual({rps:1,burst:60,unit:'minute'});
  const legacy=createRateDraft({rps:0.7,burst:1});
  const minutes=changeRateUnit(legacy,'minute')!;
  expect(minutes).toMatchObject({quantity:42,burst:1,customBurst:true});
  expect(draftPolicy(minutes)).toEqual({rps:0.7,burst:1,unit:'minute'});
  expect(draftPolicy(changeRateUnit(minutes,'second')!)).toEqual({rps:0.7,burst:1,unit:'second'});
  const edited=changeRateUnit({...original,quantity:30},'second')!;
  expect(draftPolicy(edited)).toEqual({rps:0.5,burst:30,unit:'second'});
});

test('custom capacity toggles start with current automatic value and preserve explicit values',()=>{
  const custom=changeCustomBurst({...createRateDraft(),quantity:3.5},true);
  expect(custom).toMatchObject({customBurst:true,burst:4});
  expect(draftPolicy({...custom,burst:8})).toEqual({rps:3.5/60,burst:8,unit:'minute'});
  expect(draftPolicy(changeCustomBurst({...custom,burst:8},false))).toEqual({rps:3.5/60,burst:4,unit:'minute'});
  expect(draftPolicy(changeRateUnit({...custom,burst:8},'second')!)).toEqual({rps:3.5/60,burst:8,unit:'second'});
});

test('invalid quantities, capacities and underflowing minute rates cannot be saved',()=>{
  const draft=createRateDraft();
  for(const quantity of [undefined,0,-1,NaN,Infinity,Number.MIN_VALUE]) expect(draftPolicy({...draft,quantity})).toBeNull();
  for(const burst of [undefined,0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) expect(draftPolicy({...draft,customBurst:true,burst})).toBeNull();
  expect(draftPolicy({...draft,quantity:Number.MAX_SAFE_INTEGER+1})).toBeNull();
  expect(changeRateUnit({...draft,quantity:Number.MIN_VALUE},'second')).toBeNull();
  const tiny=createRateDraft({rps:Number.MIN_VALUE,burst:1});
  expect(draftPolicy(changeRateUnit(tiny,'minute')!)).toEqual({rps:Number.MIN_VALUE,burst:1,unit:'minute'});
  expect(changeRateUnit(createRateDraft({rps:Number.MAX_VALUE,burst:1}),'minute')).toBeNull();
});

test('rate settings compile for client and SSR without warnings',async()=>{
  const filename=fileURLToPath(new URL('../ui/KeyPolicy.svelte', import.meta.url));
  const source=await Bun.file(filename).text();
  for(const generate of ['client','server'] as const) expect(compile(source,{filename,generate}).warnings).toEqual([]);
});
