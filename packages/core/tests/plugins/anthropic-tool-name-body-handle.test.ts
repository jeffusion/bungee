import { expect, test } from 'bun:test';
import { createPluginHooks } from '@jeffusion/bungee-core/plugin';
import AnthropicToolNameTransformerPlugin from '../../../../plugins/anthropic-tool-name-transformer/server';

function frozenBody(value: any): any {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozenBody); Object.freeze(value); }
  return value;
}

test('tool input repair clones the shared JSON view and only replaces changed responses', async () => {
  const hooks = createPluginHooks();
  new AnthropicToolNameTransformerPlugin().register(hooks);
  const response = new Response(null, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '123' } });
  const shared = frozenBody({ content: [{ type: 'tool_use', input: { list: '[1,2]' } }] });
  const result = await hooks.onResponse.promise(response, { response, bodyHandle: { json: async () => shared } } as any);
  expect(result).not.toBe(response);
  expect((await result.json()).content[0].input.list).toEqual([1, 2]);
  expect(shared.content[0].input.list).toBe('[1,2]');
  const unchanged = frozenBody({ content: [{ type: 'text', text: 'unchanged' }] });
  expect(await hooks.onResponse.promise(response, { response, bodyHandle: { json: async () => unchanged } } as any)).toBe(response);
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('content-length')).toBe('123');
});

test('tool name SSE transforms a frozen envelope without mutating its JSON', async () => {
  const hooks = createPluginHooks();
  new AnthropicToolNameTransformerPlugin().register(hooks);
  const json = frozenBody({ type: 'content_block_start', content_block: { type: 'tool_use', name: 'my_tool' } });
  const envelope = Object.freeze({ event: 'content_block_start', id: '42', data: JSON.stringify(json), json, raw: 'original event' });
  const result = await hooks.onStreamChunk.promise(envelope, {} as any);
  expect(result![0].json).toMatchObject({ content_block: { name: 'MyTool' } });
  expect(result![0].id).toBe('42');
  expect(result![0].raw).toBeUndefined();
  expect(json.content_block.name).toBe('my_tool');
});
