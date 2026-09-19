import { afterEach, beforeEach, expect, test } from 'bun:test';
import { get } from 'svelte/store';
import { createPublicationRecoveryStore, publicationRetryKey, unresolvedPublication } from './runtime';
import { configurationRuntimeFixture, publicationFixture } from '../../tests/fixtures/publication';

const originalFetch = globalThis.fetch;
const originals = new Map(['sessionStorage', 'localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
let unsubscribe = () => {};
let runtime = configurationRuntimeFixture();
let requests: Array<{ path: string; body: any; signal?: AbortSignal | null }>;
let post: (body: any) => Response | Promise<Response>;
const memory = new Map<string, string>();
const storage = { getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); }, removeItem: (key: string) => { memory.delete(key); } };

beforeEach(() => {
  memory.clear(); requests = []; runtime = configurationRuntimeFixture();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  post = () => Response.json({ error: 'recovery_unavailable' }, { status: 503 });
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path: input, body, signal: init?.signal });
    return init?.method === 'POST' ? post(body) : Response.json(runtime);
  }) as typeof fetch;
});
afterEach(() => {
  unsubscribe(); globalThis.fetch = originalFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function start() {
  const store = createPublicationRecoveryStore();
  unsubscribe = store.subscribe(() => {});
  await store.refresh();
  return store;
}
const retryKey = () => publicationRetryKey(runtime.publication.operation!.operation_id, runtime.publication.target_revision);

test('stopped → exact retry body → 202 running → terminal hides; duplicate click is blocked', async () => {
  const store = await start();
  let accept!: () => void;
  post = body => new Promise(resolve => { accept = () => {
    const recovery = { ...runtime.publication.recovery!, recovery_id: body.request_id, state: 'running' as const,
      trigger: 'manual' as const, attempt_count: 1, final_reason_code: null };
    runtime = configurationRuntimeFixture(publicationFixture({ recovery, retryable: false }));
    resolve(Response.json(recovery, { status: 202 }));
  }; });
  expect(unresolvedPublication(get(store).publication)).toBe(true);
  const pending = store.retry();
  await store.retry();
  expect(get(store).pending).toBe(true);
  expect(requests.filter(request => request.body)).toHaveLength(1);
  const request = requests.find(request => request.body)!;
  expect(request.path).toBe(`/__ui/api/config/operations/${runtime.publication.operation!.operation_id}/retry`);
  expect(Object.keys(request.body).sort()).toEqual(['expected_revision', 'request_id']);
  expect(request.body.expected_revision).toBe(8);
  expect(request.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(memory.get(retryKey())).toBe(request.body.request_id);
  accept(); await pending;
  expect(get(store).publication?.recovery?.state).toBe('running');
  expect(memory.has(retryKey())).toBe(false);
  runtime = configurationRuntimeFixture(publicationFixture({ recovery: { ...runtime.publication.recovery!, state: 'succeeded' }, serving_complete: true }));
  await Bun.sleep(1100);
  expect(unresolvedPublication(get(store).publication)).toBe(false);
});

test('503 and network loss retain the same request ID across another store/reload; terminal 200 clears it', async () => {
  let store = await start();
  await store.retry();
  const id = memory.get(retryKey());
  expect(get(store).notice).toBe('unavailable');
  post = () => { throw new TypeError('Failed to fetch'); };
  await store.retry();
  expect(get(store).notice).toBe('failed');
  unsubscribe(); store = await start();
  await store.retry();
  expect(requests.filter(request => request.body).map(request => request.body.request_id)).toEqual([id, id, id]);
  post = () => Response.json({ ...runtime.publication.recovery!, recovery_id: id }, { status: 200 });
  await store.retry();
  expect(memory.has(retryKey())).toBe(false);
});

test('409 in-progress is authoritative even if refresh fails, hides retry and polls at 1s', async () => {
  const store = await start();
  let refreshes = 0;
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ error: 'recovery_in_progress', recovery_id: 'other-recovery', target_revision: 8, state: 'scheduled' }, { status: 409 });
    refreshes++; throw new TypeError('offline');
  }) as typeof fetch;
  await store.retry();
  expect(get(store).accepted).toEqual({ recovery_id: 'other-recovery', target_revision: 8, state: 'scheduled' });
  expect(memory.has(retryKey())).toBe(false);
  await store.retry(); // authoritative scheduled state disallows a second POST
  await Bun.sleep(1100);
  expect(refreshes).toBeGreaterThanOrEqual(2);
});

test('authoritative 409 conflicts clear identity and show mapped text after refreshing', async () => {
  const store = await start();
  for (const [error, notice] of [['revision_conflict', 'conflict'], ['recovery_not_retryable', 'notRetryable']] as const) {
    post = () => Response.json({ error }, { status: 409 });
    await store.retry();
    expect(get(store).notice).toBe(notice);
    expect(memory.has(retryKey())).toBe(false);
  }
});

