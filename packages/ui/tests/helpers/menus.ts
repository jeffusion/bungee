import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, type MenuPage, type MenuSnapshot } from '@jeffusion/bungee-types';
import type { Route } from 'playwright/test';
import { menuIcons } from '../../../core/src/ui/menu-icons';
import requestLogsManifest from '../../../../plugins/request-logs/manifest.json';
import type { Plugin } from '../../src/api/plugins';

export const requestLogsPlugin: Plugin = { name: requestLogsManifest.name, enabled: true,
  metadata: { ...requestLogsManifest.metadata, contributes: {
    ...requestLogsManifest.contributes,
    navigation: requestLogsManifest.contributes.navigation.map(page => ({ ...page, target: 'header',
      layout: page.layout === 'standalone' ? 'standalone' : undefined })),
  } } };
const logsNavigation = requestLogsManifest.contributes.navigation[0]!;
export const requestLogsMenuPage: MenuPage = { id: `plugin:request-logs:${encodeURIComponent(logsNavigation.path)}`,
  label: logsNavigation.label, href: '/#/extensions/request-logs/logs', source: 'plugin', pluginName: 'request-logs',
  defaultIcon: logsNavigation.icon, available: true };

export function menuSnapshot(contributions: readonly MenuPage[] = []): MenuSnapshot {
  const catalog = [...BUILTIN_MENU_PAGES, ...contributions];
  return { revision: 1, catalog, layout: createDefaultMenuLayout(catalog), iconRevision: 'icons:test' };
}
export function fulfillMenuIcons(route: Route) {
  const ids = (new URL(route.request().url()).searchParams.get('ids') ?? '').split(',').filter(Boolean);
  const local = menuIcons(ids);
  return route.fulfill({ json: { revision: 'icons:test', missing: [], icons: Object.fromEntries(ids.map(id => [id, local.icons[id] ?? {
    body: '<path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2"/>', width: 24, height: 24,
  }])) } });
}
