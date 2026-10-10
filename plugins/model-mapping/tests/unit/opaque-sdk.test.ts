import { expect, test } from 'bun:test';
import { createPluginHooks, type MutableRequestContext } from '../../../../packages/core/src/hooks';
import type { PluginServices } from '../../../../packages/core/src/plugin-services';
import ModelMappingPlugin from '../../server';

function request(path: string, body?: unknown): MutableRequestContext {
  return { requestId: 'test', method: 'POST', clientIP: '127.0.0.1', originalUrl: new URL(`http://localhost${path}`), url: new URL(`https://upstream.example${path}`), headers: {}, body };
}

test('catalog provider normalization survives alongside opaque body demands', async () => {
  const plugin = new ModelMappingPlugin({ modelMappings: { source: 'openai:gpt-test', literal: 'custom:model' } });
  const services = { consume: () => ({ providers: () => [{ provider: 'openai' }] }) } as unknown as PluginServices;
  await plugin.init({ config: {}, services, storage: {} as any, logger: {} as any });
  const hooks = createPluginHooks();
  plugin.register(hooks);
  const context = request('/v1/chat/completions', { model: 'source' });
  expect(plugin.bodyRequirements({ ...context, stage: 'selected' })).toEqual({ request: 'json-write' });
  await hooks.onBeforeRequest.promise(context);
  expect(context.body.model).toBe('gpt-test');
  context.body.model = 'literal';
  await hooks.onBeforeRequest.promise(context);
  expect(context.body.model).toBe('custom:model');
  const url = request('/v1beta/models/source:generateContent');
  expect(plugin.bodyRequirements({ ...url, stage: 'selected' })).toEqual({ request: 'none' });
  await hooks.onBeforeRequest.promise(url);
  expect(url.url.pathname).toBe('/v1beta/models/gpt-test:generateContent');
  expect(url.body).toBeUndefined();
});
