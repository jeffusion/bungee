import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
test('an unregistered native settings component fails closed without mounting the sandbox host', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { tokenManifest, pageErrors } = fixture;
 const pluginRequests: string[] = [];
 page.on('request', request => {
   const path = new URL(request.url()).pathname;
   if (path.startsWith('/plugins/token-stats/')) pluginRequests.push(path);
 });
 await page.route(/^https?:\/\/[^/]+\/api\/plugins$/, route => route.fulfill({ json: [{
   name: 'token-stats', version: tokenManifest.version, enabled: true,
   metadata: { ...tokenManifest.metadata, contributes: { ...tokenManifest.contributes, nativeSettingsComponent: 'MissingSettingsComponent' } },
 }] }));
 await page.goto(`${runtime.origin}/#/plugins/token-stats${tokenManifest.contributes.settings}`);
 await expect(page.getByRole('alert')).toBeVisible();
 await expect(page.locator('iframe')).toHaveCount(0);
 await expect(page.getByTestId('token-stats-settings')).toHaveCount(0);
 expect(pluginRequests).toEqual([]);
 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 60_000);
