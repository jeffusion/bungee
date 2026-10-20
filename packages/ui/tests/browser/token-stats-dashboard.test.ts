import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';

const runtime = dashboardRuntime();

test('native Token host isolates plugin ownership and shares the selected range', () => runtime.run(async page => {
  const fixture = await connectDashboard(page, true);
  const { nativeRequests, pageErrors } = fixture;
  await page.goto(runtime.origin);
  const overview = page.getByTestId('token-stats-overview');
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('[data-card-id^="plugin:native:intruder:"]')).toHaveCount(0);
  expect(nativeRequests).toHaveLength(1);
  expect(nativeRequests.every(query => query.includes('range=1h'))).toBe(true);
  expect(nativeRequests.some(query => query.includes('groupBy=model'))).toBe(false);

  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/plugins/token-stats/control/stats');
  await page.getByRole('radio', { name: '12h', exact: true }).click();
  await (await refreshed).finished();
  await expect(overview).toHaveAttribute('aria-busy', 'false');
  expect(nativeRequests.some(query => query.includes('range=12h'))).toBe(true);
  expect(nativeRequests.some(query => query.includes('groupBy=model'))).toBe(false);
  fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 120_000);
