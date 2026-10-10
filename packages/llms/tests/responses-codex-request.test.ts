import {expect, test} from 'bun:test';
import {decodeResponsesRequest, encodeResponsesResult, ResponsesCodecError, ResponsesEventEncoder} from '../src/responses-codec';
import base from '../../../plugins/codex-router/tests/fixtures/captured-app-base.json';
import preferences from '../../../plugins/codex-router/tests/fixtures/captured-app-preferences.json';

const protocols = ['chat_completions','anthropic_messages'] as const;
const params = {maxOutputTokens:4096};
const functionTool = {type:'function',name:'read',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}};
const customTool = {type:'custom',name:'patch',format:{type:'grammar',syntax:'lark',definition:'start: /.+/'}};
const tools = [{type:'namespace',name:'files',tools:[functionTool,customTool]},
  {type:'namespace',name:'memory',tools:[functionTool]}];
const carrier = (definitions:unknown[] = tools) => ({type:'additional_tools',role:'developer',id:'carrier',tools:definitions});
const request = (extra:any = {}) => ({model:'m',input:[carrier(),{role:'user',content:'hello'}],...extra});
function errorOf(run:()=>unknown):ResponsesCodecError {
  try {run();} catch(error) {expect(error).toBeInstanceOf(ResponsesCodecError);return error as ResponsesCodecError;}
  throw new Error('Expected codec rejection');
}

for(const [name,captured,count] of [['base',base,11],['preferences',preferences,13]] as const) {
  test(`complete captured ${name} request converts to Chat without dropping tools or message order`,()=>{
    const result=decodeResponsesRequest(captured,'chat_completions',params);
    const messages=captured.input.filter(item=>item.type!=='additional_tools');
    expect(result.body.tools).toHaveLength(count);
    expect(result.toolNames.size).toBe(count);
    expect(result.canonicalInput).toEqual(messages.map(({internal_chat_message_metadata_passthrough: _metadata,...message})=>message));
    expect((result.body.messages as any[]).map(item=>item.role)).toEqual(messages.map(item=>item.role));
    expect(result.body.stream_options).toEqual({include_usage:true});
    expect(result.body).not.toHaveProperty('access_programs');
    expect(result.body).not.toHaveProperty('reasoning');
    expect(result.body).not.toHaveProperty('text');
    expect(result.diagnostics).toContainEqual({param:'text.verbosity',action:'omitted',reason:'target_verbosity_not_available'});
    if(name==='base') expect(result.body.response_format).toMatchObject({type:'json_schema',json_schema:{strict:true,schema:base.text.format.schema}});
    expect(result.diagnostics.every(d=>Object.keys(d).sort().join(',')==='action,param,reason')).toBe(true);
  });
}
test('captured Anthropic constraints remain explicit, with exact parameter location',()=>{
  expect(errorOf(()=>decodeResponsesRequest(base,'anthropic_messages',params))).toMatchObject({code:'unsupported_request',param:'text.format'});
  expect(errorOf(()=>decodeResponsesRequest(preferences,'anthropic_messages',params))).toMatchObject({code:'unsupported_content',param:'input[6].role'});
});

