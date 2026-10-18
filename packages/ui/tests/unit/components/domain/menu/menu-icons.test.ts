import { afterEach, expect, mock, test } from 'bun:test';
import type { MenuIcons } from '@jeffusion/bungee-types';
const calls: string[][] = [];
let version = 'icons:one', fail = false;
let waiting: ((value: MenuIcons) => void) | null = null;
let delay = false;
const icon = { body: '<path d="M0 0h16v16z"/>', width: 16, height: 16 };
mock.module('../../../../../src/api/menus', () => ({ MenusAPI: { icons: async (ids: string[]) => {
  calls.push(ids);
  if (delay) return await new Promise<MenuIcons>(resolve => { waiting = resolve; });
  if (fail) throw new Error('unavailable');
  return { revision: version, icons: Object.fromEntries(ids.filter(id => id !== 'lucide:missing').map(id => [id, icon])), missing: ids.includes('lucide:missing') ? ['lucide:missing'] : [] };
} } }));
const { clearMenuIcons, loadMenuIcon, setMenuIconRevision } = await import('../../../../../src/components/domain/menu/menu-icons');
afterEach(() => { clearMenuIcons(); calls.length = 0; fail = false; delay = false; waiting = null; version = 'icons:one'; });
test('same icon requests coalesce, batches contain at most 64 ids and successful/missing data is cached', async () => {
  setMenuIconRevision(version);
  const same = loadMenuIcon('lucide:server'); expect(loadMenuIcon('lucide:server')).toBe(same);
  const results = await Promise.all([same, ...Array.from({ length: 130 }, (_, i) => loadMenuIcon(`lucide:item-${i}`)), loadMenuIcon('lucide:missing')]);
  expect(results[0]).toEqual(icon); expect(results.at(-1)).toBeNull();
  expect(calls).toHaveLength(3); expect(calls.every(ids => ids.length <= 64)).toBe(true);
  const count = calls.length;
  expect(await loadMenuIcon('lucide:server')).toEqual(icon); expect(await loadMenuIcon('lucide:missing')).toBeNull(); expect(calls).toHaveLength(count);
});
test('failures are retryable and resource version changes invalidate cached values', async () => {
  setMenuIconRevision(version); fail = true;
  await expect(loadMenuIcon('lucide:server')).rejects.toThrow('unavailable');
  fail = false; expect(await loadMenuIcon('lucide:server')).toEqual(icon);
  version = 'icons:two'; setMenuIconRevision(version);
  expect(await loadMenuIcon('lucide:server')).toEqual(icon); expect(calls).toHaveLength(3);
});
test('a session reset prevents late icon responses from repopulating the cache', async () => {
  setMenuIconRevision(version); delay = true;
  const stale = loadMenuIcon('lucide:server'); await Promise.resolve();
  clearMenuIcons(); expect(await stale).toBeNull();
  waiting!({ revision: 'icons:one', icons: { 'lucide:server': icon }, missing: [] });
  await Promise.resolve(); await Promise.resolve();
  delay = false; setMenuIconRevision(version);
  expect(await loadMenuIcon('lucide:server')).toEqual(icon); expect(calls).toHaveLength(2);
});
test('the bounded icon cache evicts old entries', async () => {
  setMenuIconRevision(version);
  await loadMenuIcon('lucide:first');
  await Promise.all(Array.from({ length: 520 }, (_, i) => loadMenuIcon(`lucide:item-${i}`)));
  const count = calls.length; await loadMenuIcon('lucide:first'); expect(calls).toHaveLength(count + 1);
});

test('a data response with a different resource revision replaces the cache and still resolves its own batch', async () => {
  setMenuIconRevision('icons:old');
  expect(await loadMenuIcon('lucide:server')).toEqual(icon);
  expect(await loadMenuIcon('lucide:server')).toEqual(icon); expect(calls).toHaveLength(1);
});
