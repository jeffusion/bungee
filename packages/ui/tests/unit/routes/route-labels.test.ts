import { describe, expect, test } from 'bun:test';

describe('new route button surface', () => {
  test('both locale action labels describe route creation without an icon prefix', async () => {
    const [zhCN, en] = await Promise.all([
      Bun.file(new URL('../../../src/i18n/locales/zh-CN.json', import.meta.url)).json(),
      Bun.file(new URL('../../../src/i18n/locales/en.json', import.meta.url)).json(),
    ]);

    expect(zhCN.routes.newRoute).toBe('新建路由');
    expect(en.routes.newRoute).toBe('New Route');
    expect(zhCN.routes.newRoute).not.toMatch(/^\+/);
    expect(en.routes.newRoute).not.toMatch(/^\+/);

  });
});
