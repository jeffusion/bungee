import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ControlHostContext, ControlApiHandlerContext, PluginControl, ControlPlugin } from '@jeffusion/bungee-core/plugin';
import type { ManagementProvider, ManagementSubject } from '@jeffusion/bungee-core/plugin';
import { isDurableStateConflictError, type DurableJson, type PluginDurableState, type DurableMutation, type DurableRecord } from '@jeffusion/bungee-core/plugin';

interface Administrator { id: string; username: string; disabled: boolean; passwordHash: string; temporary: boolean; generation: number; failureEpoch: number }
interface SessionPolicy { idleTimeoutMinutes: number; absoluteTimeoutMinutes: number }
interface Session { digest: string; administratorId: string; generation: number; created: number; touched: number; transport: 'cookie' | 'bearer'; policy?: SessionPolicy }
interface Failure { key: string; count: number; until: number; epoch: number }
interface Slot<T> { key: string; version: number; value: T | null }
export interface Dependencies { now?: () => number; trustedSource?: (request: Request) => string }
const PROVIDER = 'local-accounts';
const COOKIE = 'bungee_local_session';
const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({ idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480 });
// Chromium caps persistent cookies at 400 days. Verification renews this browser lease,
// never the server-side absolute deadline. Browser/user cleanup remains outside our control.
const COOKIE_LEASE_SECONDS = 400 * 24 * 60 * 60;
const MAX_TIMEOUT_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);
const ALL = ['config.read', 'config.write', 'logs.read', 'logs.body', 'keys.read', 'keys.write', 'plugins.read', 'plugins.toggle', 'plugins.code', 'auth.mode', 'self.password', 'self.logout'];
class AccountError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
function fail(code: string, status = 400): never { throw new AccountError(code, status); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_input'); return v as Record<string, unknown>; }
function exact(v: Record<string, unknown>, fields: string[]) { if (Object.keys(v).some(k => !fields.includes(k))) fail('invalid_input'); }
function username(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(v)) fail('invalid_input'); return v.toLowerCase(); }
function password(v: unknown): string { if (typeof v !== 'string' || [...v].length < 6 || [...v].length > 64) fail('invalid_password'); return v; }
function digest(v: string): string { return createHash('sha256').update(v).digest('hex'); }
function csrf(token: string): string { return createHmac('sha256', token).update('local-accounts/csrf/v1').digest('base64url'); }
function constant(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function dto(m: Administrator) { return { id: m.id, username: m.username, requiresPasswordChange: m.temporary }; }
function json(v: unknown, status = 200, headers: Record<string, string> = {}): Response { return Response.json(v, { status, headers: { 'cache-control': 'no-store', ...headers } }); }
function safe(error: unknown): Response { return error instanceof AccountError ? json({ error: error.code }, error.status) : json({ error: 'provider_unavailable' }, 503); }
async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) fail('invalid_input');
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 8192) { await reader.cancel(); fail('body_limit', 413); } chunks.push(r.value); } }
  finally { reader.releaseLock(); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { if (e instanceof AccountError) throw e; return fail('invalid_input'); }
}
function credentials(request: Request): { token: string; transport: Session['transport'] } | null {
  const auth = request.headers.get('authorization');
  if (auth !== null) { const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth); return m ? { token: m[1]!, transport: 'bearer' } : null; }
  const tokens = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
  if (tokens.length !== 1) return null; const token = tokens[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? { token, transport: 'cookie' } : null;
}
function origin(request: Request, expected?: string) { if (request.headers.get('origin') !== (expected ?? new URL(request.url).origin)) fail('invalid_origin', 403); }
function cookie(request: Request, token: string, maxAge: number, managementOrigin?: string) { return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(managementOrigin ?? request.url).protocol === 'https:' ? '; Secure' : ''}`; }

function validateSessionPolicy(value: unknown, code = 'invalid_session_policy', status = 400): SessionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, status);
  const p = value as SessionPolicy;
  if (Object.keys(p).some(key => !['idleTimeoutMinutes', 'absoluteTimeoutMinutes'].includes(key))
    || ![p.idleTimeoutMinutes, p.absoluteTimeoutMinutes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TIMEOUT_MINUTES)) fail(code, status);
  return { idleTimeoutMinutes: p.idleTimeoutMinutes, absoluteTimeoutMinutes: p.absoluteTimeoutMinutes };
}

// Fixed slots keep expired sessions, logout markers and throttles bounded. Reuse always
// compares the previous version; a stale touch cannot restore a replaced session.
export const ACCOUNT_RECORD_SCHEMA = 3;
export const MAX_SESSIONS = 512, MAX_FAILURES = 1024;
const asJson = (value: unknown) => value as DurableJson;
function validateAdministrator(m: unknown): asserts m is Administrator {
  const a = m as Administrator;
  if (!a || typeof a.id !== 'string' || !a.id || typeof a.username !== 'string' || !/^[a-z0-9][a-z0-9_.@-]{0,63}$/.test(a.username) || typeof a.disabled !== 'boolean' || typeof a.temporary !== 'boolean' || typeof a.passwordHash !== 'string' || !a.passwordHash.startsWith('$argon2id$') || !Number.isSafeInteger(a.generation) || a.generation < 1 || !Number.isSafeInteger(a.failureEpoch) || a.failureEpoch < 1) fail('corrupt_state', 503);
}
function envelope(value: unknown, field: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('corrupt_state', 503);
  const v = value as Record<string, unknown>;
  if (v.schema !== ACCOUNT_RECORD_SCHEMA || !Object.hasOwn(v, field) || Object.keys(v).some(k => k !== 'schema' && k !== field)) fail('corrupt_state', 503);
  return v[field];
}
function administratorValue(record: DurableRecord | null): Administrator | null {
  if (!record) return null;
  const a = envelope(record.value, 'administrator'); if (a !== null) validateAdministrator(a);
  return a as Administrator | null;
}
function validateSession(value: unknown): Session | null {
  if (value === null) return null;
  const s = value as Session;
  if (!s || !/^[a-f0-9]{64}$/.test(s.digest) || typeof s.administratorId !== 'string' || !s.administratorId || !Number.isSafeInteger(s.generation) || s.generation < 1 || !Number.isFinite(s.created) || !Number.isFinite(s.touched) || s.touched < s.created || !['cookie', 'bearer'].includes(s.transport)) fail('corrupt_state', 503);
  if (s.policy !== undefined) validateSessionPolicy(s.policy, 'corrupt_state', 503);
  return s;
}
function validateFailure(value: unknown): Failure | null {
  if (value === null) return null;
  const f = value as Failure;
  if (!f || typeof f.key !== 'string' || !/^(account|source):[a-f0-9]{64}$/.test(f.key) || !Number.isSafeInteger(f.count) || f.count < 0 || !Number.isFinite(f.until) || !Number.isSafeInteger(f.epoch) || f.epoch < 1) fail('corrupt_state', 503);
  return f;
}
function slots<T extends Session | Failure>(records: readonly DurableRecord[], kind: string, limit: number, validate: (v: unknown) => T | null): Slot<T>[] {
  const result: Slot<T>[] = Array.from({length: limit}, (_, i) => ({key: `${kind}:${i}`, version: 0, value: null}));
  const seen = new Set<string>();
  for (const r of records.filter(r => r.key.startsWith(kind + ':'))) {
    const index = Number(r.key.slice(kind.length + 1));
    if (!Number.isInteger(index) || index < 0 || index >= limit || r.key !== `${kind}:${index}`) fail('corrupt_state', 503);
    const value = validate(envelope(r.value, kind));
    const identity = value && (kind === 'session' ? (value as Session).digest : (value as Failure).key);
    if (identity && seen.has(identity)) fail('corrupt_state', 503); if (identity) seen.add(identity);
    result[index] = {key: r.key, version: r.version, value};
  }
  return result;
}
const mutation = <T>(slot: Slot<T>, field: string, value: T | null): DurableMutation => ({key: slot.key, expectedVersion: slot.version, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, [field]: value})});
function next(value: number): number { if (!Number.isSafeInteger(value + 1)) fail('generation_overflow'); return value + 1; }

export class LocalAccountsControl implements PluginControl, ManagementProvider {
  readonly management = this;
  readonly rpc = [];
  readonly api;
  private readonly state: PluginDurableState;
  private readonly now: () => number;
  private readonly subjects = new WeakMap<ManagementSubject, {generation: number; digest: string}>();
  // Positive lookups only; bounded by the fixed session slots, never by attacker tokens.
  private readonly sessionSlots = new Map<string, string>();
  private dummy = '';
  private disposed = false;
  constructor(private readonly host: ControlHostContext, private readonly dependencies: Dependencies = {}) {
    if (!host.durableState) fail('durable_state_required', 503);
    this.state = host.durableState; this.now = dependencies.now ?? Date.now;
    const invoke = (fn: (c: ControlApiHandlerContext) => Promise<Response>) => async (c: ControlApiHandlerContext) => {
      try { this.alive(); if (c.requestSignal.aborted) fail('cancelled'); return await fn(c); } catch (e) { return safe(e); }
    };
    this.api = [
      {path: '/password', methods: ['POST'], handler: 'changePassword', invoke: invoke(async c => {
        await this.requireCapability(c, 'self.password', true); const b = await body(c.request); exact(b, ['currentPassword', 'password', 'passwordConfirmation']);
        await this.changePassword(c, b); return json({ok: true}, 200, {'set-cookie': cookie(c.request, '', 0, this.host.managementOrigin)});
      })},
      {path: '/logout', methods: ['POST'], handler: 'logout', invoke: invoke(async c => { await this.requireCapability(c, 'self.logout', true); return this.logout(c.request); })},
      {path: '/self', methods: ['GET'], handler: 'self', invoke: invoke(async c => {
        await this.requireCapability(c, 'self.password'); const m = (await this.readAdministrator()).value!; const creds = credentials(c.request);
        return json({administrator: dto(m), ...(creds?.transport === 'cookie' ? {csrfToken: csrf(creds.token)} : {})});
      })},
      {path: '/session-policy', methods: ['GET', 'PUT'], handler: 'sessionPolicy', invoke: invoke(async c => {
        await this.requireCapability(c, 'config.write', c.request.method === 'PUT');
        if (c.request.method === 'GET') return json(await this.readSessionPolicy());
        const b = await body(c.request); exact(b, ['version', 'policy']); if (!Number.isSafeInteger(b.version) || (b.version as number) < 0) fail('invalid_session_policy');
        const policy = validateSessionPolicy(b.policy); await this.requireCapability(c, 'config.write', true);
        try { await this.state.transact([{key: 'session-policy', expectedVersion: b.version as number, value: asJson(policy)}]); }
        catch (e) { if (isDurableStateConflictError(e)) fail('version_conflict', 409); throw e; }
        return json(await this.readSessionPolicy());
      })},
    ];
  }
  private alive() { if (this.disposed || this.host.signal.aborted) fail('provider_unavailable', 503); }
  private async readAdministrator(): Promise<Slot<Administrator>> {
    this.alive(); const record = await this.state.get('administrator'); return {key: 'administrator', version: record?.version ?? 0, value: administratorValue(record)};
  }
  private async records() {
    this.alive(); const records = await this.state.list();
    // No legacy runtime reader. A non-current namespace requires the offline converter.
    for (const r of records) if (!['administrator', 'session-policy', 'recovery-summary'].includes(r.key) && !r.key.startsWith('session:') && !r.key.startsWith('failure:')) fail('account_migration_required', 503);
    return records;
  }
  private async retry<T>(plan: () => Promise<{mutations: DurableMutation[]; result: T}>): Promise<T> {
    for (let i = 0; i < 64; i++) {
      const {mutations, result} = await plan(); if (!mutations.length) return result;
      this.alive(); try { await this.state.transact(mutations); return result; } catch (e) { if (!isDurableStateConflictError(e)) throw e; }
    }
    return fail('version_conflict', 409);
  }
  private async readSessionPolicy(): Promise<{version: number; policy: SessionPolicy}> {
    this.alive(); const record = await this.state.get('session-policy');
    return {version: record?.version ?? 0, policy: record ? validateSessionPolicy(record.value, 'corrupt_state', 503) : {...DEFAULT_SESSION_POLICY}};
  }
  async start() {
    await this.readAdministrator(); await this.readSessionPolicy(); const records = await this.records();
    slots(records, 'session', MAX_SESSIONS, validateSession); slots(records, 'failure', MAX_FAILURES, validateFailure);
    this.dummy = await this.hash(randomBytes(32).toString('base64url'));
  }
  dispose() { this.disposed = true; }
  private hash(p: string) { return Bun.password.hash(p, {algorithm: 'argon2id', memoryCost: 65536, timeCost: 3}); }
  async hasIdentity() { const a = (await this.readAdministrator()).value; return !!a && !a.disabled; }
  async revokeSessions() { await this.retry(async () => { const a = await this.readAdministrator(); return {mutations: a.value ? [mutation(a, 'administrator', {...a.value, generation: next(a.value.generation)})] : [], result: undefined}; }); }
  async bootstrap(input: unknown) {
    const b = object(input); exact(b, ['username', 'password', 'passwordConfirmation']); const name = username(b.username), p = password(b.password);
    if (b.passwordConfirmation !== p) fail('password_confirmation'); await this.records();
    const prior = (await this.readAdministrator()).value;
    if (prior) {
      if (prior.username !== name || prior.disabled || !await Bun.password.verify(p, prior.passwordHash)) fail('invalid_credentials', 401);
      const latest = (await this.readAdministrator()).value; if (!latest || latest.generation !== prior.generation || latest.disabled) fail('invalid_credentials', 401); return;
    }
    const hashed = await this.hash(p);
    await this.retry(async () => { const a = await this.readAdministrator(); if (a.value) fail('bootstrap_conflict', 409);
      return {mutations: [mutation(a, 'administrator', {id: randomUUID(), username: name, disabled: false, temporary: false, passwordHash: hashed, generation: 1, failureEpoch: 1})], result: undefined}; });
  }
  private live(m: Administrator | null, session: Session): Administrator | undefined {
    const now = this.now(), policy = session.policy ?? DEFAULT_SESSION_POLICY;
    if (now < session.touched || now < session.created || (policy.idleTimeoutMinutes > 0 && now - session.touched >= policy.idleTimeoutMinutes * 60_000) || (policy.absoluteTimeoutMinutes > 0 && now - session.created >= policy.absoluteTimeoutMinutes * 60_000)) return;
    return m && m.id === session.administratorId && !m.disabled && m.generation === session.generation ? m : undefined;
  }
  private async findSession(d: string): Promise<Slot<Session> | undefined> {
    this.alive(); const key = this.sessionSlots.get(d);
    if (key) {
      const record = await this.state.get(key), value = record && validateSession(envelope(record.value, 'session'));
      if (record && value?.digest === d) return {key, version: record.version, value};
      this.sessionSlots.delete(d);
    }
    const found = slots(await this.records(), 'session', MAX_SESSIONS, validateSession).find(x => x.value?.digest === d);
    if (found) { if (this.sessionSlots.size >= MAX_SESSIONS) this.sessionSlots.clear(); this.sessionSlots.set(d, found.key); }
    return found;
  }
  private cookieAge(policy: SessionPolicy, elapsedMs = 0): number { return policy.absoluteTimeoutMinutes === 0 ? COOKIE_LEASE_SECONDS : Math.max(0, Math.min(COOKIE_LEASE_SECONDS, Math.floor((policy.absoluteTimeoutMinutes * 60_000 - elapsedMs) / 1000))); }
  async sessionCookie(request: Request): Promise<string | undefined> {
    this.alive(); const creds = credentials(request); if (creds?.transport !== 'cookie') return;
    const slot = await this.findSession(digest(creds.token)), m = (await this.readAdministrator()).value, session = slot?.value;
    if (!session || session.transport !== 'cookie' || !this.live(m, session)) return;
    return cookie(request, creds.token, this.cookieAge(session.policy ?? DEFAULT_SESSION_POLICY, this.now() - session.created), this.host.managementOrigin);
  }
  async authenticate(request: Request): Promise<ManagementSubject | null> {
    this.alive(); const c = credentials(request); if (!c) return null;
    const authenticated = await this.retry(async () => {
      const slot = await this.findSession(digest(c.token)), m = (await this.readAdministrator()).value, session = slot?.value;
      const administrator = session && session.transport === c.transport && this.live(m, session);
      if (!slot || !session || !administrator) return {mutations: [], result: null};
      return {mutations: [mutation(slot, 'session', {...session, touched: this.now()})], result: {administrator, digest: session.digest}};
    });
    if (!authenticated) return null;
    // A concurrent generation change can invalidate the session while its own CAS succeeds.
    const m = (await this.readAdministrator()).value;
    if (!m || m.disabled || m.generation !== authenticated.administrator.generation || m.id !== authenticated.administrator.id) return null;
    const subject = Object.freeze({id: m.id, provider: PROVIDER, capabilities: Object.freeze([...ALL]), requiresPasswordChange: m.temporary});
    this.subjects.set(subject, {generation: m.generation, digest: authenticated.digest}); return subject;
  }
  async authorize(subject: ManagementSubject, _capability: string): Promise<boolean> {
    this.alive(); const issued = this.subjects.get(subject); if (!issued || subject.provider !== PROVIDER) return false;
    const slot = await this.findSession(issued.digest), session = slot?.value, m = session && this.live((await this.readAdministrator()).value, session);
    return !!m && m.id === subject.id && m.generation === issued.generation;
  }
  private async requireCapability(c: ControlApiHandlerContext, capability: string, write = false) { if (!c.subject || !await this.authorize(c.subject, capability)) fail('forbidden', 403); if (write) this.checkWrite(c.request); }
  validateWrite(request: Request) { this.checkWrite(request); }
  csrfToken(request: Request): string | undefined { const c = credentials(request); return c?.transport === 'cookie' ? csrf(c.token) : undefined; }
  private checkWrite(request: Request) { const c = credentials(request); if (!c) fail('unauthorized', 401); if (c.transport === 'cookie') { origin(request, this.host.managementOrigin); if (!constant(request.headers.get('x-csrf-token') ?? '', csrf(c.token))) fail('invalid_csrf', 403); } }
  async login(request: Request): Promise<Response> {
    try {
      this.alive(); if (request.method !== 'POST') fail('method_not_allowed', 405);
      const b = await body(request); exact(b, ['username', 'password', 'transport']); const name = username(b.username), p = typeof b.password === 'string' ? b.password : '';
      const transport = b.transport ?? 'cookie'; if (transport !== 'cookie' && transport !== 'bearer') fail('invalid_input');
      if (transport === 'cookie' || request.headers.has('origin')) origin(request, this.host.managementOrigin);
      const source = (this.dependencies.trustedSource ?? this.host.trustedSource)?.(request) ?? 'unknown'; const keys = ['account:' + digest(name), 'source:' + digest(source)];
      // Reserve both independent buckets atomically before password work.
      const reservation = await this.retry(async () => {
        const a = (await this.readAdministrator()).value, epoch = a?.failureEpoch ?? 1, now = this.now();
        const failures = slots(await this.records(), 'failure', MAX_FAILURES, validateFailure), selected: Slot<Failure>[] = [];
        for (const key of keys) {
          let slot = failures.find(x => !selected.includes(x) && x.value?.key === key);
          const active = slot?.value && slot.value.epoch === epoch && slot.value.until > now;
          if (active && slot!.value!.count >= 10) fail('login_limited', 429);
          slot ??= failures.find(x => !selected.includes(x) && (!x.value || x.value.epoch !== epoch || x.value.until <= now));
          if (!slot) fail('login_limited', 429); selected.push(slot);
        }
        return {mutations: selected.map((slot, i) => { const prior = slot.value; return mutation(slot, 'failure', {key: keys[i]!, count: prior && prior.key === keys[i] && prior.epoch === epoch && prior.until > now ? prior.count + 1 : 1, until: prior && prior.key === keys[i] && prior.epoch === epoch && prior.until > now ? prior.until : now + 15 * 60_000, epoch}); }), result: epoch};
      });
      const candidate = (await this.readAdministrator()).value, administrator = candidate?.username === name ? candidate : null;
      const valid = await Bun.password.verify(p, administrator?.passwordHash ?? (this.dummy || await this.hash('dummy-invalid-password')));
      if (!valid || !administrator || administrator.disabled) fail('invalid_credentials', 401);
      const token = randomBytes(32).toString('base64url'), policy = (await this.readSessionPolicy()).policy, created = this.now();
      await this.retry(async () => {
        const m = (await this.readAdministrator()).value;
        if (!m || m.id !== administrator.id || m.disabled || m.generation !== administrator.generation || m.failureEpoch !== reservation) fail('invalid_credentials', 401);
        const records = await this.records(), sessions = slots(records, 'session', MAX_SESSIONS, validateSession), slot = sessions.find(x => !x.value || !this.live(m, x.value));
        if (!slot) fail('session_limit', 429);
        const changes = [mutation(slot, 'session', {digest: digest(token), administratorId: m.id, generation: m.generation, created, touched: created, transport, policy})];
        const failures = slots(records, 'failure', MAX_FAILURES, validateFailure);
        const account = failures.find(x => x.value?.key === keys[0] && x.value.epoch === reservation); if (account) changes.push(mutation(account, 'failure', null));
        const source = failures.find(x => x.value?.key === keys[1] && x.value.epoch === reservation); if (source) changes.push(mutation(source, 'failure', {...source.value!, count: Math.max(0, source.value!.count - 1)}));
        return {mutations: changes, result: undefined};
      });
      const latest = (await this.readAdministrator()).value;
      if (!latest || latest.disabled || latest.generation !== administrator.generation || latest.id !== administrator.id) fail('invalid_credentials', 401);
      return transport === 'cookie' ? json({administrator: dto(administrator), csrfToken: csrf(token)}, 200, {'set-cookie': cookie(request, token, this.cookieAge(policy, this.now() - created), this.host.managementOrigin)}) : json({administrator: dto(administrator), token, expiresIn: policy.absoluteTimeoutMinutes === 0 ? null : policy.absoluteTimeoutMinutes * 60});
    } catch (e) { return safe(e); }
  }
  async logout(request: Request): Promise<Response> {
    try { this.alive(); if (request.method !== 'POST') fail('method_not_allowed', 405); this.checkWrite(request); const c = credentials(request)!;
      await this.retry(async () => { const slot = await this.findSession(digest(c.token)); return {mutations: slot?.value ? [mutation(slot, 'session', null)] : [], result: undefined}; });
      return json({ok: true}, 200, {'set-cookie': cookie(request, '', 0, this.host.managementOrigin)});
    } catch (e) { return safe(e); }
  }
  private async changePassword(c: ControlApiHandlerContext, b: Record<string, unknown>) {
    const p = password(b.password); if (b.passwordConfirmation !== p) fail('password_confirmation');
    const m = (await this.readAdministrator()).value, id = c.subject!.id;
    if (!m || m.id !== id || typeof b.currentPassword !== 'string' || !await Bun.password.verify(b.currentPassword, m.passwordHash)) fail('invalid_credentials', 401);
    if (constant(p, b.currentPassword)) fail('password_unchanged'); const hashed = await this.hash(p);
    await this.retry(async () => {
      await this.requireCapability(c, 'self.password', true); const a = await this.readAdministrator(), current = a.value;
      if (!current || current.id !== id || current.disabled || current.generation !== m.generation) fail('version_conflict', 409);
      const issued = this.subjects.get(c.subject!)!, slot = await this.findSession(issued.digest);
      if (!slot?.value || !this.live(current, slot.value)) fail('forbidden', 403);
      return {mutations: [mutation(a, 'administrator', {...current, passwordHash: hashed, temporary: false, generation: next(current.generation)}), mutation(slot, 'session', null)], result: undefined};
    });
  }
}
export function createControl(host: ControlHostContext, dependencies: Dependencies = {}): LocalAccountsControl { return new LocalAccountsControl(host, dependencies); }
export const api = [
  {path: '/password', methods: ['POST'], handler: 'changePassword'},
  {path: '/logout', methods: ['POST'], handler: 'logout'},
  {path: '/self', methods: ['GET'], handler: 'self'},
  {path: '/session-policy', methods: ['GET', 'PUT'], handler: 'sessionPolicy'},
] as const;
export const rpc = [], controlApi = api, controlRpc = rpc;
export async function recoverIdentity(input: unknown, context: {durableState: PluginDurableState}) {
  const b = object(input); exact(b, ['username', 'newUsername', 'password', 'reason']);
  const name = b.username === undefined ? undefined : username(b.username), p = password(b.password), newName = b.newUsername === undefined ? undefined : username(b.newUsername);
  if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 512) fail('invalid_reason');
  const state = context.durableState; await readManagementSetup(state);
  const record = await state.get('administrator'), prior = administratorValue(record);
  if (prior && name !== undefined && prior.username !== name) fail('recovery_requires_existing_administrator');
  const passwordHash = await Bun.password.hash(p, {algorithm: 'argon2id', memoryCost: 65536, timeCost: 3});
  const administrator: Administrator = prior ? {...prior, username: newName ?? prior.username, passwordHash, disabled: false, temporary: false, generation: next(prior.generation), failureEpoch: next(prior.failureEpoch)} : {id: randomUUID(), username: newName ?? name ?? fail('invalid_input'), disabled: false, temporary: false, passwordHash, generation: 1, failureEpoch: 1};
  const summary = await state.get('recovery-summary');
  await state.transact([
    {key: 'administrator', expectedVersion: record?.version ?? 0, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, administrator})},
    {key: 'recovery-summary', expectedVersion: summary?.version ?? 0, value: {schema: ACCOUNT_RECORD_SCHEMA, administratorId: administrator.id, reason: b.reason, at: Date.now()}},
  ]);
  return dto(administrator);
}
export async function readManagementSetup(state: Pick<PluginDurableState, 'get' | 'list'>) {
  for (const r of await state.list()) if (!['administrator', 'session-policy', 'recovery-summary'].includes(r.key) && !r.key.startsWith('session:') && !r.key.startsWith('failure:')) fail('account_migration_required', 503);
  return {initialized: !!administratorValue(await state.get('administrator'))};
}
export default {createControl, readManagementSetup, offlineRecovery: {kind: 'identity', recover: recoverIdentity}} satisfies ControlPlugin;
