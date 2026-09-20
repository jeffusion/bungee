import { expect, test } from 'bun:test';
import { allowedControlRequest, allowedHostAction, MAX_SEEN_HOST_REQUEST_IDS, PluginBridgeClient, validateHostRequest } from './host-messages';
import type { PluginHostPolicy } from './host-messages';

const hostSource = await Bun.file(new URL('../components/shell/PluginHost.svelte', import.meta.url)).text();

test('sandbox host keeps the iframe opaque and initializes a transferred port', () => {
  expect(hostSource).toContain("let sandboxAttrs = $state('allow-scripts')");
  expect(hostSource).not.toContain('allow-same-origin');
  expect(hostSource).toContain("postMessage({ type: 'bungee:bridge-init'");
  expect(hostSource).toContain("'*', [channel.port2]");
  expect(hostSource).toContain('current.seenIds.size >= MAX_SEEN_HOST_REQUEST_IDS');
  expect(hostSource).toContain('bridge !== current || current.generation !== generation');
  expect(hostSource).not.toContain('window.addEventListener(\'message\', handleMessage)');
});

test('bridge rejects forged credentials, actions, methods, paths, oversized bodies and replays', () => {
  const seen = new Set<string>();
  const valid = { type: 'bungee:host-request', generation: 4, nonce: 'n'.repeat(64), id: 'request-1', action: 'control', path: '/allowed', method: 'POST', body: { ok: true } };
  expect(validateHostRequest(valid, 4, valid.nonce, seen)).toHaveProperty('request');
  expect(validateHostRequest(valid, 4, valid.nonce, seen)).toMatchObject({ error: '请求已处理' });
  expect(validateHostRequest({ ...valid, id: 'request-2', nonce: 'wrong' }, 4, valid.nonce, seen)).toHaveProperty('error');
  expect(validateHostRequest({ ...valid, id: 'request-3', generation: 3 }, 4, valid.nonce, seen)).toHaveProperty('error');
  expect(validateHostRequest({ ...valid, id: 'request-4', action: 'execute-admin' }, 4, valid.nonce, seen)).toHaveProperty('error');
  expect(validateHostRequest({ ...valid, id: 'request-5', body: 'x'.repeat(65537) }, 4, valid.nonce, seen)).toMatchObject({ error: '请求内容过长' });
  expect(validateHostRequest({ ...valid, id: 'request-cap' }, 4, valid.nonce,
    new Set(Array.from({ length: MAX_SEEN_HOST_REQUEST_IDS }, (_, index) => String(index))))).toMatchObject({ error: '请求数量超限' });
  const policy: PluginHostPolicy = { sandbox: 'allow-scripts', allowedHostActions: ['control'], controlAllowlist: [{ path: '/allowed', methods: ['POST'] }] };
  expect(allowedControlRequest(policy, '/allowed', 'POST')).toBe(true);
  expect(allowedControlRequest(policy, '/not-allowed', 'POST')).toBe(false);
  expect(allowedControlRequest(policy, '/allowed', 'GET')).toBe(false);
  for (const path of ['/allowed?query=1', '/../allowed', '/%2e%2e/allowed', '/%252e%252e/allowed', '/allowed//child']) {
    expect(allowedControlRequest(policy, path, 'POST')).toBe(false);
  }
});

test('policy gates side effects and maps capabilities without widening control declarations', () => {
  const policy: PluginHostPolicy = { sandbox: 'allow-scripts', allowedHostActions: ['ui-context', 'copy-styles', 'open-external', 'new-service', 'references', 'control'], controlAllowlist: [{ path: '/allowed', methods: ['POST'] }] };
  expect(allowedHostAction(policy, 'ui-context')).toBe(true);
  expect(allowedHostAction(policy, 'copy-styles')).toBe(true);
  expect(allowedHostAction(policy, 'open-external')).toBe(true);
  expect(allowedHostAction(policy, 'new-service')).toBe(true);
  expect(allowedHostAction(policy, 'references')).toBe(true);
  expect(allowedHostAction(policy, 'control', '/allowed', 'POST')).toBe(true);
  for (const action of ['open-external', 'new-service', 'references'] as const) {
    expect(allowedHostAction({ ...policy, allowedHostActions: policy.allowedHostActions.filter(value => value !== action) }, action)).toBe(false);
  }
  expect(allowedHostAction(policy, 'control', '/allowed', 'GET')).toBe(false);
  expect(allowedHostAction(policy, 'control', '/other', 'POST')).toBe(false);
  expect(allowedHostAction({ ...policy, allowedHostActions: [] }, 'control', '/allowed', 'POST')).toBe(false);
});

test('a bridge client accepts only the current generation and nonce response', async () => {
  const channel = new MessageChannel();
  const client = new PluginBridgeClient(channel.port1, 7, 'q'.repeat(64));
  let responses = 0;
  channel.port2.onmessage = event => {
    if (responses++ === 0) {
      channel.port2.postMessage({ type: 'bungee:host-result', generation: 6, nonce: 'q'.repeat(64), id: event.data.id, result: { ok: false } });
      channel.port2.postMessage({ type: 'bungee:host-result', generation: 7, nonce: 'wrong', id: event.data.id, result: { ok: false } });
    }
    channel.port2.postMessage({ type: 'bungee:host-result', generation: 7, nonce: 'q'.repeat(64), id: event.data.id, result: { ok: true } });
  };
  const result = await client.request<{ ok: boolean }>('control', { path: '/allowed', method: 'POST', body: {} });
  expect(result).toEqual({ ok: true });
  client.close();
  channel.port2.close();
});