test('a new target revision never reuses an unresolved request from the previous target', async () => {
  const store = await start();
  await store.retry();
  const previousId = memory.get(retryKey());
  runtime = configurationRuntimeFixture(publicationFixture({ target_revision: 9,
    operation: { ...runtime.publication.operation!, committed_revision: 9 },
    recovery: { ...runtime.publication.recovery!, target_revision: 9 } }));
  await store.refresh(); await store.retry();
  expect(memory.get(retryKey())).not.toBe(previousId);
  expect(requests.filter(request => request.body).map(request => request.body.expected_revision)).toEqual([8, 9]);
});

test('unknown 409 codes use safe rejection copy rather than promising to reuse an acknowledged ID', async () => {
  const store = await start();
  post = () => Response.json({ error: 'private_raw_marker' }, { status: 409 });
  await store.retry();
  expect(get(store).notice).toBe('rejected');
  expect(memory.has(retryKey())).toBe(false);
});

test('401 uses existing auth logout and retains pending identity', async () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '' } } });
  memory.set('bungee_auth_token', 'test-token');
  const store = await start();
  post = () => Response.json({ error: 'unauthorized' }, { status: 401 });
  await store.retry();
  expect(window.location.hash).toBe('#/login');
  expect(memory.has('bungee_auth_token')).toBe(false);
  expect(memory.has(retryKey())).toBe(true);
  expect(get(store).notice).toBe('unauthorized');
});

test('storage failure prevents a non-replayable POST; serving complete and drain-only never retry', async () => {
  const store = await start();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('denied'); } });
  await store.retry();
  expect(get(store).notice).toBe('storage');
  expect(requests.filter(request => request.body)).toHaveLength(0);
  runtime = configurationRuntimeFixture(publicationFixture({ serving_complete: true }));
  await store.refresh(); await store.retry();
  expect(unresolvedPublication(get(store).publication)).toBe(false);
  runtime = configurationRuntimeFixture(publicationFixture({ operation: { ...runtime.publication.operation!, error_code: 'old_worker_drain_failed' } }));
  await store.refresh(); await store.retry();
  expect(requests.filter(request => request.body)).toHaveLength(0);
});

test('unsubscribe aborts in-flight runtime reads and removes scheduled polling', async () => {
  runtime = configurationRuntimeFixture(publicationFixture({ recovery: { ...runtime.publication.recovery!, state: 'running' } }));
  const store = await start();
  const count = requests.length;
  unsubscribe(); await Bun.sleep(1100);
  expect(requests).toHaveLength(count);
  unsubscribe = store.subscribe(() => {});
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    signal = init?.signal as AbortSignal;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;
  const pending = store.refresh(); unsubscribe(); await pending;
  expect(signal?.aborted).toBe(true);
});

test('200 succeeded is only an ACK when runtime refresh fails; the publication stays unresolved', async () => {
  const store = await start();
  post = () => Response.json({ ...runtime.publication.recovery!, state: 'succeeded' }, { status: 200 });
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') return post(null);
    throw new TypeError('offline');
  }) as typeof fetch;

  await store.retry();

  expect(get(store).accepted?.state).toBe('succeeded');
  expect(unresolvedPublication(get(store).publication)).toBe(true);
  expect(get(store).notice).toBe('refreshUnavailable');
});

test('an incomplete degraded publication remains unresolved after recovery succeeds', () => {
  const publication = publicationFixture({
    recovery: { ...runtime.publication.recovery!, state: 'succeeded' },
    serving_complete: false,
  });
  expect(unresolvedPublication(publication)).toBe(true);
});

test('200 stopped ACK blocks a second retry while the runtime refresh is stalled', async () => {
  const store = await start();
  let posts = 0;
  post = () => Response.json({ ...runtime.publication.recovery!, state: 'stopped' }, { status: 200 });
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return post(null); }
    throw new TypeError('offline');
  }) as typeof fetch;

  await store.retry();
  await store.retry();

  expect(posts).toBe(1);
  expect(get(store).accepted?.state).toBe('stopped');
});

test('a retry response updates state while unsubscribed before resubscription', async () => {
  const store = await start();
  let accept!: () => void;
  post = body => new Promise(resolve => { accept = () => resolve(Response.json({
    ...runtime.publication.recovery!, recovery_id: body.request_id, state: 'running',
  }, { status: 202 })); });

  const pending = store.retry();
  unsubscribe();
  accept();
  await pending;
  unsubscribe = store.subscribe(() => {});

  expect(get(store).pending).toBe(false);
  expect(get(store).accepted?.state).toBe('running');
});

test('a new runtime identity clears the old notice and retry key', async () => {
  const store = await start();
  await store.retry();
  const oldKey = retryKey();
  expect(memory.has(oldKey)).toBe(true);

  runtime = configurationRuntimeFixture(publicationFixture({
    target_revision: 9,
    operation: { ...runtime.publication.operation!, operation_id: '10000000-0000-4000-8000-000000000003', committed_revision: 9 },
    recovery: { ...runtime.publication.recovery!, target_revision: 9 },
  }));
  await store.refresh();

  expect(get(store).notice).toBe(null);
  expect(memory.has(oldKey)).toBe(false);
});
