import {expect,test} from 'bun:test';
import {relayPayload,RELAY_TOOL} from '../../server/relay-response';

const text='完整中文任务：保持 "引号"、反斜线 \\、换行\n🙂 与所有字节。';
const args=JSON.stringify({payload:text});
const call={id:'call',type:'function_call',name:RELAY_TOOL,call_id:'c',arguments:args,status:'completed'};
const response={status:'completed',output:[call]};
function result(body:any,completion:any={status:'completed'},status=200):any{return {kind:'response',status,identity:{scope:'account',model:'native',upstreamId:'u'},requestId:'aux',bodyHandle:{identity:{contentType:'application/json'},json:async()=>body,maxBytes:1024*1024},completion:Promise.resolve(completion),dispose(){}};}
function frames():any[]{return [
 {type:'response.created',response:{status:'in_progress'}},
 {type:'response.output_item.added',output_index:0,item:{...call,status:'in_progress',arguments:''}},
 ...Array.from(args).map(delta=>({type:'response.function_call_arguments.delta',item_id:'call',output_index:0,delta})),
 {type:'response.function_call_arguments.done',item_id:'call',output_index:0,arguments:args},
 {type:'response.output_item.done',output_index:0,item:call},
 {type:'response.completed',response}
];}
function stream(events:any[],contentType='text/event-stream'):any{const r=result(null);r.bodyHandle.identity.contentType=contentType;r.bodyHandle.events=()=>({async *[Symbol.asyncIterator](){for(const json of events)yield {data:JSON.stringify(json),json};}});return r;}
test('complete JSON and Chinese escaped argument fragments preserve exact payload',async()=>{
 expect(await relayPayload(result(response),'input[1].content[0].encrypted_content',new AbortController().signal)).toBe(text);
 for(const contentType of ['text/event-stream','application/octet-stream',''])
  expect(await relayPayload(stream(frames(),contentType),'input[1].content[0].encrypted_content',new AbortController().signal)).toBe(text);
});
// Native Codex streams may omit argument deltas and emit metadata before completion.
for(const withDeltas of [false,true])test(`native Codex reasoning, metadata and ${withDeltas?'delta':'done-only'} arguments preserve the exact payload`,async()=>{
 const thought={id:'thought',type:'reasoning',summary:[]};
 const events=[
  {type:'response.created',response:{status:'in_progress',output:[]}},
  {type:'response.in_progress',response:{status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:thought},
  {type:'response.output_item.done',output_index:0,item:thought},
  ...frames().slice(1,-1).filter(event=>withDeltas || event.type!=='response.function_call_arguments.delta').map(event=>({...event,output_index:1})),
  {type:'response.metadata',response_id:'native-response',metadata:{}},
  {type:'response.completed',response:{...response,output:[thought,call]}},
 ];
 for(const contentType of ['text/event-stream','application/octet-stream',''])
  expect(await relayPayload(stream(events,contentType),'input[5].content[1].encrypted_content',new AbortController().signal)).toBe(text);
});
test('done-only arguments retain identity, byte limits, output consistency and completion checks',async()=>{
 const events=frames().filter(event=>event.type!=='response.function_call_arguments.delta');
 const wrongDone=(patch:any)=>events.map(event=>event.type==='response.function_call_arguments.done'?{...event,...patch}:event);
 const oversized=stream(events);oversized.bodyHandle.maxBytes=Buffer.byteLength(args)-1;
 const incomplete=stream(events);incomplete.completion=Promise.resolve({status:'incomplete'});
 const cancelled=stream(events);cancelled.completion=Promise.resolve({status:'cancelled'});
 for(const input of [
  stream(events.slice(0,-1)),
  stream(events.filter(event=>event.type!=='response.output_item.done')),
  stream(wrongDone({item_id:'another'})),stream(wrongDone({output_index:1})),stream(wrongDone({arguments:{payload:text}})),
  stream(events.map(event=>event.type==='response.output_item.done'?{...event,item:{...call,arguments:'{}'}}:event)),
  stream(events.map(event=>event.type==='response.completed'?{...event,response:{...response,output:[{...call,arguments:'{}'}]}}:event)),
  stream(events.map(event=>event.type==='response.completed'?{...event,response:{...response,status:'incomplete'}}:event)),
  oversized,incomplete,cancelled,
 ])await expect(relayPayload(input,'input[5].content[1].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502,code:'llm_adapter_relay_invalid_response'});
});
test('an observed empty or partial argument delta must still match arguments.done',async()=>{
 const events=frames().filter(event=>event.type!=='response.function_call_arguments.delta');
 for(const delta of ['',args.slice(0,-1)]){
  const inconsistent=events.flatMap(event=>event.type==='response.function_call_arguments.done'
   ?[{type:'response.function_call_arguments.delta',item_id:call.id,output_index:0,delta},event]:[event]);
  await expect(relayPayload(stream(inconsistent),'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502,code:'llm_adapter_relay_invalid_response'});
 }
});
test('metadata cannot complete a relay or permit unknown and post-terminal events',async()=>{
 const metadata={type:'response.metadata',response_id:'native-response',metadata:{}};
 for(const events of [[metadata],[...frames().slice(0,-1),metadata],[...frames(),metadata],[...frames().slice(0,-1),{type:'response.unknown'},...frames().slice(-1)]])
  await expect(relayPayload(stream(events),'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502,code:'llm_adapter_relay_invalid_response'});
});
test('headerless relay still requires valid events, exact tool arguments and complete transport',async()=>{
 const malformed=frames();malformed[1]={...malformed[1],item:{...malformed[1].item,name:'another'}};
 const invalidArguments=frames().map(event=>event.type==='response.function_call_arguments.done'?{...event,arguments:'{'}:event);
 const r=stream(frames(),'');r.completion=Promise.resolve({status:'incomplete'});
 const invalidJSON=stream([],'');invalidJSON.bodyHandle.events=()=>({async *[Symbol.asyncIterator](){yield {data:'not JSON'};}});
 const truncated=stream([],'');truncated.bodyHandle.events=()=>({async *[Symbol.asyncIterator](){yield {data:'{}',json:{},truncated:true};}});
 for(const input of [stream(frames().slice(0,-1),''),stream(malformed,''),stream(invalidArguments,''),r,invalidJSON,truncated]){
  let disposed=false;input.dispose=()=>{disposed=true;};
  await expect(relayPayload(input,'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502,code:'llm_adapter_relay_invalid_response'});
  expect(disposed).toBe(true);
 }
});
test('an explicit unsupported media type is rejected before reading the relay body',async()=>{
 const r=stream(frames(),'text/plain');let read=false,disposed=false;
 r.bodyHandle.events=()=>{read=true;throw Error('must not read');};r.bodyHandle.json=async()=>{read=true;throw Error('must not read');};r.dispose=()=>{disposed=true;};
 await expect(relayPayload(r,'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502,code:'llm_adapter_relay_invalid_response'});
 expect(read).toBe(false);expect(disposed).toBe(true);
});
test('cancellation while reading a headerless relay propagates and disposes the result',async()=>{
 const controller=new AbortController(),reason=Error('relay cancelled');let disposed=false;
 const r=stream([], '');r.dispose=()=>{disposed=true;};
 r.bodyHandle.events=()=>({async *[Symbol.asyncIterator](){yield {data:JSON.stringify(frames()[0]),json:frames()[0]};controller.abort(reason);yield {data:JSON.stringify(frames()[1]),json:frames()[1]};}});
 await expect(relayPayload(r,'input[0].content[0].encrypted_content',controller.signal)).rejects.toBe(reason);
 expect(disposed).toBe(true);
});
test('native reasoning and encrypted reasoning history are ignored while the unique payload stays exact',async()=>{
 const thought={id:'thought',type:'reasoning',summary:[{type:'summary_text',text:'This must never become the task'}],encrypted_content:'opaque-reasoning'};
 const completed={...response,output:[thought,call]};
 expect(await relayPayload(result(completed),'input[0].content[0].encrypted_content',new AbortController().signal)).toBe(text);
 const events=[{type:'response.created',response:{status:'in_progress'}},{type:'response.output_item.added',output_index:0,item:{id:'thought',type:'reasoning',summary:[]}},
  {type:'response.reasoning_summary_part.added',output_index:0,item_id:'thought',summary_index:0,part:{type:'summary_text',text:''}},
  {type:'response.reasoning_summary_text.delta',output_index:0,item_id:'thought',summary_index:0,delta:'Not the task'},
  {type:'response.reasoning_summary_text.done',output_index:0,item_id:'thought',summary_index:0,text:'Not the task'},
  {type:'response.reasoning_summary_part.done',output_index:0,item_id:'thought',summary_index:0,part:{type:'summary_text',text:'Not the task'}},
  {type:'response.output_item.done',output_index:0,item:thought},
  ...frames().slice(1,-1).map(e=>({...e,output_index:1})),{type:'response.completed',response:completed}];
 expect(await relayPayload(stream(events),'input[0].content[0].encrypted_content',new AbortController().signal)).toBe(text);
 await expect(relayPayload(stream(events.slice(0,-1)),'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502});
 const extraAnswer={...completed,output:[thought,call,{type:'message',content:[{type:'output_text',text:'actual answer'}]}]};
 await expect(relayPayload(result(extraAnswer),'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502});
});
test('arguments.done alone, incomplete transport and extra events never become success',async()=>{
 for(const r of [stream(frames().slice(0,-1)),result(response,{status:'incomplete',code:'eof'}),stream([...frames(),{type:'response.function_call_arguments.delta',delta:'late'}]),stream([{type:'response.refusal.delta',delta:'no'}])])await expect(relayPayload(r,'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502});
});
test('only one complete forced tool with exact payload keys is accepted',async()=>{
 for(const body of [{...response,status:'incomplete'},{...response,output:[call,call]},{...response,output:[{...call,name:'another'}]},{...response,output:[{...call,arguments:JSON.stringify({payload:text,extra:true})}]},{...response,output:[{...call,arguments:'{'}]},{...response,output:[{type:'message',content:[{type:'refusal',refusal:'secret'}]}]}])await expect(relayPayload(result(body),'input[0].content[0].encrypted_content',new AbortController().signal)).rejects.toMatchObject({status:502});
});
test('HTTP status failures retain only safe 401/429 and always dispose',async()=>{
 for(const status of [401,429,403,500]){let disposed=false,read=false;const r=result({secret:'provider body'},undefined,status);r.bodyHandle.json=async()=>{read=true;throw new Error('private provider error');};r.dispose=()=>{disposed=true;};try{await relayPayload(r,'input[0].content[0].encrypted_content',new AbortController().signal);throw new Error('unexpected success');}catch(error){expect(error).toMatchObject({status:[401,429].includes(status)?status:502,code:'llm_adapter_relay_upstream_failed',details:{param:'input[0].content[0].encrypted_content',message:`Relay upstream rejected the request (HTTP ${status})`}});expect(JSON.stringify(error)).not.toContain('provider body');expect(JSON.stringify(error)).not.toContain('private provider error');expect(read).toBe(false);expect(disposed).toBe(true);}}
});
