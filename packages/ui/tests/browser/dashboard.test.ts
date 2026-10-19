import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { LAYOUT_KEY, type DashboardLayout } from '../../src/components/dashboard/layout';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard, navigateDashboard } from '../helpers/dashboard/fixture';

const runtime = dashboardRuntime();
const layout: DashboardLayout = { version: 5, cards: [
  { id: 'kpi.requests', x: 0, y: 0, w: 6, h: 4 },
  { id: 'kpi.success', x: 6, y: 0, w: 6, h: 4 },
  { id: 'chart.requests', x: 0, y: 4, w: 15, h: 8 },
  { id: 'chart.errors', x: 15, y: 4, w: 15, h: 8 },
], mobile: ['kpi.requests', 'kpi.success', 'chart.requests', 'chart.errors'].map(id => ({ id, height: 'standard' })) };
async function open(page: import('playwright').Page) {
  const fixture = await connectDashboard(page);
  await page.addInitScript(({ key, layout }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(layout)); }, { key: LAYOUT_KEY, layout });
  await navigateDashboard(page, () => page.goto(runtime.origin));
  await expect(fixture.card('kpi.requests')).toBeVisible();
  await expect(page.getByTestId('dashboard-chart-traffic').locator('canvas')).toBeVisible();
  return fixture;
}

test('Dashboard pointer drag and resize persist actual GridStack geometry', () => runtime.run(async page => {
  const { card, edit, stored, pageErrors } = await open(page);
  await edit();
  const target = card('chart.errors');
  const before = await target.boundingBox();
  const header = (await target.locator('header').boundingBox())!;
  await page.mouse.move(header.x + 100, header.y + 20); await page.mouse.down();
  await page.mouse.move(header.x - 300, header.y + 180, { steps: 15 }); await page.mouse.up();
  await expect(page.getByTestId('dashboard-save-layout')).toBeEnabled();
  await expect.poll(async () => JSON.stringify(await target.boundingBox())).not.toBe(JSON.stringify(before));
  const resize = card('chart.requests').locator('.ui-resizable-se');
  await resize.scrollIntoViewIfNeeded();
  const grip = (await resize.boundingBox())!;
  const height = (await card('chart.requests').boundingBox())!.height;
  await page.mouse.move(grip.x + 14, grip.y + 14); await page.mouse.down();
  await page.mouse.move(grip.x + 14, grip.y + 110, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await card('chart.requests').boundingBox())!.height).toBeGreaterThan(height);
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  const saved = await stored();
  expect(saved.version).toBe(5);
  expect(saved.cards.find((entry: any) => entry.id === 'chart.requests').h).toBeGreaterThan(8);
  await navigateDashboard(page, () => page.reload());
  for (const entry of saved.cards) {
    await expect(card(entry.id)).toHaveAttribute('gs-w', String(entry.w));
    await expect(card(entry.id)).toHaveAttribute('gs-h', String(entry.h));
    expect(await card(entry.id).getAttribute('gs-x') ?? '0').toBe(String(entry.x));
    expect(await card(entry.id).getAttribute('gs-y') ?? '0').toBe(String(entry.y));
  }
  await page.screenshot({ path: '/tmp/bungee-dashboard-layout.png', fullPage: true });
  expect(pageErrors).toEqual([]);
}), 60_000);

