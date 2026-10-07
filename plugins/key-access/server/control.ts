import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ControlHostContext, PluginControl } from '@jeffusion/bungee-core/plugin';
import type { PluginDurableState, DurableJson } from '@jeffusion/bungee-core/plugin';
import type { DataPrincipal } from '@jeffusion/bungee-core/plugin';
import { validatePolicy, validatePublication, stringIds, validPrincipal, type AccessPublication, type AccessCredential } from './policy';

type ReadState = Pick<PluginDurableState, 'get' | 'list'>;
const empty = (): AccessPublication => ({byKey: {}, protectedRouteIds: [], credentials: []});
function current(state: ReadState): AccessPublication {
  const value = state.get('policies')?.value;
  return value === undefined ? empty() : validatePublication(value);
}
function routeKeyBindings(value: AccessPublication) {
  return Object.fromEntries(value.protectedRouteIds.map(routeId => [routeId, value.credentials.filter(key => {
    const scope = validatePolicy(value.byKey[key.id] ?? null);
    return scope?.routes == null || scope.routes.includes(routeId);
  }).map(key => ({id: key.id, name: key.name}))]));
}
function metadata(key: AccessCredential) { const {digest: _digest, ...value} = key; return value; }
function json(value: unknown, status = 200) { return Response.json(value, {status, headers: {'cache-control': 'no-store'}}); }
function keyId(request: Request): string {
  const id = decodeURIComponent(new URL(request.url).pathname.split('/').pop() ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('invalid_key_id');
  return id;
}
export function createControl(host: ControlHostContext): PluginControl {
  if (!host.durableState) throw new Error('key-access.durable_state_required');
  const state = host.durableState;
  let running = false, publishedVersion = -1;
  let writes: Promise<unknown> = Promise.resolve();
  const policy = () => ({version: state.get('policies')?.version ?? 0, value: current(state) as unknown as DurableJson});
  const ready = () => running && !host.signal.aborted && publishedVersion === policy().version;
  async function publish() {
    if (!host.publishPolicy) throw new Error('publication_unavailable');
    const next = policy();
    await host.publishPolicy(next);
    publishedVersion = next.version;
  }
  async function save(value: AccessPublication, result: Record<string, unknown>, status = 200): Promise<Response> {
    const old = state.get('policies');
    state.execute({commandId: randomUUID(), mutations: [{key: 'policies', expectedVersion: old?.version ?? 0, value: value as unknown as DurableJson}]});
    try { await publish(); return json({...result, version: policy().version, ready: ready(), published: true}, status); }
    catch { return json({...result, error: 'key-access.publication_pending', persisted: true, version: policy().version, ready: false, active: false, published: false}, 503); }
  }
  function write(operation: () => Promise<Response>): Promise<Response> {
    const task = writes.catch(() => undefined).then(async () => {
      if (!running || host.signal.aborted) return json({error: 'key-access.inactive'}, 503);
      try { return await operation(); } catch { return json({error: 'key-access.invalid_write'}, 422); }
    });
    writes = task; return task;
  }
  return {policy, rpc: [], api: [
    {path: '/credentials', methods: ['GET', 'POST'], handler: 'credentials', async invoke(ctx) {
      if (ctx.request.method === 'GET') {
        const keys = await Promise.all(current(state).credentials.map(async key => ({...metadata(key),
          ...(host.readResourceExtensions ? {extensions: await host.readResourceExtensions(key.id)} : {})})));
        return json({keys, ready: ready(), published: ready()});
      }
      return write(async () => {
        const input = await ctx.request.json() as {name: string; expiresAt?: number | null};
        if (!input || Object.keys(input).some(k => !['name', 'expiresAt'].includes(k)) || typeof input.name !== 'string'
          || !input.name.trim() || input.name.length > 128 || /[\x00-\x1f\x7f]/.test(input.name)) return json({error: 'invalid_key_name'}, 422);
        const expiresAt = input.expiresAt ?? null, now = Date.now();
        if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) return json({error: 'invalid_expiration'}, 422);
        const next = current(state);
        if (next.credentials.some(key => key.name.trim() === input.name.trim())) return json({error: 'key_name_exists'}, 409);
        const token = `bng_data_${randomBytes(32).toString('base64url')}`;
        const key: AccessCredential = {id: randomUUID(), domain: 'data', name: input.name.trim(), prefix: token.slice(0, 17),
          digest: createHash('sha256').update(token).digest('hex'), createdAt: now, expiresAt, revokedAt: null, credentialVersion: 1};
        next.credentials.push(key);
        // A partially completed UI flow must never grant broader access.
        next.byKey[key.id] = {routes: [], models: null};
        try { await host.secretStore.compareAndSet('credential:' + key.id, null, token); }
        catch { return json({error: 'key_secret_unavailable'}, 503); }
        try { return await save(next, {key: metadata(key), token}, 201); }
        catch (error) {
          // A failed publication still persisted the credential; only clean up an uncommitted secret.
          if (!current(state).credentials.some(item => item.id === key.id)) {
            const stored = await host.secretStore.get('credential:' + key.id);
            if (stored) await host.secretStore.delete('credential:' + key.id, stored.version);
          }
          throw error;
        }
      });
    }},
    {path: '/credentials/:keyId', methods: ['GET', 'PUT', 'DELETE'], handler: 'credential', async invoke(ctx) {
      const id = keyId(ctx.request);
      if (ctx.request.method === 'GET') {
        const key = current(state).credentials.find(key => key.id === id);
        if (!key) return json({error: 'key_not_found'}, 404);
        try {
          const stored = await host.secretStore.get('credential:' + id);
          if (!stored) return json({error: 'key_secret_not_stored'}, 409);
          if (!current(state).credentials.some(key => key.id === id)) return json({error: 'key_not_found'}, 404);
          if (createHash('sha256').update(stored.value).digest('hex') !== key.digest) return json({error: 'key_secret_unavailable'}, 503);
          return json({token: stored.value});
        } catch { return json({error: 'key_secret_unavailable'}, 503); }
      }
      return write(async () => {
        const next = current(state), key = next.credentials.find(key => key.id === id);
        if (ctx.request.method === 'DELETE') {
          next.credentials = next.credentials.filter(key => key.id !== id);
          delete next.byKey[id];
          const result = await save(next, {deleted: true, id});
          try {
            const stored = await host.secretStore.get('credential:' + id);
            if (stored) await host.secretStore.delete('credential:' + id, stored.version);
          } catch { return json({...await result.json(),error:'key_secret_cleanup_pending', persisted:true, deleted:true, id}, 503); }
          return result;
        }
        if (!key || key.revokedAt !== null) return json({error:'key_not_found'}, 404);
        const input = await ctx.request.json();
        if (!input || Object.keys(input).some(k => !['name','expiresAt','routes','models'].includes(k)) || typeof input.name !== 'string'
          || !input.name.trim() || input.name.length > 128 || /[\x00-\x1f\x7f]/.test(input.name)) return json({error:'invalid_key_name'},422);
        if (next.credentials.some(other => other.id !== id && other.name.trim() === input.name.trim())) return json({error: 'key_name_exists'}, 409);
        const expiresAt = input.expiresAt ?? null;
        if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || (expiresAt <= Date.now() && expiresAt !== key.expiresAt))) return json({error:'invalid_expiration'},422);
        const value = validatePolicy({routes: input.routes, models: input.models});
        if (!host.validateKeyPolicyReferences) return json({error:'reference_validator_unavailable'},503);
        if (!await host.validateKeyPolicyReferences(id,value)) return json({error:'invalid_references'},422);
        key.name = input.name.trim(); key.expiresAt = expiresAt; next.byKey[id] = value;
        return save(next,{key: metadata(key),value});
      });
    }},
    {path: '/routes', methods: ['GET', 'PUT'], handler: 'routeProtection', async invoke(ctx) {
      if (ctx.request.method === 'GET') { const value = current(state); return json({protectedRouteIds: value.protectedRouteIds, routeKeyBindings: routeKeyBindings(value), version: policy().version, ready: ready(), published: ready()}); }
      return write(async () => {
        const input = await ctx.request.json();
        if (!input || Object.keys(input).join() !== 'protectedRouteIds') return json({error: 'invalid_routes'}, 422);
        const protectedRouteIds = stringIds(input.protectedRouteIds);
        if (!host.validateRouteReferences) return json({error: 'reference_validator_unavailable'}, 503);
        if (!await host.validateRouteReferences(protectedRouteIds)) return json({error: 'invalid_references'}, 422);
        const value = current(state), bindings = routeKeyBindings(value);
        const blockedRouteIds = value.protectedRouteIds.filter(id => !protectedRouteIds.includes(id) && bindings[id]!.length > 0);
        if (blockedRouteIds.length) return json({error:'route_has_api_keys', blockedRouteIds, routeKeyBindings: bindings},409);
        const next = {...value, protectedRouteIds};
        return save(next, {protectedRouteIds, routeKeyBindings: routeKeyBindings(next)});
      });
    }},
    {path: '/route-key', methods: ['PUT'], handler: 'applyRouteKey', async invoke(ctx) {
      return write(async () => {
        const input = await ctx.request.json();
        if (!input || Object.keys(input).some(k => !['routeId','keyId','protect'].includes(k))
          || typeof input.routeId !== 'string' || typeof input.keyId !== 'string' || typeof input.protect !== 'boolean') return json({error:'invalid_binding'},422);
        const next = current(state);
        if (!next.credentials.some(key => key.id === input.keyId && key.revokedAt === null)) return json({error:'key_not_found'},404);
        if (!host.validateRouteReferences || !host.validateKeyPolicyReferences) return json({error:'reference_validator_unavailable'},503);
        if (!await host.validateRouteReferences([input.routeId])) return json({error:'invalid_references'},422);
        if (!next.protectedRouteIds.includes(input.routeId) && !input.protect) return json({error:'route_protection_confirmation_required'},409);
        const previous = validatePolicy(next.byKey[input.keyId] ?? null);
        const value = {routes: previous?.routes == null ? null : [...new Set([...previous.routes,input.routeId])], models:previous?.models ?? null};
        if (!await host.validateKeyPolicyReferences(input.keyId,value)) return json({error:'invalid_references'},422);
        next.byKey[input.keyId] = value;
        next.protectedRouteIds = [...new Set([...next.protectedRouteIds,input.routeId])];
        return save(next,{protectedRouteIds:next.protectedRouteIds,routeKeyBindings:routeKeyBindings(next)});
      });
    }},
    {path: '/keys/:keyId', methods: ['GET', 'PUT'], handler: 'keyPolicy', async invoke(ctx) {
      const id = keyId(ctx.request);
      if (ctx.request.method === 'GET') return json({keyId: id, version: policy().version, value: current(state).byKey[id] ?? null, active: ready(), ready: ready()});
      return write(async () => {
        const next = current(state);
        if (!next.credentials.some(key => key.id === id && key.revokedAt === null)) return json({error: 'key_not_found'}, 404);
        const value = validatePolicy(await ctx.request.json());
        if (!host.validateKeyPolicyReferences) return json({error: 'reference_validator_unavailable'}, 503);
        if (!await host.validateKeyPolicyReferences(id, value)) return json({error: 'invalid_references'}, 422);
        next.byKey[id] = value;
        return save(next, {keyId: id, value, active: true});
      });
    }},
  ],
    async start() { if (host.signal.aborted) throw new Error('inactive'); await publish(); running = true; },
    dispose() { running = false; },
  };
}
export function readResource(resource: string, keyId: string, state: ReadState) {
  if (resource !== 'api-key') throw new Error('resource_not_supported');
  return {value: current(state).byKey[keyId] ?? null};
}
export function readResourceCollection(resource: string, state: ReadState): readonly unknown[] {
  if (resource !== 'api-key') throw new Error('resource_not_supported');
  return current(state).credentials.map(metadata);
}
export function readAdmissionRequirements(state: ReadState): readonly string[] { return current(state).protectedRouteIds; }
export function verifyDataPrincipal(principal: DataPrincipal, state: ReadState): boolean { return validPrincipal(principal, current(state), Date.now()); }
export default {createControl, readResource, readResourceCollection, readAdmissionRequirements, verifyDataPrincipal};
