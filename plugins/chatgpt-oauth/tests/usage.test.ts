import { describe, expect, test } from 'bun:test';
import type { ControlHostContext, SecretStore, SecretValue } from '../../../packages/core/src/plugin-control/contracts';
import { AccountStore } from '../server/accounts';
import { createControl } from '../server/control';
import type { CodexTokenSet, FetchLike } from '../server/oauth';
// @ts-expect-error Cross-layer contract test intentionally imports the UI JavaScript parser.
import { accountUsage, resetOutcome } from '../ui/account-model.js';

class FakeSecretStore implements SecretStore {
  readonly namespace = 'usage-test';
  private value: SecretValue | null = null;
  async get(): Promise<SecretValue | null> { return this.value && { ...this.value }; }
  async compareAndSet(_key: string, expected: number | null, value: string): Promise<number> {
    if ((this.value?.version ?? null) !== expected) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    const version = (this.value?.version ?? 0) + 1;
    this.value = { version, value };
    return version;
  }
  async delete(): Promise<void> { this.value = null; }
}

const ACCOUNT = 'acct-a';
const CREDIT = 'credit-a';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

function token(): CodexTokenSet {
  return { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: Date.now() + 3_600_000, identity: { accountId: ACCOUNT }, identityStatus: 'parsed' };
}

function usageBody(planType = 'plus'): Record<string, any> {
  return {
    plan_type: planType,
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_after_seconds: 120 },
      secondary_window: { used_percent: 20, limit_window_seconds: 86_400, reset_at: 1_900_000_000 },
    },
    rate_limit_reset_credits: { available_count: 3 },
  };
}

function creditsBody(availableCount = 3) {
  return {
    available_count: availableCount,
    credits: [{ id: CREDIT, reset_type: 'weekly', status: 'available', granted_at: '2025-01-01T00:00:00Z', title: 'one', expires_at: '2030-01-01T00:00:00Z' }],
  };
}

function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

function expectedWhamHeaders() {
  return {
    Accept: 'application/json',
    Authorization: 'Bearer access-secret',
    'ChatGPT-Account-Id': ACCOUNT,
    'OpenAI-Beta': 'codex-1',
    'OAI-Language': 'zh-CN',
    Originator: 'Codex Desktop',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Dest': 'empty',
    Priority: 'u=4, i',
  };
}

async function setup(fetchImpl: FetchLike, now?: () => number, timeoutMs?: number) {
  const store = new FakeSecretStore();
  const account = await new AccountStore(store).create('A', token());
  const hostController = new AbortController();
  const host: ControlHostContext = { signal: hostController.signal, secretStore: store };
  const control = createControl(host, { fetchImpl, now, timeoutMs });
  return { store, account, control, host, hostController };
}

function api(control: ReturnType<typeof createControl>, handler: string, request: Request, signal = new AbortController().signal): Promise<Response> {
  const declaration = control.api.find((item) => item.handler === handler)!;
  return Promise.resolve(declaration.invoke({ signal, secretStore: (undefined as never), request, requestSignal: signal }));
}