test('Dashboard library search, filtering, add/remove and undo use the editable draft', () => runtime.run(async page => {
  const { card, edit, library, closeLibrary, stored, cancel, pageErrors } = await open(page);
  await edit();
  await card('kpi.requests').getByRole('button', { name: '移除「总请求数」', exact: true }).click();
  await expect(card('kpi.requests')).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toBeVisible();
  await expect(page.getByTestId('dashboard-save-layout')).toBeDisabled();
  await library();
  const search = page.getByRole('textbox', { name: '搜索卡片…' });
  await expect(search).toBeFocused();
  await search.fill('不存在的卡片');
  await expect(page.getByText('没有匹配的卡片', { exact: true })).toBeVisible();
  await search.fill('');
  await page.getByRole('button', { name: '指标 5', exact: true }).click();
  await expect(page.getByRole('button', { name: '添加「响应时间趋势」', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加「每分钟请求数」', exact: true }).click();
  await closeLibrary();
  await expect(card('kpi.rpm')).toBeVisible();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  expect((await stored()).cards.some((entry: any) => entry.id === 'kpi.rpm')).toBe(true);
  await edit();
  await card('kpi.requests').getByRole('button', { name: '移动「总请求数」', exact: true }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '5');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '4');
  const narrow = (await card('kpi.requests').boundingBox())!.width;
  await card('kpi.requests').locator('button[title="卡片尺寸"]').click();
  await page.getByRole('menuitemradio', { name: /半宽/ }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-w', '15');
  await expect.poll(async () => (await card('kpi.requests').boundingBox())!.width).toBeGreaterThan(narrow);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.requests')).toHaveAttribute('gs-w', '6');
  await library();
  await page.getByRole('textbox', { name: '搜索卡片…' }).fill('请求数趋势');
  await page.getByRole('button', { name: '趋势图 4', exact: true }).click();
  await closeLibrary(); await library();
  await expect(page.getByRole('textbox', { name: '搜索卡片…' })).toHaveValue('请求数趋势');
  await expect(page.getByRole('button', { name: '趋势图 4', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '定位', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(card('chart.requests')).toBeInViewport();
  await expect(card('chart.requests').getByRole('button', { name: '移动「请求数趋势」', exact: true })).toBeFocused();
  await cancel();
  expect(pageErrors).toEqual([]);
}), 60_000);

test('Dashboard failed save preserves draft and storage; Cancel restores the saved board', () => runtime.run(async page => {
  const { card, edit, cancel, stored, pageErrors } = await open(page);
  const original = await stored(); await edit();
  await card('kpi.requests').getByRole('button', { name: '移动「总请求数」', exact: true }).focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) { if (name === key) throw new Error('storage unavailable'); return original.call(this, name, value); };
  }, LAYOUT_KEY);
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByText('保存失败，仍在编辑模式，草稿未丢失', { exact: false })).toBeVisible();
  await expect(page.getByTestId('dashboard-save-layout')).toBeEnabled();
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '5');
  expect(await stored()).toEqual(original);
  await cancel();
  await expect(card('kpi.requests')).toHaveAttribute('gs-h', '4');
  expect(await stored()).toEqual(original); expect(pageErrors).toEqual([]);
}), 60_000);

test('Dashboard dirty draft guards leaving and pauses refresh for a complete interval', () => runtime.run(async page => {
  await page.clock.install();
  const fixture = await open(page);
  await fixture.edit();
  await fixture.card('kpi.requests').getByRole('button', { name: '移除「总请求数」', exact: true }).click();
  const before = fixture.historyCalls;
  await page.clock.fastForward(31_000); expect(fixture.historyCalls).toBe(before);
  await page.getByRole('link', { name: '服务管理', exact: true }).click();
  await expect(page.getByTestId('confirmation-cancel')).toBeVisible();
  await page.getByTestId('confirmation-cancel').click();
  await expect(page.getByTestId('page-dashboard')).toBeVisible();
  await fixture.cancel();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/stats/dashboard');
  await page.clock.fastForward(31_000); await response;
  await expect.poll(() => fixture.historyCalls).toBeGreaterThan(before);
  expect(fixture.pageErrors).toEqual([]);
}), 60_000);

test('Dashboard mobile order and height persist independently from desktop geometry', () => runtime.run(async page => {
  const { stored, edit, pageErrors } = await open(page); const original = await stored();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.dashboard-mobile-card')).toHaveCount(4); await edit();
  const rows = page.locator('.dashboard-manage-row');
  await rows.first().getByRole('button', { name: '下移', exact: true }).click();
  await rows.first().getByRole('radio', { name: '加高', exact: true }).click();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  const saved = await stored(); expect(saved.cards).toEqual(original.cards);
  expect(saved.mobile[0]).toEqual({ id: 'kpi.success', height: 'tall' });
  await navigateDashboard(page, () => page.reload()); await expect(page.locator('.dashboard-mobile-card').first()).toHaveAttribute('data-card-id', 'kpi.success');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await expect(page.locator('.grid-stack-item')).toHaveCount(4); expect((await stored()).cards).toEqual(original.cards);
  expect(pageErrors).toEqual([]);
}), 60_000);

test('Dashboard current storage supports empty boards, templates and malformed-input recovery', () => runtime.run(async page => {
  const { card, pageErrors } = await open(page);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 5, cards: [], mobile: [] })), LAYOUT_KEY);
  await navigateDashboard(page, () => page.reload()); await expect(page.getByTestId('dashboard-empty')).toBeVisible();
  await page.getByRole('button', { name: '布局模板', exact: true }).click();
  await page.getByTestId('dashboard-template-api').click();
  await page.getByTestId('dashboard-save-layout').click();
  await expect(card('kpi.requests')).toBeVisible();
  await page.evaluate(key => localStorage.setItem(key, '{invalid'), LAYOUT_KEY);
  await navigateDashboard(page, () => page.reload()); await expect(card('kpi.rpm')).toBeVisible();
  expect(pageErrors).toEqual([]);
}), 60_000);

test('Dashboard GridStack fills vertical space while preserving intentional horizontal gaps', () => runtime.run(async page => {
  const { card, edit, stored, pageErrors } = await open(page);
  await page.evaluate(key => {
    const cards = [
      { id: 'kpi.requests', x: 6, y: 0, w: 6, h: 4 },
      { id: 'kpi.success', x: 12, y: 0, w: 6, h: 4 },
      { id: 'kpi.rpm', x: 12, y: 4, w: 6, h: 4 },
    ];
    localStorage.setItem(key, JSON.stringify({ version: 5, cards, mobile: cards.map(({ id }) => ({ id, height: 'standard' })) }));
  }, LAYOUT_KEY);
  await navigateDashboard(page, () => page.reload()); await edit();
  const rpmBefore = (await card('kpi.rpm').boundingBox())!;
  await card('kpi.requests').getByRole('button', { name: '移除「总请求数」', exact: true }).click();
  await expect(card('kpi.success')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  await card('kpi.success').getByRole('button', { name: '移除「请求成功率」', exact: true }).click();
  await expect.poll(async () => await card('kpi.rpm').getAttribute('gs-y') ?? '0').toBe('0');
  await expect.poll(async () => (await card('kpi.rpm').boundingBox())!.y).toBeLessThan(rpmBefore.y);
  await expect(card('kpi.rpm')).toHaveAttribute('gs-x', '12');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '4');
  await page.getByTestId('dashboard-save-layout').click();
  await expect(page.getByTestId('dashboard-customize')).toBeVisible();
  const saved = await stored();
  await navigateDashboard(page, () => page.reload());
  await expect(card('kpi.success')).toHaveAttribute('gs-x', '12');
  await expect(card('kpi.rpm')).toHaveAttribute('gs-y', '4');
  expect(await stored()).toEqual(saved); expect(pageErrors).toEqual([]);
}), 60_000);
