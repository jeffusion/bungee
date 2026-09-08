import { expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';

const source = await Bun.file(new URL('./Logs.svelte', import.meta.url)).text();
const handler = source.match(/  function clearAllFilters\([\s\S]*?\n  }/)![0];
const count = source.match(/\$: activeFiltersCount = ([\s\S]*?\.filter\(Boolean\)\.length);/)![1];
const defaults = { searchTerm: '', method: '', statusFilter: '', successFilter: undefined,
  requestTypeFilter: '', hasRetryFilter: undefined, timeRangeType: 'recent', recentHours: 1,
  customStartTime: '', customEndTime: '', sortBy: 'timestamp', sortOrder: 'desc', page: 1 };
const create = new Function('initial', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  let { ${Object.keys(defaults).join(', ')}, limit, autoRefreshEnabled, refreshInterval, logs } = initial;
  ${handler}
  return { clearAllFilters, get count() { return ${count}; },
    get values() { return { ${Object.keys(defaults).join(', ')}, limit, autoRefreshEnabled, refreshInterval, logs }; } };
`));

test('reset restores existing filter/sort/page defaults, not data or refresh preferences', () => {
  const logs = [{ requestId: 'fixture' }];
  const unchanged = { limit: 100, autoRefreshEnabled: false, refreshInterval: '60s', logs };
  const state = create({ ...defaults, ...unchanged, searchTerm: 'test', method: 'POST', statusFilter: '503',
    successFilter: false, requestTypeFilter: 'retry', hasRetryFilter: true, timeRangeType: 'custom',
    recentHours: 12, customStartTime: '2026-09-08T01:00', customEndTime: '2026-09-08T02:00',
    sortBy: 'duration', sortOrder: 'asc', page: 5 });
  expect(state.count).toBe(8);
  state.clearAllFilters();
  expect(state.values).toEqual({ ...defaults, ...unchanged });
  expect(state.values.logs).toBe(logs);
  expect(state.count).toBe(0);
});

test('reset visibility keeps the existing active-count semantics including false-valued filters', () => {
  for (const filter of [{ searchTerm: 'test' }, { method: 'POST' }, { statusFilter: '503' },
    { successFilter: false }, { requestTypeFilter: 'retry' }, { hasRetryFilter: false },
    { timeRangeType: 'custom' }, { recentHours: 2 }, { sortOrder: 'asc' }]) {
    expect(create({ ...defaults, ...filter }).count).toBe(1);
  }
  expect(create(defaults).count).toBe(0);
  expect(create({ ...defaults, searchTerm: '  ' }).count).toBe(0);
  // Existing behavior: all-time alone is not counted. This move must not change it.
  expect(create({ ...defaults, timeRangeType: 'all' }).count).toBe(0);
});

test('each responsive toolbar puts its sole reset after filters and before refresh/export', () => {
  expect(() => compile(source, { filename: 'Logs.svelte' })).not.toThrow();
  const desktop = source.split('<!-- More Filters 下拉 -->')[1].split('<!-- 中屏布局')[0];
  const tablet = source.split('<!-- 中屏布局')[1].split('<!-- 窄屏布局')[0];
  const mobile = source.split('<!-- 窄屏布局')[1].split('<!-- Filter Chips')[0];
  for (const [section, boundary] of [[desktop, '<!-- 弹性空间 -->'], [tablet, '<!-- 刷新菜单'], [mobile, "{$_('common.refresh')}</h3>"]]) {
    expect(section.match(/on:click=\{clearAllFilters\}/g)).toHaveLength(1);
    expect(section.indexOf('on:click={clearAllFilters}')).toBeLessThan(section.indexOf(boundary));
    expect(section).toMatch(/\{#if activeFiltersCount > 0\}\s*<button[\s\S]*?on:click=\{clearAllFilters\}/);
    const button = section.match(/<button\b[^>]*on:click=\{clearAllFilters\}[^>]*>[\s\S]*?<\/button>/)![0];
    expect(button).toContain('type="button"');
    expect(button).toContain('nx-btn-ghost nx-btn-md');
    expect(button).toContain("{$_('logs.resetFilters')}");
    expect(button).toContain('focus-visible:');
  }
});

test('reset wording describes filters, and chip labels describe only that filter', async () => {
  for (const [locale, reset, clear] of [['zh-CN', '重置筛选', '清除此筛选'], ['en', 'Reset filters', 'Clear this filter']]) {
    const messages = await Bun.file(new URL(`../i18n/locales/${locale}.json`, import.meta.url)).json();
    expect(messages.logs.resetFilters).toBe(reset);
    expect(messages.logs.clearFilters).toBe(clear);
  }
});
