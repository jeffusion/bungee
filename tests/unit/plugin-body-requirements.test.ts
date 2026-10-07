import { createTokenAccountingSession } from '@jeffusion/bungee-llms/plugin-api';
import { classifyResponse } from '../../plugins/token-metering/server/classifier';
import { describe, expect, test, spyOn } from 'bun:test';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { PluginBodyRequirementContext, PluginStorage, SSEEnvelope } from '../../packages/core/src/plugin.types';
import { createPluginHooks, type AttemptObservationEvent } from '../../packages/core/src/hooks';
import { PluginServiceHost, type TokenMeteringService, type TokenMeteringResult } from '../../packages/core/src/plugin-services';
import type { AdmissionTarget } from '../../packages/core/src/plugin-extensions';
import Sanitizer from '../../plugins/anthropic-request-sanitizer/server';
import Mapping from '../../plugins/model-mapping/server';
import ToolNames from '../../plugins/anthropic-tool-name-transformer/server';
import OAuth from '../../plugins/chatgpt-oauth/server';
import Transformer from '../../plugins/ai-transformer/server';
import Messages from '../../plugins/openai-messages-to-chat/server';
import Signature from '../../plugins/signature-repair/server';
import { BodySource } from '../../packages/core/src/gateway/body-service';
import { RequestRetryAction } from '@jeffusion/bungee-core/plugin';
import Metering from '../../plugins/token-metering/server';
import { createIngress as budgetIngress } from '../../plugins/token-budget/server/policy';
import { createIngress as accessIngress } from '../../plugins/key-access/server/policy';

const context = (path = '/v1/messages', method = 'POST'): PluginBodyRequirementContext => ({ requestId: 'request', method, url: new URL(path, 'https://example.test'), routeId: 'route', stage: 'selected' });
const target = (url = 'https://example.test/v1/chat/completions', domain = 'data'): AdmissionTarget => ({ requestId: 'request', attemptId: 'attempt', principal: { domain, keyId: 'key', credentialVersion: 1 }, routeId: 'route', serviceId: null, upstreamId: 'upstream', url, model: null, now: Date.now() });
const streamContext = { method: 'POST', originalUrl: new URL('https://example.test/v1/messages'), clientIP: '127.0.0.1', requestId: 'request', chunkIndex: 0, isFirstChunk: true, isLastChunk: false, streamState: new Map() };

