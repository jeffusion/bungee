import { describe, expect, test } from 'bun:test';
import { checkArchitectureSource, checkGatewayArchitecture, checkGatewayAssemblySource } from './check-gateway-architecture';
const plugin='plugins/example/server/index.ts';
const consumer='packages/core/src/gateway/response-views.ts';
function rules(file:string,source:string){return checkArchitectureSource(file,source).map(x=>x.rule);}
describe('gateway architecture AST guard',()=>{
  test('current production sources satisfy the architecture',async()=>{expect(await checkGatewayArchitecture()).toEqual([]);});
  test.each([
    "import { BodySource } from '@jeffusion/bungee-core/src/gateway/body-service';",
    "export * from '@jeffusion/bungee-core';",
    "await import('../../../packages/core/src/gateway/body-service');",
    "require('@jeffusion/bungee-core/dist/worker');",
    "type Private = import('@jeffusion/bungee-core/src/private').Private;",
  ])('rejects private plugin dependency: %s',source=>{expect(rules(plugin,source)).toContain('plugin-public-entry');});
  test.each([
    'async function onResponse(response: Response) { return response.json(); }',
    'async function onResponse(response: Response) { return response.clone().text(); }',
    'async function onResponse(response: Response) { return response.body.getReader(); }',
    'async function onResponse(response: Response) { return response["arrayBuffer"](); }',
    'async function onResponse(response: Response) { return response.body.tee(); }',
    'const decoder = new TextDecoder();',
    'let body=input.body; if(typeof body==="string") body=JSON.parse(body);',
    "import { createGunzip } from 'node:zlib';",
    "import { decodeStream } from '../body-service';",
  ])('rejects body ownership bypass: %s',source=>{expect(rules(plugin,source).length).toBeGreaterThan(0);});
  test('rejects readers newly added beside an approved transport owner',()=>{
    const file='packages/core/src/gateway/forward-plugin.ts';
    expect(rules(file,'function executeForward(){ const reader=response.body.getReader(); }')).toEqual(['native-http-reader']);
    expect(rules(file,'const trackResponseWire=()=>{const extra=response.body.getReader();};')).toEqual(['native-http-reader']);
    expect(rules(file,'const trackResponseWire=()=>{const wireReader=source.getReader();};')).toEqual([]);
  });
  test('rejects direct and renamed body construction outside the registered provider',()=>{
    expect(rules(consumer,'const source=new BodySource(response.body,100);')).toEqual(['body-provider-construction']);
    expect(rules(consumer,"import {BodySource as LocalSource} from '../body-service'; new LocalSource(null,100);")).toEqual(['body-provider-construction']);
  });
  test('rejects independent SSE framing outside the shared body service',()=>{
    expect(rules(consumer,'new BodySSEFramer(100,callback);')).toEqual(['central-body-event-parser']);
    expect(rules(consumer,"import {BodyEventSession as Session} from '../body-events'; new Session('gzip',100);")).toEqual(['central-body-event-parser']);
  });
  test('rejects renamed native Response reads masquerading as body handles',()=>{
    expect(rules(plugin,'const source=response; await source.json();')).toEqual(['native-http-body-read']);
    expect(rules(plugin,'const handle=response; await handle.text();')).toEqual(['native-http-body-read']);
  });
  test('rejects missing register/call edges even when provider identifiers remain',()=>{
    expect(checkGatewayAssemblySource('packages/core/src/gateway/body-plugin.ts','class BodyServicePlugin { register(hooks){ const diagnostic="hooks.onGatewayBody.tap"; } }')).toHaveLength(1);
    expect(checkGatewayAssemblySource('packages/core/src/gateway/body-factory.ts','function createBodySource(){ const diagnostic="gatewayHooks().onGatewayBody.call"; }')).toHaveLength(1);
  });
  test('rejects direct gateway business execution imports and missing core hook registration',()=>{
    expect(rules('packages/core/src/worker/request/proxy.ts',"import {executeForward as forward} from '../../../gateway/forward-plugin';")).toEqual(['gateway-provider-bypass']);
    expect(checkGatewayAssemblySource('packages/core/src/gateway/retry-plugin.ts','class RetryPlugin {register(hooks){ return undefined; }}')).toHaveLength(1);
  });
  test('rejects namespace access to gateway business execution',()=>{
    const file='packages/core/src/worker/request/proxy.ts';
    expect(rules(file,"import * as gateway from '../../../gateway/forward-plugin'; export const proxyRequest=gateway.executeForward;")).toEqual(['gateway-provider-bypass']);
    expect(rules(file,"const forward=gateway['executeForward'];")).toEqual(['gateway-provider-bypass']);
  });
  test('rejects value re-exports of gateway execution but permits type-only edges',()=>{
    const file='packages/core/src/worker/request/proxy.ts';
    expect(rules(file,"export {executeForward as proxyRequest} from '../../../gateway/forward-plugin';")).toEqual(['gateway-provider-bypass']);
    expect(rules(file,"export * from '../../../gateway/forward-plugin';")).toEqual(['gateway-provider-bypass']);
    expect(rules(file,"export * as gateway from '../../../gateway/forward-plugin';")).toEqual(['gateway-provider-bypass']);
    expect(rules(file,"export type {executeForward} from '../../../gateway/forward-plugin';")).toEqual([]);
    expect(rules(file,"export {type executeForward} from '../../../gateway/forward-plugin';")).toEqual([]);
  });
  test.each([
    'for await(const chunk of response.body!) { consume(chunk); }',
    'const body=response.body; for await(const chunk of body) { consume(chunk); }',
    'await response["body"]!.pipeTo(sink);',
    'response.body!.pipeThrough(transform);',
    'response.body!.values();',
  ])('rejects native body iteration or pipe ownership: %s',source=>{expect(rules(consumer,source)).toContain('native-http-reader');});
  test('allows the one registered body provider',()=>{expect(rules('packages/core/src/gateway/body-plugin.ts','hooks.onGatewayBody.tap("builtin.body-service",(...args)=>new BodySource(...args));')).toEqual([]);});
  test('allows public handles, Response assembly and business JSON fields',()=>{
    expect(rules(plugin,"import {definePlugin} from '@jeffusion/bungee-core/plugin'; const body=await ctx.bodyHandle.json(); const tool=JSON.parse(body.arguments); return Response.json(tool);")).toEqual([]);
    expect(rules(plugin,'// response.json();\nconst diagnostic="response.body.getReader()";')).toEqual([]);
  });
  test('allows typed and hook-inferred WebSocket views without allowing arbitrary HTTP readers',()=>{
    expect(rules(plugin,'function observe(event:WebSocketObservationEvent){return event.message.json();}')).toEqual([]);
    expect(rules(plugin,"hooks.onWebSocketObservation.tap('observe',event=>{const view=event.message;return view.json();});")).toEqual([]);
    expect(rules(plugin,'function read(event:Response){return event.message.json();}')).toEqual(['native-http-body-read']);
  });
  test('auxiliary network and management boundaries are explicit',()=>{
    expect(rules('plugins/chatgpt-oauth/server/oauth.ts','await response.text();')).toEqual([]);
    expect(rules('plugins/example/server/control.ts','await ctx.request.json();')).toEqual([]);
    expect(rules('plugins/chatgpt-oauth/server/adapter.ts','await response.text();')).toEqual(['native-http-body-read']);
    expect(rules('plugins/example/server/control.ts',"import {Host} from '@jeffusion/bungee-core/internal';")).toEqual(['plugin-public-entry']);
  });
});
