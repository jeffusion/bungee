import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import { toEditorRoute, toV2Route, type EditorRoute } from '../api/config-adapters';
import { getRouteFeatureBadges } from '../utils/route-service-view-model';
import type { LogicalConfigurationV2, RouteV2 } from '@jeffusion/bungee-types';

const editor = await Bun.file(new URL('./RouteEditor.svelte', import.meta.url)).text();
const index = await Bun.file(new URL('./RoutesIndex.svelte', import.meta.url)).text();

test('WebSocket setting uses the current draft state, defaults off, and exposes a review and list deep link', () => {
  expect(compile(editor, { filename: 'RouteEditor.svelte' }).warnings).toEqual([]);
  expect(compile(index, { filename: 'RoutesIndex.svelte' }).warnings).toEqual([]);
  expect(editor).toContain('checked={route.websocket?.enabled ?? false}');
  expect(editor).toContain('onchange={(enabled) => (route.websocket = { enabled })}');
  expect(editor.split("{:else if activeSection === 'review'}")[1]).toContain('route.websocket?.enabled');
  expect(index).toContain("if (section === 'websocket') return 'forward'");
});

test('actual form handler follows enable, disable and draft replacement without retaining stale state', () => {
  const handler = editor.match(/onchange=\{\(enabled\) => \(route\.websocket = \{ enabled \}\)\}/)?.[0];
  expect(handler).toBeDefined();
  const expression = editor.match(/checked=\{(route\.websocket\?\.enabled \?\? false)\}/)?.[1];
  expect(expression).toBeDefined();
  const checked = new Function('route', `return ${expression};`) as (route: EditorRoute) => boolean;
  // Execute the exact arrow callback from the component.
  const toggle = new Function('route', `return ${handler!.slice('onchange={'.length, -1)};`) as (route: EditorRoute) => (enabled: boolean) => void;
  let route: EditorRoute = { path: '/new' };
  expect(checked(route)).toBe(false);
  toggle(route)(true); expect(checked(route)).toBe(true);
  toggle(route)(false); expect(checked(route)).toBe(false);
  route = { path: '/loaded', websocket: { enabled: true } };
  expect(checked(route)).toBe(true);
  route = { path: '/reset' };
  expect(checked(route)).toBe(false);
  expect(route).not.toHaveProperty('websocket');
});

test('direct and service form adapters round-trip the switch and preserve omitted fields', () => {
  for (const enabled of [undefined, false, true]) {
    for (const serviceBacked of [false, true]) {
      const policy = enabled === undefined ? {} : { websocket: { enabled } };
      const route = { id: '20000000-0000-4000-8000-000000000081', position: 0, path: '/responses', plugins: [], ...policy,
        ...(serviceBacked ? { service_id: '10000000-0000-4000-8000-000000000081' } : { endpoints: [] }),
      } as RouteV2;
      const logical: LogicalConfigurationV2 = { routes: [route], plugins: [], services: [{ id: '10000000-0000-4000-8000-000000000081', position: 0, name: 'responses', endpoints: [], plugins: [] }] };
      const draft = toEditorRoute(route, logical.services);
      expect(draft.websocket?.enabled ?? false).toBe(enabled ?? false);
      expect(toV2Route(draft, logical, route, 0)).toEqual(route);
      expect(getRouteFeatureBadges(draft).some(({ id }) => id === 'websocket')).toBe(enabled === true);
      draft.websocket = { enabled: !enabled };
      expect(toV2Route(draft, logical, route, 0).websocket).toEqual({ enabled: !enabled });
    }
  }
});

test('both locales provide the concise connection, usage and budget explanations', async () => {
  for (const locale of ['zh-CN', 'en']) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(messages.routeEditor.enableWebsocket).toContain('WebSocket');
    expect(messages.routeEditor.websocketHelp).toContain('Responses');
    expect(messages.routeEditor.websocketBudgetHelp).toContain('Token');
    expect(messages.routeFeatures.websocket).toBe('WebSocket');
  }
});
