import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDataPlaneRuntime } from '../../../../packages/core/tests/helpers/data-plane-runtime';
const dataPlane = await createDataPlaneRuntime();
const { ScopedPluginRegistry, setScopedPluginRegistry } = await import('../../../../packages/core/src/scoped-plugin-registry');
const { setBoundControlClientProvider } = await import('../../../../packages/core/src/config-worker/runtime-dependencies');
const { setPluginRegistry } = await import('../../../../packages/core/src/worker/state/plugin-manager');
const { RESPONSES_PATH, CHAT_COMPLETIONS_PATH, CODEX_RESPONSES_PATH } = await import('../../server/adapter');
const originalFetch = global.fetch;
describe('ChatGPT OAuth request handler integration', () => {
  for (const routeId of [RESPONSES_PATH, CHAT_COMPLETIONS_PATH, '/chat/completions', '/chatgpt/responses']) {
    const native = routeId === '/chatgpt/responses';
    const chat = routeId === CHAT_COMPLETIONS_PATH || routeId === '/chat/completions';
    // The short entry is recognized only after adding the upstream base path.
    // It exercises an outer instance without a registered conversion state.
    const scopes = routeId === '/chat/completions' ? ['combined'] as const : ['upstream', 'service', 'route', 'combined'] as const;
    for (const scope of scopes) {
    for (const media of native ? ['text/event-stream', '', 'application/octet-stream'] : ['text/event-stream']) {
    for (const terminal of native ? ['completed', 'incomplete', 'failed', 'cancelled'] as const : ['completed', 'incomplete'] as const) {
      test(`real adapter and handler separate ${terminal} protocol from cancelled transport at ${routeId} (${scope}, ${media || 'headerless'})`, async () => {
        const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
          import('../../../../packages/core/src/worker/request/handler'),
          import('../../../../packages/core/src/worker/state/runtime-state'),
          import('../../../../packages/core/src/logger/access-log-writer'),
        ]);
        const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
        for (const binding of scope === 'combined' ? ['upstream', 'service', 'route'] as const : [scope]) {
        await registry.createInstance({ type: binding, routeId, ...(binding === 'upstream' ? { upstreamId: 'primary' } : binding === 'service' ? { serviceName: 'terminal' } : {}) },
          { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any);
        }
        setScopedPluginRegistry(registry);
        const terminalFrame = terminal === 'cancelled' ? 'data: {"type":"response.created","response":{"status":"in_progress"}}\n\n'
          : `data: ${JSON.stringify({ type: `response.${terminal}`, response: {
          status: terminal, output: [], ...(terminal === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        } })}\n\n`;
        let sourceCancelled = false;
        global.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(terminalFrame)); },
          cancel() { sourceCancelled = true; },
        }), { headers: media ? { 'content-type': media } : {} })) as unknown as typeof fetch;
        const config = {
          services: [{ name: 'terminal', failover: { enabled: true, retry_on: [503] },
            endpoints: [{ id: 'primary', target: routeId === '/chat/completions' ? 'https://chatgpt.com/v1' : 'https://chatgpt.com' }] }],
          routes: [{ path: routeId, service: 'terminal', ...(native ? { path_rewrite: { '^/chatgpt/responses$': CODEX_RESPONSES_PATH } } : {}) }],
        } as any;
        runtime.initializeRuntimeState(config);
        try {
          const controller = new AbortController();
          const response = await handleRequest(new Request(`http://localhost${routeId}`, {
            method: 'POST', signal: controller.signal,
            body: JSON.stringify({ model: 'codex', stream: true,
              ...(!chat ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }) }),
            headers: { 'content-type': 'application/json' },
          }), config);
          const reader = response.body!.getReader();
          let received = '';
          const decoder = new TextDecoder();
          const marker = chat ? '"finish_reason":"' : terminal === 'cancelled' ? 'response.created' : `response.${terminal}`;
          while (!received.includes(marker)) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('missing terminal');
            received += decoder.decode(chunk.value, { stream: true });
          }
          controller.abort('closed after terminal');
          await reader.cancel('closed after terminal');
          await accessLogWriter.flush();
          const row = accessLogWriter.getDatabase().query(
            'SELECT status, success, protocol_outcome, transport_outcome, transport_code FROM access_logs WHERE path = ? ORDER BY id DESC LIMIT 1',
          ).get(routeId);
          expect(row).toEqual({ status: 200, success: terminal === 'completed' ? 1 : 0, protocol_outcome: terminal,
            transport_outcome: 'cancelled', transport_code: 'client_cancelled' });
          expect(sourceCancelled).toBe(true);
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
    }
  }

  for (const routeId of ['/chat/completions', RESPONSES_PATH]) test(`combined scopes keep converted non-stream JSON at ${routeId}`, async () => {
    const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
      import('../../../../packages/core/src/worker/request/handler'),
      import('../../../../packages/core/src/worker/state/runtime-state'),
      import('../../../../packages/core/src/logger/access-log-writer'),
    ]);
    const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
    for (const scope of ['upstream', 'service', 'route'] as const) {
      await registry.createInstance({ type: scope, routeId, ...(scope === 'upstream' ? { upstreamId: 'primary' } : scope === 'service' ? { serviceName: 'terminal' } : {}) },
        { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any);
    }
    setScopedPluginRegistry(registry);
    global.fetch = (async () => new Response('data: {"type":"response.completed","response":{"id":"resp_combined","status":"completed","output":[]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
    const config = { services: [{ name: 'terminal', endpoints: [{ id: 'primary', target: routeId === '/chat/completions' ? 'https://chatgpt.com/v1' : 'https://chatgpt.com' }] }],
      routes: [{ path: routeId, service: 'terminal' }] } as any;
    runtime.initializeRuntimeState(config);
    try {
      const response = await handleRequest(new Request(`http://localhost${routeId}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex', stream: false,
          ...(routeId === RESPONSES_PATH ? { input: 'hi' } : { messages: [{ role: 'user', content: 'hi' }] }) }) }), config);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const payload = await response.json() as any;
      expect(routeId === RESPONSES_PATH ? payload.status : payload.object).toBe(routeId === RESPONSES_PATH ? 'completed' : 'chat.completion');
      await accessLogWriter.flush();
      expect(accessLogWriter.getDatabase().query('SELECT protocol_outcome, transport_outcome FROM access_logs WHERE path = ? ORDER BY id DESC LIMIT 1').get(routeId))
        .toEqual({ protocol_outcome: 'completed', transport_outcome: 'completed' });
    } finally {
      accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path = ?').run(routeId);
      runtime.runtimeState.clear(); setScopedPluginRegistry(null); await registry.destroy(); global.fetch = originalFetch;
    }
  });

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
