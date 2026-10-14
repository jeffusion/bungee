import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDataPlaneRuntime } from '../../../../packages/core/tests/helpers/data-plane-runtime';
const dataPlane = await createDataPlaneRuntime();
const { ScopedPluginRegistry, setScopedPluginRegistry } = await import('../../../../packages/core/src/scoped-plugin-registry');
const { setBoundControlClientProvider } = await import('../../../../packages/core/src/config-worker/runtime-dependencies');
const { setPluginRegistry } = await import('../../../../packages/core/src/worker/state/plugin-manager');
const { RESPONSES_PATH, CHAT_COMPLETIONS_PATH, CODEX_RESPONSES_PATH, CODEX_SEARCH_PATH, CODEX_RESPONSES_USER_AGENT } = await import('../../server/adapter');
const originalFetch = global.fetch;
const searchBody = JSON.stringify({
  id: 'search-session', model: 'search-model',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the Keycloak docs' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'search-turn' } }],
  commands: { open: [{ ref_id: 'https://www.keycloak.org/securing-apps/oidc-layers' }], response_length: 'short' },
  settings: { allowed_callers: ['direct'], external_web_access: false }, max_output_tokens: 10000,
}, null, 2) + '\n';

async function forwardSearch(options: {
  combined?: boolean; entry?: string; rewrite?: boolean; target?: string;
  contributionId?: string; method?: string; status?: number; failover?: boolean;
} = {}) {
  const [{ handleRequest }, runtime, { accessLogWriter }] = await Promise.all([
    import('../../../../packages/core/src/worker/request/handler'),
    import('../../../../packages/core/src/worker/state/runtime-state'),
    import('../../../../packages/core/src/logger/access-log-writer'),
  ]);
  const routeId = options.entry ?? '/codex/alpha/search';
  const endpointId = 'search-primary', bindingId = 'search-binding', serviceName = 'managed-search';
  const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../..', import.meta.url)));
  const controlCalls: string[] = [];
  const upstreamCalls: Array<{ url: string; method?: string; headers: Headers; body: string }> = [];
  const status = options.status ?? 200;
  const upstreamBody = status === 200 ? '{ "output": "Keycloak docs", "results": [], "encrypted_output": "opaque" }\n'
    : JSON.stringify({ error: 'upstream search failure' });
  try {
    for (const scope of options.combined ? ['route', 'service', 'upstream'] as const : ['upstream'] as const) {
      await registry.createInstance({ type: scope, routeId,
        ...(scope === 'upstream' ? { upstreamId: endpointId } : scope === 'service' ? { serviceName } : {}) },
      { name: 'chatgpt-oauth', options: { accountRef: 'integration-account' } } as any);
    }
    const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
    setPluginRegistry({ getPluginStateSnapshot: () => ({
      pluginName: 'chatgpt-oauth', discovery: 'discovered', validation: 'validated', persistedEnabled: 'enabled', manifest,
    }) } as any);
    setBoundControlClientProvider(() => ({ call: async <T>(method: string): Promise<T> => {
      controlCalls.push(method);
      return (method === 'getCredential' ? {
        version: 1, expiresAt: Date.now() + 10_000,
        headers: { authorization: 'Bearer fixture-search-token', 'chatgpt-account-id': 'fixture-search-account' },
      } : { rejected: true }) as T;
    } }));
    setScopedPluginRegistry(registry);
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      upstreamCalls.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers),
        body: await new Response(init?.body).text() });
      return new Response(upstreamBody, { status, headers: {
        'content-type': 'application/json', 'x-request-id': 'search-response', ...(status === 429 ? { 'retry-after': '7' } : {}),
      } });
    }) as unknown as typeof fetch;
    const config = {
      services: [{ name: serviceName, failover: { enabled: options.failover ?? false, retry_on: [503] }, endpoints: [{
        id: endpointId, target: options.target ?? 'https://chatgpt.com', priority: 0,
        managedBy: { plugin: 'chatgpt-oauth', contributionId: options.contributionId ?? 'chatgpt', bindingId },
        plugins: [{ id: bindingId, name: 'chatgpt-oauth', options: { accountRef: 'integration-account' }, enabled: true }],
      }, { id: 'fallback', target: 'https://fallback.example.test', priority: 1 }] }],
      routes: [{ path: routeId, service: serviceName,
        ...(options.rewrite === false ? {} : { path_rewrite: { '^/codex/alpha/search$': '/alpha/search' } }) }],
    } as any;
    runtime.initializeRuntimeState(config);
    const method = options.method ?? 'POST';
    const response = await handleRequest(new Request(`http://localhost${routeId}?request=search`, { method,
      ...(!['GET', 'HEAD'].includes(method) ? { body: searchBody } : {}),
      headers: { 'content-type': 'application/json', Authorization: 'Bearer fixture-caller-token', Cookie: 'fixture-caller-cookie',
        'X-Codex-Turn-Metadata': 'turn-metadata', 'X-Codex-Routing-Hint': 'stale',
        'X-OpenAI-Internal-Codex-Responses-Lite': 'true', 'User-Agent': 'caller', Originator: 'caller' },
    }), config, { servingRevision: 26 });
    const body = await response.text();
    await accessLogWriter.flush();
    return { status: response.status, headers: response.headers, body, upstreamBody, upstreamCalls, controlCalls,
      activeRequests: runtime.getActiveRequestCount(serviceName, endpointId),
      healthFailures: runtime.runtimeState.get(serviceName)?.upstreams.map(upstream => upstream.consecutive_failures) };
  } finally {
    accessLogWriter.getDatabase().query('DELETE FROM access_logs WHERE path = ?').run(routeId);
    runtime.runtimeState.clear(); setScopedPluginRegistry(null); setPluginRegistry(null); setBoundControlClientProvider(null);
    await registry.destroy(); global.fetch = originalFetch;
  }
}

