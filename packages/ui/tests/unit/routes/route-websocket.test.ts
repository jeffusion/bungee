import { expect, test } from 'bun:test';
import { toEditorRoute, toV2Route } from '../../../src/api/config-adapters';
import type { LogicalConfiguration, ConfigurationRoute } from '@jeffusion/bungee-types';

test('direct and service form adapters round-trip the switch and preserve omitted fields', () => {
  for (const enabled of [undefined, false, true]) {
    for (const serviceBacked of [false, true]) {
      const policy = enabled === undefined ? {} : { websocket: { enabled } };
      const route = { id: '20000000-0000-4000-8000-000000000081', position: 0, path: '/responses', plugins: [], ...policy,
        ...(serviceBacked ? { service_id: '10000000-0000-4000-8000-000000000081' } : { endpoints: [] }),
      } as ConfigurationRoute;
      const logical: LogicalConfiguration = { routes: [route], plugins: [], services: [{ id: '10000000-0000-4000-8000-000000000081', position: 0, name: 'responses', endpoints: [], plugins: [] }] };
      const draft = toEditorRoute(route, logical.services);
      expect(draft.websocket?.enabled ?? false).toBe(enabled ?? false);
      expect(toV2Route(draft, logical, route, 0)).toEqual(route);
      draft.websocket = { enabled: !enabled };
      expect(toV2Route(draft, logical, route, 0).websocket).toEqual({ enabled: !enabled });
    }
  }
});
