import { get, writable } from 'svelte/store';
import { createDefaultMenuLayout, reconcileMenuLayout, type MenuSnapshot, type MenuPage } from '@jeffusion/bungee-types';
import { MenusAPI } from '$api/menus';
import { getAuthStateRevision, isAuthenticationStateCurrent, isAuthenticated } from './auth';
import { setMenuIconRevision, clearMenuIcons } from '$components/domain/menu/menu-icons';
type MenuState = { session: number; snapshot: MenuSnapshot; available: boolean; loading: boolean; error: boolean };
const empty: MenuSnapshot = { revision: 0, catalog: [], layout: [], iconRevision: '' };
export const menus = writable<MenuState>({ session: 0, snapshot: empty, available: false, loading: false, error: false });
let session = 0, request = 0;
let fallbackCatalog: readonly MenuPage[] = [];
export function resetMenus(catalog: readonly MenuPage[] = []): void {
  session++; request++; fallbackCatalog = catalog; clearMenuIcons();
  menus.set({ session, snapshot: { ...empty, catalog, layout: createDefaultMenuLayout(catalog) }, available: false, loading: false, error: false });
}
export function menuSessionGuard(): () => boolean {
  const identity = session, revision = getAuthStateRevision();
  return () => identity === session && isAuthenticationStateCurrent(revision) && get(isAuthenticated);
}
export async function refreshMenus(): Promise<MenuSnapshot | null> {
  const current = menuSessionGuard(), generation = ++request;
  menus.update(value => ({ ...value, loading: true }));
  try {
    const snapshot = await MenusAPI.read();
    if (!current() || generation !== request) return null;
    acceptMenus(snapshot); return snapshot;
  } catch {
    if (current() && generation === request) menus.update(value => ({ ...value,
      snapshot: value.snapshot.iconRevision ? value.snapshot : { ...value.snapshot, catalog: fallbackCatalog, layout: createDefaultMenuLayout(fallbackCatalog) },
      loading: false, error: true, available: false }));
    return null;
  }
}
export function acceptMenus(snapshot: MenuSnapshot): void {
  request++;
  setMenuIconRevision(snapshot.iconRevision);
  menus.set({ session, snapshot: { ...snapshot, layout: reconcileMenuLayout(snapshot.layout, snapshot.catalog) }, available: true, loading: false, error: false });
}
export function updateMenuFallback(catalog: readonly MenuPage[]): void {
  fallbackCatalog = catalog;
  const availability = new Map(catalog.map(page => [page.id, page.available]));
  menus.update(value => {
    // Plugin state stays current even when the menu endpoint cannot refresh.
    if (value.snapshot.iconRevision) return { ...value, snapshot: { ...value.snapshot,
      catalog: value.snapshot.catalog.map(page => page.source === 'plugin'
        ? { ...page, available: availability.get(page.id) ?? false } : page) } };
    return { ...value, snapshot: { ...value.snapshot, catalog, layout: createDefaultMenuLayout(catalog) } };
  });
}
