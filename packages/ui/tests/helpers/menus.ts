import { BUILTIN_MENU_PAGES, createDefaultMenuLayout, type MenuSnapshot } from '@jeffusion/bungee-types';
import type { Route } from 'playwright/test';
import { menuIcons } from '../../../core/src/ui/menu-icons';
export function menuSnapshot(): MenuSnapshot {
  return { revision: 1, catalog: [...BUILTIN_MENU_PAGES], layout: createDefaultMenuLayout(BUILTIN_MENU_PAGES), iconRevision: 'icons:test' };
}
export function fulfillMenuIcons(route: Route) {
  const ids = (new URL(route.request().url()).searchParams.get('ids') ?? '').split(',').filter(Boolean);
  const local = menuIcons(ids);
  return route.fulfill({ json: { revision: 'icons:test', missing: [], icons: Object.fromEntries(ids.map(id => [id, local.icons[id] ?? {
    body: '<path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2"/>', width: 24, height: 24,
  }])) } });
}
