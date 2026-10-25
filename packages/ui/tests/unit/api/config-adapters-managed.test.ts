import { describe, expect, test } from 'bun:test';
import type { ConfigurationService, ConfigurationUpstream, LogicalConfiguration, ConfigurationRoute } from '@jeffusion/bungee-types';
import {
  cloneUpstreamDraft, duplicateEditorUpstream, ManagedBindingError,
  toEditorService, toEditorRoute, toEditorUpstream, toV2Service, toV2Route,
} from '../../../src/api/config-adapters';

const endpoint: ConfigurationUpstream = {
  id: 'endpoint', position: 0, target: 'https://managed.example.test/backend',
  weight: 100, priority: 1, is_disabled: false,
  managedBy: { plugin: 'provider', contributionId: 'accounts', bindingId: 'binding' },
  plugins: [
    { id: 'binding', position: 0, name: 'provider', enabled: false,
      options: { accountRef: '<unresolved-account>', unknown: { nested: ['keep', 42, false] } } },
    { id: 'other', position: 1, name: 'other-plugin', enabled: true, options: { future: null } },
  ],
};
const service: ConfigurationService = { id: 'service', position: 0, name: 'managed', endpoints: [endpoint], plugins: [] };
const logical: LogicalConfiguration = { services: [service], routes: [], plugins: [] };

describe('managed endpoint editor contract', () => {
  test('service and route roundtrip retain marker, inactive bindings and unknown options', () => {
    expect(toV2Service(toEditorService(service), service, 0)).toEqual(service);
    const route: ConfigurationRoute = { id: 'route', position: 0, path: '/managed', endpoints: [endpoint], plugins: [] };
    expect(toV2Route(toEditorRoute(route, []), logical, route, 0)).toEqual(route);
  });

  test('mixed route roundtrip retains upstreams, references, and management markers', () => {
    const reference = { id: 'reference', position: 2, service_id: 'service', weight: 100, priority: 1, is_disabled: false };
    const route: ConfigurationRoute = { id: 'route', position: 0, path: '/mixed',
      endpoints: [endpoint], service_references: [reference], plugins: [] };
    expect(toV2Route(toEditorRoute(route, []), logical, route, 0)).toEqual(route);
  });

  test('new mixed route endpoints receive positions after its references', () => {
    const saved = toV2Route({
      path: '/mixed',
      service_references: [{ id: 'reference', position: 2, service_id: 'service', weight: 100, priority: 1, is_disabled: false }],
      endpoints: [{ target: 'https://new.example' }],
    }, logical, undefined, 0);
    expect(saved.endpoints?.[0]?.position).toBe(3);
  });

  test.each(['missing', 'id', 'name', 'duplicate'] as const)('rejects %s bindings on read and write', mode => {
    const broken = structuredClone(endpoint);
    Object.assign(broken, { plugins: mode === 'missing' ? undefined : mode === 'duplicate'
      ? [broken.plugins[0], broken.plugins[0]]
      : [{ ...broken.plugins[0], ...(mode === 'id' ? { id: 'wrong' } : { name: 'wrong' }) }] });
    expect(() => toEditorUpstream(broken)).toThrow(ManagedBindingError);
    const draft = toEditorService(service);
    draft.endpoints[0].plugins = mode === 'missing' ? undefined : mode === 'duplicate'
      ? [draft.endpoints[0].plugins![0], draft.endpoints[0].plugins![0]]
      : [{ _uid: mode === 'id' ? 'wrong' : 'binding', name: mode === 'name' ? 'wrong' : 'provider' }];
    expect(() => toV2Service(draft, service, 0)).toThrow(ManagedBindingError);
  });

  test('does not silently remove an existing management marker', () => {
    const draft = toEditorService(service);
    delete draft.endpoints[0].managedBy;
    expect(() => toV2Service(draft, service, 0)).toThrow(ManagedBindingError);
  });

  test('copy keeps target/account/options and generates distinct endpoint and binding IDs', () => {
    const draft = toEditorService(service);
    const original = cloneUpstreamDraft(draft.endpoints[0]);
    const copy = duplicateEditorUpstream(draft.endpoints[0]);
    draft.endpoints.push(copy);
    const saved = toV2Service(draft, service, 0).endpoints[1];
    expect(saved.id).not.toBe(endpoint.id);
    expect(saved.id).toBe(copy._uid!);
    expect(saved.target).toBe(endpoint.target);
    expect(saved.managedBy?.bindingId).toBe(saved.plugins[0].id);
    expect(saved.plugins.map(p => p.id).every(id => !endpoint.plugins.some(p => p.id === id))).toBe(true);
    expect(new Set([saved.id, ...saved.plugins.map(p => p.id)]).size).toBe(3);
    expect(saved.plugins.map(({ id, ...p }) => p)).toEqual(endpoint.plugins.map(({ id, ...p }) => p));
    expect(draft.endpoints[0]).toEqual(original);
  });

  test('cancelled nested edits never change the source or baseline', () => {
    const editor = toEditorUpstream(endpoint);
    const draft = cloneUpstreamDraft(editor);
    const plugin = draft.plugins![0];
    if (typeof plugin === 'string') throw new Error('Expected binding');
    (plugin.options!.unknown as { nested: unknown[] }).nested.push('discarded');
    draft.managedBy = { ...draft.managedBy!, contributionId: 'discarded' };
    draft.weight = 7;
    expect(editor).toEqual(toEditorUpstream(endpoint));
    const editorPlugin = editor.plugins![0];
    if (typeof editorPlugin === 'string') throw new Error('Expected binding');
    editorPlugin.options!.accountRef = 'draft-only';
    expect(endpoint.plugins[0].options!.accountRef).toBe('<unresolved-account>');
  });
});
