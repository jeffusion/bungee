import { expect, test } from 'bun:test';
import { configurationDiff, parseImportPreview, publicationBusy } from './workspace';
import { resolveLoggingBody, withLoggingBody } from './logging-body';
import { publicationFixture } from '../../../../tests/fixtures/publication';

const base = () => ({ logical_configuration: { auth: { enabled: true, tokens: ['secret-value'] }, logging: { body: { enabled: true, max_size: 51200 } }, routes: [], services: [], plugins: [] }, plugin_activations: [] });
const envelope = (aggregate: unknown) => JSON.stringify({ format: 'bungee-config-snapshot', format_version: 1, schema_version: 2, exported_at: 1, source_revision: 7, content_hash: `sha256:${'a'.repeat(64)}`, envelope_hash: `sha256:${'b'.repeat(64)}`, aggregate });

test('known degraded terminal does not lock edits; succeeded recovery on a degraded operation is terminal', () => {
  expect(publicationBusy(publicationFixture())).toBe(false);
  expect(publicationBusy(publicationFixture({ recovery: { recovery_id: 'r', target_revision: 8, trigger: 'automatic', state: 'succeeded', attempt_count: 1, max_attempts: 3, next_retry_at: null } }))).toBe(false);
});

test('secret-as-key, dotted keys, numeric secrets and unknown subtrees never reach review output', () => {
  const before = base(), after: any = structuredClone(before);
  after.logical_configuration.auth['secret-as-key-marker'] = true;
  after.logical_configuration.auth['tokens.enabled'] = 8675309;
  after.logical_configuration.unknown = { innocuous: 987654321, 'nested.secret-key': 'hidden-value-marker' };
  const output = JSON.stringify(configurationDiff(before, after));
  for (const value of ['secret-as-key-marker', 'tokens.enabled', '8675309', '987654321', 'nested.secret-key', 'hidden-value-marker']) expect(output).not.toContain(value);
});

test('known storage limit has a readable KiB summary', () => {
  const before = base(), after = structuredClone(before); after.logical_configuration.logging.body.max_size = 53248;
  expect(JSON.stringify(configurationDiff(before, after))).toContain('50 KiB');
  expect(JSON.stringify(configurationDiff(before, after))).toContain('52 KiB');
});

test('resource additions identify their safe identity and action, not just a masked scalar', () => {
  const before = base(), after: any = structuredClone(before);
  after.logical_configuration.routes = [{ id: 'route-one', path: '/v1/chat', plugins: [] }];
  after.logical_configuration.services = [{ id: 'service-one', name: 'OpenAI', endpoints: [], plugins: [] }];
  after.plugin_activations = [{ plugin_name: 'chatgpt-oauth' }];
  const output = configurationDiff(before, after) as any[];
  expect(output.some(row => row.action === 'added' && row.identity === '/v1/chat')).toBe(true);
  expect(output.some(row => row.action === 'added' && row.identity === 'OpenAI')).toBe(true);
  expect(output.some(row => row.action === 'added' && row.identity === 'chatgpt-oauth')).toBe(true);
});

test('large, deeply nested or excessive-item files are rejected before preview', () => {
  const deep: any = base(); let cursor = deep.logical_configuration;
  for (let i = 0; i < 50; i++) { cursor.extra = {}; cursor = cursor.extra; }
  expect(() => parseImportPreview(envelope(deep))).toThrow();
  expect(() => parseImportPreview(envelope({ ...base(), unknown: 'x'.repeat(2_000_000) }))).toThrow();
  const many: any = base(); many.logical_configuration.routes = Array.from({ length: 2000 }, () => ({ path: '/test' }));
  expect(() => parseImportPreview(envelope(many))).toThrow();
});

test('clearing an optional logging field deletes it and preserves display defaults', () => {
  const next = withLoggingBody({ body: { enabled: true, max_size: 51200 } }, { max_size: undefined });
  expect(Object.hasOwn(next.body, 'max_size')).toBe(false);
  expect(resolveLoggingBody(next).max_size).toBe(5120);
  expect(resolveLoggingBody({ body: { enabled: true, max_size: undefined, retention_days: undefined } })).toEqual({ enabled: true, max_size: 5120, retention_days: 1 });
});

test('resource removal and modification follow identity rather than shifted indices', () => {
  const before: any = base();
  before.logical_configuration.services = [{ id: 'service-a', name: 'Alpha', endpoints: [], plugins: [] }, { id: 'service-b', name: 'Beta', endpoints: [], plugins: [] }];
  const after = structuredClone(before); after.logical_configuration.services.shift();
  after.logical_configuration.services[0].endpoints.push({ id: 'endpoint', credentials: 'private-marker' });
  const diff = configurationDiff(before, after);
  expect(diff.filter(d => d.action === 'removed').map(d => d.identity)).toEqual(['Alpha']);
  expect(diff.find(d => d.action === 'changed' && d.identity === 'Beta')?.endpoints).toEqual([0, 1]);
  expect(JSON.stringify(diff)).not.toContain('private-marker');
});

test('invalid identities and credential collisions remain unidentified', () => {
  const before: any = base(), after = structuredClone(before);
  after.logical_configuration.routes = [{ path: '/v1?token=secret-value' }, { path: '/bad\npath' }];
  after.logical_configuration.services = [{ name: 987654321 }, { name: 'A'.repeat(200) }, { name: 'secret-value' }];
  expect(configurationDiff(before, after).every(row => row.identity === undefined)).toBe(true);
});

test('object key ordering is not a configuration change; array ordering is a safe summary', () => {
  const before: any = base(), after = structuredClone(before);
  before.logical_configuration.unknown = { b: 1, a: 2 }; after.logical_configuration.unknown = { a: 2, b: 1 };
  expect(configurationDiff(before, after)).toEqual([]);
  before.plugin_activations = [{ plugin_name: 'alpha' }, { plugin_name: 'beta' }]; after.plugin_activations = [...before.plugin_activations].reverse();
  expect(configurationDiff(before, after)).toMatchObject([{ label: 'activations', action: 'reordered', count: 2 }]);
});
