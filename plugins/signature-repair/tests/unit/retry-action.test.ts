import { describe, expect, test } from 'bun:test';
import { createPluginHooks, RequestRetryAction } from '@jeffusion/bungee-core/plugin';
import SignatureRepairPlugin from '../../server';

function request(requestId: string) {
  return {
    requestId, method: 'POST', url: new URL('https://upstream.test/v1/messages'), headers: {},
    body: { contents: [{ parts: [{ thought: true, text: 'private' }, { functionCall: { name: 'tool' }, thoughtSignature: 'broken' }] }] },
  } as any;
}
function responseContext(requestId: string, message = 'Missing thought signature') {
  const response = new Response(null, { status: 400, headers: { 'content-type': 'application/json' } });
  return { requestId, response, bodyHandle: { json: async () => Object.freeze({ error: Object.freeze({ message }) }) } } as any;
}

async function action(hooks: ReturnType<typeof createPluginHooks>, requestId: string) {
  const ctx = responseContext(requestId);
  try {
    await hooks.onResponse.promise(ctx.response, ctx);
    throw new Error('Expected repair action');
  } catch (error) {
    expect(error).toBeInstanceOf(RequestRetryAction);
    return error as RequestRetryAction;
  }
}

describe('signature repair declarative retry', () => {
  test('isolates concurrent logical requests and emits one repair action per request', async () => {
    const plugin = new SignatureRepairPlugin();
    const hooks = createPluginHooks();
    plugin.register(hooks);
    const first = request('first'), second = request('second');
    await hooks.onBeforeRequest.promise(first);
    await hooks.onBeforeRequest.promise(second);
    const retry = await action(hooks, 'first');
    expect(retry.reason).toBe('signature-repair');
    expect(retry.message).toBe('gateway request repair retry');
    expect((retry.body as any).contents[0].parts).toEqual([
      { functionCall: { name: 'tool' }, thoughtSignature: 'skip_thought_signature_validator' }
    ]);
    expect(first.body.contents[0].parts).toHaveLength(2);
    await action(hooks, 'second');
    // A new host-owned attempt with the same logical request must not reset the guard.
    await hooks.onBeforeRequest.promise(request('first'));
    const ctx = responseContext('first');
    expect(await hooks.onResponse.promise(ctx.response, ctx)).toBe(ctx.response);
    await hooks.onFinally.promise({ requestId: 'first' } as any);
    await hooks.onBeforeRequest.promise(request('first'));
    await action(hooks, 'first');
  });

  test('keeps the original response for unrelated status, errors, and malformed JSON', async () => {
    const hooks = createPluginHooks();
    new SignatureRepairPlugin().register(hooks);
    await hooks.onBeforeRequest.promise(request('unchanged'));
    for (const ctx of [
      responseContext('unchanged', 'Invalid model'),
      { ...responseContext('unchanged'), response: new Response(null, { status: 503 }) },
      { ...responseContext('unchanged'), bodyHandle: { json: async () => { throw new Error('invalid_json_body'); } } },
    ]) {
      expect(await hooks.onResponse.promise(ctx.response, ctx)).toBe(ctx.response);
    }
  });

  test('declares replay and JSON views only when enabled and request has a body', () => {
    expect(new SignatureRepairPlugin().bodyRequirements({ method: 'POST' } as any)).toEqual({ request: 'json-read', response: ['json'], replay: true });
    expect(new SignatureRepairPlugin({ enabled: false }).bodyRequirements({ method: 'POST' } as any)).toEqual({ request: 'none' });
    expect(new SignatureRepairPlugin().bodyRequirements({ method: 'GET' } as any)).toEqual({ request: 'none' });
  });
});
