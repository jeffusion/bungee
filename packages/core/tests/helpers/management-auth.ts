import { randomUUID } from 'node:crypto';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import type { PluginControlHost } from '../../src/plugin-control';
import type { ManagementProvider, ManagementSubject } from '../../src/plugin-extensions';
import { ManagementAuthentication, MANAGEMENT_CAPABILITIES } from '../../src/master-runtime/management-auth';

/** Anonymous by default; selected-provider tests use revocable simulated plugin sessions. */
export function createManagementAuthFixture(aggregate: () => ConfigurationAggregateV2, options: {provider?: boolean} = {}) {
  const current = { id: randomUUID(), token: randomUUID() };
  const next = { id: randomUUID(), token: randomUUID() };
  const activeSessions = new Map<string, typeof current>([current, next].map(session => [session.id, session]));
  const sessions = {
    authenticate(token: string) { return [...activeSessions.values()].find(session => session.token === token) ?? null; },
    revoke(id: string) { activeSessions.delete(id); },
  };
  const issued = new WeakMap<ManagementSubject, string>();
  const provider: ManagementProvider = {
    async authenticate(request) {
      const token = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      const session = token ? sessions.authenticate(token) : null;
      if (!session) return null;
      const subject = {id: session.id, provider: 'test-provider', capabilities: MANAGEMENT_CAPABILITIES};
      issued.set(subject, session.id);
      return subject;
    },
    async authorize(subject) { return activeSessions.has(issued.get(subject) ?? ''); },
    async login(request) {
      const {token} = await request.json() as {token?: string};
      return Response.json({}, {status: token && sessions.authenticate(token) ? 200 : 401});
    },
    async logout() { return Response.json({success: true}); },
    async bootstrap() {}, hasIdentity: async () => true, async revokeSessions() { activeSessions.clear(); },
  };
  const host = { get: () => options.provider ? {status:'ready', admission:true, control:{management:provider}} : undefined } as unknown as PluginControlHost;
  const authAggregate = options.provider ? () => ({...aggregate(), plugin_activations:[{plugin_name:'test-provider'}]}) : aggregate;
  const managementAuth = new ManagementAuthentication(host, authAggregate, new Set(options.provider ? ['test-provider'] : []));
  return { sessions, current, next, managementAuth, dispose: () => activeSessions.clear() };
}
