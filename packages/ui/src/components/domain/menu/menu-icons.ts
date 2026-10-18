import { writable } from 'svelte/store';
import type { MenuIconData } from '@jeffusion/bungee-types';
import { getAuthStateRevision, isAuthenticationStateCurrent } from '$stores/auth';
import { MenusAPI } from '$api/menus';
export const menuIconRevision = writable('');
const MAX_CACHE = 512;
let revision = '', generation = 0, scheduled = false;
const cache = new Map<string, MenuIconData | null>();
type Pending = { resolve: (data: MenuIconData | null) => void; reject: (error: unknown) => void; promise: Promise<MenuIconData | null> };
const pending = new Map<string, Pending>();
const queue = new Set<string>();
export function setMenuIconRevision(next: string): void {
  if (next === revision) return;
  revision = next; generation++; cache.clear(); queue.clear();
  for (const item of pending.values()) item.resolve(null);
  pending.clear(); menuIconRevision.set(next);
}
export function clearMenuIcons(): void {
  generation++; revision = ''; cache.clear(); queue.clear();
  for (const item of pending.values()) item.resolve(null);
  pending.clear(); menuIconRevision.set('');
}
export function loadMenuIcon(id: string): Promise<MenuIconData | null> {
  if (cache.has(id)) { const data = cache.get(id)!; cache.delete(id); cache.set(id, data); return Promise.resolve(data); }
  if (pending.has(id)) return pending.get(id)!.promise;
  let resolve!: Pending['resolve'], reject!: Pending['reject'];
  const promise = new Promise<MenuIconData | null>((yes, no) => { resolve = yes; reject = no; });
  pending.set(id, { resolve, reject, promise }); queue.add(id);
  if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  return promise;
}
async function flush(): Promise<void> {
  scheduled = false;
  const ids = [...queue].slice(0, 64); ids.forEach(id => queue.delete(id));
  if (queue.size) { scheduled = true; queueMicrotask(flush); }
  const entries = ids.map(id => [id, pending.get(id)!] as const), started = generation, authentication = getAuthStateRevision();
  try {
    const result = await MenusAPI.icons(ids);
    if (started !== generation || !isAuthenticationStateCurrent(authentication)) { for (const [, entry] of entries) entry.resolve(null); return; }
    // Resource versions apply to every icon, including negative cache entries.
    // Keep this successful batch while invalidating all older in-flight work.
    for (const [id, entry] of entries) if (pending.get(id) === entry) pending.delete(id);
    setMenuIconRevision(result.revision);
    for (const [id, entry] of entries) {
      const data = result.icons[id] ?? null; cache.set(id, data); entry.resolve(data);
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    }
  } catch (error) { for (const [, entry] of entries) entry.reject(error); }
  finally { for (const [id, entry] of entries) if (pending.get(id) === entry) pending.delete(id); }
}
