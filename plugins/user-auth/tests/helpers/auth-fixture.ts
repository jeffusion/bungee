import type { ControlHostContext, SecretStore } from '../../../../packages/core/src/plugin-control/contracts';
import { createControl, recoverIdentity, type Dependencies, type UserAuthControl } from '../../server/control';
import { AsyncFakeState } from './fake-durable-state';

export class MemorySecrets implements SecretStore {
  readonly namespace = 'user-auth';
  readonly values = new Map<string, { version: number; value: string }>();
  readonly versions = new Map<string, number>();
  unknownNext = false;
  failNext = false;
  async get(key: string) { return this.values.get(key) ?? null; }
  async compareAndSet(key: string, expectedVersion: number | null, value: string) {
    if (this.failNext) { this.failNext = false; throw new Error('secret unavailable'); }
    const prior = this.values.get(key);
    if ((prior?.version ?? null) !== expectedVersion) throw Object.assign(new Error('secret conflict'), {code:'version_conflict'});
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    this.values.set(key, { version, value });
    if (this.unknownNext) { this.unknownNext = false; throw new Error('secret acknowledgement lost'); }
    return version;
  }
  async delete(key: string, expectedVersion: number) {
    if (this.values.get(key)?.version !== expectedVersion) throw new Error('secret conflict');
    this.values.delete(key);
  }
}
export const PASSWORD = 'Local owner password';
export const PUBLIC_ORIGIN = 'https://manager.example';
export function request(path: string, method = 'GET', payload?: unknown, headers: Record<string, string> = {}) {
  return new Request(PUBLIC_ORIGIN + path, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}
export async function authFixture(dependencies: Dependencies = {}, managementOrigin: string | null = PUBLIC_ORIGIN) {
  const state = new AsyncFakeState(), secrets = new MemorySecrets();
  let now = Date.now();
  const host: ControlHostContext = { signal: new AbortController().signal, managementOrigin: managementOrigin ?? undefined, durableState: state, secretStore: secrets, storage: {} as never };
  await recoverIdentity({ operation: 'reset', username: 'owner', password: PASSWORD, passwordConfirmation: PASSWORD, reason: 'Fixture setup' }, { durableState: state, now: () => now });
  const control = createControl(host, { now: () => now, ...dependencies });
  await control.start();
  const login = async (username = 'owner', password = PASSWORD) => {
    const result = await control.login(request('/api/auth/login', 'POST', { username, password, transport: 'bearer' }));
    if (result.status !== 200) throw new Error('Fixture login failed: ' + await result.text());
    return (await result.json() as { token: string }).token;
  };
  const call = async (token: string, path: string, method = 'GET', payload?: unknown, target: UserAuthControl = control) => {
    const req = request(path, method, payload, { authorization: 'Bearer ' + token });
    const subject = await target.authenticate(req);
    const handler = target.api.find(route => route.path === path.split('?')[0] && route.methods.includes(method));
    if (!handler) throw new Error('Fixture route missing: ' + path);
    return handler.invoke({ ...host, request: req, requestSignal: req.signal, subject: subject ?? undefined });
  };
  return { state, secrets, host, control, login, call, advance(ms: number) { now += ms; }, now: () => now };
}
