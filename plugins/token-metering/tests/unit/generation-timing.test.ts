import {expect,test} from 'bun:test';
import {GenerationTiming,generationSignals} from '../../server/generation-timing';
import type {SupportedProvider} from '../../server/classifier';

test.each([
  ['openai',{choices:[{delta:{content:'text'}}]},undefined],
  ['openai',{choices:[{delta:{reasoning_content:'reason'}}]},undefined],
  ['openai',{choices:[{delta:{tool_calls:[{function:{arguments:'{'}}]}}]},undefined],
  ['openai',{choices:[{delta:{function_call:{arguments:'{'}}}]},undefined],
  ['openai',{choices:[{text:'completion'}]},undefined],
  ['openai',{type:'response.output_text.delta',delta:'text'},undefined],
  ['openai',{type:'response.reasoning_summary_text.delta',delta:'reason'},undefined],
  ['openai',{delta:'{'},'response.function_call_arguments.delta'],
  ['anthropic',{type:'content_block_delta',delta:{type:'text_delta',text:'text'}},undefined],
  ['anthropic',{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'reason'}},undefined],
  ['anthropic',{type:'content_block_delta',delta:{type:'input_json_delta',partial_json:'{'}},undefined],
  ['anthropic',{type:'content_block_start',content_block:{type:'text',text:'text'}},undefined],
  ['gemini',{candidates:[{content:{parts:[{text:'reason',thought:true}]}}]},undefined],
  ['gemini',{candidates:[{content:{parts:[{functionCall:{name:'f',args:{value:1}}}]}}]},undefined],
] as const)('recognizes effective output for %s %#',(provider,body,event)=>{
  expect(generationSignals(provider,body,event).output).toBe(true);
});

test.each([
  ['openai',{choices:[{delta:{role:'assistant',content:''}}]}],
  ['openai',{choices:[{delta:{tool_calls:[{function:{name:'f',arguments:''}}]}}]}],
  ['openai',{usage:{completion_tokens:10}}],
  ['openai',{type:'response.completed',response:{output:[{content:[{text:'final only'}]}]}}],
  ['anthropic',{type:'content_block_delta',delta:{type:'signature_delta',signature:'metadata'}}],
  ['anthropic',{type:'content_block_start',content_block:{type:'tool_use',name:'f',input:{}}}],
  ['gemini',{candidates:[{content:{parts:[{functionCall:{name:'f',args:{}}}]}}],usageMetadata:{candidatesTokenCount:3}}],
] as const)('ignores empty content, metadata and final snapshots for %s %#',(provider,body)=>{
  expect(generationSignals(provider,body).output).toBe(false);
});

test.each([
  ['openai',{choices:[{finish_reason:'stop'}]}],
  ['openai',{type:'response.completed'}],
  ['anthropic',{type:'message_stop'}],
  ['anthropic',{type:'message_delta',delta:{stop_reason:'end_turn'}}],
  ['gemini',{candidates:[{finishReason:'STOP'}]}],
] as const)('stops on protocol completion for %s %#',(provider,body)=>{
  const timing=new GenerationTiming();
  const output=provider==='openai'?{choices:[{delta:{content:'a'}}]}:provider==='anthropic'?{type:'content_block_delta',delta:{type:'text_delta',text:'a'}}:{candidates:[{content:{parts:[{text:'a'}]}}]};
  timing.observe(provider,output,100);timing.observe(provider,body,400);
  expect(timing.duration(900)).toBe(300);
});

test('normal EOF uses physical end; missing/nonpositive time and absent first output never produce durations',()=>{
  const output={choices:[{delta:{content:'a'}}]};
  const timing=new GenerationTiming();timing.observe('openai',output,100);
  expect(timing.duration(350)).toBe(250);expect(timing.duration(100)).toBeUndefined();expect(timing.duration(undefined)).toBeUndefined();
  for(const missing of [undefined,NaN,Infinity]) {const timer=new GenerationTiming();timer.observe('openai',output,missing);timer.observe('openai',output,200);expect(timer.duration(400)).toBeUndefined();}
  const overflow=new GenerationTiming();overflow.observe('openai',output,-Number.MAX_VALUE);expect(overflow.duration(Number.MAX_VALUE)).toBeUndefined();
  const absent=new GenerationTiming();absent.observe('openai',{type:'response.completed'},200);absent.observe('openai',output,300);expect(absent.duration(400)).toBeUndefined();
  const terminal=new GenerationTiming();terminal.observe('openai',output,100);terminal.observe('openai',{type:'response.completed'},undefined);expect(terminal.duration(400)).toBeUndefined();
});

test('null errors in a successful Responses envelope do not invalidate generation', () => {
  const timing = new GenerationTiming();
  timing.observe('openai', { type: 'response.output_text.delta', delta: 'answer', error: null }, 100);
  timing.observe('openai', { type: 'response.completed', response: { status: 'completed', error: null } }, 400);
  expect(timing.duration(900)).toBe(300);
});

test.each(['openai', 'gemini'] as const)('waits for all %s branches and uses EOF for an unfinished branch', provider => {
  const chunk = (index: number, complete = false) => provider === 'openai'
    ? { choices: [{ index, delta: complete ? {} : { content: 'a' }, finish_reason: complete ? 'stop' : null }] }
    : { candidates: [{ index, content: complete ? undefined : { parts: [{ text: 'a' }] }, finishReason: complete ? 'STOP' : undefined }] };
  const timing = new GenerationTiming();
  timing.observe(provider, chunk(0), 100);
  timing.observe(provider, chunk(1), 100);
  timing.observe(provider, chunk(0, true), 200);
  expect(timing.duration(700)).toBe(600);
  timing.observe(provider, chunk(1), 400);
  timing.observe(provider, chunk(1, true), 600);
  expect(timing.duration(900)).toBe(500);
});

test('a later branch is not hidden by a previously completed choice', () => {
  const timing = new GenerationTiming();
  timing.observe('openai', { choices: [{ index: 0, delta: { content: 'a' } }] }, 100);
  timing.observe('openai', { choices: [{ index: 0, finish_reason: 'stop' }] }, 200);
  timing.observe('openai', { choices: [{ index: 1, delta: { content: 'b' } }] }, 300);
  timing.observe('openai', { choices: [{ index: 1, finish_reason: 'stop' }] }, 600);
  expect(timing.duration(900)).toBe(500);
});
