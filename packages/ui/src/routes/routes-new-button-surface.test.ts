import { describe, expect, test } from 'bun:test';

describe('new route button surface', () => {
  test('keeps the plus icon in markup and out of both locale labels', async () => {
    const [zhCN, en, source] = await Promise.all([
      Bun.file(new URL('../i18n/locales/zh-CN.json', import.meta.url)).json(),
      Bun.file(new URL('../i18n/locales/en.json', import.meta.url)).json(),
      Bun.file(new URL('./RoutesIndex.svelte', import.meta.url)).text(),
    ]);

    expect(zhCN.routes.newRoute).toBe('新建路由');
    expect(en.routes.newRoute).toBe('New Route');
    expect(zhCN.routes.newRoute).not.toMatch(/^\+/);
    expect(en.routes.newRoute).not.toMatch(/^\+/);

    const button = source.match(/<button[^>]*data-testid="route-new-button"[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(button).toBeDefined();
    expect(button?.match(/<svg\b/g)).toHaveLength(1);
  });
});
