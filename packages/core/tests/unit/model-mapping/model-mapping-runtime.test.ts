import { describe, expect, test } from 'bun:test';
import { createPluginHooks, type MutableRequestContext } from '../../../src/hooks';
import { PluginServiceHost } from '../../../src/plugin-services';
import type { PluginInitContext } from '../../../src/hooks';
import { rawCatalogService } from '../../../../../plugins/token-stats/tests/helpers/catalog-service';
import { MODELS_DEV_CATALOG_SERVICE_ID, MODEL_IDENTITY_ANNOTATION_KEY } from '../../../../../plugins/models-dev/contract';
import ModelMappingPlugin from '../../../../../plugins/model-mapping/server/index';

function createMockRequestContext(model: string): MutableRequestContext {
  return {
    method: 'POST',
    originalUrl: new URL('http://localhost/v1/chat/completions'),
    clientIP: '127.0.0.1',
    requestId: 'test-request-id',
    routeId: '/v1/test',
    url: new URL('http://mock-upstream/v1/chat/completions'),
    headers: {
      'content-type': 'application/json'
    },
    body: {
      model,
      messages: [{ role: 'user', content: 'hello' }]
    }
  };
}

function createMockGeminiRequestContext(model: string, isStreaming = false): MutableRequestContext {
  const endpoint = isStreaming ? 'streamGenerateContent' : 'generateContent';
  return {
    method: 'POST',
    originalUrl: new URL(`http://localhost/v1beta/models/${model}:${endpoint}`),
    clientIP: '127.0.0.1',
    requestId: 'test-request-id',
    routeId: '/v1/test',
    url: new URL(`http://mock-upstream/v1beta/models/${model}:${endpoint}`),
    headers: {
      'content-type': 'application/json'
    },
    body: {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
    }
  };
}

describe('model-mapping runtime behavior', () => {
  test('should match canonical source IDs and normalize canonical target IDs', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'openai:gpt-4o-mini',
          target: 'anthropic:claude-3-5-sonnet-20241022'
        }
      ]
    });

    const services = new PluginServiceHost();
    services.createContext('models-dev').publish(MODELS_DEV_CATALOG_SERVICE_ID, 1,
      rawCatalogService({ anthropic: { id: 'anthropic', models: {} } }));
    services.markReady('models-dev');
    await plugin.init({ services: services.createContext('model-mapping', 'global', { 'models-dev': '^1.0.0' }) } as PluginInitContext);

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockRequestContext('gpt-4o-mini');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.body.model).toBe('claude-3-5-sonnet-20241022');
  });

  test('should map Gemini URL path model to target model', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gemini-pro',
          target: 'gemini-1.5-pro'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockGeminiRequestContext('gemini-pro');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-pro:generateContent');
  });

  test('should map Gemini streaming URL path model', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gemini-pro',
          target: 'gemini-1.5-flash'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockGeminiRequestContext('gemini-pro', true);
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-flash:streamGenerateContent');
  });

  test('should handle URL encoded model names in Gemini path', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'models/gemini-pro',
          target: 'gemini-1.5-pro'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const encodedModel = encodeURIComponent('models/gemini-pro');
    const context = createMockGeminiRequestContext(encodedModel);
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.url.pathname).toBe('/v1beta/models/gemini-1.5-pro:generateContent');
  });

  test('should prefer body.model over URL path model when both exist', async () => {
    const plugin = new ModelMappingPlugin({
      modelMappings: [
        {
          source: 'gpt-4',
          target: 'claude-3-opus'
        }
      ]
    });

    const hooks = createPluginHooks();
    plugin.register(hooks);

    const context = createMockRequestContext('gpt-4');
    const transformedContext = await hooks.onBeforeRequest.promise(context);

    expect(transformedContext.body.model).toBe('claude-3-opus');
  });
});

test('matched mapping replaces or clears identity, no match retains it, and unchanged wire names declare too',async()=>{
 const identity={provider:'zai',model:'glm-5.3'};
 const hooks=createPluginHooks();new ModelMappingPlugin({modelMappings:[{source:'glm-5.3',target:'GLM-5.3',catalogModel:identity},{source:'GLM-5.3',target:'GLM-5.3',catalogModel:identity}]}).register(hooks);
 const ctx=createMockRequestContext('glm-5.3');
 await hooks.onBeforeRequest.promise(ctx);
 expect(ctx.body.model).toBe('GLM-5.3');expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toEqual({wireModel:'GLM-5.3',catalogModel:identity});
 await hooks.onBeforeRequest.promise(ctx);expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toEqual({wireModel:'GLM-5.3',catalogModel:identity});
 const next=createPluginHooks();new ModelMappingPlugin({modelMappings:[{source:'GLM-5.3',target:'OTHER',catalogModel:{provider:'other',model:'m'}}]}).register(next);
 await next.onBeforeRequest.promise(ctx);expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toEqual({wireModel:'OTHER',catalogModel:{provider:'other',model:'m'}});
 ctx.body.model='no-match';await next.onBeforeRequest.promise(ctx);expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toBeDefined();
 ctx.body.model='OTHER';const clear=createPluginHooks();new ModelMappingPlugin({modelMappings:[{source:'OTHER',target:'OTHER'}]}).register(clear);
 await clear.onBeforeRequest.promise(ctx);expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toBeUndefined();
});
test('candidate conflict includes optional identity and exact source still wins',async()=>{
 for(const catalogModel of [undefined,{provider:'b',model:'m'}]){
  const rules=[{source:'a:m',target:'WIRE',catalogModel:{provider:'a',model:'m'}},{source:'b:m',target:'WIRE',...(catalogModel?{catalogModel}:{})},{source:'m-',target:'fallback'}];
  const hooks=createPluginHooks();new ModelMappingPlugin({modelMappings:rules}).register(hooks);
  await expect(hooks.onBeforeRequest.promise(createMockRequestContext('m'))).rejects.toMatchObject({status:422,code:'model_mapping_ambiguous'});
  const exact=createMockRequestContext('a:m');await hooks.onBeforeRequest.promise(exact);expect(exact.body.model).toBe('WIRE');
 }
});
test('Gemini mapping uses encoded terminal URL segment, preserving base prefix and ignoring forged body model',async()=>{
 const hooks=createPluginHooks();new ModelMappingPlugin({modelMappings:[{source:'models/source',target:'WIRE/Model',catalogModel:{provider:'p',model:'m'}}]}).register(hooks);
 const ctx=createMockGeminiRequestContext('models%2Fsource',true);ctx.url.pathname='/company'+ctx.url.pathname;ctx.body.model='FORGED';
 await hooks.onBeforeRequest.promise(ctx);
 expect(ctx.url.pathname).toBe('/company/v1beta/models/WIRE%2FModel:streamGenerateContent');expect(ctx.body.model).toBe('FORGED');
 expect(ctx.annotations?.[MODEL_IDENTITY_ANNOTATION_KEY]).toEqual({wireModel:'WIRE/Model',catalogModel:{provider:'p',model:'m'}});
});

test('mapping retains the existing slash-form model path rewrite',async()=>{
 const hooks=createPluginHooks();new ModelMappingPlugin({modelMappings:[{source:'old',target:'new'}]}).register(hooks);
 const ctx=createMockGeminiRequestContext('old');ctx.url.pathname='/base/v1/models/old/generateContent';
 await hooks.onBeforeRequest.promise(ctx);expect(ctx.url.pathname).toBe('/base/v1/models/new/generateContent');
});
