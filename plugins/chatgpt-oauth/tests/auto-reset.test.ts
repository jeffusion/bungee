import { describe, expect, test } from 'bun:test';
import type { SecretStore, SecretValue, PluginControl, ControlHostContext } from '../../../packages/core/src/plugin-control/contracts';
import { AccountStore } from '../server/accounts';
import { AUTO_RESET_LEAD_MS, AUTO_RESET_INTERVAL_MS, isAutoResetDue, type AutoResetTimer } from '../server/auto-reset';
import { createControl } from '../server/control';
import type { FetchLike } from '../server/oauth';
import type { ResetCredit } from '../server/usage';

// All identities, credentials, storage and upstream responses in this file are invented.
const NOW = 1_900_000_000_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const credit = (id = 'simulation-credit', expiresAt: number | undefined = NOW + AUTO_RESET_LEAD_MS): ResetCredit => ({
  id, resetType: 'codex_rate_limits', status: 'available', grantedAt: NOW - 86400_000, expiresAt,
});

class MemoryStore implements SecretStore {
  readonly namespace = 'simulation-only';
  value: SecretValue | null = null;
  async get() { return this.value && { ...this.value }; }
  async compareAndSet(_key: string, expected: number | null, value: string) {
    if ((this.value?.version ?? null) !== expected) throw Object.assign(new Error('conflict'), { code: 'version_conflict' });
    const version = (this.value?.version ?? 0) + 1;
    this.value = { value, version };
    return version;
  }
  async delete() { this.value = null; }
}

class VirtualTimer implements AutoResetTimer {
  nextId = 0;
  tasks = new Map<number, { callback: () => Promise<void>; delay: number; at: number }>();
  constructor(private readonly now: () => number = () => NOW) {}
  schedule(callback: () => Promise<void>, delay: number) { const id = ++this.nextId; this.tasks.set(id, { callback, delay, at: this.now() + delay }); return id; }
  cancel(handle: unknown) { this.tasks.delete(handle as number); }
  async fire(delay?: number) {
    const [id, task] = [...this.tasks.entries()].filter(([, task]) => delay === undefined || task.delay === delay)
      .sort((a, b) => a[1].at - b[1].at)[0] ?? [];
    if (!task) throw new Error('no scheduled simulation tick');
    this.tasks.delete(id);
    await task.callback();
  }
}

async function setup(enabled = true) {
  let now = NOW;
  let credits = [credit()];
  let creditStatus = 200;
  let outcome = 'reset';
  let onGetCredits: (() => void | Promise<void>) | undefined;
  let onPost: (() => Promise<void>) | undefined;
  const posts: { credit_id: string; redeem_request_id: string }[] = [];
  const requests: string[] = [];
  const store = new MemoryStore();
  const accounts = new AccountStore(store);
  const account = await accounts.create('Simulation account', { accessToken: 'simulation-access', refreshToken: 'simulation-refresh',
    identity: { accountId: 'simulation-account', email: 'simulation@example.test' }, identityStatus: 'parsed', expiresAt: NOW + 86400_000 });
  if (enabled) await accounts.setAutoResetCredits(account.id, true);
  const fetchImpl: FetchLike = async (input, init) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer simulation-access');
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      if (onPost) await onPost();
      return json({ code: outcome, windows_reset: 1 });
    }
    if (path.endsWith('/usage')) return json({ rate_limit: { allowed: true, primary_window: {
      used_percent: 50, limit_window_seconds: 18000, reset_after_seconds: 3600,
    } } });
    if (!path.endsWith('/rate-limit-reset-credits')) throw new Error('Unexpected simulation endpoint');
    await onGetCredits?.();
    return json({ available_count: credits.filter(item => item.status === 'available').length,
      credits: credits.map(item => ({ id: item.id, reset_type: item.resetType, status: item.status,
        granted_at: new Date(item.grantedAt).toISOString(), expires_at: item.expiresAt === undefined ? null : new Date(item.expiresAt).toISOString() })) }, creditStatus);
  };
  const host = new AbortController();
  const controls: PluginControl[] = [];
  const restart = async () => {
    for (const item of controls) await item.dispose();
    const timer = new VirtualTimer(() => now);
    const control = createControl({ signal: host.signal, secretStore: store } as ControlHostContext,
      { fetchImpl, now: () => now, autoResetTimer: timer });
    controls.push(control);
    await control.start();
    return { control, timer };
  };
  const initial = await restart();
  return { ...initial, accounts, account, store, requests, posts, host, restart,
    setNow: (value: number) => { now = value; }, setCredits: (value: ResetCredit[]) => { credits = value; },
    setCreditStatus: (value: number) => { creditStatus = value; }, setOutcome: (value: string) => { outcome = value; },
    onGetCredits: (callback: () => void | Promise<void>) => { onGetCredits = callback; },
    onPost: (callback: () => Promise<void>) => { onPost = callback; },
    dispose: async () => { for (const item of controls) await item.dispose(); },
  };
}

