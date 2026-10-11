import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDataPlaneRuntime } from '../../../../packages/core/tests/helpers/data-plane-runtime';
const dataPlane = await createDataPlaneRuntime();
const { ScopedPluginRegistry, setScopedPluginRegistry } = await import('../../../../packages/core/src/scoped-plugin-registry');
const { setBoundControlClientProvider } = await import('../../../../packages/core/src/config-worker/runtime-dependencies');
const { setPluginRegistry } = await import('../../../../packages/core/src/worker/state/plugin-manager');
const { RESPONSES_PATH, CHAT_COMPLETIONS_PATH } = await import('../../server/adapter');
const originalFetch = global.fetch;
describe('ChatGPT OAuth request handler integration', () => {
  for (const routeId of [RESPONSES_PATH, CHAT_COMPLETIONS_PATH]) {
    for (const terminal of ['completed', 'incomplete'] as const) {
      test(`real adapter and handler preserve ${terminal} when ${routeId} is cancelled after terminal`, async () => {
        const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
          import('../../../../packages/core/src/worker/request/handler'),
          import('../../../../packages/core/src/worker/state/runtime-state'),
          import('../../../../packages/core/src/logger/access-log-writer'),
        ]);
        const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
        await registry.createInstance({ type: 'upstream', routeId, upstreamId: 'primary' },
          { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any);
        setScopedPluginRegistry(registry);
        const terminalFrame = `data: ${JSON.stringify({ type: `response.${terminal}`, response: {
          status: terminal, output: [], ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        } })}\n\n`;
        global.fetch = (async () => new Response(terminalFrame + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })) as unknown as typeof fetch;
        const config = {
          services: [{ name: 'terminal', failover: { enabled: true, retry_on: [503] },
            endpoints: [{ id: 'primary', target: 'https://chatgpt.com' }] }],
          routes: [{ path: routeId, service: 'terminal' }],
        } as any;
        runtime.initializeRuntimeState(config);
        try {
          const controller = new AbortController();
          const response = await handleRequest(new Request(`http://localhost${routeId}`, {
            method: 'POST', signal: controller.signal,
            body: JSON.stringify({ model: 'codex', stream: true,
              ...(routeId === RESPONSES_PATH ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }) }),
            headers: { 'content-type': 'application/json' },
          }), config);
          const reader = response.body!.getReader();
          let received = '';
          const decoder = new TextDecoder();
          const marker = routeId === RESPONSES_PATH ? `response.${terminal}` : '[DONE]';
          while (!received.includes(marker)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('missing terminal');
            received += decoder.decode(chunk.value, { stream: true });
          }
          controller.abort('closed after terminal');
          await reader.cancel('closed after terminal');
          await accessLogWriter.flush();
          const row = accessLogWriter.getDatabase().query(
            'SELECT success, protocol_outcome FROM access_logs WHERE path = ? ORDER BY id DESC LIMIT 1',
          ).get(routeId);
          expect(row).toEqual({ success: terminal === 'completed' ? 1 : 0, protocol_outcome: terminal });
          expect(runtime.getActiveRequestCount('terminal', 'primary')).toBe(0);
        } finally {
          accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path = ?').run(routeId);
          runtime.runtimeState.clear();
          setScopedPluginRegistry(null);
          await registry.destroy();
          global.fetch = originalFetch;
        }
      });
    }
  }

  test('real adapter and handler preserve a safe upstream 400 without failover or health failure', async () => {
    const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
      import('../../../../packages/core/src/worker/request/handler'),
      import('../../../../packages/core/src/worker/state/runtime-state'),
      import('../../../../packages/core/src/logger/access-log-writer'),
    ]);
    const routeId = CHAT_COMPLETIONS_PATH;
    const pluginManifestPath = fileURLToPath(new URL('../../manifest.json', import.meta.url));
    expect(await Bun.file(pluginManifestPath).exists()).toBe(true);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
    await registry.createInstance(
      { type: 'upstream', routeId, upstreamId: 'primary' },
      { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any,
    );
    setScopedPluginRegistry(registry);
    let fetchCount = 0;
    let originalUpstreamResponse: Response | undefined;
    global.fetch = (async () => {
      fetchCount++;
      originalUpstreamResponse = new Response('upstream-secret', { status: 400, headers: { 'content-type': 'application/json' } });
      return originalUpstreamResponse;
    }) as unknown as typeof fetch;

    const config = {
      services: [{
        name: 'chatgpt-integration-service',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [
          { id: 'primary', target: 'https://chatgpt.com', priority: 0 },
          { id: 'secondary', target: 'https://fallback.example.test', priority: 1 },
        ],
      }],
      routes: [{ path: routeId, service: 'chatgpt-integration-service' }],
    } as any;
    runtime.initializeRuntimeState(config);

    try {
      const response = await handleRequest(new Request(`http://localhost${routeId}`, {
        method: 'POST',
        body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hello' }] }),
        headers: { 'content-type': 'application/json' },
      }), config);
      const body = await response.text();
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().prepare(
        'SELECT status, success, protocol_outcome, protocol_code FROM access_logs WHERE path = ? ORDER BY timestamp DESC LIMIT 1',
      ).get(routeId) as { status: number; success: number; protocol_outcome: string; protocol_code: string } | null;

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(body).not.toContain('upstream-secret');
      expect(originalUpstreamResponse?.bodyUsed).toBe(true);
      expect(fetchCount).toBe(1);
      expect(runtime.runtimeState.get('chatgpt-integration-service')?.upstreams).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'primary', status: 'HEALTHY', consecutive_failures: 0 }),
      ]));
      expect(row).toEqual({ status: 400, success: 0, protocol_outcome: 'failed', protocol_code: 'upstream_http_error' });
      accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run(routeId);
    } finally {
      runtime.runtimeState.clear();
      setScopedPluginRegistry(null);
      await registry.destroy();
      global.fetch = originalFetch;
    }
  });

  test('real managed ChatGPT 401 rejects the lease once and returns a safe failed response', async () => {
    const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
      import('../../../../packages/core/src/worker/request/handler'),
      import('../../../../packages/core/src/worker/state/runtime-state'),
      import('../../../../packages/core/src/logger/access-log-writer'),
    ]);
    const routeId = CHAT_COMPLETIONS_PATH;
    const endpointId = 'managed-primary';
    const bindingId = 'managed-binding';
    const pluginManifestPath = fileURLToPath(new URL('../../manifest.json', import.meta.url));
    expect(await Bun.file(pluginManifestPath).exists()).toBe(true);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
    await registry.createInstance(
      { type: 'upstream', routeId, upstreamId: endpointId },
      { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any,
    );
    const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({
      getPluginStateSnapshot: () => ({
        pluginName: 'chatgpt-oauth', discovery: 'discovered', validation: 'validated',
        persistedEnabled: 'enabled', manifest,
      }),
    } as any);
    const controlCalls: Array<{ method: string; attempt?: { revision: number; endpointId: string; attemptId: string } }> = [];
    setBoundControlClientProvider((_binding, attempt) => ({
      call: async <T>(method: string): Promise<T> => {
        controlCalls.push({ method, attempt: attempt as typeof controlCalls[number]['attempt'] });
        if (method === 'getCredential') {
          return {
            version: 7,
            expiresAt: Date.now() + 10_000,
            headers: { authorization: 'Bearer managed-secret', 'chatgpt-account-id': 'managed-account' },
          } as T;
        }
        return true as T;
      },
    }));
    setScopedPluginRegistry(registry);
    let originalUpstreamResponse: Response | undefined;
    let fetchCount = 0;
    global.fetch = (async () => {
      fetchCount++;
      originalUpstreamResponse = new Response(JSON.stringify({ error: {
        code: 'invalid_token', type: 'authentication_error',
        message: 'Lease rejected: managed-secret managed-account', private: 'managed-upstream-secret',
      } }), { status: 401, headers: { 'content-type': 'application/json' } });
      return originalUpstreamResponse;
    }) as unknown as typeof fetch;
    const config = {
      services: [{
        name: 'managed-chatgpt-401',
        failover: { enabled: true, retry_on: [503] },
        endpoints: [{
          id: endpointId,
          target: 'https://chatgpt.com',
          priority: 0,
          managedBy: { plugin: 'chatgpt-oauth', contributionId: 'chatgpt', bindingId },
          plugins: [{ id: bindingId, name: 'chatgpt-oauth', options: { accountRef: 'integration-account' }, enabled: true }],
        }, {
          id: 'managed-secondary', target: 'https://fallback.example.test', priority: 1,
        }],
      }],
      routes: [{ path: routeId, service: 'managed-chatgpt-401' }],
    } as any;
    runtime.initializeRuntimeState(config);

    try {
      const response = await handleRequest(new Request(`http://localhost${routeId}`, {
        method: 'POST',
        body: JSON.stringify({ model: 'codex', messages: [{ role: 'user', content: 'hello' }] }),
        headers: { 'content-type': 'application/json' },
      }), config, { servingRevision: 26 });
      const body = await response.text();
      await accessLogWriter.flush();
      const row = accessLogWriter.getDatabase().prepare(
        'SELECT status, success, protocol_outcome, protocol_code FROM access_logs WHERE path = ? ORDER BY timestamp DESC LIMIT 1',
      ).get(routeId) as { status: number; success: number; protocol_outcome: string; protocol_code: string } | null;
      const selected = runtime.runtimeState.get('managed-chatgpt-401')?.upstreams[0];

      expect(response.status).toBe(401);
      expect(body).not.toContain('managed-upstream-secret');
      expect(body).not.toContain('managed-secret');
      expect(body).not.toContain('managed-account');
      expect(body).toContain('invalid_token');
      expect(body).toContain('Lease rejected');
      expect(originalUpstreamResponse?.bodyUsed).toBe(true);
      expect(fetchCount).toBe(1);
      expect(controlCalls.map(({ method }) => method)).toEqual(['getCredential', 'rejectAccess']);
      expect(controlCalls[0]?.attempt).toMatchObject({ revision: 26, endpointId, attemptId: controlCalls[1]?.attempt?.attemptId });
      expect(selected).toMatchObject({ status: 'HEALTHY', consecutive_failures: 1 });
      expect(row).toEqual({ status: 401, success: 0, protocol_outcome: 'failed', protocol_code: 'upstream_http_error' });
      accessLogWriter.getDatabase().prepare('DELETE FROM access_logs WHERE path = ?').run(routeId);
    } finally {
      runtime.runtimeState.clear();
      setScopedPluginRegistry(null);
      setPluginRegistry(null);
      setBoundControlClientProvider(null);
      await registry.destroy();
      global.fetch = originalFetch;
    }
  });
});
afterAll(async () => { global.fetch = originalFetch; await dataPlane.close(); });
