import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {createIngress, validatePolicy, type AccessPublication} from '../../server/policy';
import {ANONYMOUS_PRINCIPAL} from '../../../../packages/core/src/plugin-extensions';
const token = `bng_data_${'A'.repeat(43)}`;
const target = {requestId: 'r', attemptId: 'a', principal: {domain: 'data', keyId: 'k', credentialVersion: 1}, routeId: 'route', serviceId: 'service', upstreamId: 'u', url: 'https://example.test', model: 'model', now: 10};
function publication(): AccessPublication { return {protectedRouteIds: ['route', 'other'], byKey: {k: {routes: ['route'], models: ['model']}}, credentials: [{id: 'k', domain: 'data', name: 'key', prefix: 'bng_data_A', digest: createHash('sha256').update(token).digest('hex'), createdAt: 1, expiresAt: null, revokedAt: null, credentialVersion: 1}]}; }
test('only explicit protected routes authenticate; same service routes remain independent', () => {
  const plugin = createIngress(), value = publication();
  expect(plugin.authenticate!(new Request('https://example.test', {headers: {authorization: `Bearer ${token}`}}), value as any, 10)).toEqual(target.principal);
  expect(plugin.resolveIdentity!({...target, routeId: 'public'}, value as any)).toEqual(ANONYMOUS_PRINCIPAL);
  expect(plugin.plan({...target, principal: ANONYMOUS_PRINCIPAL, routeId: 'public'}, value as any, null)).toEqual({snapshot: null});
  expect(() => plugin.resolveIdentity!({...target, principal: ANONYMOUS_PRINCIPAL}, value as any)).toThrow('unauthorized');
  const plan = plugin.plan(target, value as any, null);
  expect(plan.denial).toBeUndefined();
  for (const patch of [{model: 'model-2026'}, {routeId: 'other'}]) expect(plugin.beforeAttempt!({...target, ...patch}, plan.snapshot!)).toMatchObject({status: 403});
  expect(plugin.plan({...target, routeId: 'other'}, value as any, null).denial).toMatchObject({status: 403});
  expect(plugin.plan({...target, serviceId: null}, value as any, null).denial).toBeUndefined();
});
test('revoking the last credential preserves route protection and existing pinned grants', () => {
  const plugin = createIngress(), value = publication(), plan = plugin.plan(target, value as any, null);
  value.credentials[0]!.revokedAt = 5; value.credentials[0]!.credentialVersion = 2;
  expect(() => plugin.resolveIdentity!(target, value as any)).toThrow('unauthorized');
  expect(value.protectedRouteIds).toEqual(['route', 'other']);
  expect(plugin.beforeAttempt!(target, plan.snapshot!)).toBeNull();
});
test('scope null is unrestricted, empty array denies all, service and unknown fields are rejected', () => {
  expect(validatePolicy({routes: null, models: null})).toEqual({routes: null, models: null});
  expect(validatePolicy({routes: [], models: []})).toEqual({routes: [], models: []});
  expect(() => validatePolicy({services: ['service'], routes: null, models: null})).toThrow();
  expect(() => validatePolicy({routes: null})).toThrow();
});

test('model wildcards apply both at admission and to final attempts, with literal punctuation', () => {
  const plugin = createIngress();
  const cases: [string, string, boolean][] = [
    ['gpt-*', 'gpt-4.1-mini', true], ['gpt-*', 'GPT-4.1', false],
    ['gpt-4.1', 'gpt-4.1-mini', false], ['*mini', 'gpt-4.1-mini', true],
    ['gpt-*-mini', 'gpt-4.1-mini', true], ['gpt-*-mini', 'gpt-mini', false],
    ['gpt-**', 'gpt-', true], ['*a', 'aaa', true], ['ab*bc', 'abc', false],
    ['gpt-4.*', 'gpt-4x1', false], ['model[1]?', 'model[1]?', true],
    ['model[1]?', 'model1x', false], ['*', 'any-model', true],
  ];
  for (const [pattern, model, allowed] of cases) {
    const value = publication(); value.byKey.k = {routes: ['route'], models: [pattern]};
    expect(plugin.plan({...target, model}, value as any, null).denial === undefined).toBe(allowed);
    expect(plugin.beforeAttempt!({...target, model}, {routeId: 'route', policy: value.byKey.k} as any) === null).toBe(allowed);
  }
  const value = publication(); value.byKey.k = {routes: ['route'], models: ['gpt-*', 'gemini-*']};
  const plan = plugin.plan({...target, model: 'gpt-4.1'}, value as any, null);
  expect(plugin.beforeAttempt!({...target, model:'gemini-pro'}, plan.snapshot!)).toBeNull();
  expect(plugin.beforeAttempt!({...target, model:'other'}, plan.snapshot!)).toMatchObject({status:403});
  value.byKey.k.models = ['*'];
  expect(plugin.plan({...target, model:null}, value as any, null).denial).toMatchObject({status:403});
  value.byKey.k.models = [];
  expect(plugin.plan(target, value as any, null).denial).toMatchObject({status:403});
});
