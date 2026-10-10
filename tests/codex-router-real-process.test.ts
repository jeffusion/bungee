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
import {createCodexRouterGatewayFixture, seedCodexRouterCatalog, registerCodexProbeTargets, CODEX_PROCESS_PROBE, CODEX_MODELS, CODEX_CHAT_MODEL, CODEX_ANTHROPIC_MODEL} from './support/codex-router-gateway-fixture';
import {
  cleanupGatewayFixture, quarantinePortBlock, recordOwnedWorkers, releasePortBlock, requestJson,
  reservePortBlock, safeGatewayError, startTrackedGatewayMaster, stopOwnedMaster, waitForHealth, waitUntil,
  type GatewayFixture, type GatewayMasterStartupState, type OwnedMaster, type PortLease,
} from './support/token-stats-gateway';
import {probeProcessIdentity} from '../packages/core/src/master-runtime/process-identity';
import {probeCodexCli, probeCodexChatgptModels, bundledCodexCatalogModel, CLI_TOOL_ROUNDTRIP, CLI_EXEC_MARKER, CLI_MCP_MARKER, CLI_PATCH_MARKER} from './support/codex-router-cli-probe';
import modelTemplate from '../plugins/codex-router/server/model-template-0.160.1.json';
import capturedBase from '../plugins/codex-router/tests/fixtures/captured-app-base.json';
import capturedPreferences from '../plugins/codex-router/tests/fixtures/captured-app-preferences.json';

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
type Socket = {client: WebSocket; events: any[]; create(body: any): Promise<any[]>; close(): Promise<void>};
const message = (text: string) => ({type: 'message', role: 'assistant', content: [{type: 'output_text', text}]});
function response(id: string, model: string) {return {id, object: 'response', status: 'completed', model,
  output: [message('fixture answer')], usage: {input_tokens: 4, output_tokens: 2, total_tokens: 6}};}
