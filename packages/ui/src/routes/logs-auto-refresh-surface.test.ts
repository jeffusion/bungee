import { expect, test } from 'bun:test';

test('all Logs refresh settings keep one visible title and a localized switch name', async () => {
  const source = await Bun.file(new URL('./Logs.svelte', import.meta.url)).text();
  const switches = source.match(/<BSwitch\b[^>]*bind:checked=\{autoRefreshEnabled\}[^>]*\/>/g) ?? [];
  // Desktop refresh settings, tablet refresh menu, and mobile actions menu.
  expect(switches).toHaveLength(3);
  expect(source.match(/<span\b[^>]*>\{\$_\('logs.autoRefresh'\)\}<\/span>/g)).toHaveLength(3);
  for (const control of switches) {
    expect(control).not.toMatch(/\blabel=/);
    expect(control).toContain("description={$_('logs.autoRefresh')}");
  }

  const rows = [...source.matchAll(/<label class="([^"]+)">\s*<span class="([^"]+)">\{\$_\('logs.autoRefresh'\)\}<\/span>\s*<BSwitch\b[^>]*\/>\s*<\/label>/g)];
  const intervalTitles = [...source.matchAll(/<span class="([^"]+)">\{\$_\('logs.refreshInterval'\)\}<\/span>/g)];
  expect(rows).toHaveLength(3);
  expect(intervalTitles).toHaveLength(3);
  rows.forEach((row, index) => {
    expect(row[1].split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'flex', 'justify-between', 'items-center']));
    expect(row[2]).toBe('nx-field-label');
    expect(intervalTitles[index][1]).toBe(row[2]);
  });

  const leaf = await Bun.file(new URL('../components/industrial/BSwitch.svelte', import.meta.url)).text();
  const standalone = leaf.split('{:else}')[1];
  expect(standalone).toContain('aria-label={description || "switch"}');
  expect(standalone).not.toContain('{description}</');

  for (const [locale, title] of [['zh-CN', '自动刷新'], ['en', 'Auto Refresh']]) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(messages.logs.autoRefresh).toBe(title);
  }
});