describe('SDK 3 plugin body demands', () => {
  test('every built-in explicitly declares demands and uses schema 3', async () => {
    const root = resolve(import.meta.dir, '../../plugins');
    for (const name of await readdir(root)) {
      const manifestPath = resolve(root, name, 'manifest.json');
      if (!await Bun.file(manifestPath).exists()) continue;
      expect((await Bun.file(manifestPath).json()).schemaVersion).toBe(3);
      const module = await import(resolve(root, name, 'server/index.ts'));
      const instance = new module.default();
      expect(typeof instance.bodyRequirements).toBe('function');
      expect(['none', 'json-read', 'json-write']).toContain(instance.bodyRequirements(context()).request);
    }
  });
  test('header-only sanitizer and disabled transforms need no request contents', async () => {
    expect(new Sanitizer({ betaMode: 'strip', removeBetaQuery: true }).bodyRequirements(context()).request).toBe('none');
    expect(new Sanitizer({ stripCacheControl: true }).bodyRequirements(context()).request).toBe('json-write');
    expect(new Sanitizer({ filterOrphanToolResults: true }).bodyRequirements(context()).request).toBe('json-write');
    expect(new Mapping().bodyRequirements(context()).request).toBe('none');
    expect(new Signature({ enabled: false }).bodyRequirements(context())).toEqual({ request: 'none' });
    expect(new ToolNames({ transformNames: false, fixSerializedArrays: false }).bodyRequirements(context())).toEqual({ request: 'none', response: [] });
    const transformer = new Transformer(); const hooks = createPluginHooks(); transformer.register(hooks);
    const ctx = { ...streamContext, method: 'GET', url: new URL('https://example.test/models'), headers: {}, body: undefined };
    expect(await hooks.onBeforeRequest.promise(ctx)).toBe(ctx);
  });
  test('protocol converters only demand matching request paths', () => {
    const ai = new Transformer({ from: 'anthropic', to: 'openai' });
    expect(ai.bodyRequirements(context('/v1/models', 'GET')).request).toBe('none');
    expect(ai.bodyRequirements(context('/upload')).request).toBe('none');
    expect(ai.bodyRequirements(context())).toEqual({ request: 'json-write', response: ['json', 'sse-json'] });
    expect(new Messages().bodyRequirements(context('/v1/models', 'GET')).request).toBe('none');
    expect(new Messages().bodyRequirements(context('/v1/responses')).request).toBe('json-write');
    const oauth = new OAuth();
    expect(oauth.bodyRequirements(context('/v1/models', 'GET')).request).toBe('none');
    expect(oauth.bodyRequirements(context('/backend-api/codex/responses')).request).toBe('json-write');
    expect(oauth.bodyRequirements(context('/arbitrary')).request).toBe('none');
  });
  test('URL model mapping needs no JSON body and takes precedence', async () => {
    const mapping = new Mapping({ modelMappings: { old: 'new', conflicting: 'other' } });
    const demand = context('/v1beta/models/old:generateContent');
    expect(mapping.bodyRequirements(demand).request).toBe('none');
    const hooks = createPluginHooks(); mapping.register(hooks);
    const body = { model: 'conflicting' };
    const result = await hooks.onBeforeRequest.promise({ ...streamContext, url: demand.url, headers: {}, body });
    expect(result.url.pathname).toBe('/v1beta/models/new:generateContent');
    expect(body.model).toBe('conflicting');
  });
  test('replay is explicit and independent from request mutation', () => {
    expect(new Signature().bodyRequirements(context())).toEqual({ request: 'json-read', response: ['json'], replay: true });
  });
  test('signature repair requests one managed retry without privately fetching', async () => {
    const plugin = new Signature(); const hooks = createPluginHooks(); plugin.register(hooks);
    const before = { ...streamContext, url: context().url, headers: { 'Content-Encoding': 'gzip', authorization: 'Bearer upstream' }, body: { contents: [{ parts: [{ thought: true, text: 'private' }, { functionCall: { name: 'tool' }, thoughtSignature: 'bad' }] }] } };
    await hooks.onBeforeRequest.promise(before);
    const mock = spyOn(globalThis, 'fetch');
    const response = Response.json({ error: { message: 'missing thought signature' } }, { status: 400 });
    const source = new BodySource(response.body, 1024);
    const responseContext = { ...streamContext, response, latencyMs: 0, bodyHandle: source.handle() };
    try {
      let action: unknown;
      try { await hooks.onResponse.promise(response, responseContext); } catch (error) { action = error; }
      expect(action).toBeInstanceOf(RequestRetryAction);
      expect(action).toMatchObject({ body: { contents: [{ parts: [{ functionCall: { name: 'tool' }, thoughtSignature: 'skip_thought_signature_validator' }] }] } });
      expect(await hooks.onResponse.promise(response, responseContext)).toBe(response);
      expect(mock).not.toHaveBeenCalled();
      expect(before.headers['Content-Encoding']).toBe('gzip');
      expect(before.body.contents[0]!.parts).toHaveLength(2);
    } finally { source.dispose(); mock.mockRestore(); }
  });
  test('effective budget policy alone requires mandatory JSON; anonymous and no-policy remain opaque', () => {
    const ingress = budgetIngress();
    expect(ingress.bodyRequirements(target(), { byKey: {} }).request).toBe('none');
    const publication = { byKey: { key: { policy: { mode: 'daily', limit: 10 } } } };
    expect(ingress.bodyRequirements(target(), publication).request).toBe('json-read');
    expect(ingress.bodyRequirements(target(undefined, 'anonymous'), publication).request).toBe('none');
  });
  test('model access restrictions prefer the URL and do not inspect public routes', () => {
    const ingress = accessIngress();
    const policy = { protectedRouteIds: ['route'], byKey: { key: { routes: null, models: ['model'] } }, credentials: [] };
    expect(ingress.bodyRequirements(target(), policy).request).toBe('json-read');
    expect(ingress.bodyRequirements(target('https://example.test/v1beta/models/model:generateContent'), policy).request).toBe('none');
    expect(ingress.bodyRequirements(target(), { ...policy, protectedRouteIds: [] }).request).toBe('none');
    expect(ingress.bodyRequirements(target(), { ...policy, byKey: { key: { routes: null, models: null } } }).request).toBe('none');
  });
  test('SSE JSON transforms retain independent event metadata and do not inject _event', async () => {
    const plugin = new ToolNames({ nameMap: 'tool=Named', fixSerializedArrays: false });
    const hooks = createPluginHooks(); plugin.register(hooks);
    const json = { type: 'content_block_start', content_block: { type: 'tool_use', name: 'tool' } };
    const envelope: SSEEnvelope = { data: JSON.stringify(json), json, event: 'custom-event', id: '17', retry: '200', comments: ['keep'], raw: 'original' };
    const result = await hooks.onStreamChunk.promise(envelope, streamContext);
    expect(result[0]).toMatchObject({ event: 'custom-event', id: '17', retry: '200', comments: ['keep'], json: { type: 'content_block_start', content_block: { name: 'Named' } } });
    expect(result[0]!.raw).toBeUndefined();
    expect(json.content_block.name).toBe('tool');
    expect((result[0]!.json as Record<string, unknown>)._event).toBeUndefined();
  });
  test('event-only SSE metering uses independent metadata without touching JSON', () => {
    const body = { response: { usage: { input_tokens: 4, output_tokens: 5 }, output: [] } };
    expect(classifyResponse(body, false, 'response.completed')).toBe('openai');
    const session = createTokenAccountingSession({ provider: 'openai', requestId: 'request', attemptId: 'attempt', routeId: 'route', upstreamId: 'upstream', streaming: true }, { deferFinalization: true });
    session.consumeStreamChunk({ chunk: body, event: 'response.completed' });
    expect(session.finalizeCompletedStream()).toMatchObject({ inputTokens: 4, outputTokens: 5, inputAuthority: 'official', outputAuthority: 'official', outcome: 'completed' });
    expect(Object.keys(body)).toEqual(['response']);
  });
  test('metering parses nothing without consumers and ignores unclassified optional observations', async () => {
    const host = new PluginServiceHost(); const provider = new Metering();
    await provider.init({ config: {}, storage: {} as PluginStorage, logger: { debug() {}, info() {}, warn() {}, error() {} }, services: host.createContext('token-metering') });
    host.markReady('token-metering');
    expect(provider.bodyRequirements(context())).toEqual({ request: 'none' });
    const service = host.createContext('stats', 'global', { 'token-metering': '^1.0.0' }).consume<TokenMeteringService>('token-metering', 'token-metering.v1', 1);
    const results: TokenMeteringResult[] = []; service.subscribe({ onResult: result => { results.push(result); } });
    expect(provider.bodyRequirements(context())).toEqual({ request: 'none', observe: { request: true, response: true, sse: true } });
    const hooks = createPluginHooks(); provider.register(hooks);
    const send = (phase: Record<string, unknown>) => hooks.onAttemptObservation.promise({ requestId: 'request', attemptId: 'attempt', routeId: 'route', upstreamId: 'upstream', isActive: () => true, ...phase } as AttemptObservationEvent);
    await send({ phase: 'selected' }); await send({ phase: 'incomplete', reason: 'unsupported-encoding' }); await send({ phase: 'end', outcome: 'completed', sent: true });
    await Promise.resolve();
    expect(provider.parsedResponses).toBe(0);
    expect(results).toHaveLength(0);
    await provider.onDestroy();
  });
});
