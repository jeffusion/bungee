import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localAdmissionSelector } from '../fixtures/public-listener';
import { fileURLToPath } from 'node:url';
import '../helpers/data-plane-runtime';
import {expect, test} from 'bun:test';
import {createHash, randomUUID} from 'node:crypto';
import {DataAdmissionHost, type AdmissionPluginPublication} from '../../src/data-admission/host';
import {createDataAdmissionRpcServer, createSignedWorkerRpcClient, DATA_ADMISSION_RPC_PATH, parseAdmissionTarget} from '../../src/data-admission/rpc';
import {WorkerRequestAdmission, setWorkerAdmissionSession} from '../../src/data-admission/worker';
import {generateWorkerTransportSecret, restoreWorkerTransportRequest, getTrustedDataIdentity} from '../../src/config-worker/private-transport';
import {privateRequestHeaders} from '../../src/public-listener/headers';
import {createPublicRequestForwarder} from '../../src/public-listener/forwarding';
import {handleRequest} from '../../src/worker/request/handler';
import {ANONYMOUS_PRINCIPAL, type AdmissionTarget} from '../../src/plugin-extensions';
import {ScopedPluginRegistry, setScopedPluginRegistry} from '../../src/scoped-plugin-registry';
import type {AppConfig} from '@jeffusion/bungee-types';
import type {RateLimitWorkerIdentity} from '../../src/rate-limit';
import {createIngress as accessIngress, type AccessPublication} from '../../../../plugins/key-access/server/policy';
import {createIngress as rateIngress} from '../../../../plugins/key-rate-limit/server/policy';
import {createIngress as budgetIngress} from '../../../../plugins/token-budget/server/policy';
const token = `bng_data_${'A'.repeat(43)}`;
const principal = {domain: 'data', keyId: 'key', credentialVersion: 1};
const worker: RateLimitWorkerIdentity = {role: 'worker', master_generation: randomUUID(), process_instance_id: randomUUID(), boot_nonce: randomUUID(), worker_slot: 0};
const catalogHash = 'a'.repeat(64);
const target = (): AdmissionTarget => ({requestId: randomUUID(), attemptId: randomUUID(), principal, routeId: 'route', serviceId: 'service', upstreamId: 'up', url: 'http://127.0.0.1/test', model: 'm', now: Date.now()});
function access(): AccessPublication {return {protectedRouteIds: ['route', 'other'], byKey: {key: {routes: ['route'], models: ['m']}}, credentials: [{id: 'key', domain: 'data', name: 'test', prefix: 'bng_data_A', digest: createHash('sha256').update(token).digest('hex'), createdAt: 1, expiresAt: null, revokedAt: null, credentialVersion: 1}]};}
const accessPlugin = (value = access()): AdmissionPluginPublication => ({name: 'key-access', entry: 'access', catalogHash, policy: value as any});
function host() {return new DataAdmissionHost({authorizeWorker: () => 'active', catalogHash: () => catalogHash, loadPlugin: async entry => ({createIngress: entry === 'access' ? accessIngress : entry === 'rate' ? rateIngress : budgetIngress})});}
test('default public and invalid Bearer are anonymous; protection is explicit per route, never per service', async () => {
  const h = host(); await h.publish({version: 1, plugins: []});
  expect(h.authenticate(new Request('http://public', {headers: {authorization: 'Bearer invalid'}}))).toEqual(ANONYMOUS_PRINCIPAL);
  expect(h.admit(target(), worker).principal).toEqual(ANONYMOUS_PRINCIPAL);
  await h.publish({version: 2, plugins: [accessPlugin()], routeRequirements: [{plugin: 'key-access', routeIds: ['route', 'other']}]});
  expect(() => h.admit({...target(), principal: ANONYMOUS_PRINCIPAL}, worker)).toThrow('unauthorized');
  expect(h.admit({...target(), routeId: 'public'}, worker).principal).toEqual(ANONYMOUS_PRINCIPAL);
  expect(() => h.admit({...target(), routeId: 'other'}, worker)).toThrow('key-access.scope_denied');
  expect(h.admit({...target(), serviceId: null}, worker).principal).toEqual(principal);
});
test('public requests carrying valid Keys never consume rate or token budget', async () => {
  const h = host(); await h.publish({version: 1, plugins: [accessPlugin(), {name: 'key-rate-limit', entry: 'rate', catalogHash, policy: {byKey: {key: {rps: 1, burst: 1}}}}, {name: 'token-budget', entry: 'budget', catalogHash, policy: {byKey: {key: {policy: {mode: 'cumulative', limit: 1}, cumulative: 1}}}}]});
  for (let i = 0; i < 3; i++) {
    const grant = h.admit({...target(), routeId: 'public'}, worker);
    expect(grant.principal).toEqual(ANONYMOUS_PRINCIPAL); expect(grant.snapshots['key-rate-limit']).toBeNull(); expect(grant.snapshots['token-budget']).toBeNull();
  }
});
test('persistent protections fail closed when plugin is removed, invalid, or fails publication', async () => {
  const h = host(); await h.publish({version: 1, plugins: [accessPlugin()], routeRequirements: [{plugin: 'key-access', routeIds: ['route']}]});
  await h.publish({version: 2, plugins: []});
  expect(() => h.admit(target(), worker)).toThrow('route_protection_unavailable');
  expect(h.admit({...target(), routeId: 'public'}, worker).principal).toEqual(ANONYMOUS_PRINCIPAL);
  await h.publish({version: 3, plugins: [{...accessPlugin(), policy: null}]});
  expect(() => h.admit(target(), worker)).toThrow('route_protection_unavailable');
  await expect(h.publish({version: 4, plugins: [{...accessPlugin(), catalogHash: 'wrong'}]})).rejects.toThrow();
  expect(h.status().version).toBe(3); expect(() => h.admit(target(), worker)).toThrow('route_protection_unavailable');
});
test('revocation and expiry reject new admissions but existing grants survive, with pinned route and model scopes', async () => {
  const h = host(); await h.publish({version: 1, plugins: [accessPlugin()]}); const t = target(), grant = h.admit(t, worker);
  expect(h.admit(t, worker)).toBe(grant);
  const revoked = access(); revoked.credentials[0]!.revokedAt = Date.now(); revoked.credentials[0]!.credentialVersion++;
  await h.publish({version: 2, plugins: [accessPlugin(revoked)]});
  expect(() => h.admit(target(), worker)).toThrow('unauthorized');
  expect(h.beforeAttempt(t, worker)).toBe(grant);
  expect(() => h.beforeAttempt({...t, routeId: 'other'}, worker)).toThrow('admission_identity_mismatch');
  expect(() => h.beforeAttempt({...t, model: 'm-suffix'}, worker)).toThrow('key-access.scope_denied');
  expect(h.authenticate(new Request('http://localhost', {headers: {authorization: `Bearer ${token}`}}))).toEqual(ANONYMOUS_PRINCIPAL);
  const expired = access(); expired.credentials[0]!.expiresAt = Date.now() - 1;
  await h.publish({version: 3, plugins: [accessPlugin(expired)]}); expect(() => h.admit(target(), worker)).toThrow('unauthorized');
});
test('staged plans are atomic and uncertain state freezes only affected authenticated scope', async () => {
  let reject = true; const states: unknown[] = [];
  const h = new DataAdmissionHost({authorizeWorker: () => 'active', catalogHash: () => catalogHash, loadPlugin: async entry => ({createIngress: () => entry === 'access' ? accessIngress() : entry === 'rate' ? {plan(_t, _p, state) {states.push(state); return {state: Number(state ?? 0)+1, snapshot: true};}} : {plan() {return reject ? {denial: {error: 'rejected', status: 403}} : {snapshot: null};}}})});
  const plugins = [accessPlugin(), {name: 'rate', entry: 'rate', catalogHash, policy: null}, {name: 'gate', entry: 'gate', catalogHash, policy: null}];
  await h.publish({version: 1, plugins}); const t = target(); expect(() => h.admit(t, worker)).toThrow('rejected'); reject = false;
  h.admit(t, worker); expect(states).toEqual([null, null]);
  h.freezePluginKey('rate', principal.keyId); expect(() => h.admit(target(), worker)).toThrow('plugin_state_unavailable');
  await h.publish({version: 2, plugins, unblock: [{plugin: 'rate', keyId: principal.keyId}]}); expect(h.admit(target(), worker)).toBeDefined();
});
test('signed anonymous and Key transport preserve Authorization and reject forged identity', () => {
  const secret = generateWorkerTransportSecret();
  for (const identityPrincipal of [principal, ANONYMOUS_PRINCIPAL]) {
    const requestId = randomUUID(); const request = new Request('http://localhost/test', {headers: {authorization: `Bearer ${token}`, 'x-bungee-internal-data-identity': 'spoof'}});
    const headers = privateRequestHeaders(request, secret, undefined, {requestId, principal: identityPrincipal});
    const restored = restoreWorkerTransportRequest(new Request('http://127.0.0.1/private', {headers}), secret);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(restored.ok).toBe(true); if (restored.ok) {expect(getTrustedDataIdentity(restored.request)?.principal).toEqual(identityPrincipal); expect(restored.request.headers.get('authorization')).toBe(`Bearer ${token}`);}
    headers.set('x-bungee-internal-data-identity', JSON.stringify({requestId: randomUUID(), principal: identityPrincipal}));
    expect(restoreWorkerTransportRequest(new Request('http://127.0.0.1/private', {headers}), secret).ok).toBe(false);
  }
  for (const invalid of [{...ANONYMOUS_PRINCIPAL, keyId: 'key'}, {...ANONYMOUS_PRINCIPAL, credentialVersion: 1}, {...ANONYMOUS_PRINCIPAL, extra: true}]) {
    const request = new Request('http://localhost/test');
    const headers = privateRequestHeaders(request, secret, undefined, {requestId: randomUUID(), principal: invalid});
    expect(restoreWorkerTransportRequest(new Request('http://127.0.0.1/private', {headers}), secret).ok).toBe(false);
  }
  expect(parseAdmissionTarget({...target(), principal: ANONYMOUS_PRINCIPAL}).principal).toEqual(ANONYMOUS_PRINCIPAL);
  expect(() => parseAdmissionTarget({...target(), principal: {...ANONYMOUS_PRINCIPAL, keyId: 'key'}})).toThrow();
});
test('worker prepare uses effective anonymous identity and publication changes cancel and retry before atomic debit', async () => {
  let plans = 0, prepared = 0, cancelled = 0;
  const h = new DataAdmissionHost({authorizeWorker: () => 'active', catalogHash: () => catalogHash, loadPlugin: async () => ({createIngress: () => ({plan(_t, _p, state) {plans++; return {state: Number(state ?? 0)+1, snapshot: true};}})})});
  const plugins = [{name: 'test', entry: 'test', catalogHash, policy: null}]; await h.publish({version: 1, plugins});
  const secret = generateWorkerTransportSecret(), identity = {role: 'ingress' as const, process_instance_id: randomUUID(), boot_nonce: randomUUID()};
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: createDataAdmissionRpcServer({host: h, transportSecret: secret, identity, authorizeWorker: () => 'active'})});
  try {
    const rpc = createSignedWorkerRpcClient({transportSecret: secret, worker, expectedServer: identity, url: `http://127.0.0.1:${server.port}${DATA_ADMISSION_RPC_PATH}`});
    setWorkerAdmissionSession({admission: rpc}); const t = target();
    const admission = new WorkerRequestAdmission([{pluginName: 'test', async prepareAdmissionAttempt({target}) {expect(target.principal).toEqual(ANONYMOUS_PRINCIPAL); prepared++; if (prepared === 1) await h.publish({version: 2, plugins}); return {async cancel() {cancelled++;}};}}], t);
    await admission.prepare({...t, body: {}}, new AbortController().signal);
    expect(prepared).toBe(2); expect(cancelled).toBe(1); expect(plans).toBe(3);
    h.freeze(); expect(() => h.admit(target(), worker)).toThrow('admission_state_unavailable'); expect(h.beforeAttempt(t, worker).version).toBe(2);
  } finally {setWorkerAdmissionSession(null); await server.stop(true);}
});
async function pipeline(run: (ctx: {host: DataAdmissionHost; send: (path?: string, authorization?: string, body?: ReadableStream<Uint8Array>) => Promise<Response>; calls: () => number; headers: () => string | null}) => Promise<void>, upstreamFetch?: (request: Request, count: number, host: DataAdmissionHost) => Response | Promise<Response>, retry = false) {
  const secret = generateWorkerTransportSecret(), identity = {role: 'ingress' as const, process_instance_id: randomUUID(), boot_nonce: randomUUID()};
  const h = host(); await h.publish({version: 1, plugins: [accessPlugin()], routeRequirements: [{plugin: 'key-access', routeIds: ['route', 'other']}]});
  let calls = 0, auth: string | null = null;
  const upstream = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {calls++; auth = request.headers.get('authorization'); return upstreamFetch?.(request, calls, h) ?? Response.json({ok: true});}});
  const rpcServer = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: createDataAdmissionRpcServer({host: h, transportSecret: secret, identity, authorizeWorker: () => 'active'})});
  const registry = new ScopedPluginRegistry(fileURLToPath(new URL('../../../../plugins', import.meta.url)));
  await registry.initializeFromConfig({plugins: [{name: 'key-access', path: fileURLToPath(new URL('../../../../plugins/key-access/server/index.ts', import.meta.url))}]}); setScopedPluginRegistry(registry);
  const config = {services: [{id: 'service', name: 'shared', endpoints: [{id: 'up', target: `http://127.0.0.1:${upstream.port}`}]}], routes: ['route', 'public', 'other'].map(id => ({id, path: '/'+id, service: 'shared', auth: {enabled: false}, ...(retry ? {retry: {enabled: true, max_retries: 1, retry_on: [503]}} : {})}))} as AppConfig;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {const restored = restoreWorkerTransportRequest(request, secret); return restored.ok ? handleRequest(restored.request, config) : new Response(null, {status: restored.status});}});
  const forward = createPublicRequestForwarder({admission: localAdmissionSelector(() => ({private_port: server.port!})), transportSecret: secret, authenticate: h.authenticate.bind(h)});
  const send = (path = 'route', authorization = `Bearer ${token}`, body?: ReadableStream<Uint8Array>) => forward(new Request('http://public/'+path+'/chat/completions', {method: 'POST', headers: {'content-type': 'application/json', ...(authorization ? {authorization} : {})}, body: body ?? JSON.stringify({model: 'm'})}));
  setWorkerAdmissionSession({admission: createSignedWorkerRpcClient({transportSecret: secret, worker, expectedServer: identity, url: `http://127.0.0.1:${rpcServer.port}${DATA_ADMISSION_RPC_PATH}`})});
  try {await run({host: h, send, calls: () => calls, headers: () => auth});} finally {setWorkerAdmissionSession(null); await upstream.stop(true); await rpcServer.stop(true); await server.stop(true); setScopedPluginRegistry(null); await registry.destroy();}
}
test('actual public forwarder and worker permit anonymous/invalid Key on public route and enforce protected scopes', async () => {
  await pipeline(async ({send, calls, headers}) => {
    expect((await send('public', '')).status).toBe(200); expect(headers()).toBeNull();
    expect((await send('public', 'Bearer invalid')).status).toBe(200); expect(headers()).toBe('Bearer invalid');
    expect((await send('public')).status).toBe(200); expect(headers()).toBe(`Bearer ${token}`);
    expect((await send('route', '')).status).toBe(401); expect((await send('other')).status).toBe(403);
    expect((await send()).status).toBe(200); expect(calls()).toBe(4); expect(headers()).toBe(`Bearer ${token}`);
  });
});
test('actual public forwarder and worker pass upstream Authorization through without access control', async () => {
  await pipeline(async ({host, send, headers}) => {
    await host.publish({version: 2, plugins: []});
    expect((await send('public', 'Basic upstream-credential')).status).toBe(200);
    expect(headers()).toBe('Basic upstream-credential');
  });
});
test('actual slow body admission rejects revoked credential; accepted retry retains original grant', async () => {
  await pipeline(async ({host, send, calls}) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start(c) {controller = c; c.enqueue(new TextEncoder().encode('{"model":'));}});
    const pending = send('route', `Bearer ${token}`, body);
    const revoked = access(); revoked.credentials[0]!.revokedAt = Date.now(); revoked.credentials[0]!.credentialVersion++;
    await host.publish({version: 2, plugins: [accessPlugin(revoked)]}); controller.enqueue(new TextEncoder().encode('"m"}')); controller.close();
    expect((await pending).status).toBe(401); expect(calls()).toBe(0);
  });
  await pipeline(async ({send, calls}) => {expect((await send()).status).toBe(200); expect(calls()).toBe(2);}, async (_req, count, h) => {
    if (count === 1) {const revoked = access(); revoked.credentials[0]!.revokedAt = Date.now(); revoked.credentials[0]!.credentialVersion++; await h.publish({version: 2, plugins: [accessPlugin(revoked)]}); return new Response('retry', {status: 503});}
    return Response.json({ok: true});
  }, true);
});
test('actual accepted stream continues after revocation while next protected request is denied', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  await pipeline(async ({send, host, calls}) => {
    const response = await send(); expect(response.status).toBe(200);
    const revoked = access(); revoked.credentials[0]!.revokedAt = Date.now(); revoked.credentials[0]!.credentialVersion++;
    await host.publish({version: 2, plugins: [accessPlugin(revoked)]}); expect((await send()).status).toBe(401);
    stream.enqueue(new TextEncoder().encode('data: done\n\n')); stream.close(); expect(await response.text()).toContain('done'); expect(calls()).toBe(1);
  }, () => new Response(new ReadableStream({start(controller) {stream = controller; controller.enqueue(new TextEncoder().encode('data: start\n\n'));}}), {headers: {'content-type': 'text/event-stream'}}));
});
test('preview pins admission month while final protected credential expiration uses current clock', async () => {
  let now = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
  const h = new DataAdmissionHost({clock: () => now, authorizeWorker: () => 'active', catalogHash: () => catalogHash,
    loadPlugin: async entry => ({createIngress: entry === 'access' ? accessIngress : () => ({plan(t) {return {snapshot: {month: new Date(t.now).toISOString().slice(0, 7)}};}})})});
  const plugins = [accessPlugin(), {name: 'opaque', entry: 'opaque', catalogHash, policy: null}];
  await h.publish({version: 1, plugins}); const t = target(), preview = h.admit(t, worker, true); now += 2;
  expect(h.admit(t, worker, false, preview.version).snapshots).toEqual(preview.snapshots);
  const expiring = access(); expiring.credentials[0]!.expiresAt = now+1;
  await h.publish({version: 2, plugins: [accessPlugin(expiring)]}); const next = target(); h.admit(next, worker, true); now += 2;
  expect(() => h.admit(next, worker, false, 2)).toThrow('unauthorized');
});
test('lost final-decision ACK replays exact signed operation without duplicate plugin debit', async () => {
  let plans = 0;
  const h = new DataAdmissionHost({authorizeWorker: () => 'active', catalogHash: () => catalogHash,
    loadPlugin: async () => ({createIngress: () => ({plan(_t, _p, state) {plans++; return {state: Number(state ?? 0)+1, snapshot: null};}})})});
  await h.publish({version: 1, plugins: [{name: 'rate', entry: 'rate', catalogHash, policy: null}]});
  const secret = generateWorkerTransportSecret(), identity = {role: 'ingress' as const, process_instance_id: randomUUID(), boot_nonce: randomUUID()};
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: createDataAdmissionRpcServer({host: h, transportSecret: secret, identity, authorizeWorker: () => 'active'})});
  let lost = false;
  const client = createSignedWorkerRpcClient({transportSecret: secret, worker, expectedServer: identity, url: `http://127.0.0.1:${server.port}${DATA_ADMISSION_RPC_PATH}`, fetch: async (input, init) => {
    const response = await fetch(input, init);
    if (!lost && JSON.parse(String(init?.body)).proof.body.policy_id === 'admit') {lost = true; await response.text(); throw new Error('ACK lost');}
    return response;
  }});
  try {const t = target(), preview = await client('preview', t) as {version: number}; await client('admit', {target: t, version: preview.version}); expect(lost).toBe(true); expect(plans).toBe(2);}
  finally {await server.stop(true);}
});
test('worker-set changes gate new requests and existing grants retain retired plugin snapshots', async () => {
  let sequence = 1, currentWorker = worker;
  const replacement = {...worker, process_instance_id: randomUUID(), boot_nonce: randomUUID()};
  const h = new DataAdmissionHost({admissionSequence: () => sequence, authorizeWorker: w => w.process_instance_id === currentWorker.process_instance_id ? 'active' : 'retired', catalogHash: () => catalogHash,
    loadPlugin: async () => ({createIngress: () => ({plan() {return {snapshot: {upstream: 'up'}};}, beforeAttempt(t, snapshot) {return (snapshot as any).upstream === t.upstreamId ? null : {status: 403, error: 'old_scope'};}})})});
  await h.publish({version: 1, admissionSequence: 1, plugins: [{name: 'generic', entry: 'generic', catalogHash, policy: null}]}); const t = target(); h.admit(t, worker);
  await h.publish({version: 2, admissionSequence: 2, plugins: []}); expect(() => h.admit(target(), worker)).toThrow('admission_worker_set_changed'); sequence = 2; currentWorker = replacement;
  expect(h.admit(target(), replacement).snapshots).toEqual({}); expect(h.beforeAttempt(t, worker).snapshots.generic).toEqual({upstream: 'up'});
  expect(() => h.beforeAttempt({...t, upstreamId: 'elsewhere'}, worker)).toThrow('old_scope');
});

test('separately bundled access plugin preserves 401 denial across artifact boundaries', async () => {
  const {mkdtemp,rm} = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'bungee-admission-artifact-'));
  try {
    const output = join(directory, 'ingress.js');
    const built = await Bun.build({entrypoints:[fileURLToPath(new URL('../../../../plugins/key-access/server/policy.ts', import.meta.url))],outdir:directory,naming:'ingress.js',target:'bun'});
    expect(built.success).toBe(true);
    const h = new DataAdmissionHost({authorizeWorker:()=> 'active',catalogHash:()=> catalogHash});
    await h.publish({version:1,plugins:[{...accessPlugin(),entry:output}]});
    try {h.admit({...target(),principal:ANONYMOUS_PRINCIPAL},worker);throw Error('unexpected admission');}
    catch(error) {expect(error).toMatchObject({status:401,code:'unauthorized'});}
    expect(h.admit(target(),worker).principal).toEqual(principal);
  } finally {await rm(directory,{recursive:true,force:true});}
});
