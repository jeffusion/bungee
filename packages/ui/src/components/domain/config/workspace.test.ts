import { expect, test } from 'bun:test';
import { configurationDiff, parseImportPreview, publicationBusy, servingStatus, readPendingPublication } from './workspace';
import { toggleAuth } from './auth-value';
import { bytesToKiB, kibToBytes, resolveLoggingBody } from './logging-body';
import { publicationFixture } from '../../../../tests/fixtures/publication';

test('legacy UUID is unaccepted; absent, corrupt and unavailable storage are distinct', () => {
  const mutationId = '10000000-0000-4000-8000-000000000001';
  expect(readPendingPublication({ getItem: () => mutationId })).toEqual({ mutationId, accepted: false });
  expect(readPendingPublication({ getItem: () => null })).toBeNull();
  for (const value of ['', 'secret', '{}', 'null', JSON.stringify({ version: 2, mutationId, accepted: true }),
    JSON.stringify({ version: 1, mutationId, accepted: false }), JSON.stringify({ version: 1, mutationId, accepted: true, token: 'secret' })]) {
    expect(() => readPendingPublication({ getItem: () => value })).toThrow();
  }
  expect(() => readPendingPublication({ getItem() { throw new Error('denied'); } })).toThrow();
});

test('structural diff redacts auth, plugin options, headers and arbitrary strings including additions', () => {
  const secret = 'do-not-render-private-value';
  const before = { logical_configuration: { auth: { enabled: true, tokens: ['old'] }, routes: [], services: [], plugins: [] }, plugin_activations: [] };
  const after = { logical_configuration: { auth: { enabled: false, tokens: [secret] }, routes: [{ id: 'id', path: secret, headers: { Authorization: secret } }], services: [], plugins: [{ options: { apiKey: secret } }] }, plugin_activations: [{ plugin_name: 'example' }] };
  const diff = configurationDiff(before, after);
  expect(JSON.stringify(diff)).not.toContain(secret);
  expect(diff.some(d => d.label === 'authTokens' && d.after === 'hidden')).toBe(true);
  expect(diff.find(d => d.label === 'authEnabled')).toMatchObject({ before: 'on', after: 'off' });
  expect(diff.some(d => d.label === 'activations')).toBe(true);
  expect(configurationDiff({ plugin_activations: [{ plugin_name: 'a' }, { plugin_name: 'b' }] }, { plugin_activations: [{ plugin_name: 'b' }, { plugin_name: 'a' }] })).toMatchObject([{ action: 'reordered' }]);
});

test('51200 bytes ↔ 50 KiB exactly; invalid values are rejected', () => {
  expect(bytesToKiB(51200)).toBe(50);
  expect(kibToBytes(bytesToKiB(51200)!)).toBe(51200);
  expect(bytesToKiB(undefined)).toBeUndefined();
  expect(() => kibToBytes(NaN)).toThrow();
  expect(() => kibToBytes(101)).toThrow();
});

test('disabling auth retains all tokens until explicit deletion', () => {
  const original = { enabled: true, tokens: ['one', 'two'] };
  expect(toggleAuth(original, false)).toEqual({ enabled: false, tokens: ['one', 'two'] });
  expect(original.enabled).toBe(true);
});

test('viewing defaults and cancelling a copied draft does not materialize defaults', () => {
  const aggregate = { logical_configuration: { routes: [], services: [], plugins: [] }, plugin_activations: [] };
  const initial = JSON.stringify(aggregate);
  const copy = structuredClone(aggregate);
  resolveLoggingBody(undefined);
  expect(configurationDiff(aggregate, copy)).toEqual([]);
  expect(JSON.stringify(copy)).toBe(initial);
});

test('file selection and cancellation are a local preview, not an import write', () => {
  const aggregate = { logical_configuration: { routes: [], services: [], plugins: [] }, plugin_activations: [] };
  const envelope = { format: 'bungee-config-snapshot', format_version: 1, schema_version: 2, exported_at: 1,
    source_revision: 7, content_hash: `sha256:${'a'.repeat(64)}`, envelope_hash: `sha256:${'b'.repeat(64)}`, aggregate };
  expect(parseImportPreview(JSON.stringify(envelope)).aggregate).toEqual(aggregate);
  expect(() => parseImportPreview(JSON.stringify({ aggregate }))).toThrow();
  expect(() => parseImportPreview(JSON.stringify({ ...envelope, extra: true }))).toThrow();
});

test('publication and serving are independent; stale reads are never green; degraded is terminal', () => {
  const p = publicationFixture({ serving_complete: false, serving_revision: null,
    operation: { operation_id: 'op', committed_revision: 8, state: 'converged', result_status: 200, error_code: null } });
  expect(servingStatus(p, true)).toBe('unconfirmed');
  expect(servingStatus({ ...p, serving_complete: true, serving_revision: 8 }, false)).toBe('unknown');
  expect(servingStatus({ ...p, serving_revision: undefined } as any, true)).toBe('unknown');
  expect(publicationBusy(p)).toBe(false);
  expect(publicationBusy(publicationFixture())).toBe(false);
});
