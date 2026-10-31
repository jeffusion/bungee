import WebSocket from '@bungee/ws-client';
/**
 * Local acceptance: actual master + two supervised Bun workers, production plugins,
 * public ingress and canonical peer RPC. models.dev data and upstream protocols are
 * fixtures; this does not claim external-provider, Desktop, or deployment acceptance.
 * BUNGEE_CODEX_CLI_PROBE=1 also exercises isolated installed CLI discovery/generation.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCodexRouterGatewayFixture, seedCodexRouterCatalog, registerCodexProbeTargets, CODEX_PROCESS_PROBE, CODEX_MODELS, CODEX_CHAT_MODEL, CODEX_ANTHROPIC_MODEL, CODEX_DEEPSEEK_MODEL} from '../helpers/codex-router-gateway-fixture';
import {
  cleanupGatewayFixture, quarantinePortBlock, recordOwnedWorkers, releasePortBlock, requestJson,
  reservePortBlock, safeGatewayError, startTrackedGatewayMaster, stopOwnedMaster, waitForHealth, waitUntil,
  type GatewayFixture, type GatewayMasterStartupState, type OwnedMaster, type PortLease,
} from '../helpers/gateway-runtime';
import {probeProcessIdentity} from '../../packages/core/src/master-runtime/process-identity';
import {probeCodexCli, probeCodexChatgptModels, bundledCodexCatalogModel, CLI_TOOL_ROUNDTRIP, CLI_EXEC_MARKER, CLI_MCP_MARKER, CLI_PATCH_MARKER, CLI_COLLABORATION} from '../fixtures/codex-router-cli-probe';
import modelTemplate from '../../plugins/codex-router/server/model-template-0.160.1.json';
import capturedBase from '../fixtures/codex-requests/captured-app-base.json';
import capturedPreferences from '../fixtures/codex-requests/captured-app-preferences.json';

const uuid = (n: number) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ENTRY = uuid(1), NATIVE = uuid(2), CHAT = uuid(3), ANTHROPIC = uuid(4), NATIVE_WS = uuid(5);
let nativeCatalogModel: Record<string, any> = {...modelTemplate, slug: 'native-only', display_name: 'Native fixture model', extra: {keep: true}};
const tools = [
  {type: 'function', name: 'lookup', parameters: {type: 'object', properties: {}}},
  {type: 'namespace', name: 'files', tools: [{type: 'function', name: 'read', parameters: {type: 'object', properties: {}}}]},
  {type: 'namespace', name: 'memory', tools: [{type: 'function', name: 'read', parameters: {type: 'object', properties: {}}}]},
  {type: 'custom', name: 'shell', format: {type: 'text'}},
];
const customInput = 'echo "你好"\n\\$HOME';
// Deliberately opaque mock input, never evidence of native model decryption.
const relayTask = '协作任务：读取文件，再改写指定部分。\n"引号" \\ 路径\n```ts\nconst value = "完整任务";\n```';
const cliChildTask=`${CLI_TOOL_ROUNDTRIP}: execute the three isolated file, command and MCP fixture tools, return the child result.`;
const agentMessage = (cipher = 'fixture-opaque-agent-task') => ({type:'agent_message', author:'parent-agent', recipient:'child-agent',
  content:[{type:'input_text',text:'Task from parent'}, {type:'encrypted_content',encrypted_content:cipher}]});
const history = [
  {role: 'developer', content: ' preserve the complete history '},
  {role: 'user', content: [{type: 'input_text', text: '中文🙂'.repeat(10000)}]},
  {type: 'function_call', call_id: 'plain', name: 'lookup', arguments: '{}'},
  {type: 'function_call_output', call_id: 'plain', output: 'ordinary result'},
  {type: 'function_call', call_id: 'files', namespace: 'files', name: 'read', arguments: '{"path":"a"}'},
  {type: 'function_call_output', call_id: 'files', output: 'file result'},
  {type: 'function_call', call_id: 'memory', namespace: 'memory', name: 'read', arguments: '{}'},
  {type: 'function_call_output', call_id: 'memory', output: 'memory result'},
  {type: 'custom_tool_call', call_id: 'shell', name: 'shell', input: customInput},
  {type: 'custom_tool_call_output', call_id: 'shell', output: 'custom result'},
  {role: 'user', content: 'continue'},
];
// WS protocol/lifecycle assertions are independent of the >64 KiB RPC boundary.
const smallHistory = history.map((item, index) => index === 1
  ? {role: 'user', content: [{type: 'input_text', text: '中文🙂'.repeat(50)}]}
  : structuredClone(item));
type Call = {pid: number; requestId: string; path: string; body: any; transport: 'http' | 'websocket'};
type Worker = {pid: number; worker_instance_id: string; boot_nonce: string; revision: number};
type Attempt = {request_id: string; attempt_id: string; input_tokens: number; output_tokens: number; outcome: string};
type Socket = {client: WebSocket; events: any[]; create(body: any, allowError?: boolean): Promise<any[]>; close(): Promise<void>};
const message = (text: string) => ({type: 'message', role: 'assistant', content: [{type: 'output_text', text}]});
function response(id: string, model: string) {return {id, object: 'response', status: 'completed', model,
  output: [message('fixture answer')], usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6}};}
function sse(events: any[], done = false) {return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''),
  {headers: {'content-type': 'text/event-stream', 'x-models-etag': 'W/"fixture-upstream-directory"', 'x-fixture-response': 'keep'}});}
// Public Chat Completions usage shape; the vendor aux is intentionally unknown to a fixed field list.
const richChatUsage = {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6,
  prompt_tokens_details: {cached_tokens: 1, audio_tokens: 0, vendor_aux: {cache_read_tokens: 0}},
  completion_tokens_details: {reasoning_tokens: 1, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0}};
function chatEvents(text='chat answer', rich=false) {return rich ? [
  {choices: [{index: 0, delta: {content: text}, finish_reason: null}]},
  {choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: richChatUsage},
] : [
  {choices: [{index: 0, delta: {content: text}, finish_reason: null}]},
  {choices: [{index: 0, delta: {}, finish_reason: 'stop'}]},
  {choices: [], usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}},
];}
function anthropicEvents() {return [
  {type: 'message_start', message: {id: 'msg_fixture', model: 'org/anthropic', usage: {input_tokens: 4, output_tokens: 0}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'anthropic answer'}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}},
  {type: 'message_stop'},
];}

describe('CodexRouter actual master + two workers (local catalog/protocol fixtures)', () => {
  let fixture: GatewayFixture | undefined, lease: PortLease | undefined, master: OwnedMaster | undefined;
  let upstream: ReturnType<typeof Bun.serve<{headers: Headers}>> | undefined;
  const startup: GatewayMasterStartupState = {attempted: false, errors: []};
  const calls: Call[] = [], sockets = new Set<Socket>();
  const pending = new Set<string>(), aborted = new Set<string>();
  const modelQueries: Array<{path: string; clientVersion: string | null; pid: number; etag: string | null}> = [];
  const accountQueries: string[] = [];
  type ToolRoundTrip={firstRequestId?:string;followupRequestId?:string;wires?:Record<string,string>;outputs?:Array<{callId:string;content:unknown}>};
  const cliToolRoundTrips=new Map<string,ToolRoundTrip>();
  let collaborationChildModel='org/chat';
  const collaborationCalls:string[]=[];
  let management = '', proxy = '', revision = 0, aggregate: any;
  let token = '', otherToken = '', firstId = '', firstPid = 0;
  let workers: Worker[] = [];

  function capture(headers: Headers, path: string, body: any, transport: Call['transport']): Call {
    const call = {pid: Number(headers.get('x-codex-fixture-pid')), requestId: headers.get('x-codex-fixture-request-id') ?? '', path, body, transport};
    calls.push(call); return call;
  }
  beforeAll(async () => {
    fixture = await createCodexRouterGatewayFixture(); lease = await reservePortBlock();
    if (process.env.BUNGEE_CODEX_CLI_PROBE === '1') nativeCatalogModel = await bundledCodexCatalogModel(fixture.root);
    upstream = Bun.serve<{headers: Headers}>({hostname: '127.0.0.1', port: 0,
      async fetch(request, server) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/accounts/check')) {
          accountQueries.push(path);
          return Response.json({accounts: [{id: request.headers.get('chatgpt-account-id') ?? 'fixture-account', workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT'}]});
        }
        if (path.endsWith('/config/bundle')) return Response.json({config_toml: {enterprise_managed: []}});
        if (path.startsWith('/backend-api/')) return Response.json({error: 'fixture_not_found'}, {status: 404});
        if (request.headers.get('upgrade') === 'websocket') {
          if (server.upgrade(request, {data: {headers: new Headers(request.headers)}})) return;
          return new Response('upgrade failed', {status: 400});
        }
        if (path.endsWith('/models')) {
          const etag = `W/"${new Bun.CryptoHasher('sha256').update(JSON.stringify(nativeCatalogModel)).digest('hex')}"`;
          const condition = request.headers.get('if-none-match');
          modelQueries.push({path, clientVersion: new URL(request.url).searchParams.get('client_version'), pid: Number(request.headers.get('x-codex-fixture-pid')), etag: condition});
          return condition === etag ? new Response(null, {status: 304, headers: {etag}}) : Response.json({models: [nativeCatalogModel]}, {headers: {etag}});
        }
        // app-server probes unrelated ChatGPT plugin/settings APIs during init.
        // This fixture implements only accounts/config and model inference.
        if (request.method !== 'POST') return Response.json({error: 'fixture_not_found'}, {status: 404});
        const body: any = await request.json(); const call = capture(request.headers, path, body, 'http');
        if (/\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(path)) {
          expect(request.method).toBe('POST');expect(body).not.toHaveProperty('model');
          const streaming=path.endsWith(':streamGenerateContent');
          expect(new URL(request.url).searchParams.get('alt')).toBe(streaming?'sse':null);
          if(JSON.stringify(body).includes('fixture-hold-gemini')){
            pending.add(call.requestId);
            return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts:[{text:'pending'}]}}]})+'\n\n'));},cancel(){pending.delete(call.requestId);aborted.add(call.requestId);}}),{headers:{'content-type':'text/event-stream'}});
          }
          const parts=body.contents.flatMap((item:any)=>item.parts);
          const restored=parts.some((part:any)=>part.functionResponse?.id==='gemini-one');
          const output=restored?[{text:'gemini answer',thoughtSignature:'c2lnbmF0dXJlLXRleHQ='}]:[
            {text:'provider preface',thoughtSignature:'c2lnbmF0dXJlLXRleHQ='},
            {functionCall:{id:'gemini-one',name:'bungee_tool_0',args:{q:'one'}},thoughtSignature:'c2lnbmF0dXJlLW9uZQ=='},
            {functionCall:{id:'gemini-two',name:'bungee_tool_0',args:{q:'two'}},thoughtSignature:'c2lnbmF0dXJlLXR3bw=='},
          ];
          const result={candidates:[{index:0,content:{role:'model',parts:output},finishReason:'STOP'}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:2,totalTokenCount:6,promptTokensDetails:[{modality:'TEXT',tokenCount:4}]}};
          return streaming?sse([result]):Response.json(result);
        }
        // The real DeepSeek Chat API accepts only its documented roles; other providers keep their fixtures.
        if (body.model === CODEX_DEEPSEEK_MODEL && path.endsWith('/chat/completions')) {
          const unsupported = Array.isArray(body.messages) && body.messages.find((message: any) => !['system', 'user', 'assistant', 'tool'].includes(message.role));
          if (unsupported) return Response.json({error: 'fixture_deepseek_unsupported_role', role: unsupported.role}, {status: 422});
        }
        // Observed legal Chat stream: text, then tool calls, then more text. The follow-up
        // rejects a tool result that does not directly follow its assistant tool_calls.
        if (path.endsWith('/chat/completions') && JSON.stringify(body.messages).includes('fixture-chat-text-before-tool')) {
          const messages: any[] = body.messages;
          const textOf = (content: any): string => typeof content === 'string' ? content
            : Array.isArray(content) ? content.map((part: any) => part.text ?? '').join('') : '';
          const toolMessage = messages.find((message: any) => message.role === 'tool');
          if (toolMessage) {
            const index = messages.indexOf(toolMessage);
            const assistant = messages[index - 1];
            const paired = assistant?.role === 'assistant' && assistant.tool_calls?.some((call: any) => call.id === 'fixture_image_call');
            if (!paired || toolMessage.tool_call_id !== 'fixture_image_call' || !textOf(assistant.content).includes("I'll start by retrieving the image."))
              return Response.json({error: 'fixture_tool_result_not_adjacent'}, {status: 400});
            const projected = messages.slice(index + 1).find((message: any) => message.role === 'user'
              && Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url'));
            if (!projected) return Response.json({error: 'fixture_projected_image_missing'}, {status: 400});
            return body.stream ? sse(chatEvents('image follow-up answer')) : Response.json({
              id: `chat-image-${calls.length}`, object: 'chat.completion', model: body.model,
              choices: [{index: 0, message: {role: 'assistant', content: 'image follow-up answer'}, finish_reason: 'stop', provider_specific_fields: {}}],
              usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
            });
          }
          const declared = (body.tools ?? []).map((tool: any) => tool.function).find((tool: any) => tool?.name);
          if (!declared) return Response.json({error: 'fixture_tool_declaration_missing'}, {status: 400});
          const call = {index: 0, id: 'fixture_image_call', type: 'function', function: {name: declared.name, arguments: '{"q":"image"}'}};
          return body.stream ? sse([
            {choices: [{index: 0, delta: {content: "I'll "}, finish_reason: null}]},
            {choices: [{index: 0, delta: {tool_calls: [call]}, finish_reason: null}]},
            {choices: [{index: 0, delta: {content: 'start by retrieving the image.'}, finish_reason: 'tool_calls'}]},
            {choices: [], usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}},
          ]) : Response.json({
            id: `chat-image-${calls.length}`, object: 'chat.completion', model: body.model,
            choices: [{index: 0, message: {role: 'assistant', content: "I'll start by retrieving the image.", tool_calls: [call]},
              finish_reason: 'tool_calls', provider_specific_fields: {}}],
            usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
          });
        }
        if (body.tools?.[0]?.name === 'relay_external_agent_payload') {
          if (path !== '/v1/responses') return Response.json({error:'unsupported_relay_path'}, {status:404});
          expect(body.tools).toHaveLength(1);
          expect(body.tool_choice).toEqual({type:'function',name:'relay_external_agent_payload'});
          expect(body.input).toHaveLength(1);
          expect(body.input[0].type).toBe('agent_message');
          expect(body.model).toBe('native-relay-model');
          const cipher=body.input[0].content.find((part:any)=>part.type==='encrypted_content')?.encrypted_content;
          if (cipher === 'fixture-relay-denied') return Response.json({error:'fixture-denial'}, {status:401});
          const args=JSON.stringify({payload:cipher==='fixture-native-cli-task'?cliChildTask:relayTask});
          const item={type:'function_call',id:'relay-item',call_id:'relay-call',name:'relay_external_agent_payload',status:'completed',arguments:args};
          const result={...response(`relay-${calls.length}`,body.model),output:[item]};
          const events=[
            {type:'response.created',response:{...result,status:'in_progress',output:[]}},
            {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}},
            // Native Codex can send complete arguments without deltas, then sideband metadata.
            ...(cipher?.startsWith('fixture-headerless-')?[]:[args.slice(0,9),args.slice(9)].map(delta=>({type:'response.function_call_arguments.delta',output_index:0,item_id:item.id,delta}))),
            {type:'response.function_call_arguments.done',output_index:0,item_id:item.id,arguments:args},
            {type:'response.output_item.done',output_index:0,item},
            {type:'response.metadata',response_id:result.id,metadata:{}},
            {type:'response.completed',response:result},
          ];
          const stream=sse(cipher==='fixture-headerless-truncated'?events.slice(0,-1):events);
          // A stream body avoids Bun adding a default media type to a string response.
          if(cipher?.startsWith('fixture-headerless-'))return new Response(stream.body);
          stream.headers.set('content-type','application/octet-stream');
          return stream;
        }
        if (JSON.stringify(body.input ?? body.messages).includes(CLI_COLLABORATION)) {
          const native=path.endsWith('/responses'),anthropic=path.endsWith('/messages');
          const available=native?body.tools.flatMap((tool:any)=>tool.type==='namespace'?tool.tools.map((item:any)=>({...item,namespace:tool.name})): [tool])
            :body.tools.map((tool:any)=>anthropic?{...tool,parameters:tool.input_schema}:tool.function);
          const logical=native?body.input:body.messages;
          const returned=native?logical.filter((item:any)=>item.type==='function_call_output').length
            :anthropic?logical.flatMap((item:any)=>Array.isArray(item.content)?item.content:[]).filter((item:any)=>item.type==='tool_result').length
              :logical.filter((item:any)=>item.role==='tool').length;
          const names=['spawn_agent','send_message','followup_task','wait_agent'];
          if(returned>=names.length) {
            // A wait wakes the parent only after the child result enters its input.
            if(!JSON.stringify(logical).includes('chat answer') && !JSON.stringify(logical).includes('anthropic answer'))return Response.json({error:'fixture_child_result_missing'},{status:400});
            if(native) {
              const item={...message('parent verified child result'),id:'parent-summary',status:'completed'};
              const final={...response('parent-completed',body.model),output:[item]};
              return sse([{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
                {type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'parent verified child result'},
                {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:final}]);
            }
            return sse(anthropic?anthropicEvents():chatEvents());
          }
          const name=names[returned]!;
          if(name==='send_message')await waitUntil(()=>Boolean(cliToolRoundTrips.get(collaborationChildModel==='org/chat'?CODEX_CHAT_MODEL:CODEX_ANTHROPIC_MODEL)?.followupRequestId),
            'child did not return its actual file/MCP tools before the next collaboration task',10000);
          const tool=available.find((item:any)=>native?item.namespace==='collaboration'&&item.name===name:
            item.description?.includes(`Original tool identity: ${JSON.stringify({name,namespace:'collaboration'})}\n`));
          if(!tool)throw new Error(`fixture missing ${name}: ${JSON.stringify(available.map((item:any)=>({name:item.name,description:item.description,properties:Object.keys(item.parameters?.properties??{})})))}`);
          collaborationCalls.push(name);
          const args=name==='spawn_agent'?{task_name:'isolated_child',fork_turns:'none',model:collaborationChildModel,message:native?'fixture-native-cli-task':cliChildTask}
            :name==='wait_agent'?{timeout_ms:10000}:{target:'isolated_child',message:native?'fixture-native-cli-task':cliChildTask};
          const argumentText=JSON.stringify(args),id=`collaboration-${returned}`;
          if(native) {
            const item={type:'function_call',namespace:'collaboration',name,id,call_id:id,status:'completed',arguments:argumentText};
            const result={...response(`parent-${returned}`,body.model),output:[item]};
            return sse([{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}},
              {type:'response.function_call_arguments.delta',output_index:0,item_id:id,delta:argumentText},
              {type:'response.function_call_arguments.done',output_index:0,item_id:id,arguments:argumentText},
              {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}]);
          }
          if(anthropic)return sse([{type:'message_start',message:{id,usage:{input_tokens:4,output_tokens:0}}},
            {type:'content_block_start',index:0,content_block:{type:'tool_use',id,name:tool.name,input:{}}},
            {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:argumentText}},
            {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}]);
          return sse([{choices:[{index:0,delta:{tool_calls:[{index:0,id,type:'function',function:{name:tool.name,arguments:argumentText}}]},finish_reason:null}]},
            {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}]);
        }
        const collaborationTool=body.tools?.find((tool:any)=>(tool.function?.parameters ?? tool.input_schema)?.properties?.message);
        if (collaborationTool && JSON.stringify(body.messages).includes('fixture-plaintext-collaboration')) {
          const name=collaborationTool.function?.name ?? collaborationTool.name;
          const args={message:relayTask};
          if(path.endsWith('/messages'))return body.stream?sse([
            {type:'message_start',message:{id:'collaboration',usage:{input_tokens:4,output_tokens:0}}},
            {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'collaboration-call',name,input:{}}},
            {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},
            {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}}, {type:'message_stop'},
          ]):Response.json({id:'collaboration',type:'message',role:'assistant',model:body.model,
            content:[{type:'tool_use',id:'collaboration-call',name,input:args}],stop_reason:'tool_use',usage:{input_tokens:4,output_tokens:2}});
          const tool={id:'collaboration-call',type:'function',function:{name,arguments:JSON.stringify(args)}};
          return body.stream?sse([
            {choices:[{index:0,delta:{tool_calls:[{index:0,...tool}]},finish_reason:null}]},
            {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
            {choices:[],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}},
          ]):Response.json({id:'collaboration',object:'chat.completion',model:body.model,
            choices:[{index:0,message:{role:'assistant',content:null,tool_calls:[tool]},finish_reason:'tool_calls'}],
            usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}});
        }
        if (JSON.stringify(body).includes('fixture-hold-')) {
          pending.add(call.requestId);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chatEvents()[0])}\n\n`));},
            cancel() {pending.delete(call.requestId); aborted.add(call.requestId);},
          }), {headers: {'content-type': 'text/event-stream'}});
        }
        if ((path.endsWith('/chat/completions') || path.endsWith('/messages')) && JSON.stringify(body.messages).includes(cliChildTask)) {
          const anthropic=path.endsWith('/messages');
          const declared=body.tools.map((tool:any)=>anthropic?{...tool,parameters:tool.input_schema}:tool.function);
          const exec=declared.find((tool:any)=>tool.parameters?.properties?.cmd);
          const patch=declared.find((tool:any)=>tool.parameters?.properties?.input && tool.description?.includes('Original input format:'));
          const echo=declared.find((tool:any)=>tool.parameters?.properties?.fixture_echo);
          const roundTrip:ToolRoundTrip=cliToolRoundTrips.get(body.model) ?? {};
          cliToolRoundTrips.set(body.model,roundTrip);
          const outputs:NonNullable<ToolRoundTrip['outputs']>=anthropic?body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[])
            .filter((part:any)=>part.type==='tool_result').map((part:any)=>({callId:part.tool_use_id,content:part.content}))
            :body.messages.filter((message:any)=>message.role==='tool').map((message:any)=>({callId:message.tool_call_id,content:message.content}));
          roundTrip.outputs=outputs;
          const content=(id:string)=>JSON.stringify(outputs.find(item=>item.callId===id)?.content);
          let requested:any[];
          if(!outputs.length) {
            roundTrip.firstRequestId=call.requestId;
            requested=[{id:'call_fixture_exec',tool:exec,arguments:{cmd:`cat fixture-patched.txt; printf '${CLI_EXEC_MARKER}\\n'`,login:false,yield_time_ms:1000,max_output_tokens:1000}}];
          } else if(outputs.length===1) {
            if(!content('call_fixture_exec')?.includes('pending') || !content('call_fixture_exec')?.includes(CLI_EXEC_MARKER))return Response.json({error:'fixture_initial_read_missing'},{status:400});
            requested=[{id:'call_fixture_patch',tool:patch,arguments:{input:`*** Begin Patch\n*** Update File: fixture-patched.txt\n@@\n-pending\n+${CLI_PATCH_MARKER}\n*** End Patch\n`}},
              {id:'call_fixture_mcp',tool:echo,arguments:{fixture_echo:CLI_MCP_MARKER}}];
          } else if(outputs.length===3) {
            if(!content('call_fixture_patch')?.includes('Success') || !content('call_fixture_mcp')?.includes(CLI_MCP_MARKER))return Response.json({error:'fixture_modification_or_mcp_missing'},{status:400});
            requested=[{id:'call_fixture_readback',tool:exec,arguments:{cmd:'cat fixture-patched.txt',login:false,yield_time_ms:1000,max_output_tokens:1000}}];
          } else {
            if(outputs.length!==4 || !content('call_fixture_readback')?.includes(CLI_PATCH_MARKER))return Response.json({error:'fixture_readback_missing'},{status:400});
            roundTrip.followupRequestId=call.requestId;
            return sse(anthropic?anthropicEvents():chatEvents());
          }
          if(requested.some(item=>!item.tool))return Response.json({error:'fixture_tool_declaration_missing'},{status:400});
          if(anthropic)return sse([{type:'message_start',message:{id:'child-tools',usage:{input_tokens:4,output_tokens:0}}},
            ...requested.flatMap((item,index)=>[{type:'content_block_start',index,content_block:{type:'tool_use',id:item.id,name:item.tool.name,input:{}}},
              {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(item.arguments)}},{type:'content_block_stop',index}]),
            {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}]);
          return sse([{choices:[{index:0,delta:{tool_calls:requested.map((item,index)=>({index,id:item.id,type:'function',function:{name:item.tool.name,arguments:JSON.stringify(item.arguments)}}))},finish_reason:null}]},
            {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}}]);
        }
        if ((path.endsWith('/chat/completions') || path.endsWith('/messages')) && JSON.stringify(body.messages).includes(CLI_TOOL_ROUNDTRIP)) {
          const anthropic=path.endsWith('/messages');
          const cliToolRoundTrip:ToolRoundTrip=cliToolRoundTrips.get(body.model) ?? {};
          cliToolRoundTrips.set(body.model,cliToolRoundTrip);
          if (!cliToolRoundTrip.firstRequestId) {
            const declared = body.tools.map((tool: any) => anthropic ? {...tool,parameters:tool.input_schema}:tool.function);
            const exec = declared.find((tool: any) => tool.parameters?.properties?.cmd);
            const patch = declared.find((tool: any) => tool.parameters?.properties?.input && tool.description?.includes('Original input format:'));
            const echo = declared.find((tool: any) => tool.parameters?.properties?.fixture_echo);
            cliToolRoundTrip.firstRequestId = call.requestId;
            cliToolRoundTrip.wires = {exec: exec?.name, patch: patch?.name, ...(echo ? {mcp: echo.name} : {})};
            const requested = [
              {id: 'call_fixture_exec', tool: exec, arguments: {cmd: `printf '${CLI_EXEC_MARKER}\\n'`, login: false, yield_time_ms: 1000, max_output_tokens: 1000}},
              {id: 'call_fixture_patch', tool: patch, arguments: {input: `*** Begin Patch\n*** Add File: fixture-patched.txt\n+${CLI_PATCH_MARKER}\n*** End Patch\n`}},
              ...(echo ? [{id: 'call_fixture_mcp', tool: echo, arguments: {fixture_echo: CLI_MCP_MARKER}}] : []),
            ];
            if (requested.some(item => !item.tool)) return Response.json({error: 'fixture_tool_declaration_missing'}, {status: 400});
            if(anthropic)return sse([
              {type:'message_start',message:{id:'tool-turn',usage:{input_tokens:4,output_tokens:0}}},
              ...requested.flatMap((item,index)=>[{type:'content_block_start',index,content_block:{type:'tool_use',id:item.id,name:item.tool.name,input:{}}},
                {type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(item.arguments)}},{type:'content_block_stop',index}]),
              {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'},
            ]);
            return sse([
              {choices: [{index: 0, delta: {role: 'assistant', reasoning_content:'fixture tool reasoning', tool_calls: requested.map((item, index) => ({index, id: item.id, type: 'function',
                function: {name: item.tool.name, arguments: JSON.stringify(item.arguments)}}))}, finish_reason: null}]},
              {choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]},
              {choices: [], usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}},
            ]);
          }
          cliToolRoundTrip.followupRequestId = call.requestId;
          if(!anthropic)expect(body.messages.find((message:any)=>message.tool_calls?.length)?.reasoning_content).toBe('fixture tool reasoning');
          const outputs:NonNullable<ToolRoundTrip['outputs']> = anthropic ? body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[])
            .filter((block:any)=>block.type==='tool_result').map((block:any)=>({callId:block.tool_use_id,content:block.content}))
            : body.messages.filter((message: any) => message.role === 'tool').map((message: any) => ({callId: message.tool_call_id, content: message.content}));
          cliToolRoundTrip.outputs=outputs;
          const output=(id:string)=>JSON.stringify(outputs.find(item=>item.callId===id)?.content);
          if(outputs.length!==3 || !output('call_fixture_exec')?.includes(CLI_EXEC_MARKER)
            || !output('call_fixture_patch')?.includes('Success') || !output('call_fixture_mcp')?.includes(CLI_MCP_MARKER)) {
            return Response.json({error:'fixture_tool_results_incomplete'}, {status:400});
          }
          return sse(anthropic?anthropicEvents():chatEvents());
        }
        if (path.endsWith('/chat/completions')) {
          const deepseek = body.model === CODEX_DEEPSEEK_MODEL;
          const text = body.response_format?.type === 'json_schema' ? '{"title":"fixture","description":"fixture"}' : 'chat answer';
          return body.stream ? sse(chatEvents(text, deepseek), deepseek) : Response.json({
            id: `chat-${calls.length}`, object: 'chat.completion', model: body.model,
            choices: [{index: 0, message: {role: 'assistant', content: text}, finish_reason: 'stop'}],
            usage: deepseek ? richChatUsage : {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
          });
        }
        if (path.endsWith('/messages')) return body.stream ? sse(anthropicEvents()) : Response.json({
          id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [{type: 'text', text: 'anthropic answer'}], stop_reason: 'end_turn', usage: {input_tokens: 4, output_tokens: 2},
        });
        if (path.endsWith('/responses')) {
          if (body.input === 'fixture-sse-rate-limit') return new Response('event: error\ndata: {"error":"rate_limit"}\n\n', {
            status: 429, headers: {'content-type': 'text/event-stream', 'retry-after': '5', 'x-models-etag': 'upstream-unrelated'},
          });
          const result = response(`resp_fixture_${calls.length}`, body.model);
          const itemId = `msg_fixture_${calls.length}`;
          return body.stream ? sse([{type: 'response.created', response: {...result, status: 'in_progress', output: []}},
            {type: 'response.output_item.added', output_index: 0, item: {...result.output[0], id: itemId, status: 'in_progress', content: []}},
            {type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: 'fixture answer'},
            {type: 'response.output_item.done', output_index: 0, item: {...result.output[0], id: itemId, status: 'completed'}},
            {type: 'response.completed', response: result}]) : Response.json(result, {headers: {'x-models-etag': 'W/"fixture-upstream-directory"', 'x-fixture-response': 'keep'}});
        }
        return Response.json({error: 'fixture_wrong_path'}, {status: 404});
      },
      websocket: {message(socket, raw) {
        const body = JSON.parse(String(raw)); capture(socket.data.headers, '/v1/responses', body, 'websocket');
        const result = response(`resp_native_ws_${calls.length}`, body.model);
        socket.send(JSON.stringify({type: 'response.created', response: {...result, status: 'in_progress', output: []}}));
        socket.send(JSON.stringify({type: 'response.completed', response: result}));
      }},
    });
    try {master = await startTrackedGatewayMaster(startup, fixture, lease);} catch (error) {master = startup.master; throw error;}
    await waitForHealth(master, lease.base, fixture);
    management = `http://127.0.0.1:${lease.base}`; proxy = `http://127.0.0.1:${lease.block.ports[1]}`;
    registerCodexProbeTargets(fixture,[proxy,`http://127.0.0.1:${upstream!.port}`]);
    await seedCodexRouterCatalog(fixture);
    const initial: any = (await requestJson(`${management}/api/config`, {}, fixture)).body; revision = initial.revision;
    const endpoint = (n: number) => ({id: uuid(n), position: 1, target: `http://127.0.0.1:${upstream!.port}${[11,12,15].includes(n)?'/v1/':'/'}`, weight: 100, priority: 1, is_disabled: false, plugins: []});
    const binding = (name: string, n: number, options?: any) => ({id: uuid(n), position: n, name, enabled: true, ...(options ? {options} : {})});
    aggregate = {
      plugin_activations: ['models-dev', 'llm-protocol-adapter', 'codex-router', 'key-access', 'token-metering', 'token-stats', CODEX_PROCESS_PROBE].map(plugin_name => ({plugin_name})),
      logical_configuration: {
        plugins: [binding(CODEX_PROCESS_PROBE, 22)],
        services: [{id: CHAT, position: 1, name: 'Chat fixture', plugins: [], endpoints: [endpoint(13)]}],
        routes: [
          {id: ENTRY, position: 1, path: '/codex/', websocket: {enabled: true}, endpoints: [endpoint(11)],
            path_rewrite: {'^/codex': ''}, plugins: [binding(CODEX_PROCESS_PROBE, 20, {priority: -1000}), binding('codex-router', 21, {models: [
              {provider: 'lab', model: CODEX_MODELS[0], target: {type: 'route', id: NATIVE, protocol: 'responses'}},
              {provider: 'zai', source: CODEX_MODELS[1], model: CODEX_CHAT_MODEL, target: {type: 'service', id: CHAT, protocol: 'chat_completions'}},
              {provider: 'anthropic', source: CODEX_MODELS[2], model: CODEX_ANTHROPIC_MODEL, target: {type: 'route', id: ANTHROPIC, protocol: 'anthropic_messages'}},
              {provider: 'lab', model: CODEX_MODELS[3], target: {type: 'route', id: NATIVE_WS, protocol: 'responses'}},
              {provider: 'deepseek', source: CODEX_MODELS[4], model: CODEX_DEEPSEEK_MODEL, target: {type: 'service', id: CHAT, protocol: 'chat_completions'}},
            ]})]},
          {id: NATIVE, position: 2, path: '/native-target/', endpoints: [endpoint(12)], path_rewrite: {'^/native-target': ''}, plugins: []},
          {id: ANTHROPIC, position: 3, path: '/anthropic-target/', endpoints: [endpoint(14)], path_rewrite: {'^/anthropic-target': ''}, plugins: []},
          {id: NATIVE_WS, position: 4, path: '/native-ws-target/', websocket: {enabled: true}, endpoints: [endpoint(15)], path_rewrite: {'^/native-ws-target': ''}, plugins: []},
        ],
      },
    };
    await publish();
    for (let i = 0; i < 2; i++) {
      const key: any = (await control('/api/plugins/key-access/control/credentials', 'POST', {name: `Codex fixture ${i}`})).body;
      expect(key.token).toBeString(); if (i === 0) token = key.token; else otherToken = key.token;
      expect((await control('/api/plugins/key-access/control/route-key', 'PUT', {keyId: key.key.id, routeId: ENTRY})).response.status).toBe(200);
    }
    expect((await control('/api/plugins/key-access/control/routes', 'PUT', {protectedRouteIds: [ENTRY]})).response.status).toBe(200);
  }, 90000);

  async function control(path: string, method = 'GET', body?: unknown) {
    if (!fixture) throw new Error('fixture unavailable');
    return requestJson(`${management}${path}`, {method, ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})}, fixture);
  }
  async function publish(onServing?: () => Promise<void>) {
    const mutation = randomUUID();
    const result = await control('/api/config', 'PUT', {expected_revision: revision, mutation_id: mutation, aggregate}).catch(async error => {
      throw new Error(`Codex configuration publication failed: ${String(error)}; ${await master!.diagnostics?.()}`, {cause: error});
    });
    expect(result.response.status).toBe(202);
    if (onServing) {
      await waitUntil(async () => {
        const runtime: any = (await control('/api/config/runtime')).body;
        return runtime.publication?.serving_revision === revision + 1 && runtime.workers?.length === 2;
      }, 'replacement revision was not published before WS drain', 15000);
      await onServing();
    }
    let failedOperation: unknown;
    await waitUntil(async () => {
      const value: any = (await control(`/api/config/operations/${mutation}`)).body;
      if (['degraded', 'failed'].includes(value.operation?.state)) {failedOperation = value; return true;}
      return value.operation?.state === 'converged';
    }, 'Codex configuration did not converge', 30000);
    if (failedOperation) throw new Error(`Codex configuration failed: ${JSON.stringify(failedOperation)}; ${await master!.diagnostics?.()}`);
    revision++;
    await waitUntil(async () => {
      const runtime: any = (await control('/api/config/runtime')).body; workers = runtime.workers ?? [];
      return runtime.publication?.serving_complete && runtime.publication.serving_revision === revision && workers.length === 2 && workers.every(w => w.revision === revision);
    }, 'two workers did not serve Codex configuration', 30000);
    await recordOwnedWorkers(master!, workers);
  }
  async function post(body: any, credential = token) {
    const result = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${credential}`}, body: JSON.stringify(body), signal: AbortSignal.timeout(20000)});
    const text = await result.text();
    if (!text.startsWith('{')) throw new Error(`HTTP generation returned non-JSON status=${result.status}: ${text.slice(0, 200)}; ${await master!.diagnostics?.()}`);
    return {status: result.status, body: JSON.parse(text) as any};
  }
  function redactEvidence(text: string): string {
    const redacted = text.replace(/data:[^\s"'\\]+/g, value =>
      `data-uri(${Buffer.byteLength(value)}B,sha256=${new Bun.CryptoHasher('sha256').update(value).digest('hex').slice(0, 16)})`);
    let output = redacted;
    for (const credential of [token, otherToken]) if (credential) output = output.split(credential).join('[redacted-token]');
    return safeGatewayError(output, fixture!, 8192);
  }
  function failureEvidence(value: unknown): string {
    let text: string;
    try {text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);} catch {text = String(value);}
    return redactEvidence(text);
  }
  function imageDigest(value: string): string {
    return new Bun.CryptoHasher('sha256').update(value).digest('hex');
  }
  function attempts(): Attempt[] {
    const db = new Database(fixture!.accessDbPath, {readonly: true});
    try {return db.query<Attempt, []>('SELECT request_id, attempt_id, input_tokens, output_tokens, outcome FROM token_stats_attempts').all();} finally {db.close();}
  }
  async function assertMetered(selected: Call[], completed = true) {
    let rows: Attempt[] = [];
    await waitUntil(() => {
      rows = attempts().filter(row => selected.some(call => call.requestId === row.request_id));
      return selected.every(call => rows.some(row => row.request_id === call.requestId));
    }, 'per-generation token-stats observations did not settle', 12000);
    expect(rows).toHaveLength(selected.length);
    expect(new Set(selected.map(call => call.requestId)).size).toBe(selected.length);
    expect(new Set(rows.map(row => row.attempt_id)).size).toBe(selected.length);
    if (completed) for (const row of rows) expect(row).toMatchObject({input_tokens: 4, output_tokens: 2, outcome: 'completed'});
  }

  test('publication rejects a missing binding protocol without changing the revision', async () => {
    const invalid=structuredClone(aggregate);
    delete invalid.logical_configuration.routes[0].plugins.find((plugin:any)=>plugin.name==='codex-router').options.models[0].target.protocol;
    const result=await fetch(`${management}/api/config`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:revision,mutation_id:randomUUID(),aggregate:invalid}),signal:AbortSignal.timeout(5000)});
    expect(result.status).toBe(422);
    expect((await result.json() as any).errors).toContainEqual({code:'invalid_value',path:'logical_configuration.routes[0].plugins[1].options.models[0].target',message:'Dispatch target requires an explicit receiving protocol'});
    expect((await control('/api/config')).body).toMatchObject({revision});
    expect((await control('/api/config/runtime')).body).toMatchObject({publication:{serving_revision:revision}});
  });

  test.skipIf(process.env.BUNGEE_CODEX_CLI_PROBE !== '1')('isolated installed CLI can generate through the public native model', async () => {
    const before = calls.length;
    const cli = await probeCodexCli({root: fixture!.root, baseUrl: `${proxy}/codex`, token, model: 'native-only'});
    console.info(`codex_router_native_cli ${JSON.stringify({...cli, upstream: calls.slice(before).map(call => ({pid: call.pid, path: call.path, model: call.body.model}))})}`);
    expect(cli.timedOut).toBe(false);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain('fixture answer');
    expect(calls.slice(before).some(call => call.body.model === 'native-only')).toBe(true);
    await assertMetered(calls.slice(before), false);
  }, 45000);

  test('shared public history query returns a controlled missing response across worker/control', async () => {
    const before = calls.length;
    const missing = await post({model: 'org/native', previous_response_id: 'missing-public-history', input: 'next'});
    expect(missing.status).toBe(422);
    expect(missing.body.error).toBe('codex_router_history_missing_start_new_conversation');
    expect(calls).toHaveLength(before);
  });

  test.skipIf(process.env.BUNGEE_CODEX_CLI_PROBE !== '1')('isolated CLI lists and explicitly selects each advertised reasoning level',async()=>{
    for(const [model,levels] of [['org/chat',['low','high','max']],['org/anthropic',['low','medium','high','max']],['org/deepseek-flash',['low','high','max']]] as const){
      for(const effort of levels){
        const before=calls.length;
        const result=await probeCodexChatgptModels({root:fixture!.root,baseUrl:`${proxy}/codex`,mockUrl:`http://127.0.0.1:${upstream!.port}`,token,model,effort});
        // The catalog default is null; Codex app-server exposes that absence as the client value "none".
        expect(result.reasoningModels).toEqual([{model,levels:[...levels],defaultEffort:'none'}]);
        expect(result.notifications.some((event:any)=>event.method==='turn/completed'&&event.status==='completed')).toBe(true);
        const outgoing=calls.slice(before);expect(outgoing).toHaveLength(1);
        if(model==='org/chat')expect(outgoing[0]!.body).toMatchObject({model:CODEX_CHAT_MODEL,reasoning_effort:effort});
        else if(model==='org/deepseek-flash'){
          expect(outgoing[0]!.path).toBe('/v1/chat/completions');
          expect(outgoing[0]!.body).toMatchObject({model:CODEX_DEEPSEEK_MODEL,reasoning_effort:effort,stream:true});
          expect(outgoing[0]!.body.messages.some((message:any)=>message.role==='developer')).toBe(false);
          expect(outgoing[0]!.body.messages.some((message:any)=>message.role==='system')).toBe(true);
          expect(result.notifications.some((event:any)=>event.itemType==='agentMessage'&&event.text==='chat answer')).toBe(true);
        } else expect(outgoing[0]!.body).toMatchObject({model:CODEX_ANTHROPIC_MODEL,output_config:{effort}});
        expect(outgoing[0]!.body).not.toHaveProperty('thinking');
        console.info(`codex_router_cli_effort ${JSON.stringify({model,effort,levels,defaultEffort:'none',requestId:outgoing[0]!.requestId,transport:outgoing[0]!.transport})}`);
        await assertMetered(outgoing);
      }
    }
  },90000);

  async function validateCatalogNotifications(headers: Record<string, string>) {
    const original = nativeCatalogModel;
    let clientEtag: string | null = null;
    const beforeQueries = modelQueries.length;
    async function refreshCatalog() {
      const result = await fetch(`${proxy}/codex/models?client_version=0.162.1`, {headers: {...headers, 'cache-control': 'no-cache'}, signal: AbortSignal.timeout(20000)});
      expect(result.status).toBe(200);
      const bytes = await result.arrayBuffer();
      // Independent byte-level check, including non-ASCII native catalog fields.
      expect(result.headers.get('etag')).toBe(`"${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}"`);
      expect(result.headers.get('cache-control')).toBe('private, no-store');
      clientEtag = result.headers.get('etag');
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    async function generateCatalogIdentity(model: string, stream: boolean, overrides: Record<string, string> = {}) {
      const result = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {...headers, ...overrides, 'content-type': 'application/json'},
        body: JSON.stringify({model, stream, input: 'validator generation'}), signal: AbortSignal.timeout(20000)});
      expect(result.status).toBe(200);
      const text = await result.text();
      if (stream) expect(text).toContain('response.completed'); else expect(JSON.parse(text).status).toBe('completed');
      expect(result.headers.get('x-fixture-response')).toBe(model === 'native-only' || model === 'org/native' || stream ? 'keep' : null);
      return result.headers.get('x-models-etag');
    }
    try {
      expect(await generateCatalogIdentity('native-only', true)).toBeNull();
      await refreshCatalog();
      const directoryPid = modelQueries.at(-1)!.pid;
      const limited = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'},
        body: JSON.stringify({model: 'native-only', stream: true, input: 'fixture-sse-rate-limit'}), signal: AbortSignal.timeout(20000)});
      expect(limited.status).toBe(429);
      expect(limited.headers.get('x-models-etag')).toBe(clientEtag);
      expect(limited.headers.get('retry-after')).toBe('5');
      expect(await limited.text()).toBe('event: error\ndata: {"error":"rate_limit"}\n\n');
      expect(workers.map(worker => worker.pid)).toContain(directoryPid);
      const generationPids = new Set<number>();
      for (let i = 0; i < 3; i++) {
        const notification = await generateCatalogIdentity('native-only', i % 2 === 0);
        // Codex compares exact strings; it fetches only on a nonempty mismatch.
        if (notification && notification !== clientEtag) await refreshCatalog();
        expect(notification).toBe(clientEtag);
        generationPids.add(calls.at(-1)!.pid);
      }
      expect(modelQueries.length - beforeQueries).toBe(1);
      for (let i = 0; i < 24 && ![...generationPids].some(pid => pid !== directoryPid); i++) {
        expect(await generateCatalogIdentity('native-only', false)).toBe(clientEtag);
        generationPids.add(calls.at(-1)!.pid);
      }
      expect([...generationPids].some(pid => pid !== directoryPid)).toBe(true);
      for (const model of ['org/native', 'org/chat', 'org/anthropic']) for (const stream of [false, true]) {
        expect(await generateCatalogIdentity(model, stream)).toBe(clientEtag);
      }
      const overridesList: Record<string, string>[] = [
        {authorization: `Bearer ${otherToken}`}, {'chatgpt-account-id': 'another-account'}, {version: '0.160.1'}, {version: ''},
      ];
      for (const overrides of overridesList) expect(await generateCatalogIdentity('native-only', false, overrides)).toBeNull();
      expect(modelQueries.length - beforeQueries).toBe(1);
      const oldEtag = clientEtag;
      nativeCatalogModel = {...original, display_name: 'Updated directory 中文🙂'};
      // An upstream change is discovered by normal directory refresh, not generation.
      expect(await generateCatalogIdentity('native-only', true)).toBe(oldEtag);
      expect(modelQueries.length - beforeQueries).toBe(1);
      expect((await refreshCatalog()).models[0].display_name).toBe('Updated directory 中文🙂');
      expect(clientEtag).not.toBe(oldEtag);
      expect(await generateCatalogIdentity('org/chat', true)).toBe(clientEtag);
      await refreshCatalog();
      expect(await generateCatalogIdentity('native-only', false)).toBe(clientEtag);
      expect(modelQueries.length - beforeQueries).toBe(3);
    } finally { nativeCatalogModel = original; }
  }

  test('actual catalog validators cross workers, suppress per-generation refresh and update on explicit catalog refresh', async () => {
    const anonymousHeaders = {'chatgpt-account-id': 'validator-account', version: '0.162.1'};
    try {
      expect((await control('/api/plugins/key-access/control/routes', 'PUT', {protectedRouteIds: []})).response.status).toBe(200);
      await validateCatalogNotifications(anonymousHeaders);
      expect((await control('/api/plugins/key-access/control/routes', 'PUT', {protectedRouteIds: [ENTRY]})).response.status).toBe(200);
      const before = calls.length;
      for (const headers of [anonymousHeaders, {...anonymousHeaders, authorization: 'Bearer invalid'}]) {
        const deniedCatalog = await fetch(`${proxy}/codex/models?client_version=0.162.1`, {headers, signal: AbortSignal.timeout(20000)});
        const deniedGeneration = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'},
          body: JSON.stringify({model: 'native-only', input: 'denied generation'}), signal: AbortSignal.timeout(20000)});
        expect(deniedCatalog.status).toBe(401); await deniedCatalog.text();
        expect(deniedGeneration.status).toBe(401); await deniedGeneration.text();
      }
      expect(calls).toHaveLength(before);
      await validateCatalogNotifications({...anonymousHeaders, authorization: `Bearer ${token}`});
    } finally {
      expect((await control('/api/plugins/key-access/control/routes', 'PUT', {protectedRouteIds: [ENTRY]})).response.status).toBe(200);
    }
  }, 120000);

  test('production-size model snapshots suppress upstream fetches, restore 304 and notify alpha clients', async () => {
    const original = nativeCatalogModel;
    // Fill only the instructions to the asserted directory size so the installed CLI's real metadata is preserved.
    const overhead = Buffer.byteLength(JSON.stringify({models: [{...original, base_instructions: ''}]}), 'utf8');
    expect(overhead).toBeLessThan(580_000);
    nativeCatalogModel = {...original, base_instructions: '中'.repeat(Math.floor((580_000 - overhead) / 3))};
    const headers = {authorization: `Bearer ${token}`, 'chatgpt-account-id': 'snapshot-cache-account', version: '0.162.0-alpha.17.2'};
    try {
      const bytes = Buffer.byteLength(JSON.stringify({models: [nativeCatalogModel]}), 'utf8');
      expect(bytes).toBeGreaterThan(568_000); expect(bytes).toBeLessThan(600_000);
      const before = modelQueries.length;
      let etag: string | null = null;
      for (let i = 0; i < 12; i++) {
        const result = await fetch(`${proxy}/codex/models?client_version=0.162.0`, {headers, signal: AbortSignal.timeout(20000)});
        expect(result.status).toBe(200);
        const bytes = await result.arrayBuffer();
        expect(result.headers.get('etag')).toBe(`"${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}"`);
        const body = JSON.parse(new TextDecoder().decode(bytes)); expect(body.models[0]).toEqual(nativeCatalogModel);
        etag ??= result.headers.get('etag'); expect(result.headers.get('etag')).toBe(etag);
      }
      expect(modelQueries.length - before).toBeGreaterThan(0);
      expect(modelQueries.length - before).toBeLessThanOrEqual(2);
      const refreshStart = modelQueries.length;
      for (let i = 0; i < 4; i++) {
        const result = await fetch(`${proxy}/codex/models?client_version=0.162.0`, {headers: {...headers, 'cache-control': 'no-cache'}, signal: AbortSignal.timeout(20000)});
        expect(result.status).toBe(200); expect(result.headers.get('etag')).toBe(etag);
        expect((await result.json() as any).models[0]).toEqual(nativeCatalogModel);
      }
      expect(modelQueries.length - refreshStart).toBe(4);
      expect(modelQueries.slice(refreshStart).some(query => query.etag?.startsWith('W/"'))).toBe(true);
      const generationStart = modelQueries.length;
      for (const model of ['native-only', 'org/chat']) {
        const result = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {...headers, 'content-type': 'application/json'},
          body: JSON.stringify({model, stream: true, input: 'alpha directory notification'}), signal: AbortSignal.timeout(20000)});
        expect(result.status).toBe(200); expect(result.headers.get('x-models-etag')).toBe(etag);
        expect(await result.text()).toContain('response.completed');
      }
      expect(modelQueries.length).toBe(generationStart);
    } finally { nativeCatalogModel = original; }
  }, 60000);

  test('public models retain metadata; long tool history crosses real workers via canonical RPC and rejects another identity', async () => {
    const catalog = await fetch(`${proxy}/codex/models?client_version=0.160.1`, {headers: {authorization: `Bearer ${token}`}});
    expect(catalog.status).toBe(200);
    const catalogText = await catalog.text();
    if (!catalogText.startsWith('{')) throw new Error(`catalog non-JSON ${catalog.headers.get('content-type')}: ${catalogText.slice(0, 300)}; ${await master!.diagnostics?.()}`);
    const body: any = JSON.parse(catalogText); expect(body.models[0]).toEqual(nativeCatalogModel);
    expect(body.models.slice(1).map((model: any) => model.slug)).toEqual(CODEX_MODELS);
    expect(body.models[1].context_window).toBe(200000);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(65536);
    const start = calls.length;
    const first = await post({model: 'org/native', input: history, tools}); expect(first.status).toBe(200);
    firstId = first.body.id; firstPid = calls.at(-1)!.pid;
    expect(calls.at(-1)!.body).toMatchObject({model: 'org/native', input: history, tools});
    let crossed = false;
    for (let i = 0; i < 24 && !crossed; i++) {
      const delta = [{role: 'user', content: `cross-worker-${i}`}];
      const next = await post({model: 'org/native', previous_response_id: firstId, input: delta, tools});
      expect(next.status).toBe(200); const actual = calls.at(-1)!;
      expect(actual.body.input).toEqual([...history, ...first.body.output, ...delta]);
      expect(actual.body.previous_response_id).toBeUndefined(); expect(actual.body.model).toBe('org/native');
      crossed = actual.pid !== firstPid;
    }
    expect(crossed).toBe(true);
    expect(new Set(calls.slice(start).map(call => call.pid))).toEqual(new Set(workers.map(worker => worker.pid)));
    const before = calls.length;
    const denied = await post({model: 'org/native', previous_response_id: firstId, input: 'other key'}, otherToken);
    expect(denied.status).toBe(422); expect(JSON.stringify(denied.body)).toContain('history_missing'); expect(calls).toHaveLength(before);
    await assertMetered(calls.slice(start));
    console.info(`codex_router_cross_worker ${JSON.stringify({masterPid: master!.child.pid, workerPids: workers.map(w => w.pid), originPid: firstPid, continuationPids: calls.slice(start + 1).map(c => c.pid), historyBytes: Buffer.byteLength(JSON.stringify(history)), canonicalService: 'llm-protocol-adapter.history.v1'})}`);
  }, 60000);

  test('catalog metadata alone drives advertised efforts and each converted HTTP protocol carries only the selected effort', async () => {
    const catalog = await fetch(`${proxy}/codex/models?client_version=0.162.1`, {headers: {authorization: `Bearer ${token}`}});
    expect(catalog.status).toBe(200);
    const body: any = await catalog.json();
    expect(body.models.find((model: any) => model.slug === 'org/deepseek-flash')).toMatchObject({
      context_window: 1048576, input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{effort: 'low', description: 'low'}, {effort: 'high', description: 'high'}, {effort: 'max', description: 'max'}],
      supports_reasoning_effort_updates: true, default_reasoning_level: null,
    });
    const before = calls.length;
    const generate = (model: string, effort?: string) => post({model, input: 'catalog effort evidence', ...(effort ? {reasoning: {effort}} : {})});
    // Production Codex history carries several developer messages and no instructions.
    const deepseekHistory = [
      {role: 'developer', content: 'fixture developer one'},
      {role: 'user', content: 'fixture user one'},
      {role: 'developer', content: 'fixture developer two'},
      {role: 'user', content: 'fixture user two'},
      {role: 'developer', content: 'fixture developer three'},
      {role: 'user', content: 'fixture user three'},
      {type: 'function_call', call_id: 'deepseek_lookup', name: 'lookup', arguments: '{}'},
      {type: 'function_call_output', call_id: 'deepseek_lookup', output: 'fixture tool result'},
    ];
    const nonstream = await post({model: 'org/deepseek-flash', input: deepseekHistory, tools, reasoning: {effort: 'high'}});
    expect(nonstream.status).toBe(200);
    expect(nonstream.body).toMatchObject({status: 'completed',
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'chat answer'}]}],
      usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6,
        input_tokens_details: {cached_tokens: 1}, output_tokens_details: {reasoning_tokens: 1}}});
    let call = calls.at(-1)!;
    expect(call.path).toBe('/v1/chat/completions');
    expect(call.body).toMatchObject({model: CODEX_DEEPSEEK_MODEL, reasoning_effort: 'high'});
    expect(call.body).not.toHaveProperty('thinking');
    expect(call.body.messages.map((message: any) => [message.role, message.content ?? null])).toEqual([
      ['system', 'fixture developer one'], ['user', 'fixture user one'], ['system', 'fixture developer two'], ['user', 'fixture user two'],
      ['system', 'fixture developer three'], ['user', 'fixture user three'], ['assistant', null], ['tool', 'fixture tool result'],
    ]);
    expect(call.body.tools[0].function.name).toEqual(expect.any(String));
    expect(call.body.messages[6]).toMatchObject({tool_calls: [{id: 'deepseek_lookup', type: 'function', function: {name: call.body.tools[0].function.name, arguments: '{}'}}]});
    expect(call.body.messages[7]).toMatchObject({tool_call_id: 'deepseek_lookup'});
    const streamed = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
      body: JSON.stringify({model: 'org/deepseek-flash', input: deepseekHistory, tools, reasoning: {effort: 'high'}, stream: true}), signal: AbortSignal.timeout(20000)});
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    const streamText = await streamed.text();
    expect(streamText).not.toContain('stream_read_failed');
    const streamEvents = streamText.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(data => data && data !== '[DONE]').map(data => JSON.parse(data));
    expect(streamEvents.filter(event => ['response.failed', 'response.incomplete', 'error'].includes(event.type))).toEqual([]);
    const completed = streamEvents.filter(event => event.type === 'response.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.response).toMatchObject({status: 'completed',
      output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'chat answer'}]}],
      usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6,
        input_tokens_details: {cached_tokens: 1}, output_tokens_details: {reasoning_tokens: 1}}});
    call = calls.at(-1)!;
    expect(call.path).toBe('/v1/chat/completions');
    expect(call.body).toMatchObject({model: CODEX_DEEPSEEK_MODEL, reasoning_effort: 'high'});
    expect(call.body.messages.some((message: any) => message.role === 'developer')).toBe(false);
    expect(call.body.messages.some((message: any) => message.role === 'system')).toBe(true);
    expect((await generate('org/anthropic', 'medium')).status).toBe(200);
    call = calls.at(-1)!;
    expect(call.path).toBe('/v1/messages');
    expect(call.body).toMatchObject({model: CODEX_ANTHROPIC_MODEL, output_config: {effort: 'medium'}});
    expect(call.body).not.toHaveProperty('thinking');
    for (const [model, path] of [['org/deepseek-flash', '/v1/chat/completions'], ['org/anthropic', '/v1/messages']] as const) {
      expect((await generate(model)).status).toBe(200);
      call = calls.at(-1)!;
      expect(call.path).toBe(path);
      expect(call.body).not.toHaveProperty('thinking');
      if (path === '/v1/chat/completions') expect(call.body).not.toHaveProperty('reasoning_effort');
      else expect(call.body.output_config).toBeUndefined();
    }
    await assertMetered(calls.slice(before));
    const rejected = calls.length;
    const unsupported = await generate('org/deepseek-flash', 'medium');
    expect(unsupported.status).toBe(422);
    expect(unsupported.body).toMatchObject({error: 'llm_adapter_unsupported_reasoning', param: 'reasoning.effort'});
    expect(calls).toHaveLength(rejected);
    expect(calls.slice(before)).toHaveLength(5);
    console.info(`codex_router_catalog_effort ${JSON.stringify({model: 'org/deepseek-flash', levels: ['low', 'high', 'max'], defaultEffort: null,
      protocols: ['chat_completions', 'anthropic_messages'], unmappedEffortRejected: true,
      nonstreamUsage: nonstream.body.usage, streamUsage: completed[0]!.response.usage})}`);
  }, 60000);

  test('built Chat tool images keep parallel pairing from WS input through cross-worker previous_response_id replay', async () => {
    // Existing committed PNG bytes: the fixture upstream is not a real provider.
    const png = async (name: string) => `data:image/png;base64,${(await readFile(join(import.meta.dir, '../../packages/ui/public', name))).toString('base64')}`;
    const [imageA, imageB] = [await png('favicon-16x16.png'), await png('favicon-32x32.png')];
    expect(Buffer.from(imageA.split(',')[1]!, 'base64').subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // Real parallel batch shape: every call first, then every tool result.
    const request = {model: 'org/deepseek-flash', tools, input: [
      {role: 'user', content: 'inspect the tool images'},
      {type: 'function_call', call_id: 'image_call_a', name: 'lookup', arguments: '{}'},
      {type: 'function_call', call_id: 'image_call_b', name: 'lookup', arguments: '{}'},
      {type: 'function_call_output', call_id: 'image_call_a', output: [
        {type: 'input_text', text: 'first tool text'}, {type: 'input_image', image_url: imageA, detail: 'high'}]},
      {type: 'function_call_output', call_id: 'image_call_b', output: [{type: 'input_image', image_url: imageB, detail: 'low'}]},
    ]};
    const textOf = (content: unknown) => typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((part: any) => part.text ?? '').join(' ') : '';
    const conversationText = (messages: any[]) => messages.map(message => textOf(message.content)).join('\n');
    const assertProjection = (call: Call) => {
      expect(call.path).toBe('/v1/chat/completions');
      const messages: any[] = call.body.messages;
      const toolMessages = messages.filter((message: any) => message.role === 'tool');
      expect(toolMessages.map((message: any) => message.tool_call_id)).toEqual(['image_call_a', 'image_call_b']);
      expect(messages.flatMap((message: any) => message.tool_calls ?? []).map((tool: any) => tool.id)).toEqual(['image_call_a', 'image_call_b']);
      // Text stays on the tool message; a pure-image result points at the following user message.
      expect(textOf(toolMessages[0].content)).toContain('first tool text');
      const images = messages.filter((message: any) => message.role === 'user' && Array.isArray(message.content))
        .flatMap((message: any) => message.content.filter((part: any) => part.type === 'image_url'));
      // Digest and length keep byte equality without putting an image in an assertion diff.
      expect(images.map((part: any) => [part.image_url.url.length, imageDigest(part.image_url.url)]))
        .toEqual([[imageA.length, imageDigest(imageA)], [imageB.length, imageDigest(imageB)]]);
      // Canonical history replay projects each image once instead of accumulating it.
      expect(JSON.stringify(messages).split(imageA).length - 1).toBe(1);
      expect(JSON.stringify(messages).split(imageB).length - 1).toBe(1);
    };
    const start = calls.length;
    let socket: Socket | undefined;
    let response: {status: number; body: unknown} | undefined;
    try {
      socket = await openSocket();
      const generation = await socket.create(request);
      expect(generation.at(-1).type).toBe('response.completed');
      const origin = calls.at(-1)!;
      assertProjection(origin);
      const prior = calls.length;
      const result = await post({model: 'org/deepseek-flash', previous_response_id: generation.at(-1).response.id, input: [{role: 'user', content: 'after the images'}]});
      response = result;
      expect(result.status).toBe(200);
      expect(calls.length - prior).toBe(1);
      const replay = calls.at(-1)!;
      // Ingress admission rotates workers for each public request; verify this replay ran on the other one.
      expect(replay.pid).not.toBe(origin.pid);
      assertProjection(replay);
      expect(conversationText(replay.body.messages as any[])).toContain('after the images');
      expect(calls.length - start).toBe(2);
    } catch (error) {
      try {
        console.error(`codex_router_tool_images_failure ${failureEvidence({events: socket?.events, response, calls: calls.slice(start)})}`);
        console.error(`codex_router_test_diagnostics ${failureEvidence(await master?.diagnostics?.() ?? '')}`);
      } catch {}
      try {await socket?.close();} catch (closeError) {
        try {console.error(`codex_router_tool_images_close_error ${failureEvidence(closeError instanceof Error ? closeError.message : closeError)}`);} catch {}
      }
      throw error;
    }
    await socket.close();
    console.info(`codex_router_chat_tool_images ${JSON.stringify({inbound: 'WS', parallelCalls: 2,
      imageBytes: [imageA.length, imageB.length], continuationRequestId: calls.at(-1)!.requestId,
      workerPids: calls.slice(start).map(call => call.pid), crossWorker: true})}`);
  }, 60000);

  test('built Chat replay keeps interleaved assistant text and tool calls adjacent before the projected tool image', async () => {
    const image = `data:image/png;base64,${(await readFile(join(import.meta.dir, '../../packages/ui/public/favicon-32x32.png'))).toString('base64')}`;
    const marker = 'fixture-chat-text-before-tool';
    const prompt = 'A tool will return an image; keep the whole answer.';
    const output = [{type: 'function_call_output', call_id: 'fixture_image_call', output: [
      {type: 'input_text', text: 'tool image text'}, {type: 'input_image', image_url: image, detail: 'high'}]}];
    const textOf = (content: unknown) => typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((part: any) => part.text ?? '').join('') : '';
    const conversationText = (messages: any[]) => messages.map(message => textOf(message.content)).join('\n');
    const start = calls.length;
    let streamStatus: number | null = null;
    let streamText = '';
    let events: any[] = [];
    let response: {status: number; body: unknown} | undefined;
    let jsonResponse: {status: number; body: unknown} | undefined;
    try {
      const streamed = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
        body: JSON.stringify({model: 'org/deepseek-flash', input: `${marker}: ${prompt}`, tools, stream: true}), signal: AbortSignal.timeout(20000)});
      streamStatus = streamed.status;
      streamText = await streamed.text();
      expect(streamed.status).toBe(200);
      events = streamText.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim()).filter(data => data && data !== '[DONE]').map(data => JSON.parse(data));
      const completed = events.find(event => event.type === 'response.completed');
      expect(completed).toBeDefined();
      // The real upstream stream is interleaved text, tool call, text; the adapter must complete it as-is.
      expect(completed.response.output.map((item: any) => item.type)).toEqual(['message', 'function_call', 'message']);
      expect(completed.response.output[0].content.map((part: any) => part.text).join('')).toBe("I'll ");
      expect(completed.response.output[2].content.map((part: any) => part.text).join('')).toBe('start by retrieving the image.');
      expect(calls.length - start).toBe(1);
      const origin = calls[start]!;
      expect(origin.path).toBe('/v1/chat/completions');
      expect(origin.body.stream).toBe(true);
      const prior = calls.length;
      const result = await post({model: 'org/deepseek-flash', previous_response_id: completed.response.id, input: output});
      response = result;
      expect(result.status).toBe(200);
      expect(calls.length - prior).toBe(1);
      const replay = calls.at(-1)!;
      // Ingress admission rotates workers for each public request; verify this replay ran on the other one.
      expect(replay.pid).not.toBe(origin.pid);
      expect(replay.path).toBe('/v1/chat/completions');
      const messages: any[] = replay.body.messages;
      expect(conversationText(messages)).toContain(marker);
      const toolIndex = messages.findIndex((message: any) => message.role === 'tool');
      expect(toolIndex).toBeGreaterThan(0);
      const assistant = messages[toolIndex - 1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.tool_calls.map((call: any) => call.id)).toEqual(['fixture_image_call']);
      expect(textOf(assistant.content)).toBe("I'll start by retrieving the image.");
      expect(messages[toolIndex].tool_call_id).toBe('fixture_image_call');
      expect(textOf(messages[toolIndex].content)).toBe('tool image text');
      const projection = messages.findIndex((message: any, index: number) => index > toolIndex && message.role === 'user'
        && Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url'));
      expect(projection).toBeGreaterThan(toolIndex);
      expect(textOf(messages[projection].content)).toContain('fixture_image_call');
      const projected = messages[projection].content.find((part: any) => part.type === 'image_url');
      expect(projected).toBeDefined();
      // Digest and length keep byte equality without putting an image in an assertion diff.
      expect([projected.image_url.url.length, imageDigest(projected.image_url.url)]).toEqual([image.length, imageDigest(image)]);
      expect(messages.filter((message: any) => message.role === 'user' && Array.isArray(message.content)
        && message.content.some((part: any) => part.type === 'image_url'))).toHaveLength(1);
      const serialized = JSON.stringify(messages);
      expect(serialized.split(image).length - 1).toBe(1);
      expect(messages.filter((message: any) => message.role === 'assistant' && textOf(message.content).includes("I'll "))).toHaveLength(1);
      // Non-stream Chat JSON carrying the observed empty choice metadata and positional tool index.
      const json = await post({model: 'org/deepseek-flash', input: `${marker}: ${prompt}`, tools});
      jsonResponse = json;
      expect(json.status).toBe(200);
      expect(json.body.output).toContainEqual(expect.objectContaining({type: 'function_call', call_id: 'fixture_image_call'}));
      expect(calls.length - start).toBe(3);
      console.info(`codex_router_chat_text_tool_text ${JSON.stringify({inbound: 'SSE', replayedAcrossWorker: true,
        assistantText: "I'll start by retrieving the image.", toolCallId: 'fixture_image_call',
        originPid: origin.pid, replayPid: replay.pid, upstreamCalls: calls.length - start})}`);
    } catch (error) {
      try {
        console.error(`codex_router_text_tool_text_failure ${failureEvidence({status: streamStatus, stream: streamText,
          events, response, json: jsonResponse, calls: calls.slice(start)})}`);
        console.error(`codex_router_test_diagnostics ${failureEvidence(await master?.diagnostics?.() ?? '')}`);
      } catch {}
      throw error;
    }
  }, 60000);

  async function openSocket(credential = token): Promise<Socket> {
    const client = new WebSocket(`${proxy.replace('http:', 'ws:')}/codex/responses`, {headers: {authorization: `Bearer ${credential}`}});
    const events: any[] = [];
    client.onmessage = event => events.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('public WS open timed out')), 10000);
      client.onopen = () => {clearTimeout(timeout); resolve();};
      client.onerror = () => {clearTimeout(timeout); reject(new Error('public WS open failed'));};
    });
    const socket = {client, events, async create(body: any, allowError = false) {
      const start = events.length; client.send(JSON.stringify({type: 'response.create', ...body}));
      await waitUntil(() => events.slice(start).some(e => ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(e.type)), 'public WS generation has no terminal', 15000);
      const generation = events.slice(start);
      if (!allowError && generation.at(-1)?.type === 'error') throw new Error(`WS generation: ${JSON.stringify(generation)}; upstream=${JSON.stringify(calls.slice(-1).map(call => ({...call, body: {model: call.body.model}})))}; ${await master!.diagnostics?.()}`);
      return generation;
    }, async close() {
      if (client.readyState === WebSocket.CLOSED) return;
      client.close(); await waitUntil(() => client.readyState === WebSocket.CLOSED, 'public WS did not close', 5000);
    }};
    sockets.add(socket); return socket;
  }
  test('cached search declaration at tools[28] preserves HTTP/WS tool history and logs its omission', async () => {
    const start = calls.length;
    const declarations = [...tools, ...Array.from({length: 24}, (_, i) => ({type: 'function', name: `fixture_extra_${i}`, parameters: {type: 'object', properties: {}}})),
      {type: 'web_search', external_web_access: false}];
    const socket = await openSocket();
    try {
      for (const model of ['org/chat', 'org/anthropic']) {
        const raw = {model, input: smallHistory, tools: declarations, tool_choice: 'auto', stream: true, store: false, include: ['reasoning.encrypted_content']};
        const result = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(raw), signal: AbortSignal.timeout(20000)});
        expect(result.status).toBe(200); expect(await result.text()).toContain('response.completed');
        expect(calls.at(-1)!.body.tools).toHaveLength(28);
        expect(JSON.stringify(calls.at(-1)!.body)).not.toContain('web_search');
        expect(JSON.stringify(calls.at(-1)!.body.messages)).toContain('custom result');
        const events = await socket.create(raw); expect(events.at(-1).type).toBe('response.completed');
        expect(calls.at(-1)!.body.tools).toHaveLength(28);
        expect(JSON.stringify(calls.at(-1)!.body.messages)).toContain('file result');
        const before = calls.length;
        const denied = await post({...raw, stream: false, tool_choice: {type: 'web_search'}});
        expect(denied.status).toBe(422); expect(denied.body.param).toBe('tools[28].type'); expect(calls).toHaveLength(before);
      }
      const requestId = calls.at(-1)!.requestId;
      await waitUntil(() => {
        const db = new Database(fixture!.accessDbPath, {readonly: true});
        try {
          const row: any = db.query("SELECT j.value FROM access_logs, json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='dispatch_conversion' AND json_extract(j.value,'$.detail.requestId')=?").get(requestId);
          return row && JSON.parse(row.value).detail.diagnostics.some((item: any) => item.param === 'tools[28]' && item.reason === 'optional_hosted_web_search_unavailable' && item.action === 'omitted');
        } finally { db.close(); }
      }, 'optional hosted search diagnostic was not logged', 12000);
      await assertMetered(calls.slice(start));
    } finally { await socket.close(); }
  }, 60000);
  test('captured full HTTP/WS requests cross the built gateway; canonical tool history crosses workers and target protocol',async()=>{
    const start=calls.length;
    const socket=await openSocket();
    try{
      for(const [captured,count] of [[capturedBase,11],[capturedPreferences,13]] as const){
        const raw=await fetch(`${proxy}/codex/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...captured,model:'org/chat'}),signal:AbortSignal.timeout(20000)});
        expect(raw.status).toBe(200);const text=await raw.text();expect(text).toContain('response.completed');
        expect(calls.at(-1)!.body.tools).toHaveLength(count);expect(calls.at(-1)!.path).toBe('/v1/chat/completions');
        const result=await socket.create({...captured,model:'org/chat'});expect(result.at(-1).type).toBe('response.completed');expect(calls.at(-1)!.body.tools).toHaveLength(count);
      }
      const conversionId=calls.at(-1)!.requestId;
      await waitUntil(()=>{
        const db=new Database(fixture!.accessDbPath,{readonly:true});
        try{
          const row:any=db.query("SELECT j.value FROM access_logs, json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='dispatch_conversion' AND json_extract(j.value,'$.detail.requestId')=?").get(conversionId);
          const step=row?.value && JSON.parse(row.value);
          return step?.detail?.diagnostics?.some((item:any)=>item.param==='stream_options.reasoning_summary_delivery');
        }finally{db.close();}
      },'conversion diagnostic did not reach the existing request log',12000);
      const carrier={type:'additional_tools',role:'developer',tools};
      const first=await post({model:'org/chat',input:[carrier,...smallHistory]});expect(first.status).toBe(200);
      const origin=calls.at(-1)!.pid;
      const changed={...carrier,tools:tools.map(tool=>({...tool,description:'current request declaration'}))};
      let crossed=false;
      for(let i=0;i<24 && !crossed;i++){
        const follow=await post({model:'org/anthropic',previous_response_id:first.body.id,input:[changed,{role:'user',content:'continue'}]});
        expect(follow.status).toBe(200);expect(calls.at(-1)!.path).toBe('/v1/messages');
        expect(calls.at(-1)!.body.tools).toHaveLength(4);
        const blocks=calls.at(-1)!.body.messages.flatMap((m:any)=>m.content);
        expect(blocks.filter((b:any)=>b.type==='tool_result').map((b:any)=>b.content)).toEqual(['ordinary result','file result','memory result','custom result']);
        crossed=calls.at(-1)!.pid!==origin;
      }
      expect(crossed).toBe(true);
      const before=calls.length;
      const denied=await post({model:'org/chat',input:'x',access_programs:{cyber:'daybreak_blue'}});
      expect(denied.status).toBe(422);expect(denied.body.param).toBe('access_programs.cyber');expect(calls).toHaveLength(before);
      await assertMetered(calls.slice(start));
    }finally{await socket.close();}
  },60000);
  test('public WS generations switch Chat/service → Anthropic/route with exact tool history and native WS transport, each metered once', async () => {
    const socket = await openSocket(); const start = calls.length;
    try {
      const warm = await socket.create({generate: false, model: 'org/chat', input: smallHistory});
      expect(warm.at(-1).type).toBe('response.completed'); expect(calls).toHaveLength(start);
      const chat = await socket.create({model: 'org/chat', previous_response_id: warm.at(-1).response.id, input: 'after warm', tools});
      expect(chat.at(-1).type).toBe('response.completed'); expect(chat.at(-1).response.model).toBe('org/chat');
      const chatCall = calls.at(-1)!; expect(chatCall.path).toBe('/v1/chat/completions'); expect(chatCall.body.model).toBe(CODEX_CHAT_MODEL);
      expect(chatCall.body.messages[0]).toMatchObject({role: 'developer', content: ' preserve the complete history '});
      const allChatCalls = chatCall.body.messages.flatMap((m: any) => m.tool_calls ?? []);
      expect(allChatCalls.map((t: any) => t.id)).toEqual(['plain', 'files', 'memory', 'shell']);
      expect(new Set(allChatCalls.map((t: any) => t.function.name)).size).toBe(4);
      expect(JSON.parse(allChatCalls[3].function.arguments)).toEqual({input: customInput});
      expect(chatCall.body.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content)).toEqual(['ordinary result', 'file result', 'memory result', 'custom result']);
      const anth = await socket.create({model: 'org/anthropic', previous_response_id: chat.at(-1).response.id, input: 'switch', tools});
      expect(anth.at(-1).type).toBe('response.completed'); expect(anth.at(-1).response.model).toBe('org/anthropic');
      const anthCall = calls.at(-1)!; expect(anthCall.path).toBe('/v1/messages'); expect(anthCall.body.model).toBe(CODEX_ANTHROPIC_MODEL);
      expect(anthCall.body.system).toContain(' preserve the complete history ');
      const blocks = anthCall.body.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
      expect(blocks.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id)).toEqual(['plain', 'files', 'memory', 'shell']);
      expect(blocks.find((b: any) => b.id === 'shell').input).toEqual({input: customInput});
      expect(blocks.filter((b: any) => b.type === 'tool_result').map((b: any) => b.content)).toEqual(['ordinary result', 'file result', 'memory result', 'custom result']);
      expect(blocks.some((b: any) => b.type === 'text' && b.text === 'chat answer')).toBe(true);
      let nativeId = '';
      for (let i = 0; i < 2; i++) {
        const native = await socket.create({model: 'org/native-ws', input: 'native repeated'});
        expect(native.at(-1).type).toBe('response.completed'); expect(calls.at(-1)!.transport).toBe('websocket');
        expect(calls.at(-1)!.body).toMatchObject({type: 'response.create', model: 'org/native-ws'});
        nativeId = native.at(-1).response.id;
      }
      expect(calls.slice(start)).toHaveLength(4);
      expect(new Set(calls.slice(start).map(c => c.pid)).size).toBe(1);
      await assertMetered(calls.slice(start));
      // A new connection restores another connection's response through shared control history.
      const other = await openSocket();
      try {
        const restored = await other.create({model: 'org/native', previous_response_id: nativeId, input: 'new connection', tools});
        expect(restored.at(-1).type).toBe('response.completed');
        expect(calls.at(-1)!.body.input).toEqual([{role: 'user', content: 'native repeated'}, message('fixture answer'), {role: 'user', content: 'new connection'}]);
        await assertMetered([calls.at(-1)!]);
      } finally {await other.close();}
      if (process.env.BUNGEE_CODEX_CLI_PROBE === '1') {
        const beforeCli = calls.length, beforeQueries = modelQueries.length;
        const cli = await probeCodexCli({root: fixture!.root, baseUrl: `${proxy}/codex`, token, model: 'org/native'});
        const actual = calls.slice(beforeCli).map(call => ({pid: call.pid, path: call.path, transport: call.transport, model: call.body.model}));
        console.info(`codex_router_cli_probe ${JSON.stringify({...cli, upstream: actual, modelQueries: modelQueries.slice(beforeQueries)})}`);
        expect(cli.timedOut).toBe(false); expect(cli.code).toBe(0);
        expect(cli.stdout).toContain('"type":"agent_message"'); expect(cli.stdout).toContain('fixture answer');
        expect(actual.length).toBeGreaterThan(0); expect(actual.every(call => call.model === 'org/native')).toBe(true);
        const beforeDiscovery = calls.length, beforeDiscoveryQueries = modelQueries.length;
        // A fresh account partitions the directory snapshot; the shared fixture account may already be warm.
        const discovery = await probeCodexChatgptModels({root: fixture!.root, baseUrl: `${proxy}/codex`, mockUrl: `http://127.0.0.1:${upstream!.port}`, token, model: 'org/native', accountId: `fixture-cold-${randomUUID()}`});
        const discoveredActual = calls.slice(beforeDiscovery).map(call => ({pid: call.pid, path: call.path, transport: call.transport, model: call.body.model}));
        const discoveredQueries = modelQueries.slice(beforeDiscoveryQueries);
        console.info(`codex_router_cli_discovery ${JSON.stringify({...discovery, modelQueries: discoveredQueries, accountQueries, upstream: discoveredActual})}`);
        expect(discovery.accountType).toBe('chatgpt'); expect(discovery.modelListError).toBeNull();
        expect(CODEX_MODELS.every(model => discovery.listedModels.includes(model))).toBe(true);
        expect(discoveredQueries.length).toBeGreaterThan(0);
        for (const query of discoveredQueries) {
          expect(query.clientVersion).toMatch(/^\d+\.\d+\.\d+/);
          expect(discovery.userAgent).toContain(`/${query.clientVersion}`);
        }
        expect(discoveredActual.length).toBeGreaterThan(0); expect(discoveredActual.every(call => call.model === 'org/native')).toBe(true);
        expect(discovery.notifications.some((event: any) => event.method === 'turn/completed' && event.status === 'completed')).toBe(true);
        const beforeChat = calls.length;
        const chatDiscovery = await probeCodexChatgptModels({root: fixture!.root, baseUrl: `${proxy}/codex`, mockUrl: `http://127.0.0.1:${upstream!.port}`, token, model: 'org/chat'});
        const chatActual = calls.slice(beforeChat).map(call => ({pid: call.pid, path: call.path, transport: call.transport,
          requestShape: {keys: Object.keys(call.body), model: call.body.model, stream: call.body.stream,
            messages: call.body.messages?.map((message: any) => ({role: message.role, contentType: typeof message.content})),
            tools: call.body.tools?.map((tool: any) => ({type: tool.type, name: tool.function?.name}))}}));
        const inputShapes = (await readFile(join(fixture!.root, 'cli-input-shapes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(shape => shape.stage === 'dispatch' && shape.model === 'org/chat').slice(-2);
        console.info(`codex_router_cli_chat ${JSON.stringify({...chatDiscovery, upstream: chatActual, inputShapes})}`);
        expect(chatDiscovery.listedModels).toContain('org/chat');
        expect(chatDiscovery.notifications.some((event: any) => event.method === 'turn/completed' && event.status === 'completed')).toBe(true);
        expect(chatActual).toHaveLength(1); expect(chatActual[0]!.path).toBe('/v1/chat/completions');
        expect(chatActual[0]!.requestShape.model).toBe(CODEX_CHAT_MODEL);
        expect(chatDiscovery.notifications.some((event: any) => event.itemType === 'agentMessage' && event.text === 'chat answer')).toBe(true);
        const beforeAnthropic = calls.length;
        const anthropicDiscovery = await probeCodexChatgptModels({root: fixture!.root, baseUrl: `${proxy}/codex`, mockUrl: `http://127.0.0.1:${upstream!.port}`, token, model: 'org/anthropic'});
        const anthropicActual = calls.slice(beforeAnthropic).map(call => ({pid: call.pid, path: call.path, transport: call.transport,
          requestShape: {keys: Object.keys(call.body), model: call.body.model, stream: call.body.stream,
            messages: call.body.messages?.map((message: any) => ({role: message.role, contentTypes: message.content?.map((part: any) => part.type)})),
            tools: call.body.tools?.map((tool: any) => ({name: tool.name, schemaType: tool.input_schema?.type}))}}));
        const anthropicInputShapes = (await readFile(join(fixture!.root, 'cli-input-shapes.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(shape => shape.stage === 'dispatch' && shape.model === 'org/anthropic').slice(-1);
        console.info(`codex_router_cli_anthropic ${JSON.stringify({...anthropicDiscovery, upstream: anthropicActual, inputShapes: anthropicInputShapes})}`);
        expect(anthropicDiscovery.listedModels).toContain('org/anthropic');
        expect(anthropicDiscovery.notifications.some((event: any) => event.method === 'turn/completed' && event.status === 'completed')).toBe(true);
        expect(anthropicActual).toHaveLength(1); expect(anthropicActual[0]!.path).toBe('/v1/messages');
        expect(anthropicActual[0]!.requestShape.model).toBe(CODEX_ANTHROPIC_MODEL);
        expect(anthropicDiscovery.notifications.some((event: any) => event.itemType === 'agentMessage' && event.text === 'anthropic answer')).toBe(true);
        for(const toolModel of ['org/chat','org/anthropic']){
        const beforeTools = calls.length;
        const toolDiscovery = await probeCodexChatgptModels({root: fixture!.root, baseUrl: `${proxy}/codex`, mockUrl: `http://127.0.0.1:${upstream!.port}`, token,
          model: toolModel, toolRoundTrip: true});
        const cliToolRoundTrip=cliToolRoundTrips.get(toolModel==='org/chat'?CODEX_CHAT_MODEL:CODEX_ANTHROPIC_MODEL)!;
        const toolCalls = calls.slice(beforeTools);
        const toolInputShapes = (await readFile(join(fixture!.root, 'cli-input-shapes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
          .filter(shape => shape.stage === 'dispatch' && toolCalls.some(call => call.requestId === shape.requestId));
        console.info(`codex_router_cli_tools ${JSON.stringify({...toolDiscovery, upstream: toolCalls.map(call => ({requestId: call.requestId, pid: call.pid,
          path: call.path, model: call.body.model})), roundTrip: cliToolRoundTrip, inputShapes: toolInputShapes})}`);
        expect(toolDiscovery.notifications.some((event: any) => event.method === 'turn/completed' && event.status === 'completed')).toBe(true);
        expect(toolDiscovery.notifications.some((event: any) => event.itemType === 'agentMessage' && event.text === (toolModel==='org/chat'?'chat answer':'anthropic answer'))).toBe(true);
        expect(toolInputShapes).toHaveLength(2);
        expect(toolInputShapes.every(shape => shape.toolShape.some((tool: any) => tool.type === 'web_search' && tool.externalWebAccess === false))).toBe(true);
        expect(toolCalls.every(call => !JSON.stringify(call.body.tools).includes('web_search'))).toBe(true);
        expect(toolDiscovery.patchedContent).toBe(`${CLI_PATCH_MARKER}\n`);
        expect(toolCalls).toHaveLength(2);
        for(const call of toolCalls){
          expect(call.body).not.toHaveProperty('thinking');
          expect(call.body).not.toHaveProperty('budget_tokens');
        }
        expect(cliToolRoundTrip.firstRequestId).toBe(toolCalls[0]!.requestId);
        expect(cliToolRoundTrip.followupRequestId).toBe(toolCalls[1]!.requestId);
        expect(cliToolRoundTrip.wires?.mcp).toBeString();
        expect(cliToolRoundTrip.outputs?.map(item => item.callId).sort()).toEqual(['call_fixture_exec', 'call_fixture_mcp', 'call_fixture_patch']);
        expect(cliToolRoundTrip.outputs?.find(item => item.callId === 'call_fixture_exec')?.content).toContain(CLI_EXEC_MARKER);
        expect(JSON.stringify(cliToolRoundTrip.outputs?.find(item => item.callId === 'call_fixture_patch')?.content)).toContain('Success');
        expect(JSON.stringify(cliToolRoundTrip.outputs?.find(item => item.callId === 'call_fixture_mcp')?.content)).toContain(CLI_MCP_MARKER);
        expect(toolDiscovery.notifications.some((event: any) => event.method === 'item/completed' && event.itemType === 'commandExecution'
          && event.exitCode === 0 && event.output?.includes(CLI_EXEC_MARKER))).toBe(true);
        expect(toolDiscovery.notifications.some((event: any) => event.method === 'item/completed' && event.itemType === 'mcpToolCall'
          && event.server === 'codex_fixture' && event.tool === 'echo' && event.status === 'completed')).toBe(true);
        expect(toolDiscovery.mcpAudit.filter((event: any) => event.event === 'tools/call')).toEqual([{pid: toolDiscovery.mcpAudit[0].pid,
          event: 'tools/call', name: 'echo', text: CLI_MCP_MARKER}]);
        expect(['dead', 'mismatch']).toContain(toolDiscovery.mcpShutdown);
        const followup = toolCalls[1]!.body.messages;
        const restoredCalls=toolModel==='org/chat'?followup.find((message:any)=>message.role==='assistant' && message.tool_calls)?.tool_calls
          :followup.flatMap((message:any)=>message.content).filter((block:any)=>block.type==='tool_use');
        expect(restoredCalls.map((tool:any)=>tool.id).sort())
          .toEqual(['call_fixture_exec', 'call_fixture_mcp', 'call_fixture_patch']);
        const restoredInput = toolInputShapes.find(shape => shape.requestId === cliToolRoundTrip.followupRequestId)?.inputShape;
        expect(restoredInput).toContainEqual(expect.objectContaining({type: 'custom_tool_call', callId: 'call_fixture_patch', name: 'apply_patch'}));
        expect(restoredInput).toContainEqual(expect.objectContaining({type: 'custom_tool_call_output', callId: 'call_fixture_patch', outputType: 'string'}));
        expect(restoredInput).toContainEqual(expect.objectContaining({type: 'function_call', callId: 'call_fixture_mcp', name: 'echo', namespace: 'mcp__codex_fixture'}));
        }
        const cliCalls = calls.slice(beforeCli);
        // CLI may stop consuming HTTP after the terminal event. Keep the transport
        // outcome visible while asserting complete token counts and no duplicates.
        await assertMetered(cliCalls, false);
        const cliMetering = attempts().filter(row => cliCalls.some(call => call.requestId === row.request_id));
        console.info(`codex_router_cli_metering ${JSON.stringify(cliCalls.map(call => ({requestId: call.requestId, model: call.body.model,
          path: call.path, ...cliMetering.find(row => row.request_id === call.requestId)})))}`);
        for (const row of cliMetering) {
          expect(row).toMatchObject({input_tokens: 4, output_tokens: 2});
          expect(['completed', 'aborted']).toContain(row.outcome);
        }
      }
    } finally {await socket.close();}
  }, 120000);

  test('built plaintext collaboration preserves three tool identities in JSON, SSE/WS and subsequent cross-model history', async () => {
    const start=calls.length;
    for(const model of ['org/chat','org/anthropic'])for(const name of ['spawn_agent','send_message','followup_task']) {
      const declared=[{type:'namespace',name:'collaboration',tools:[{type:'function',name,
        parameters:{type:'object',properties:{message:{type:'string',encrypted:true}},required:['message'],additionalProperties:false}}]}];
      const request={model,input:'fixture-plaintext-collaboration',tools:declared};
      const json=await post(request);
      expect(json.status).toBe(200);
      expect(json.body.output).toContainEqual(expect.objectContaining({type:'function_call',namespace:'collaboration',name,
        call_id:'collaboration-call',encrypted_function_args:[],arguments:JSON.stringify({message:relayTask})}));
      const socket=await openSocket();
      try {
        const events=await socket.create(request);
        const item=events.find(event=>event.type==='response.output_item.done')?.item;
        expect(item).toMatchObject({namespace:'collaboration',name,encrypted_function_args:[],call_id:'collaboration-call'});
        expect(events.at(-1).response.output).toContainEqual(expect.objectContaining({namespace:'collaboration',name,encrypted_function_args:[]}));
      } finally {await socket.close();}
      const next=await post({model:model==='org/chat'?'org/anthropic':'org/chat',input:[
        {type:'agent_message',author:'parent-agent',recipient:'child-agent',content:[{type:'input_text',text:relayTask}]},
        {role:'user',content:'continue the task'},
      ]});
      expect(next.status).toBe(200);
      const texts=calls.at(-1)!.body.messages.flatMap((item:any)=>typeof item.content==='string'?[item.content]:item.content.map((part:any)=>part.text ?? ''));
      expect(texts.some((text:string)=>text.includes(relayTask))).toBe(true);
      expect(calls.slice(start).some(call=>call.body.tools?.[0]?.name==='relay_external_agent_payload')).toBe(false);
    }
    await assertMetered(calls.slice(start));
  },60000);

  for(const cipher of ['fixture-opaque-agent-task','fixture-headerless-relay'])for(const relayType of ['route','service'] as const)test(`built native auxiliary relay (${cipher}, ${relayType}) uses shared cache across workers, isolates identity and counts actual calls`, async () => {
    const saved=structuredClone(aggregate),start=calls.length;
    try {
      aggregate.logical_configuration.routes[0].path_rewrite={'^/codex':'/backend-api/codex'};
      if(relayType==='service'){
        const native=aggregate.logical_configuration.routes.find((route:any)=>route.id===NATIVE);
        aggregate.logical_configuration.services.push({id:uuid(16),position:2,name:'Native relay fixture',plugins:[],endpoints:native.endpoints.map((endpoint:any)=>({...endpoint,id:uuid(17)}))});
      }
      aggregate.logical_configuration.routes[0].plugins.find((p:any)=>p.name==='codex-router').options.collaborationRelay={
        target:{type:relayType,id:relayType==='route'?NATIVE:uuid(16),protocol:'responses'},model:'native-relay-model'};
      const native=aggregate.logical_configuration.routes.find((route:any)=>route.id===NATIVE);
      aggregate.logical_configuration.routes.unshift({...structuredClone(native),id:uuid(18),position:0,path:'/codex/v1/',
        path_rewrite:{'^/codex/v1':''},endpoints:native.endpoints.map((endpoint:any)=>({...endpoint,id:uuid(19)}))});
      await publish();
      const request={model:'org/chat',input:[agentMessage(cipher),{role:'user',content:'execute restored task'}]};
      const first=await post(request);expect(first.status).toBe(200);
      expect(calls.slice(start)).toHaveLength(2);
      const relayed=calls[start]!;
      expect(relayed.path).toBe('/v1/responses');
      expect(relayed.body.input).toEqual([agentMessage(cipher)]);
      const restored=calls[start+1]!.body.messages.find((item:any)=>item.role==='user').content;
      expect(restored.map((part:any)=>part.text)).toContain(relayTask);
      const observed=new Set([calls[start+1]!.pid]);
      for(let i=0;i<16 && observed.size<2;i++) {
        const result=await post(request);expect(result.status).toBe(200);observed.add(calls.at(-1)!.pid);
      }
      expect(observed).toEqual(new Set(workers.map(worker=>worker.pid)));
      expect(calls.slice(start).filter(call=>call.body.tools?.[0]?.name==='relay_external_agent_payload')).toHaveLength(1);
      const socket=await openSocket();
      try {
        const before=calls.length;
        const events=await socket.create({...request,model:'org/anthropic'});
        expect(events.at(-1).type).toBe('response.completed');
        expect(events.some(event=>event.item?.name==='relay_external_agent_payload')).toBe(false);
        expect(calls.slice(before)).toHaveLength(1);
        expect(JSON.stringify(calls.at(-1)!.body.messages)).not.toContain(cipher);
      } finally {await socket.close();}
      const other=calls.length;expect((await post(request,otherToken)).status).toBe(200);
      expect(calls.slice(other)).toHaveLength(2);
      const failure=calls.length;
      const failed=await post({...request,input:[agentMessage('fixture-relay-denied')]});
      expect(failed.status).toBe(401);expect(failed.body.error).toBe('llm_adapter_relay_upstream_failed');
      expect(calls.slice(failure)).toHaveLength(1);
      expect(calls.at(-1)!.body.tools[0].name).toBe('relay_external_agent_payload');
      await assertMetered(calls.slice(start,failure));
      if(cipher==='fixture-headerless-relay'){
        const incomplete={...request,input:[agentMessage('fixture-headerless-truncated')]};
        for(let attempt=0;attempt<2;attempt++){
          const before=calls.length;const result=await post(incomplete);
          expect(result.status).toBe(502);expect(result.body.error).toBe('llm_adapter_relay_invalid_response');
          expect(calls.slice(before)).toHaveLength(1);expect(calls.at(-1)!.body.tools[0].name).toBe('relay_external_agent_payload');
        }
        const socket=await openSocket();
        try{
          const before=calls.length;const events=await socket.create(incomplete,true);
          expect(events.at(-1)).toMatchObject({type:'error',status:502,error:{code:'llm_adapter_relay_invalid_response'}});
          expect(events.some(event=>event.type==='response.completed')).toBe(false);expect(calls.slice(before)).toHaveLength(1);
        }finally{await socket.close();}
      }
      await waitUntil(() => {
        const db = new Database(fixture!.accessDbPath, {readonly:true});
        try {
          const rows = db.query<{detail:string}, []>("SELECT json_extract(j.value,'$.detail') AS detail FROM access_logs,json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='auxiliary_resolution'").all();
          const resolutions = rows.map(row => JSON.parse(row.detail));
          return [true,false].every(reused => resolutions.some(item => item.model === 'native-relay-model' && item.reused === reused && typeof item.upstreamId === 'string' && Object.keys(item).sort().join(',') === 'model,reused,upstreamId'));
        } finally {db.close();}
      }, 'safe actual model and reuse diagnostics were not logged', 12000);
      console.info(`codex_collaboration_relay ${JSON.stringify({workers:[...observed],successfulRelayCalls:2,
        cachedAcrossWorkers:true,identityIsolated:true,failedFinalCalls:0})}`);
    } finally {aggregate=saved;await publish();}
  },90000);

  test.skipIf(process.env.BUNGEE_CODEX_CLI_PROBE!=='1')('isolated CLI children execute tools and return results through plaintext and native relay paths',async()=>{
    const saved=structuredClone(aggregate);
    try {
      aggregate.logical_configuration.routes[0].plugins.find((p:any)=>p.name==='codex-router').options.collaborationRelay={target:{type:'route',id:NATIVE,protocol:'responses'},model:'native-relay-model'};
      await publish();
      for(const [parent,child] of [['org/chat','org/chat'],['org/chat','org/anthropic'],['org/native','org/chat']]) {
        collaborationChildModel=child!;collaborationCalls.length=0;cliToolRoundTrips.clear();
        const before=calls.length;
        const report=await probeCodexChatgptModels({root:fixture!.root,baseUrl:`${proxy}/codex`,mockUrl:`http://127.0.0.1:${upstream!.port}`,token,
          model:parent!,toolRoundTrip:true,collaboration:true});
        if(!report.patchedContent){
          const db=new Database(fixture!.accessDbPath,{readonly:true});
          try {console.info('codex_collaboration_rejections',JSON.stringify(db.query("SELECT status,json_extract(j.value,'$.detail') AS detail FROM access_logs,json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='request_rejected'").all()));}
          finally {db.close();}
        }
        console.info(`codex_collaboration_cli ${JSON.stringify({parent,child,report:{notifications:report.notifications,patchedContent:report.patchedContent,mcpAudit:report.mcpAudit,selectedModel:report.selectedModel},tools:collaborationCalls,upstream:calls.slice(before).map(call=>({model:call.body.model,path:call.path}))})}`);
        expect(collaborationCalls).toEqual(['spawn_agent','send_message','followup_task','wait_agent']);
        expect(report.notifications.some((event:any)=>event.method==='turn/completed'&&event.parentThread&&event.status==='completed')).toBe(true);
        expect(report.notifications.some((event:any)=>event.method==='item/completed'&&event.parentThread&&event.itemType==='agentMessage'&&event.text)).toBe(true);
        expect(report.patchedContent).toBe(`${CLI_PATCH_MARKER}\n`);
        expect(report.mcpAudit.some((event:any)=>event.event==='tools/call'&&event.text===CLI_MCP_MARKER)).toBe(true);
        const roundTrip=cliToolRoundTrips.get(child==='org/chat'?CODEX_CHAT_MODEL:CODEX_ANTHROPIC_MODEL)!;
        expect(roundTrip.outputs?.map(item=>item.callId).sort()).toEqual(['call_fixture_exec','call_fixture_mcp','call_fixture_patch','call_fixture_readback']);
        const auxiliary=calls.slice(before).filter(call=>call.body.tools?.[0]?.name==='relay_external_agent_payload');
        // spawn/send/followup carry distinct complete agent_message identities.
        expect(auxiliary.length).toBe(parent==='org/native'?3:0);
        await assertMetered(calls.slice(before),false);
      }
    } finally {aggregate=saved;await publish();}
  },180000);

  test('busy/cancel and disconnect abort real pending upstreams; later generation remains usable without duplicate statistics', async () => {
    const socket = await openSocket(); const start = calls.length;
    try {
      socket.client.send(JSON.stringify({type: 'response.create', model: 'org/chat', input: 'fixture-hold-cancel'}));
      await waitUntil(() => calls.length === start + 1 && pending.size === 1, 'held generation did not reach actual upstream');
      const held = calls.at(-1)!;
      socket.client.send(JSON.stringify({type: 'response.create', model: 'org/chat', input: 'overlap'}));
      await waitUntil(() => socket.events.some(event => event.error?.code === 'codex_router_response_busy'), 'overlap was not rejected');
      expect(calls).toHaveLength(start + 1);
      socket.client.send(JSON.stringify({type: 'response.cancel'}));
      await waitUntil(() => aborted.has(held.requestId) && socket.events.some(event => event.error?.code === 'codex_router_generation_cancelled'), 'cancel did not abort actual upstream', 10000);
      expect(socket.events.some(event => event.type === 'response.completed')).toBe(false);
      await Bun.sleep(25);
      const next = await socket.create({model: 'org/chat', input: 'after cancel'});
      expect(next.at(-1).type).toBe('response.completed'); await assertMetered([calls.at(-1)!]);
      socket.client.send(JSON.stringify({type: 'response.create', model: 'org/chat', input: 'fixture-hold-close'}));
      await waitUntil(() => pending.size === 1, 'disconnect generation did not reach upstream'); const closing = calls.at(-1)!;
      await socket.close();
      await waitUntil(() => aborted.has(closing.requestId) && pending.size === 0, 'disconnect did not abort actual upstream', 10000);
      await assertMetered(calls.slice(start), false);
      expect(calls.slice(start)).toHaveLength(3);
    } finally {await socket.close();}
  }, 45000);

  test('built model mapping identity preserves verified effort; bundled HTTP/WS refusals never poison the shared upstream', async () => {
    const saved = structuredClone(aggregate);
    let socket: Socket | undefined;
    try {
      aggregate.plugin_activations.push({plugin_name:'model-mapping'});
      const service = aggregate.logical_configuration.services[0];
      service.failover = {enabled:true,retry_on:['>400'],passive_health:{consecutive_failures:3},recovery:{backoff_base_ms:300000}};
      service.plugins = [{id:uuid(31),position:1,name:'model-mapping',enabled:true,options:{modelMappings:[
        {source:CODEX_CHAT_MODEL,target:'GLM-5.3-Flash',catalogModel:{provider:'zai',model:CODEX_CHAT_MODEL}}, {source:'glm-5.3',target:'unverified-wire-model'},
      ]}}];
      aggregate.logical_configuration.routes[0].plugins.find((p:any)=>p.name==='codex-router').options.models.push({
        provider:'zai',source:'org/unverified',model:'glm-5.3',target:{type:'service',id:CHAT,protocol:'chat_completions'},
      });
      await publish();
      socket = await openSocket();
      const before = calls.length;
      for (let i=0;i<5;i++) {
        const result = await post({model:'org/unverified',input:'strict rejection',reasoning:{effort:'max'}});
        expect(result.status).toBe(422);
        expect(result.body).toMatchObject({error:'llm_adapter_unsupported_reasoning',param:'reasoning.effort'});
        const events = await socket.create({model:'org/unverified',input:'strict rejection',reasoning:{effort:'max'}},true);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({type:'error',status:422,error:{code:'llm_adapter_unsupported_reasoning',param:'reasoning.effort'}});
        expect(calls).toHaveLength(before);
      }
      for (const effort of ['low','high','max']) {
        const result = await post({model:'org/chat',input:smallHistory,tools,reasoning:{effort}});
        expect(result.status).toBe(200);
        expect(calls.at(-1)!.body).toMatchObject({model:'GLM-5.3-Flash',reasoning_effort:effort});
        expect(calls.at(-1)!.body).not.toHaveProperty('thinking');
        expect(JSON.stringify(calls.at(-1)!.body.messages)).toContain('custom result');
        const events = await socket.create({model:'org/chat',input:smallHistory,tools,reasoning:{effort}});
        expect(events.at(-1).type).toBe('response.completed');
        expect(calls.at(-1)!.body).toMatchObject({model:'GLM-5.3-Flash',reasoning_effort:effort});
        expect(calls.at(-1)!.body).not.toHaveProperty('thinking');
      }
      for(let i=0;i<16 && new Set(calls.slice(before).map(call=>call.pid)).size<2;i++) {
        expect((await post({model:'org/chat',input:'second worker positive control',reasoning:{effort:'max'}})).status).toBe(200);
      }
      expect(new Set(calls.slice(before).map(call=>call.pid))).toEqual(new Set(workers.map(worker=>worker.pid)));
      if(process.env.BUNGEE_CODEX_CLI_PROBE==='1') {
        const start=calls.length;
        const cli=await probeCodexChatgptModels({root:fixture!.root,baseUrl:`${proxy}/codex`,mockUrl:`http://127.0.0.1:${upstream!.port}`,token,
          model:'org/chat',effort:'max',toolRoundTrip:true});
        expect(cli.reasoningModels).toEqual([{model:'org/chat',levels:['low','high','max'],defaultEffort:'none'}]);
        expect(cli.notifications.some((e:any)=>e.method==='turn/completed'&&e.status==='completed')).toBe(true);
        expect(cli.patchedContent).toBe(`${CLI_PATCH_MARKER}\n`);
        expect(cli.notifications.some((e:any)=>e.itemType==='commandExecution'&&e.exitCode===0&&e.output?.includes(CLI_EXEC_MARKER))).toBe(true);
        expect(cli.mcpAudit.filter((e:any)=>e.event==='tools/call').map((e:any)=>({name:e.name,text:e.text}))).toEqual([{name:'echo',text:CLI_MCP_MARKER}]);
        expect(calls.slice(start)).toHaveLength(2);
        const roundTrip=cliToolRoundTrips.get('GLM-5.3-Flash')!;
        expect(roundTrip.outputs?.map(output=>output.callId).sort()).toEqual(['call_fixture_exec','call_fixture_mcp','call_fixture_patch']);
      }
      const outgoing=calls.slice(before);
      for(const call of outgoing){expect(call.body).toMatchObject({model:'GLM-5.3-Flash'});expect(call.body).not.toHaveProperty('thinking');}
      await assertMetered(outgoing);
      console.info(`codex_router_wire_alias ${JSON.stringify({workerPids:workers.map(w=>w.pid),refusedGenerations:10,
        upstreamCalls:outgoing.length,wireModel:'GLM-5.3-Flash',efforts:['low','high','max']})}`);
    } catch (error) {
      throw new Error(`Wire alias acceptance failed: ${String(error)}; ${await master!.diagnostics?.()}`,{cause:error});
    } finally {
      await socket?.close();
      aggregate=saved;await publish();
    }
  },90000);

  test('built Gemini JSON/SSE/WS preserve signed parallel tool history, final URL mapping and cancellation',async()=>{
    const saved=structuredClone(aggregate);let socket:Socket|undefined;
    const model='org/gemini',wire='gemini/wire';const start=calls.length;
    try{
      aggregate.plugin_activations.push({plugin_name:'model-mapping'});
      aggregate.logical_configuration.services[0].plugins=[{id:uuid(41),position:1,name:'model-mapping',enabled:true,options:{modelMappings:[{source:CODEX_CHAT_MODEL,target:wire,catalogModel:{provider:'zai',model:CODEX_CHAT_MODEL}}]}}];
      aggregate.logical_configuration.routes[0].plugins.find((item:any)=>item.name==='codex-router').options.models.push({source:model,provider:'zai',model:CODEX_CHAT_MODEL,target:{type:'service',id:CHAT,protocol:'gemini_generate_content'}});
      await publish();
      const catalog=await fetch(`${proxy}/codex/models?client_version=0.162.1`,{headers:{authorization:`Bearer ${token}`}});
      expect(catalog.status).toBe(200);
      expect((await catalog.json() as any).models.find((item:any)=>item.slug===model)).toMatchObject({supported_reasoning_levels:[{effort:'low',description:'low'},{effort:'high',description:'high'}],default_reasoning_level:null});
      const codex=await post({model,tools,reasoning:{effort:'high'},parallel_tool_calls:false,input:[
        {role:'developer',content:'initial instruction'},{role:'user',content:'workspace context'},
        {role:'developer',content:'runtime instruction'},{role:'user',content:'inspect workspace'},
      ]});
      expect(codex.status).toBe(200);
      expect(calls.at(-1)!.body.systemInstruction).toEqual({parts:[{text:'initial instruction'},{text:'runtime instruction'},{text:'Call at most one tool per response.'}]});
      expect(calls.at(-1)!.body.contents).toEqual([{role:'user',parts:[{text:'workspace context'},{text:'inspect workspace'}]}]);
      expect(calls.at(-1)!.body).not.toHaveProperty('parallel_tool_calls');
      const request={model,input:smallHistory,tools,reasoning:{effort:'high'},parallel_tool_calls:true};
      const first=await post(request);expect(first.status).toBe(200);expect(first.body.model).toBe(model);
      const toolCalls=first.body.output.filter((item:any)=>item.type==='function_call');
      expect(toolCalls.map((item:any)=>item.call_id)).toEqual(['gemini-one__thought__c2lnbmF0dXJlLW9uZQ==','gemini-two__thought__c2lnbmF0dXJlLXR3bw==']);
      expect(toolCalls.map((item:any)=>item.name)).toEqual(['lookup','lookup']);
      const outputs=toolCalls.map((item:any,index:number)=>({type:'function_call_output',call_id:item.call_id,output:`result-${index}`}));
      const checkHistory=()=>{
        const call=calls.at(-1)!;expect(call.path).toBe('/v1beta/models/gemini%2Fwire:generateContent');
        expect(call.body.generationConfig.thinkingConfig).toEqual({thinkingLevel:'high'});
        const parts=call.body.contents.flatMap((item:any)=>item.parts);
        expect(parts).toContainEqual({text:'provider preface',thoughtSignature:'c2lnbmF0dXJlLXRleHQ='});
        for(const [index,id,signature] of [[0,'gemini-one','c2lnbmF0dXJlLW9uZQ=='],[1,'gemini-two','c2lnbmF0dXJlLXR3bw==']] as const){
          expect(parts).toContainEqual({functionCall:{id,name:'bungee_tool_0',args:{q:index===0?'one':'two'}},thoughtSignature:signature});
          expect(parts).toContainEqual({functionResponse:{id,name:'bungee_tool_0',response:{output:`result-${index}`}}});
        }
        expect(JSON.stringify(parts)).toContain('custom result');expect(JSON.stringify(parts)).toContain('file result');
      };
      const continued=await post({...request,previous_response_id:first.body.id,input:outputs});
      expect(continued.status).toBe(200);expect(JSON.stringify(continued.body)).toContain('gemini answer');checkHistory();
      const full=await post({...request,input:[...smallHistory,...first.body.output,...outputs]});expect(full.status).toBe(200);checkHistory();
      const streamed=await fetch(`${proxy}/codex/responses`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...request,stream:true}),signal:AbortSignal.timeout(20000)});
      expect(streamed.status).toBe(200);const text=await streamed.text();
      expect(text).toContain('response.completed');expect(text).toContain('gemini-two__thought__c2lnbmF0dXJlLXR3bw==');expect(text).not.toContain('response.failed');
      expect(calls.at(-1)!.path).toBe('/v1beta/models/gemini%2Fwire:streamGenerateContent');
      socket=await openSocket();const firstWs=await socket.create(request);
      expect(firstWs.at(-1).type).toBe('response.completed');
      const done=firstWs.filter((event:any)=>event.type==='response.output_item.done').map((event:any)=>event.item);
      expect(done.filter((item:any)=>item.type==='function_call').map((item:any)=>item.call_id)).toEqual(toolCalls.map((item:any)=>item.call_id));
      const next=await socket.create({...request,previous_response_id:firstWs.at(-1).response.id,input:outputs});
      expect(next.at(-1).type).toBe('response.completed');expect(JSON.stringify(next.at(-1))).toContain('gemini answer');
      expect(calls.at(-1)!.transport).toBe('http');
      await assertMetered(calls.slice(start));
      const before=calls.length,eventStart=socket.events.length;
      socket.client.send(JSON.stringify({type:'response.create',model,input:'fixture-hold-gemini'}));
      await waitUntil(()=>calls.length===before+1 && pending.size===1,'Gemini hold did not reach upstream');
      const held=calls.at(-1)!;socket.client.send(JSON.stringify({type:'response.cancel'}));
      await waitUntil(()=>aborted.has(held.requestId) && socket!.events.slice(eventStart).some((event:any)=>event.error?.code==='codex_router_generation_cancelled'),'Gemini cancel did not abort upstream',10000);
      expect(socket.events.slice(eventStart).some((event:any)=>event.type==='response.completed')).toBe(false);
    }finally{await socket?.close();aggregate=saved;await publish();}
  },90000);

  test('serving-revision change isolates HTTP history and old WS worker owners drain on close', async () => {
    const socket = await openSocket(); const oldWorkers = workers.slice();
    try {
      const first = await socket.create({model: 'org/chat', input: 'before revision'}); expect(first.at(-1).type).toBe('response.completed');
      const saved = await post({model: 'org/native', input: 'old-revision history'}); expect(saved.status).toBe(200);
      const directory = await fetch(`${proxy}/codex/models?client_version=0.162.1`, {headers: {authorization: `Bearer ${token}`}});
      expect(directory.status).toBe(200); await directory.text();
      await publish(() => socket.close());
      expect(workers.every(worker => !oldWorkers.some(old => old.pid === worker.pid))).toBe(true);
      const before = calls.length;
      const denied = await post({model: 'org/native', previous_response_id: saved.body.id, input: 'new revision'});
      expect(denied.status).toBe(422); expect(JSON.stringify(denied.body)).toContain('history_missing'); expect(calls).toHaveLength(before);
      const generated = await fetch(`${proxy}/codex/responses`, {method: 'POST', headers: {authorization: `Bearer ${token}`, version: '0.162.1', 'content-type': 'application/json'},
        body: JSON.stringify({model: 'native-only', input: 'new revision directory validator'})});
      expect(generated.status).toBe(200); expect(generated.headers.has('x-models-etag')).toBe(false); await generated.text();
      // The replacement revision serves new traffic; the retained old connection was closed before waiting for full convergence.
      await waitUntil(async () => {
        const states = await Promise.all(oldWorkers.map(worker => probeProcessIdentity(master!.workers.get(worker.worker_instance_id)!.identity!)));
        return states.every(state => state === 'dead' || state === 'mismatch');
      }, 'old worker WS owners did not drain', 15000);
      expect(pending.size).toBe(0);
      console.info(`codex_router_ws_drain ${JSON.stringify({oldWorkerPids: oldWorkers.map(w => w.pid), newWorkerPids: workers.map(w => w.pid), revision, uniqueGenerations: new Set(calls.map(c => c.requestId)).size, upstreamCalls: calls.length})}`);
    } finally {await socket.close();}
  }, 60000);

  afterAll(async () => {
    const errors: unknown[] = [...startup.errors]; const evidence = fixture;
    let shutdownVerified = false, portsVerifiedClosed = !startup.attempted;
    for (const socket of sockets) try {await socket.close();} catch (error) {errors.push(error);}
    if (master) try {await stopOwnedMaster(master); shutdownVerified = true;} catch (error) {errors.push(error);}
    let upstreamClosed = true;
    if (upstream) try {await upstream.stop(true);} catch (error) {upstreamClosed = false; errors.push(error);}
    if (lease) try {await releasePortBlock(lease); portsVerifiedClosed = upstreamClosed;} catch (error) {quarantinePortBlock(lease); errors.push(error);}
    if (fixture) try {
      const removed = await cleanupGatewayFixture(fixture, {startupAttempted: startup.attempted, master, shutdownVerified, portsVerifiedClosed});
      if (!removed) errors.push(new Error(`unverified cleanup; preserving private fixture ${fixture.root}`));
    } catch (error) {errors.push(error);}
    if (errors.length) throw new Error(errors.map(error => evidence ? safeGatewayError(error, evidence, 8192) : String(error)).join('\n'));
  }, 45000);
});
