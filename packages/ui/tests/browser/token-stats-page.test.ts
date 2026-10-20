import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
test('Token statistics query ranges, model sorting and refresh failures recover independently', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { tokenManifest, nativeRequests, pageErrors } = fixture;

    await page.goto(`${runtime.origin}/#/extensions/token-stats${tokenManifest.contributes.navigation[0].path}`);
    await expect(page.getByTestId('token-stats-page')).toBeVisible();
    const rangeSelect = page.getByRole('combobox', { name: '时间范围' });
    const refresh = page.getByRole('button', { name: '刷新', exact: true });
    await expect(refresh).toBeEnabled();

    await rangeSelect.click();

    await page.keyboard.press('Escape');
    for (const [label, range] of [
      ['本日', 'day'], ['最近7天', '7d'], ['最近30天', '30d'],
      ['本周', 'week'], ['本月', 'month'], ['最近1天', '1d'],
    ] as const) {
      await rangeSelect.click();
      await page.getByRole('option', { name: label, exact: true }).click();

      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=model'))).toBe(true);
      await expect.poll(() => nativeRequests.some(query => query.includes(`range=${range}`) && query.includes('groupBy=time'))).toBe(true);
      await expect(refresh).toBeEnabled();
    }
    for (const calendarRange of ['day', 'week', 'month']) {
      expect(nativeRequests.some(query => query.includes(`range=${calendarRange}`) && query.includes('timeZone=Asia%2FShanghai'))).toBe(true);
    }

    await expect(page.getByRole('radio', { name: 'Token', exact: true })).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-11');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-0');
    await page.getByRole('radio', { name: 'Token', exact: true }).click();
    await expect(page.getByTestId('token-stats-model-row').first()).toContainText('model-0');
    await expect(page.getByTestId('token-stats-model-row').last()).toContainText('model-1');
    await page.getByRole('radio', { name: '费用', exact: true }).click();
    await page.getByRole('textbox', { name: '搜索模型' }).fill('model-11');
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(1);
    await page.getByRole('textbox', { name: '搜索模型' }).fill('');

    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);

    fixture.nativeFailure = true;
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('token-stats-model-row')).toHaveCount(12);
    fixture.nativeFailure = false;
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}, { viewport: { width: 390, height: 844 } }), 120_000);