describe('ChatGPT usage control', () => {
  test('cross-layer: UsageService normalized response is accepted by the UI account model contract', async () => {
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === 'POST') return json({ code: 'reset', windows_reset: 2 });
      return String(_input).endsWith('/usage') ? json(usageBody()) : json({
        available_count: 3,
        credits: [{ id: CREDIT, reset_type: 'weekly', status: 'available', granted_at: '2025-01-01T00:00:00Z', title: 'one', description: 'bounded description', expires_at: '2030-01-01T00:00:00Z' }],
      });
    };
    const { account, control } = await setup(fetchImpl);
    const usageResponse = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    const normalized = await usageResponse.json();
    const parsed = accountUsage(normalized);
    expect(parsed.usage.value?.primary).toMatchObject({ usedPercent: 10, windowSeconds: 3600 });
    expect(parsed.usage.value?.availableCount).toBe(3);
    expect(parsed.resetCredits.value?.availableCount).toBe(3);
    expect(parsed.resetCredits.value?.credits[0]).toMatchObject({
      creditId: CREDIT, status: 'available', resetType: 'weekly', title: 'one', description: 'bounded description',
    });
    const resetResponse = await api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    expect(resetOutcome(await resetResponse.json())).toMatchObject({ outcome: 'reset', windowsReset: 2 });
    await control.dispose();
  });

  test('official nullable usage windows are absent without fabricating windows', async () => {
    const readUsage = async (value: unknown) => {
      const fetchImpl: FetchLike = async (_input) => String(_input).endsWith('/usage') ? json(value) : json(creditsBody());
      const { account, control } = await setup(fetchImpl);
      const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
      const body = await response.json();
      await control.dispose();
      return body;
    };

    const explicitWindows = usageBody();
    explicitWindows.rate_limit.primary_window.limit_window_seconds = 18_000;
    explicitWindows.rate_limit.secondary_window.limit_window_seconds = 604_800;
    const both = await readUsage(explicitWindows);
    expect(both.usage).toMatchObject({ state: 'fresh', primary: { windowSeconds: 18_000 }, secondary: { windowSeconds: 604_800 } });

    const secondaryNull = usageBody();
    secondaryNull.rate_limit.secondary_window = null;
    const one = await readUsage(secondaryNull);
    expect(one.usage.state).toBe('fresh');
    expect(one.usage.primary).toBeDefined();
    expect(one.usage.secondary).toBeUndefined();

    const bothNull = usageBody();
    bothNull.rate_limit.primary_window = null;
    bothNull.rate_limit.secondary_window = null;
    const none = await readUsage(bothNull);
    expect(none.usage).toMatchObject({ state: 'fresh', planType: 'plus', allowed: true, availableCount: 3 });
    expect(none.usage.primary).toBeUndefined();
    expect(none.usage.secondary).toBeUndefined();

    const invalid = usageBody();
    invalid.rate_limit.primary_window = 'not-an-object';
    invalid.rate_limit.secondary_window = null;
    const rejected = await readUsage(invalid);
    expect(rejected.usage).toMatchObject({ state: 'unavailable', error: { code: 'invalid_response' } });
  });

  test('uses exact fixed URLs and headers, performs GETs concurrently, and preserves partial data', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.at(-1)!.url.endsWith('/usage') ? json(usageBody()) : json({ error: 'forbidden' }, 403);
    };
    const { account, control } = await setup(fetchImpl);
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    const body = await response.json();
    expect(body.usage.state).toBe('fresh');
    expect(body.resetCredits.state).toBe('unavailable');
    expect(body.usage.primary.resetAt).toBeGreaterThan(0);
    expect(calls.map((call) => call.url).sort()).toEqual([
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
      'https://chatgpt.com/backend-api/wham/usage',
    ]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe('manual');
      expect(call.init?.headers).toEqual(expectedWhamHeaders());
    }
    await control.dispose();
  });

  test('strict query, bounded response, authoritative available_count, and 30 second cache', async () => {
    let now = Date.now();
    let calls = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      calls++;
      if ((init?.headers as Record<string, string>).Accept !== 'application/json') throw new Error('bad headers');
      return json(calls % 2 === 1 ? usageBody() : creditsBody());
    };
    const { account, control } = await setup(fetchImpl, () => now);
    expect((await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}&extra=x`))).status).toBe(400);
    const first = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect((await first.json()).resetCredits.availableCount).toBe(3);
    expect(calls).toBe(2);
    await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect(calls).toBe(2);
    now += 30_001;
    await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect(calls).toBe(4);
    await control.dispose();
  });

  test('one caller may abort without cancelling the host-owned GET', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      calls++;
      await gate;
      return json((init?.method ?? 'GET') === 'GET' && calls % 2 === 1 ? usageBody() : creditsBody());
    };
    const { account, control } = await setup(fetchImpl);
    const firstSignal = new AbortController();
    const first = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`), firstSignal.signal);
    const second = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    firstSignal.abort();
    await expect(first).resolves.toMatchObject({ status: 400 });
    release();
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);
    await control.dispose();
  });

  test('401 rejects access once and does not expose a fresh section', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => { calls++; return new Response('', { status: 401 }); };
    const { account, control, store } = await setup(fetchImpl);
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect(await response.json()).toEqual({ error: 'reauth_required' });
    expect(calls).toBe(2);
    expect((await new AccountStore(store).get(account.id)).status).toBe('reauth_required');
    await control.dispose();
  });

  test('stale-generation 401 is retryable and never reports reauth_required', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl: FetchLike = async () => { await gate; return new Response('', { status: 401 }); };
    const { account, control, store } = await setup(fetchImpl);
    const pending = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new AccountStore(store).rejectAccess(account.id, account.generation);
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'upstream_unavailable' });
    await control.dispose();
  });

  test('expired fresh TTL refresh failure retains same-generation last-good values as stale', async () => {
    let now = Date.now();
    let failed = false;
    const fetchImpl: FetchLike = async (_input, init) => {
      if (failed) throw new Error('offline');
      return String(_input).endsWith('/usage') ? json(usageBody()) : json(creditsBody());
    };
    const { account, control } = await setup(fetchImpl, () => now);
    await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    now += 30_001;
    failed = true;
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    const body = await response.json();
    expect(body.usage).toMatchObject({ state: 'stale', planType: 'plus' });
    expect(body.resetCredits).toMatchObject({ state: 'stale', availableCount: 3 });
    await control.dispose();
  });

  test('generation switch during inflight GET prevents the old result from reaching its caller', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl: FetchLike = async (_input) => {
      const call = ++calls;
      await gate;
      const current = call > 2;
      return String(_input).endsWith('/usage') ? json(usageBody(current ? 'new-generation' : 'old-generation')) : json(creditsBody());
    };
    const { account, control, store } = await setup(fetchImpl);
    const pending = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const accounts = new AccountStore(store);
    const fence = await accounts.reserveRelogin(account.id);
    await accounts.relogin(account.id, token(), fence);
    release();
    const response = await pending;
    expect((await response.json()).usage.planType).toBe('new-generation');
    expect(calls).toBe(4);
    await control.dispose();
  });

  test('late GET after mutation invalidation cannot repopulate the cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl: FetchLike = async (_input) => {
      calls++;
      if (calls <= 2) await gate;
      return String(_input).endsWith('/usage') ? json(usageBody('late-old')) : json(creditsBody());
    };
    const { account, control } = await setup(fetchImpl);
    const pending = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disable = await api(control, 'disableAccount', new Request('http://localhost/accounts/disable', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }));
    expect(disable.status).toBe(200);
    release();
    await pending;
    const enable = await api(control, 'enableAccount', new Request('http://localhost/accounts/enable', { method: 'POST', body: JSON.stringify({ accountRef: account.id }) }));
    expect(enable.status).toBe(200);
    const fresh = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect((await fresh.json()).usage.planType).toBe('late-old');
    expect(calls).toBe(4);
    await control.dispose();
  });

  test('host disposal stops waiting and does not fall back to global fetch', async () => {
    const fetchImpl: FetchLike = async () => await new Promise<Response>(() => undefined);
    const { account, control, hostController } = await setup(fetchImpl);
    const pending = api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    await new Promise((resolve) => setTimeout(resolve, 0));
    hostController.abort();
    await expect(pending).resolves.toMatchObject({ status: 409 });
    await control.dispose();
  });

  test('GET and POST response limits are enforced without content-type gating', async () => {
    let post = false;
    let getCancelled = false;
    const tooLarge = JSON.stringify(usageBody()) + 'x'.repeat(256 * 1024);
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(tooLarge)); },
      cancel() { getCancelled = true; },
    });
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === 'POST') {
        post = true;
        return new Response(JSON.stringify({ code: 'success' }) + 'x'.repeat(64 * 1024), { status: 200 });
      }
      return String(_input).endsWith('/usage') ? new Response(oversized, { status: 200 }) : json(creditsBody());
    };
    const { account, control } = await setup(fetchImpl);
    const get = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect((await get.json()).usage).toMatchObject({ state: 'unavailable', error: { code: 'invalid_response' } });
    expect(getCancelled).toBe(true);
    const reset = await api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    expect(await reset.json()).toMatchObject({ outcome: 'reset_outcome_unknown', usage: { usage: { state: 'unavailable' } } });
    expect(post).toBe(true);
    await control.dispose();
  });

  test('3xx fails under manual redirect and rate limits preserve only legal Retry-After', async () => {
    let cancelled = 0;
    const errorBody = () => new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
      cancel() { cancelled++; },
    });
    const redirect = await setup(async () => new Response(errorBody(), { status: 302, headers: { location: 'https://chatgpt.com/elsewhere' } }));
    const redirectResponse = await api(redirect.control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${redirect.account.id}`));
    expect((await redirectResponse.json()).usage.error).toEqual({ code: 'upstream_unavailable' });
    await redirect.control.dispose();

    const limited = await setup(async () => new Response(errorBody(), { status: 429, headers: { 'retry-after': '3' } }));
    const limitedResponse = await api(limited.control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${limited.account.id}`));
    expect((await limitedResponse.json()).usage.error).toEqual({ code: 'rate_limited', retryAfterSeconds: 3 });
    expect(cancelled).toBe(4);
    await limited.control.dispose();
  });

  test('nullable official optional credit fields are omitted and nullable usage summary is absent', async () => {
    const fetchImpl: FetchLike = async (_input) => String(_input).endsWith('/usage')
      ? json({ ...usageBody(), rate_limit_reset_credits: null })
      : json({ available_count: 1, credits: [
        { id: CREDIT, reset_type: 'weekly', status: 'available', granted_at: '2025-01-01T00:00:00Z', expires_at: null, title: null, description: null },
        { id: `${CREDIT}-empty`, reset_type: 'weekly', status: 'available', granted_at: '2025-01-01T00:00:00Z', expires_at: null, title: '', description: '' },
      ] });
    const { account, control } = await setup(fetchImpl);
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    const body = await response.json();
    expect(body.usage.availableCount).toBeUndefined();
    expect(body.resetCredits.credits[0]).not.toHaveProperty('expiresAt');
    expect(body.resetCredits.credits[0]).not.toHaveProperty('title');
    expect(body.resetCredits.credits[0]).not.toHaveProperty('description');
    expect(body.resetCredits.credits[1]).not.toHaveProperty('expiresAt');
    expect(body.resetCredits.credits[1]).not.toHaveProperty('title');
    expect(body.resetCredits.credits[1]).not.toHaveProperty('description');
    await control.dispose();
  });

  test('rejectAccess exceptions never become reauth_required', async () => {
    const fetchImpl: FetchLike = async () => new Response('', { status: 401 });
    const { account, control } = await setup(fetchImpl);
    const internals = control as unknown as { accounts: { rejectAccess: () => Promise<never> } };
    internals.accounts.rejectAccess = async () => { throw new Error('test reject failure'); };
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect(await response.json()).toEqual({ error: 'upstream_unavailable' });
    await control.dispose();
  });

  test('timeout aborts non-cooperative fake fetches', async () => {
    const controllerSignals: AbortSignal[] = [];
    const slow: FetchLike = async (_input, init) => {
      controllerSignals.push(init?.signal as AbortSignal);
      return await new Promise<Response>(() => undefined);
    };
    const { account, control } = await setup(slow, undefined, 5);
    const response = await api(control, 'getAccountUsage', new Request(`http://localhost/accounts/usage?accountRef=${account.id}`));
    expect((await response.json()).usage.error).toEqual({ code: 'timeout' });
    expect(controllerSignals.every((signal) => signal.aborted)).toBe(true);
    await control.dispose();
  });

  test('consume sends one exact POST, shares same key, and rejects another key while busy', async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const calls: Array<{ method: string; url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input), init });
      if (init?.method === 'POST') { await postGate; return json({ code: 'reset', windows_reset: 1 }); }
      return String(input).endsWith('/usage') ? json(usageBody()) : json(creditsBody());
    };
    const { account, control } = await setup(fetchImpl);
    const request = (id = REQUEST_ID, credit = CREDIT) => api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: id, creditId: credit }) }));
    const first = request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const same = request();
    const other = await request('123e4567-e89b-42d3-a456-426614174001', 'other');
    expect(await other.json()).toEqual({ error: 'reset_in_progress' });
    releasePost();
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    expect(await firstResponse.json()).toMatchObject({ outcome: 'reset', windowsReset: 1 });
    await expect(same).resolves.toMatchObject({ status: 200 });
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
    expect(posts[0].init?.headers).toEqual({
      ...expectedWhamHeaders(),
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ redeem_request_id: REQUEST_ID, credit_id: CREDIT });
    await control.dispose();
  });

  test('provider reset codes normalize exactly and windows_reset is an integer', async () => {
    for (const code of ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const) {
      const fetchImpl: FetchLike = async (_input, init) => {
        if (init?.method === 'POST') return json({ code, windows_reset: 2 });
        return String(_input).endsWith('/usage') ? json(usageBody()) : json(creditsBody());
      };
      const { account, control } = await setup(fetchImpl);
      const response = await api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
      expect(await response.json()).toMatchObject({ outcome: code, windowsReset: 2 });
      await control.dispose();
    }
    const legacyAlias = await setup(async (_input, init) => init?.method === 'POST' ? json({ result: 'reset' }) : json(String(_input).endsWith('/usage') ? usageBody() : creditsBody()));
    const aliasResponse = await api(legacyAlias.control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: legacyAlias.account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    expect(await aliasResponse.json()).toMatchObject({ outcome: 'reset_outcome_unknown', windowsReset: 0 });
    await legacyAlias.control.dispose();

    const nullableWindow = await setup(async (_input, init) => init?.method === 'POST' ? json({ code: 'reset', windows_reset: null }) : json(String(_input).endsWith('/usage') ? usageBody() : creditsBody()));
    const nullableResponse = await api(nullableWindow.control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: nullableWindow.account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    expect(await nullableResponse.json()).toMatchObject({ outcome: 'reset', windowsReset: 0 });
    await nullableWindow.control.dispose();
  });

  test('unknown consume outcome keeps the same key and credit for explicit retry', async () => {
    let posts = 0;
    const bodies: unknown[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === 'POST') { posts++; bodies.push(JSON.parse(String(init.body))); return new Response('bad', { status: 503 }); }
      return String(_input).endsWith('/usage') ? json(usageBody()) : json(creditsBody(1));
    };
    const { account, control } = await setup(fetchImpl);
    const request = () => api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    expect(await (await request()).json()).toMatchObject({ outcome: 'reset_outcome_unknown', usage: { usage: { state: 'fresh' } } });
    expect(await (await request()).json()).toMatchObject({ outcome: 'reset_outcome_unknown', usage: { usage: { state: 'fresh' } } });
    expect(posts).toBe(2);
    expect(bodies[0]).toEqual(bodies[1]);
    await control.dispose();
  });

  test('same-key unknown retry skips eligibility and converges after the credit disappears', async () => {
    let posts = 0;
    let gets = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === 'POST') {
        posts++;
        return posts === 1 ? new Response('', { status: 503 }) : json({ code: 'already_redeemed' });
      }
      if (String(_input).endsWith('/usage')) return json(usageBody());
      gets++;
      return json(gets === 1
        ? creditsBody(1)
        : { available_count: 0, credits: [{ id: CREDIT, reset_type: 'weekly', status: 'redeemed', granted_at: '2025-01-01T00:00:00Z' }] });
    };
    const { account, control } = await setup(fetchImpl);
    const request = () => api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }));
    await expect((await request()).json()).resolves.toMatchObject({ outcome: 'reset_outcome_unknown', windowsReset: 0 });
    await expect((await request()).json()).resolves.toMatchObject({ outcome: 'already_redeemed', windowsReset: 0 });
    expect(posts).toBe(2);
    expect(gets).toBe(3);
    await control.dispose();
  });

  test('consume caller abort does not stop the host-owned post or unknown refresh', async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    let posts = 0;
    let gets = 0;
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === 'POST') { posts++; await postGate; return new Response('', { status: 503 }); }
      gets++;
      return String(_input).endsWith('/usage') ? json(usageBody()) : json(creditsBody());
    };
    const { account, control } = await setup(fetchImpl);
    const caller = new AbortController();
    const pending = api(control, 'resetAccountUsage', new Request('http://localhost/accounts/usage/reset', { method: 'POST', body: JSON.stringify({ accountRef: account.id, redeemRequestId: REQUEST_ID, creditId: CREDIT }) }), caller.signal);
    while (posts === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort();
    await expect(pending).resolves.toMatchObject({ status: 400 });
    releasePost();
    while (gets < 4) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts).toBe(1);
    expect(gets).toBe(4);
    await control.dispose();
  });
});