describe('ChatGPT OAuth request handler integration', () => {
  for (const combined of [false, true]) {
    test(`standalone search preserves JSON bytes through managed ${combined ? 'combined' : 'upstream'} scopes`, async () => {
      const result = await forwardSearch({ combined });
      expect(result.status).toBe(200);
      expect(result.body).toBe(result.upstreamBody);
      expect(result.headers.get('content-type')).toBe('application/json');
      expect(result.headers.get('x-request-id')).toBe('search-response');
      expect(result.controlCalls).toEqual(['getCredential']);
      expect(result.upstreamCalls).toHaveLength(1);
      const sent = result.upstreamCalls[0]!;
      expect(sent.url).toBe('https://chatgpt.com' + CODEX_SEARCH_PATH + '?request=search');
      expect(sent.method).toBe('POST');
      expect(sent.body).toBe(searchBody);
      expect(sent.headers.get('authorization')).toBe('Bearer fixture-search-token');
      expect(sent.headers.get('chatgpt-account-id')).toBe('fixture-search-account');
      expect(sent.headers.get('accept')).toBe('application/json');
      expect(sent.headers.get('content-type')).toBe('application/json');
      expect(sent.headers.get('user-agent')).toBe(CODEX_RESPONSES_USER_AGENT);
      expect(sent.headers.get('originator')).toBe('codex-tui');
      expect(sent.headers.get('x-codex-turn-metadata')).toBe('turn-metadata');
      for (const header of ['cookie', 'x-codex-routing-hint', 'x-openai-internal-codex-responses-lite']) expect(sent.headers.has(header)).toBe(false);
      expect(result.activeRequests).toBe(0);
    });
  }

  for (const status of [200, 400, 401, 429, 503]) {
    test(`native standalone search preserves upstream ${status} and existing credential handling`, async () => {
      const result = await forwardSearch({ entry: CODEX_SEARCH_PATH, status });
      expect(result.status).toBe(status);
      expect(result.body).toBe(result.upstreamBody);
      expect(result.upstreamCalls).toHaveLength(1);
      expect(result.controlCalls).toEqual(status === 401 ? ['getCredential', 'rejectAccess'] : ['getCredential']);
      expect(result.headers.get('x-request-id')).toBe('search-response');
      if (status === 429) expect(result.headers.get('retry-after')).toBe('7');
      expect(result.activeRequests).toBe(0);
    });
  }

  for (const [name, options] of [
    ['missing prefix rewrite', { rewrite: false }],
    ['unsupported method', { method: 'GET' }],
    ['similar path', { entry: '/alpha/search/extra' }],
    ['other origin', { target: 'https://other.example.test' }],
    ['SIWC source', { target: 'https://api.openai.com', contributionId: 'chatgpt-siwc' }],
  ] as const) {
    test(`standalone search rejects ${name} before acquiring credentials or fetching a sibling`, async () => {
      const result = await forwardSearch({ ...options, failover: true });
      expect(result.status).toBe(503);
      expect(JSON.parse(result.body)).toEqual({ error: 'Service Unavailable' });
      expect(result.controlCalls).toEqual([]);
      expect(result.upstreamCalls).toEqual([]);
      expect(result.healthFailures).toEqual([0, 0]);
      expect(result.activeRequests).toBe(0);
    });
  }

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