for(const protocol of protocols) {
  test(`${protocol}: additional tools, namespace custom, forcing and complete result history`,()=>{
    const decoded=decodeResponsesRequest(request({tool_choice:{type:'custom',name:'patch',namespace:'files'}}),protocol,params);
    expect(decoded.body.tools).toHaveLength(3);
    expect(decoded.canonicalInput).toEqual([{role:'user',content:'hello'}]);
    const patch=[...decoded.toolNames].find(([,original])=>original.custom)![0];
    const plain=[...decoded.toolNames].find(([,original])=>original.namespace==='memory')![0];
    expect(decoded.body.tool_choice).toEqual(protocol==='chat_completions'?{type:'function',function:{name:patch}}:{type:'tool',name:patch});
    const input='*** Begin Patch\n中文🙂\\"\n*** End Patch';
    const output=encodeResponsesResult(protocol==='chat_completions'?{choices:[{message:{tool_calls:[
      {id:'p',function:{name:patch,arguments:JSON.stringify({input})}}, {id:'r',function:{name:plain,arguments:'{"path":"x"}'}}]},finish_reason:'tool_calls'}]}
      :{content:[{type:'tool_use',id:'p',name:patch,input:{input}},{type:'tool_use',id:'r',name:plain,input:{path:'x'}}],stop_reason:'tool_use'},protocol,'public',decoded.toolNames);
    expect(output.output).toMatchObject([{type:'custom_tool_call',call_id:'p',namespace:'files',name:'patch',input},
      {type:'function_call',call_id:'r',namespace:'memory',name:'read',arguments:'{"path":"x"}'}]);
    const follow=decodeResponsesRequest(request({input:[carrier(),...decoded.canonicalInput,...output.output,
      {type:'custom_tool_call_output',call_id:'p',output:'patched'},{type:'function_call_output',call_id:'r',output:'read-result'}]}),protocol,params);
    expect(JSON.stringify(follow.body.messages)).toContain('patched');
    expect(JSON.stringify(follow.body.messages)).toContain('read-result');
    expect(follow.canonicalInput.some(item=>item.type==='additional_tools')).toBe(false);
  });
  test(`${protocol}: identical definitions deduplicate, changed definitions or kind never override`,()=>{
    const reordered={parameters:structuredClone(functionTool.parameters),name:'read',type:'function'};
    const duplicate=decodeResponsesRequest(request({tools:[{type:'namespace',name:'files',tools:[reordered]}]}),protocol,params);
    expect(duplicate.body.tools).toHaveLength(3);
    for(const conflicting of [{...functionTool,description:'different'},{...customTool,name:'read'}]) {
      const error=errorOf(()=>decodeResponsesRequest(request({tools:[{type:'namespace',name:'files',tools:[conflicting]}]}),protocol,params));
      expect(error).toMatchObject({code:'tool_name_collision',param:'input[0].tools[0].tools[0]'});
    }
  });
  test(`${protocol}: duplicate declarations and parameter definitions remain resource bounded`,()=>{
    expect(errorOf(()=>decodeResponsesRequest(request({input:[carrier(Array(8).fill(functionTool)),{role:'user',content:'x'}]}),protocol,{...params,limits:{maxItems:4}})).code).toBe('resource_limit');
    expect(errorOf(()=>decodeResponsesRequest(request({input:[carrier([{...functionTool,description:'x'.repeat(200)}])]}),protocol,{...params,limits:{maxArgumentBytes:100}})).code).toBe('resource_limit');
    expect(errorOf(()=>decodeResponsesRequest(request({input:[{...carrier(),content:'must not disappear'}]}),protocol,params))).toMatchObject({code:'invalid_payload',param:'input[0].content'});
  });
  test(`${protocol}: known preferences are omitted, unsupported access programs and unknown nested fields fail`,()=>{
    const decoded=decodeResponsesRequest(request({stream:true,stream_options:{include_usage:false,reasoning_summary_delivery:'sequential_cutoff'},
      access_programs:{cyber:'standard'},reasoning:{effort:'high',summary:'detailed',context:'all_turns'},text:{verbosity:'low'}}),protocol,params);
    expect(decoded.diagnostics.map(d=>d.param)).toEqual(['stream_options.include_usage','stream_options.reasoning_summary_delivery','access_programs','reasoning.summary','reasoning.context','reasoning.effort','text.verbosity']);
    expect(decoded.body).not.toHaveProperty('thinking');
    expect(decoded.body).not.toHaveProperty('reasoning_effort');
    expect(decoded.body.stream_options).toEqual(protocol==='chat_completions'?{include_usage:true}:undefined);
    for(const cyber of ['daybreak_blue','daybreak_red']) expect(errorOf(()=>decodeResponsesRequest(request({access_programs:{cyber}}),protocol,params))).toMatchObject({code:'unsupported_access_program',param:'access_programs.cyber'});
    for(const access_programs of [{},{cyber:'standard'}]) expect(()=>decodeResponsesRequest(request({access_programs}),protocol,params)).not.toThrow();
    for(const invalid of [null,{cyber:null},{cyber:'invalid'}]) expect(errorOf(()=>decodeResponsesRequest(request({access_programs:invalid}),protocol,params)).code).toBe('invalid_payload');
    for(const [field,value,path] of [['stream_options',{include_usage:'yes'},'stream_options.include_usage'],['reasoning',{summary:'mystery'},'reasoning.summary'],['text',{verbosity:5},'text.verbosity']]) {
      expect(errorOf(()=>decodeResponsesRequest(request({[field as string]:value}),protocol,params))).toMatchObject({code:'invalid_payload',param:path});
    }
    expect(errorOf(()=>decodeResponsesRequest(request({stream_options:{future:'do not discard'}}),protocol,params))).toMatchObject({code:'unsupported_request',param:'stream_options.future'});
    expect(errorOf(()=>decodeResponsesRequest(request({input:[carrier([{...functionTool,defer_loading:true}])]}),protocol,params))).toMatchObject({code:'unsupported_tool',param:'input[0].tools[0].defer_loading'});
  });
}

test('namespace custom SSE restores complete escaped input; truncation never becomes a successful call',()=>{
  const decoded=decodeResponsesRequest(request(),'chat_completions',params);
  const name=[...decoded.toolNames].find(([,original])=>original.custom)![0];
  const input='中文🙂\n\\" repeated repeated';
  const argumentsText=JSON.stringify({input});
  const encoder=new ResponsesEventEncoder('chat_completions','public',decoded.toolNames);
  const events:any[]=[];
  for(let i=0;i<argumentsText.length;i++) events.push(...encoder.push({choices:[{delta:{tool_calls:[{index:0,...(i===0?{id:'c',function:{name,arguments:argumentsText[i]}}:{function:{arguments:argumentsText[i]}})}]}}]}));
  events.push(...encoder.push({choices:[{delta:{},finish_reason:'tool_calls'}]}),...encoder.finish());
  expect(events.at(-1).response.output[0]).toMatchObject({type:'custom_tool_call',namespace:'files',name:'patch',call_id:'c',input});
  expect(events.filter(e=>e.type==='response.completed')).toHaveLength(1);
  const truncated=new ResponsesEventEncoder('chat_completions','public',decoded.toolNames);
  truncated.push({choices:[{delta:{tool_calls:[{index:0,id:'t',function:{name,arguments:'{"input":"partial'}}]},finish_reason:'length'}]});
  expect(truncated.finish().at(-1)?.type).toBe('response.incomplete');
});
