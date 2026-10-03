import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ControlHostContext, ControlApiHandlerContext, PluginControl, ControlPlugin } from '../../../packages/core/src/plugin-control/contracts';
import type { ManagementProvider, ManagementSubject } from '../../../packages/core/src/plugin-extensions';
import { DurableStateConflictError, type DurableJson, type PluginDurableState } from '../../../packages/core/src/plugin-durable-state';

interface Administrator { id: string; username: string; disabled: boolean; passwordHash: string; temporary: boolean; generation: number }
interface Session { digest: string; administratorId: string; generation: number; created: number; touched: number; transport: 'cookie' | 'bearer' }
interface Failure { key: string; count: number; until: number }
interface State { schema: 2; administrator: Administrator | null; sessions: Session[]; failures: Failure[] }
export interface Dependencies { now?: () => number; trustedSource?: (request: Request) => string }
const PROVIDER = 'local-accounts';
const COOKIE = 'bungee_local_session';
const IDLE = 30 * 60_000, ABSOLUTE = 8 * 60 * 60_000;
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
function cookie(request: Request, token: string, clear = false, managementOrigin?: string) { return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : ABSOLUTE / 1000}${new URL(managementOrigin ?? request.url).protocol === 'https:' ? '; Secure' : ''}`; }

function validateAdministrator(m: unknown): asserts m is Administrator {
  const a = m as Administrator;
  if (!a || typeof a.id !== 'string' || !a.id || typeof a.username !== 'string' || !/^[a-z0-9][a-z0-9_.@-]{0,63}$/.test(a.username) || typeof a.disabled !== 'boolean' || typeof a.temporary !== 'boolean' || typeof a.passwordHash !== 'string' || !a.passwordHash.startsWith('$argon2id$') || !Number.isSafeInteger(a.generation) || a.generation < 1) fail('corrupt_state', 503);
}
/** Migration never promotes a former admin/viewer. Ambiguous owners require offline selection. */
function validateAccountState(value: unknown, recoveryUsername?: string): State {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('corrupt_state', 503);
  const raw = value as Record<string, unknown>;
  if (raw.schema === 1) {
    if (!Array.isArray(raw.members) || !Array.isArray(raw.sessions) || !Array.isArray(raw.failures)) fail('corrupt_state', 503);
    const ids = new Set<string>(), names = new Set<string>();
    for (const member of raw.members) {
      validateAdministrator(member);
      const legacy = member as Administrator & {role: string};
      if (!['owner', 'admin', 'viewer'].includes(legacy.role) || ids.has(member.id) || names.has(member.username)) fail('corrupt_state', 503);
      ids.add(member.id); names.add(member.username);
    }
    const candidates = raw.members.filter(m => m.role === 'owner' && (recoveryUsername ? m.username === recoveryUsername : !m.disabled));
    if (raw.members.length && candidates.length !== 1) fail(recoveryUsername ? 'recovery_requires_existing_administrator' : 'administrator_migration_required', 503);
    const chosen = candidates[0];
    const administrator = chosen ? { id: chosen.id, username: chosen.username, disabled: chosen.disabled, temporary: chosen.temporary, passwordHash: chosen.passwordHash, generation: chosen.generation } : null;
    return {schema: 2, administrator, sessions: [], failures: []};
  }
  const s = raw as unknown as State;
  if (s.schema !== 2 || !Array.isArray(s.sessions) || !Array.isArray(s.failures)) fail('corrupt_state', 503);
  if (s.administrator !== null) validateAdministrator(s.administrator);
  for (const x of s.sessions) if (!x || !/^[a-f0-9]{64}$/.test(x.digest) || x.administratorId !== s.administrator?.id || !Number.isSafeInteger(x.generation) || x.generation < 1 || !Number.isFinite(x.created) || !Number.isFinite(x.touched) || !['cookie','bearer'].includes(x.transport)) fail('corrupt_state', 503);
  for (const x of s.failures) if (!x || typeof x.key !== 'string' || !Number.isSafeInteger(x.count) || x.count < 0 || !Number.isFinite(x.until)) fail('corrupt_state', 503);
  return s;
}

export class LocalAccountsControl implements PluginControl, ManagementProvider {
  readonly management = this;
  readonly rpc = [];
  readonly api;
  private readonly state: PluginDurableState;
  private readonly now: () => number;
  private readonly subjects = new WeakMap<ManagementSubject, { generation: number; digest: string }>();
  private dummy = '';
  private disposed = false;
  constructor(private readonly host: ControlHostContext, private readonly dependencies: Dependencies = {}) {
    if (!host.durableState) fail('durable_state_required', 503);
    this.state = host.durableState;
    this.now = dependencies.now ?? Date.now;
    const invoke = (fn: (c: ControlApiHandlerContext) => Promise<Response> | Response) => async (c: ControlApiHandlerContext) => {
      try { this.alive(); if (c.requestSignal.aborted) fail('cancelled'); return await fn(c); } catch (e) { return safe(e); }
    };
    this.api = [
      { path: '/password', methods: ['POST'], handler: 'changePassword', invoke: invoke(async c => { this.requireCapability(c, 'self.password', true); const b = await body(c.request); exact(b, ['currentPassword', 'password', 'passwordConfirmation']); await this.changePassword(c.subject!.id, b, () => this.requireCapability(c, 'self.password', true)); return json({ ok: true }, 200, { 'set-cookie': cookie(c.request, '', true, this.host.managementOrigin) }); }) },
      { path: '/logout', methods: ['POST'], handler: 'logout', invoke: invoke(c => { this.requireCapability(c, 'self.logout', true); return this.logout(c.request); }) },
      { path: '/self', methods: ['GET'], handler: 'self', invoke: invoke(c => { this.requireCapability(c, 'self.password'); const m = this.read().value.administrator!; const creds = credentials(c.request); return json({ administrator: dto(m), ...(creds?.transport === 'cookie' ? { csrfToken: csrf(creds.token) } : {}) }); }) },
    ];
  }
  private alive() { if (this.disposed || this.host.signal.aborted) fail('provider_unavailable', 503); }
  private read(): { version: number; value: State } {
    this.alive(); const record = this.state.get('accounts');
    if (!record) return { version: 0, value: { schema: 2, administrator: null, sessions: [], failures: [] } };
    const s = validateAccountState(record.value);
    return { version: record.version, value: s };
  }
  private mutate<T>(fn: (s: State) => T): T {
    for (let i = 0; i < 8; i++) { const {version, value} = this.read(); const result = fn(value);
      try { this.state.execute({ commandId: randomUUID(), mutations: [{ key: 'accounts', expectedVersion: version, value: value as unknown as DurableJson }] }); return result; }
      catch (e) { if (!(e instanceof DurableStateConflictError)) throw e; }
    } return fail('version_conflict', 409);
  }
  async start() { const record = this.state.get('accounts'); this.read(); if (record && (record.value as any).schema === 1) this.mutate(() => undefined); this.dummy = await this.hash(randomBytes(32).toString('base64url')); }
  dispose() { this.disposed = true; }
  private hash(p: string) { return Bun.password.hash(p, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 }); }
  hasIdentity() { const a = this.read().value.administrator; return !!a && !a.disabled; }
  revokeSessions() { this.mutate(s => { s.sessions = []; }); }
  async bootstrap(input: unknown) {
    const b = object(input); exact(b, ['username', 'password', 'passwordConfirmation']); const name = username(b.username), p = password(b.password);
    if (b.passwordConfirmation !== p) fail('password_confirmation');
    const prior = this.read().value.administrator;
    if (prior) {
      if (prior.username !== name || prior.disabled || !await Bun.password.verify(p, prior.passwordHash)) fail('invalid_credentials', 401);
      const latest = this.read().value.administrator;
      if (!latest || latest.generation !== prior.generation || latest.disabled) fail('invalid_credentials', 401);
      return;
    }
    const hashed = await this.hash(p);
    this.mutate(s => { if (s.administrator) fail('bootstrap_conflict', 409); s.administrator = { id: randomUUID(), username: name, disabled: false, temporary: false, passwordHash: hashed, generation: 1 }; });
  }
  private live(s: State, session: Session): Administrator | undefined { const now = this.now(); if (now < session.touched || now - session.touched >= IDLE || now - session.created >= ABSOLUTE) return; const m = s.administrator; return m && m.id === session.administratorId && !m.disabled && m.generation === session.generation ? m : undefined; }
  async authenticate(request: Request): Promise<ManagementSubject | null> {
    this.alive(); const c = credentials(request); if (!c) return null;
    return this.mutate(s => { const session = s.sessions.find(x => x.digest === digest(c.token) && x.transport === c.transport); const administrator = session && this.live(s, session); if (!session || !administrator) return null; session.touched = this.now(); const subject = Object.freeze({ id: administrator.id, provider: PROVIDER, capabilities: Object.freeze([...ALL]), requiresPasswordChange: administrator.temporary }); this.subjects.set(subject, { generation: administrator.generation, digest: session.digest }); return subject; });
  }
  authorize(subject: ManagementSubject, _capability: string): boolean {
    this.alive(); const issued = this.subjects.get(subject); if (!issued || subject.provider !== PROVIDER) return false;
    const s = this.read().value, session = s.sessions.find(x => x.digest === issued.digest), m = session && this.live(s, session);
    return !!m && m.id === subject.id && m.generation === issued.generation;
  }
  private requireCapability(c: ControlApiHandlerContext, capability: string, write = false) { if (!c.subject || !this.authorize(c.subject, capability)) fail('forbidden', 403); if (write) this.checkWrite(c.request); }
  validateWrite(request: Request) { this.checkWrite(request); }
  csrfToken(request: Request): string | undefined { const c = credentials(request); return c?.transport === 'cookie' ? csrf(c.token) : undefined; }
  private checkWrite(request: Request) { const c = credentials(request); if (!c) fail('unauthorized', 401); if (c.transport === 'cookie') { origin(request, this.host.managementOrigin); if (!constant(request.headers.get('x-csrf-token') ?? '', csrf(c.token))) fail('invalid_csrf', 403); } }
  async login(request: Request): Promise<Response> {
    try {
      this.alive(); if (request.method !== 'POST') fail('method_not_allowed', 405);
      const b = await body(request); exact(b, ['username','password','transport']);
      const name = username(b.username); const p = typeof b.password === 'string' ? b.password : '';
      const transport = b.transport ?? 'cookie'; if (transport !== 'cookie' && transport !== 'bearer') fail('invalid_input');
      if (transport === 'cookie') origin(request, this.host.managementOrigin); else if (request.headers.has('origin')) origin(request, this.host.managementOrigin);
      const source = (this.dependencies.trustedSource ?? this.host.trustedSource)?.(request) ?? 'unknown';
      const keys = ['account:' + digest(name), 'source:' + digest(source)]; const now = this.now();
      // Reserve before password work so simultaneous requests cannot bypass throttling.
      this.mutate(s => { s.failures = s.failures.filter(x => x.until > now); if (keys.some(k => s.failures.some(x => x.key === k && x.count >= 10))) fail('login_limited', 429); for (const key of keys) { let f = s.failures.find(x => x.key === key); if (!f) { f = { key, count: 0, until: now + 15 * 60_000 }; s.failures.push(f); } f.count++; } if (s.failures.length > 1024) fail('login_limited', 429); });
      const candidate = this.read().value.administrator; const administrator = candidate?.username === name ? candidate : null;
      const valid = await Bun.password.verify(p, administrator?.passwordHash ?? (this.dummy || await this.hash('dummy-invalid-password')));
      if (!valid || !administrator || administrator.disabled) fail('invalid_credentials', 401);
      const token = randomBytes(32).toString('base64url');
      this.mutate(s => { const m = s.administrator; if (!m || m.id !== administrator.id || m.disabled || m.generation !== administrator.generation) fail('invalid_credentials', 401); s.sessions = s.sessions.filter(x => !!this.live(s, x)); if (s.sessions.length >= 512) fail('session_limit', 429); s.sessions.push({ digest: digest(token), administratorId: m.id, generation: m.generation, created: this.now(), touched: this.now(), transport }); s.failures = s.failures.filter(x => x.key !== keys[0]); const sourceFailure = s.failures.find(x => x.key === keys[1]); if (sourceFailure) sourceFailure.count = Math.max(0, sourceFailure.count - 1); });
      return transport === 'cookie' ? json({ administrator: dto(administrator), csrfToken: csrf(token) }, 200, { 'set-cookie': cookie(request, token, false, this.host.managementOrigin) }) : json({ administrator: dto(administrator), token, expiresIn: ABSOLUTE / 1000 });
    } catch (e) { return safe(e); }
  }
  async logout(request: Request): Promise<Response> {
    try { if (request.method !== 'POST') fail('method_not_allowed', 405); this.checkWrite(request); const c = credentials(request)!; this.mutate(s => { s.sessions = s.sessions.filter(x => x.digest !== digest(c.token)); }); return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', true, this.host.managementOrigin) }); } catch(e) { return safe(e); }
  }
  private async changePassword(id: string, b: Record<string, unknown>, guard: () => void) {
    const p = password(b.password); if (b.passwordConfirmation !== p) fail('password_confirmation'); const m = this.read().value.administrator; if (!m || m.id !== id || typeof b.currentPassword !== 'string' || !await Bun.password.verify(b.currentPassword, m.passwordHash)) fail('invalid_credentials', 401); if (constant(p, b.currentPassword)) fail('password_unchanged'); const hashed = await this.hash(p);
    this.mutate(s => { guard(); const current = s.administrator; if (!current || current.id !== id || current.disabled || current.generation !== m.generation) fail('version_conflict', 409); if (!Number.isSafeInteger(current.generation + 1)) fail('generation_overflow'); current.passwordHash = hashed; current.temporary = false; current.generation++; s.sessions = []; });
  }
}
export function createControl(host: ControlHostContext, dependencies: Dependencies = {}): LocalAccountsControl { return new LocalAccountsControl(host, dependencies); }
export const api = [
  { path: '/password', methods: ['POST'], handler: 'changePassword' },
  { path: '/logout', methods: ['POST'], handler: 'logout' },
  { path: '/self', methods: ['GET'], handler: 'self' },
] as const;
export const rpc = [];
export const controlApi = api, controlRpc = rpc;
export async function recoverIdentity(input: unknown, context: { durableState: PluginDurableState }) {
  const b = object(input); exact(b, ['username', 'newUsername', 'password', 'reason']);
  const name = b.username === undefined ? undefined : username(b.username), p = password(b.password);
  const newName = b.newUsername === undefined ? undefined : username(b.newUsername);
  if (typeof b.reason !== 'string' || b.reason.trim().length < 1 || b.reason.length > 512) fail('invalid_reason');
  const state = context.durableState, record = state.get('accounts');
  const s = record ? validateAccountState(record.value, name) : { schema: 2 as const, administrator: null, sessions: [], failures: [] };
  let administrator = s.administrator;
  if (administrator && name !== undefined && administrator.username !== name) fail('recovery_requires_existing_administrator');
  const passwordHash = await Bun.password.hash(p, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
  if (!administrator) { administrator = { id: randomUUID(), username: newName ?? name ?? fail('invalid_input'), disabled: false, temporary: false, passwordHash, generation: 1 }; s.administrator = administrator; }
  else { if (!Number.isSafeInteger(administrator.generation + 1)) fail('generation_overflow'); administrator.username = newName ?? administrator.username; administrator.passwordHash = passwordHash; administrator.disabled = false; administrator.temporary = false; administrator.generation++; }
  s.sessions = [];
  s.failures = [];
  state.execute({commandId: randomUUID(), mutations: [
    {key: 'accounts', expectedVersion: record?.version ?? 0, value: s as unknown as DurableJson},
    {key: 'recovery:' + randomUUID(), expectedVersion: 0, value: {administratorId: administrator.id, reason: b.reason, at: Date.now()}},
  ]});
  return dto(administrator);
}
export function readManagementSetup(state: Pick<PluginDurableState,'get'|'list'>) {
  const record = state.get('accounts');
  return {initialized:record ? !!validateAccountState(record.value).administrator : false};
}
export default { createControl, readManagementSetup, offlineRecovery: {kind: 'identity', recover: recoverIdentity} } satisfies ControlPlugin;