function sse(events: any[]) {return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  {headers: {'content-type': 'text/event-stream'}});}
function chatEvents(text='chat answer') {return [
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
  const modelQueries: Array<{path: string; clientVersion: string | null}> = [];
  const accountQueries: string[] = [];
  type ToolRoundTrip={firstRequestId?:string;followupRequestId?:string;wires?:Record<string,string>;outputs?:any[]};
  const cliToolRoundTrips=new Map<string,ToolRoundTrip>();
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
          return Response.json({accounts: [{id: 'fixture-account', workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT'}]});
        }
        if (path.endsWith('/config/bundle')) return Response.json({config_toml: {enterprise_managed: []}});
        if (path.startsWith('/backend-api/')) return Response.json({error: 'fixture_not_found'}, {status: 404});
        if (request.headers.get('upgrade') === 'websocket') {
          if (server.upgrade(request, {data: {headers: new Headers(request.headers)}})) return;
          return new Response('upgrade failed', {status: 400});
        }
        if (path.endsWith('/models')) {
          modelQueries.push({path, clientVersion: new URL(request.url).searchParams.get('client_version')});
          return Response.json({models: [nativeCatalogModel]});
        }
        // app-server probes unrelated ChatGPT plugin/settings APIs during init.
        // This fixture implements only accounts/config and model inference.
        if (request.method !== 'POST') return Response.json({error: 'fixture_not_found'}, {status: 404});
        const body: any = await request.json(); const call = capture(request.headers, path, body, 'http');
        if (JSON.stringify(body).includes('fixture-hold-')) {
          pending.add(call.requestId);
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chatEvents()[0])}\n\n`));},
            cancel() {pending.delete(call.requestId); aborted.add(call.requestId);},
          }), {headers: {'content-type': 'text/event-stream'}});
        }
        if ((path.endsWith('/chat/completions') || path.endsWith('/messages')) && JSON.stringify(body.messages).includes(CLI_TOOL_ROUNDTRIP)) {
          const anthropic=path.endsWith('/messages');
          const cliToolRoundTrip=cliToolRoundTrips.get(body.model) ?? {};
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
          cliToolRoundTrip.outputs = anthropic ? body.messages.flatMap((message:any)=>Array.isArray(message.content)?message.content:[])
            .filter((block:any)=>block.type==='tool_result').map((block:any)=>({callId:block.tool_use_id,content:block.content}))
            : body.messages.filter((message: any) => message.role === 'tool').map((message: any) => ({callId: message.tool_call_id, content: message.content}));
          const output=(id:string)=>JSON.stringify(cliToolRoundTrip.outputs!.find(item=>item.callId===id)?.content);
          if(cliToolRoundTrip.outputs.length!==3 || !output('call_fixture_exec')?.includes(CLI_EXEC_MARKER)
            || !output('call_fixture_patch')?.includes('Success') || !output('call_fixture_mcp')?.includes(CLI_MCP_MARKER)) {
            return Response.json({error:'fixture_tool_results_incomplete'}, {status:400});
          }
          return sse(anthropic?anthropicEvents():chatEvents());
        }
        if (path.endsWith('/chat/completions')) return body.stream ? sse(chatEvents(body.response_format?.type==='json_schema'?'{"title":"fixture","description":"fixture"}':'chat answer')) : Response.json({
          id: `chat-${calls.length}`, object: 'chat.completion', model: body.model,
          choices: [{index: 0, message: {role: 'assistant', content: 'chat answer'}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6},
        });
        if (path.endsWith('/messages')) return body.stream ? sse(anthropicEvents()) : Response.json({
          id: `msg-${calls.length}`, type: 'message', role: 'assistant', model: body.model,
          content: [{type: 'text', text: 'anthropic answer'}], stop_reason: 'end_turn', usage: {input_tokens: 4, output_tokens: 2},
        });
        if (path.endsWith('/responses')) {
          const result = response(`resp_fixture_${calls.length}`, body.model);
          const itemId = `msg_fixture_${calls.length}`;
          return body.stream ? sse([{type: 'response.created', response: {...result, status: 'in_progress', output: []}},
            {type: 'response.output_item.added', output_index: 0, item: {...result.output[0], id: itemId, status: 'in_progress', content: []}},
            {type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: 'fixture answer'},
            {type: 'response.output_item.done', output_index: 0, item: {...result.output[0], id: itemId, status: 'completed'}},
            {type: 'response.completed', response: result}]) : Response.json(result);
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
    const endpoint = (n: number) => ({id: uuid(n), position: 1, target: `http://127.0.0.1:${upstream!.port}/v1/`, weight: 100, priority: 1, is_disabled: false, plugins: []});
    const binding = (name: string, n: number, options?: any) => ({id: uuid(n), position: n, name, enabled: true, ...(options ? {options} : {})});
    aggregate = {
      plugin_activations: ['models-dev', 'llm-protocol-adapter', 'codex-router', 'key-access', 'token-metering', 'token-stats', CODEX_PROCESS_PROBE].map(plugin_name => ({plugin_name})),
      logical_configuration: {
        plugins: [binding(CODEX_PROCESS_PROBE, 22)],
        services: [{id: CHAT, position: 1, name: 'Chat fixture', plugins: [], endpoints: [endpoint(13)]}],
        routes: [
          {id: ENTRY, position: 1, path: '/codex', websocket: {enabled: true}, endpoints: [endpoint(11)],
            path_rewrite: {'^/codex': ''}, plugins: [binding(CODEX_PROCESS_PROBE, 20, {priority: -1000}), binding('codex-router', 21, {models: [
              {provider: 'lab', model: CODEX_MODELS[0], target: {type: 'route', id: NATIVE, protocol: 'responses'}},
              {provider: 'zai', source: CODEX_MODELS[1], model: CODEX_CHAT_MODEL, target: {type: 'service', id: CHAT, protocol: 'chat_completions'}},
              {provider: 'anthropic', source: CODEX_MODELS[2], model: CODEX_ANTHROPIC_MODEL, target: {type: 'route', id: ANTHROPIC, protocol: 'anthropic_messages'}},
              {provider: 'lab', model: CODEX_MODELS[3], target: {type: 'route', id: NATIVE_WS, protocol: 'responses'}},
            ]})]},
          {id: NATIVE, position: 2, path: '/native-target', endpoints: [endpoint(12)], path_rewrite: {'^/native-target': ''}, plugins: []},
          {id: ANTHROPIC, position: 3, path: '/anthropic-target', endpoints: [endpoint(14)], path_rewrite: {'^/anthropic-target': ''}, plugins: []},
          {id: NATIVE_WS, position: 4, path: '/native-ws-target', websocket: {enabled: true}, endpoints: [endpoint(15)], path_rewrite: {'^/native-ws-target': ''}, plugins: []},
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
    const result = await control('/api/config', 'PUT', {expected_revision: revision, mutation_id: mutation, aggregate});
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
  function attempts(): Attempt[] {
    const db = new Database(fixture!.accessDbPath, {readonly: true});
    try {return db.query<Attempt, []>('SELECT request_id, attempt_id, input_tokens, output_tokens, outcome FROM token_stats_attempts').all();} finally {db.close();}
  }
  async function assertMetered(selected: Call[], completed = true) {
    await waitUntil(() => {
      const rows = attempts(); return selected.every(call => rows.some(row => row.request_id === call.requestId));
    }, 'per-generation token-stats observations did not settle', 12000);
    const rows = attempts().filter(row => selected.some(call => call.requestId === row.request_id));
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
    expect((await control('/api/config')).body.revision).toBe(revision);
    expect((await control('/api/config/runtime')).body.publication.serving_revision).toBe(revision);
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
    for(const [model,levels,defaultEffort] of [['org/chat',['low','high','max'],'max'],['org/anthropic',['low','medium','high','max'],'high']] as const){
      for(const effort of levels){
        const before=calls.length;
        const result=await probeCodexChatgptModels({root:fixture!.root,baseUrl:`${proxy}/codex`,mockUrl:`http://127.0.0.1:${upstream!.port}`,token,model,effort});
        expect(result.reasoningModels).toEqual([{model,levels:[...levels],defaultEffort}]);
        expect(result.notifications.some((event:any)=>event.method==='turn/completed'&&event.status==='completed')).toBe(true);
        const outgoing=calls.slice(before);expect(outgoing).toHaveLength(1);
        if(model==='org/chat')expect(outgoing[0]!.body).toMatchObject({model:CODEX_CHAT_MODEL,reasoning_effort:effort,thinking:{type:'enabled'}});
        else expect(outgoing[0]!.body).toMatchObject({model:CODEX_ANTHROPIC_MODEL,output_config:{effort},thinking:{type:'adaptive'}});
        console.info(`codex_router_cli_effort ${JSON.stringify({model,effort,levels,defaultEffort,requestId:outgoing[0]!.requestId,transport:outgoing[0]!.transport})}`);
        await assertMetered(outgoing);
      }
    }
  },90000);

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

  async function openSocket(credential = token): Promise<Socket> {
    const client = new WebSocket(`${proxy.replace('http:', 'ws:')}/codex/responses`, {headers: {authorization: `Bearer ${credential}`}});
    const events: any[] = [];
    client.onmessage = event => events.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('public WS open timed out')), 10000);
      client.onopen = () => {clearTimeout(timeout); resolve();};
      client.onerror = () => {clearTimeout(timeout); reject(new Error('public WS open failed'));};
    });
    const socket = {client, events, async create(body: any) {
      const start = events.length; client.send(JSON.stringify({type: 'response.create', ...body}));
      await waitUntil(() => events.slice(start).some(e => ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(e.type)), 'public WS generation has no terminal', 15000);
      // Terminal delivery precedes generation cleanup by one task turn.
      await Bun.sleep(25);
      const generation = events.slice(start);
      if (generation.at(-1)?.type === 'error') throw new Error(`WS generation: ${JSON.stringify(generation)}; upstream=${JSON.stringify(calls.slice(-1).map(call => ({...call, body: {model: call.body.model}})))}; ${await master!.diagnostics?.()}`);
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
          const row: any = db.query("SELECT j.value FROM access_logs, json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='codex_router_conversion' AND json_extract(j.value,'$.detail.requestId')=?").get(requestId);
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
          const row:any=db.query("SELECT j.value FROM access_logs, json_each(access_logs.processing_steps) AS j WHERE json_extract(j.value,'$.step')='codex_router_conversion' AND json_extract(j.value,'$.detail.requestId')=?").get(conversionId);
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
        const discovery = await probeCodexChatgptModels({root: fixture!.root, baseUrl: `${proxy}/codex`, mockUrl: `http://127.0.0.1:${upstream!.port}`, token, model: 'org/native'});
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
          if(toolModel==='org/chat')expect(call.body).toMatchObject({reasoning_effort:'max',thinking:{type:'enabled'}});
          else expect(call.body).toMatchObject({output_config:{effort:'high'},thinking:{type:'adaptive'}});
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

  test('serving-revision change isolates HTTP history and old WS worker owners drain on close', async () => {
    const socket = await openSocket(); const oldWorkers = workers.slice();
    try {
      const first = await socket.create({model: 'org/chat', input: 'before revision'}); expect(first.at(-1).type).toBe('response.completed');
      const saved = await post({model: 'org/native', input: 'old-revision history'}); expect(saved.status).toBe(200);
      await publish(() => socket.close());
      expect(workers.every(worker => !oldWorkers.some(old => old.pid === worker.pid))).toBe(true);
      const before = calls.length;
      const denied = await post({model: 'org/native', previous_response_id: saved.body.id, input: 'new revision'});
      expect(denied.status).toBe(422); expect(JSON.stringify(denied.body)).toContain('history_missing'); expect(calls).toHaveLength(before);
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
