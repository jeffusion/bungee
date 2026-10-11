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
function stream(events:any[]):any{const r=result(null);r.bodyHandle.identity.contentType='text/event-stream';r.bodyHandle.events=()=>({async *[Symbol.asyncIterator](){for(const json of events)yield {data:JSON.stringify(json),json};}});return r;}
test('complete JSON and Chinese escaped argument fragments preserve exact payload',async()=>{
 expect(await relayPayload(result(response),'input[1].content[0].encrypted_content',new AbortController().signal)).toBe(text);
 expect(await relayPayload(stream(frames()),'input[1].content[0].encrypted_content',new AbortController().signal)).toBe(text);
 const binary=stream(frames());binary.bodyHandle.identity.contentType='application/octet-stream';
 expect(await relayPayload(binary,'input[1].content[0].encrypted_content',new AbortController().signal)).toBe(text);
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
 for(const status of [401,429,403,500]){let disposed=false;const r=result({secret:'provider body'},undefined,status);r.dispose=()=>{disposed=true;};try{await relayPayload(r,'input[0].content[0].encrypted_content',new AbortController().signal);throw new Error('unexpected success');}catch(error){expect(error).toMatchObject({status:[401,429].includes(status)?status:502});expect(JSON.stringify(error)).not.toContain('provider body');expect(disposed).toBe(true);}}
});