async function invoke(control: PluginControl, handler: string, body?: unknown): Promise<Response> {
  const signal = new AbortController().signal;
  const request = new Request('https://simulation.example.test/control', body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  return control.api.find(item => item.handler === handler)!.invoke({ request, requestSignal: signal, signal } as never);
}

describe('automatic reset, simulation only', () => {
  test('five-minute discovery does not poll between scans or delay a known deadline', async () => {
    const s = await setup();
    try {
      expect(AUTO_RESET_INTERVAL_MS).toBe(300_000);
      s.setCredits([credit('scheduled', NOW + AUTO_RESET_LEAD_MS + 120_000)]);
      await s.timer.fire();
      expect(s.requests).toHaveLength(2);
      expect([...s.timer.tasks.values()].map(task => task.delay).sort((a, b) => a - b)).toEqual([120_000, 300_000]);
      s.setNow(NOW + 30_000);
      expect(s.posts).toHaveLength(0);
      expect(s.requests).toHaveLength(2);
      s.setNow(NOW + 120_000);
      await s.timer.fire();
      expect(s.posts.map(post => post.credit_id)).toEqual(['scheduled']);
      expect([...s.timer.tasks.values()].map(task => task.at)).toEqual([NOW + 300_000]);
    } finally { await s.dispose(); }
  });

  test('idle discovery makes only 24 queries per hour, excluding startup', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('far-future', NOW + AUTO_RESET_LEAD_MS + 7200_000)]);
      await s.timer.fire();
      for (let i = 1; i <= 12; i++) {
        s.setNow(NOW + i * AUTO_RESET_INTERVAL_MS);
        await s.timer.fire();
      }
      expect(s.requests).toHaveLength(26);
      expect(s.posts).toHaveLength(0);
    } finally { await s.dispose(); }
  });

  test('fresh discovery replaces changed expiries and cancelled callbacks cannot revive old plans', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('changing', NOW + AUTO_RESET_LEAD_MS + 600_000)]);
      await s.timer.fire();
      const old = [...s.timer.tasks.values()].find(task => task.delay === 600_000)!;
      s.setNow(NOW + AUTO_RESET_INTERVAL_MS);
      s.setCredits([credit('changing', NOW + AUTO_RESET_LEAD_MS + 900_000)]);
      await s.timer.fire();
      const requestCount = s.requests.length;
      s.setNow(NOW + 600_000);
      await old.callback();
      expect(s.requests).toHaveLength(requestCount);
      expect(s.posts).toHaveLength(0);
      await s.timer.fire(AUTO_RESET_INTERVAL_MS);
      s.setNow(NOW + 900_000);
      await s.timer.fire(300_000);
      expect(s.posts.map(post => post.credit_id)).toEqual(['changing']);
    } finally { await s.dispose(); }
  });

  test('removing a card cancels its deadline; turning automation off stops a queued deadline without upstream calls', async () => {
    for (const change of ['remove', 'disable'] as const) {
      const s = await setup();
      try {
        s.setCredits([credit('future', NOW + AUTO_RESET_LEAD_MS + 600_000)]);
        await s.timer.fire();
        const deadline = [...s.timer.tasks.values()].find(task => task.delay === 600_000)!;
        if (change === 'remove') {
          s.setCredits([]);
          s.setNow(NOW + AUTO_RESET_INTERVAL_MS);
          await s.timer.fire();
          expect([...s.timer.tasks.values()].some(task => task.at === NOW + 600_000 && task.delay === 600_000)).toBe(false);
        } else await s.accounts.setAutoResetCredits(s.account.id, false);
        const requestCount = s.requests.length;
        s.setNow(NOW + 600_000);
        await deadline.callback();
        expect(s.requests).toHaveLength(requestCount);
        expect(s.posts).toHaveLength(0);
      } finally { await s.dispose(); }
    }
  });

  test('a late deadline skips an expired card and disposal cancels both timer kinds', async () => {
    for (const disposed of [false, true]) {
      const s = await setup();
      try {
        s.setCredits([credit('future', NOW + AUTO_RESET_LEAD_MS + 60_000)]);
        await s.timer.fire();
        expect(s.timer.tasks.size).toBe(2);
        const deadline = [...s.timer.tasks.values()].find(task => task.delay === 60_000)!;
        const requestCount = s.requests.length;
        if (disposed) { await s.control.dispose(); expect(s.timer.tasks.size).toBe(0); }
        s.setNow(NOW + AUTO_RESET_LEAD_MS + 60_000);
        await deadline.callback();
        expect(s.posts).toHaveLength(0);
        expect(s.requests).toHaveLength(requestCount);
      } finally { await s.dispose(); }
    }
  });

  test('a failed discovery preserves a known deadline and consumption still validates fresh credits', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('known', NOW + AUTO_RESET_LEAD_MS + 360_000)]);
      await s.timer.fire();
      s.setCreditStatus(503);
      s.setNow(NOW + AUTO_RESET_INTERVAL_MS);
      await s.timer.fire();
      expect([...s.timer.tasks.values()].some(task => task.at === NOW + 360_000)).toBe(true);
      s.setCreditStatus(200);
      s.setNow(NOW + 360_000);
      await s.timer.fire();
      expect(s.posts.map(post => post.credit_id)).toEqual(['known']);
    } finally { await s.dispose(); }
  });

  test('long expiries use a bounded native timer delay', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('long-lived', NOW + 40 * 86400_000)]);
      await s.timer.fire();
      expect([...s.timer.tasks.values()].map(task => task.delay).sort((a, b) => a - b)).toEqual([AUTO_RESET_INTERVAL_MS, 2_147_483_647]);
      expect(s.posts).toHaveLength(0);
    } finally { await s.dispose(); }
  });

  test('discovery during an owned POST preserves the next card deadline', async () => {
    const s = await setup();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let time = NOW;
    const postTimes: number[] = [];
    try {
      s.setCredits([credit('first', NOW + AUTO_RESET_LEAD_MS + 299_000), credit('next', NOW + AUTO_RESET_LEAD_MS + 302_000)]);
      s.onPost(async () => {
        postTimes.push(time);
        if (s.posts.length === 1) { started(); await held; }
      });
      await s.timer.fire();
      time = NOW + 299_000; s.setNow(time);
      const redeeming = s.timer.fire();
      await entered;
      time = NOW + 300_000; s.setNow(time);
      await s.timer.fire();
      time = NOW + 301_000; s.setNow(time);
      release(); await redeeming;
      expect([...s.timer.tasks.values()].some(task => task.at === NOW + 302_000)).toBe(true);
      time = NOW + 302_000; s.setNow(time);
      await s.timer.fire();
      expect(s.posts.map(post => post.credit_id)).toEqual(['first', 'next']);
      expect(postTimes).toEqual([NOW + 299_000, NOW + 302_000]);
    } finally { release?.(); await s.dispose(); }
  });

  test('fresh validation reschedules a delayed expiry while preserving other cards', async () => {
    const s = await setup();
    try {
      const other = credit('other', NOW + AUTO_RESET_LEAD_MS + 150_000);
      s.setCredits([credit('changed', NOW + AUTO_RESET_LEAD_MS + 120_000), other]);
      let gets = 0;
      s.onGetCredits(() => {
        if (++gets === 2) s.setCredits([credit('changed', NOW + AUTO_RESET_LEAD_MS + 180_000), other]);
      });
      await s.timer.fire();
      s.setNow(NOW + 120_000);
      await s.timer.fire();
      expect(s.posts).toHaveLength(0);
      expect((await s.accounts.list())[0].pendingAutoReset).toBeUndefined();
      expect([...s.timer.tasks.values()].some(task => task.at === NOW + 150_000)).toBe(true);
      s.setNow(NOW + 150_000);
      await s.timer.fire();
      expect(s.posts.map(post => post.credit_id)).toEqual(['other']);
      expect([...s.timer.tasks.values()].some(task => task.at === NOW + 180_000)).toBe(true);
      s.setNow(NOW + 180_000);
      await s.timer.fire();
      expect(s.posts.map(post => post.credit_id)).toEqual(['other', 'changed']);
    } finally { await s.dispose(); }
  });

  test('exact threshold, expired cards, unknown dates and unavailable states', () => {
    expect(isAutoResetDue(credit(), NOW - 1)).toBe(false);
    expect(isAutoResetDue(credit(), NOW)).toBe(true);
    expect(isAutoResetDue(credit(), NOW + AUTO_RESET_LEAD_MS)).toBe(false);
    expect(isAutoResetDue({ ...credit(), expiresAt: undefined }, NOW)).toBe(false);
    expect(isAutoResetDue({ ...credit(), expiresAt: NaN }, NOW)).toBe(false);
    for (const status of ['redeeming', 'redeemed', 'unknown'] as const) expect(isAutoResetDue({ ...credit(), status }, NOW)).toBe(false);
  });

  test('old and new accounts default off; starting control makes no upstream requests', async () => {
    const s = await setup(false);
    try {
      expect((await s.accounts.list())[0].autoResetCredits).toBe(false);
      await s.timer.fire();
      expect(s.requests).toEqual([]);
      expect([...s.timer.tasks.values()][0].delay).toBe(AUTO_RESET_INTERVAL_MS);
    } finally { await s.dispose(); }
  });

  test('uses the card at 30 minutes, once across polling and restart, without a browser', async () => {
    const s = await setup();
    try {
      s.setNow(NOW - 1);
      await s.timer.fire();
      expect(s.posts).toHaveLength(0);
      s.setNow(NOW);
      await s.timer.fire();
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0].credit_id).toBe('simulation-credit');
      expect(s.posts[0].redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
      await s.timer.fire();
      const next = await s.restart();
      await next.timer.fire();
      expect(s.posts).toHaveLength(1);
    } finally { await s.dispose(); }
  });

  test('catches up inside the window; sorts due cards; skips expired, undated and redeemed cards', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('later', NOW + 100_000), credit('earliest', NOW + 10_000), credit('expired', NOW),
        { ...credit('undated'), expiresAt: undefined }, credit('future', NOW + AUTO_RESET_LEAD_MS + 1),
        { ...credit('redeemed'), status: 'redeemed' }]);
      await s.timer.fire();
      expect(s.posts.map(item => item.credit_id)).toEqual(['earliest', 'later']);
    } finally { await s.dispose(); }
  });

  test('disabled and reauthentication accounts cannot redeem', async () => {
    for (const status of ['disabled', 'reauth_required', 'revoked'] as const) {
      const s = await setup();
      try {
        await s.accounts.setStatus(s.account.id, status);
        await s.timer.fire();
        expect(s.requests).toEqual([]);
      } finally { await s.dispose(); }
    }
  });

  test('a stale credits response cannot authorize automatic consumption', async () => {
    const s = await setup();
    try {
      s.setCredits([credit('future', NOW + AUTO_RESET_LEAD_MS + 100_000)]);
      await s.timer.fire();
      s.setNow(NOW + 100_000);
      s.setCreditStatus(503);
      await s.timer.fire();
      expect(s.posts).toHaveLength(0);
    } finally { await s.dispose(); }
  });

  test('rechecks expiry and enabled setting immediately before POST', async () => {
    for (const change of ['expire', 'disable', 'remove'] as const) {
      const s = await setup();
      try {
        let gets = 0;
        s.onGetCredits(async () => {
          if (++gets !== 2) return;
          if (change === 'expire') s.setNow(NOW + AUTO_RESET_LEAD_MS);
          if (change === 'disable') await s.accounts.setAutoResetCredits(s.account.id, false);
          if (change === 'remove') s.setCredits([]);
        });
        await s.timer.fire();
        expect(s.posts).toHaveLength(0);
        expect((await s.accounts.list())[0].pendingAutoReset).toBeUndefined();
      } finally { await s.dispose(); }
    }
  });

  test('atomic persistent claims allow only one scheduler to POST', async () => {
    const s = await setup();
    const otherTimer = new VirtualTimer();
    const other = createControl({ signal: s.host.signal, secretStore: s.store } as ControlHostContext, {
      now: () => NOW, autoResetTimer: otherTimer,
      fetchImpl: async (_url, init) => {
        if (init?.method === 'POST') { s.posts.push(JSON.parse(String(init.body))); return json({ code: 'reset', windows_reset: 1 }); }
        return String(_url).endsWith('/usage') ? json({ allowed: true }) : json({ available_count: 1, credits: [{
          id: 'simulation-credit', reset_type: 'codex_rate_limits', status: 'available', granted_at: NOW,
          expires_at: NOW + AUTO_RESET_LEAD_MS,
        }] });
      },
    });
    try {
      await other.start();
      await Promise.all([s.timer.fire(), otherTimer.fire()]);
      expect(s.posts).toHaveLength(1);
    } finally { await other.dispose(); await s.dispose(); }
  });

  test('unknown outcome persists and never retries automatically; explicit retry reuses request ID', async () => {
    const s = await setup();
    try {
      s.setOutcome('unexpected');
      await s.timer.fire();
      const pending = (await s.accounts.list())[0].pendingAutoReset!;
      expect(pending.redeemRequestId).toBe(s.posts[0].redeem_request_id);
      const next = await s.restart();
      await next.timer.fire();
      expect(s.posts).toHaveLength(1);
      const unrelated = await invoke(next.control, 'resetAccountUsage', { accountRef: s.account.id,
        creditId: pending.creditId, redeemRequestId: '123e4567-e89b-42d3-a456-426614174000' });
      expect(unrelated.status).toBe(409);
      s.setOutcome('already_redeemed');
      const retry = await invoke(next.control, 'resetAccountUsage', { accountRef: s.account.id,
        creditId: pending.creditId, redeemRequestId: pending.redeemRequestId });
      expect(retry.status).toBe(200);
      expect(s.posts[1]).toEqual(s.posts[0]);
      expect((await s.accounts.list())[0].pendingAutoReset).toBeUndefined();
      await next.timer.fire();
      expect(s.posts).toHaveLength(2);
    } finally { await s.dispose(); }
  });

  test('pending crash claim is preserved across restart', async () => {
    const s = await setup();
    try {
      await s.accounts.claimAutoReset(s.account.id, credit(), NOW);
      const next = await s.restart();
      await next.timer.fire();
      expect(s.requests).toEqual([]);
      expect((await s.accounts.list())[0].pendingAutoReset).toBeDefined();
    } finally { await s.dispose(); }
  });

  test('manual unknown outcome also blocks automatic retry after restart', async () => {
    const s = await setup();
    try {
      s.setOutcome('unexpected');
      const response = await invoke(s.control, 'resetAccountUsage', { accountRef: s.account.id,
        creditId: 'simulation-credit', redeemRequestId: '123e4567-e89b-42d3-a456-426614174000' });
      expect((await response.json()).outcome).toBe('reset_outcome_unknown');
      const next = await s.restart();
      await next.timer.fire();
      expect(s.posts).toHaveLength(1);
      expect((await s.accounts.list())[0].pendingAutoReset?.redeemRequestId).toBe(s.posts[0].redeem_request_id);
    } finally { await s.dispose(); }
  });

  test('manual pre-POST crash fence survives restart even without a card expiry', async () => {
    const s = await setup();
    try {
      await s.accounts.recordResetAttempt(s.account.id, '123e4567-e89b-42d3-a456-426614174000', { ...credit(), expiresAt: undefined }, NOW);
      const next = await s.restart();
      await next.timer.fire();
      expect(s.requests).toEqual([]);
      expect((await s.accounts.list())[0].pendingAutoReset?.expiresAt).toBeUndefined();
    } finally { await s.dispose(); }
  });

  test('manual reset and automatic reset cannot send competing POSTs', async () => {
    const s = await setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    try {
      s.onPost(async () => { started(); await held; });
      const manual = invoke(s.control, 'resetAccountUsage', { accountRef: s.account.id,
        creditId: 'simulation-credit', redeemRequestId: '123e4567-e89b-42d3-a456-426614174000' });
      await entered;
      await s.timer.fire();
      expect(s.posts).toHaveLength(1);
      release();
      await manual;
    } finally { release?.(); await s.dispose(); }
  });

  test('strict settings API persists boolean and redacts credentials', async () => {
    const s = await setup(false);
    try {
      for (const enabled of ['true', 1, null]) {
        expect((await invoke(s.control, 'setAutoResetCredits', { accountRef: s.account.id, enabled })).status).toBe(400);
      }
      expect((await invoke(s.control, 'setAutoResetCredits', { accountRef: s.account.id, enabled: true, extra: 1 })).status).toBe(400);
      const response = await invoke(s.control, 'setAutoResetCredits', { accountRef: s.account.id, enabled: true });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"autoResetCredits":true');
      expect(body).not.toContain('simulation-access');
      expect(body).not.toContain('simulation-refresh');
      expect((await s.accounts.list())[0].autoResetCredits).toBe(true);
    } finally { await s.dispose(); }
  });

  test('dispose and host abort clear timers and prevent further traffic', async () => {
    for (const abort of [false, true]) {
      const s = await setup();
      if (abort) s.host.abort(); else await s.control.dispose();
      expect(s.timer.tasks.size).toBe(0);
      expect(s.requests).toEqual([]);
      await s.dispose();
    }
  });
});
