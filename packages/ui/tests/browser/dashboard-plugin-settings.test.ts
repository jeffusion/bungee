import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { dashboardRuntime } from '../helpers/dashboard/runtime';
import { connectDashboard } from '../helpers/dashboard/fixture';
const runtime = dashboardRuntime();
test('Token pricing settings load the native pricing route independently', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { tokenManifest, pageErrors } = fixture;
    await page.goto(`${runtime.origin}/#/plugins/token-stats${tokenManifest.contributes.settings}`);
    await expect(page.getByTestId('token-stats-page')).toHaveCount(0);
    await expect(page.getByTestId('token-stats-settings')).toBeVisible();
    await expect(page.getByTestId('token-stats-bucket-detail')).toHaveCount(0);
    await expect(page.getByTestId('price-mappings-save')).toBeEnabled();
    await expect(page.getByTestId('pricing-catalog-state')).toBeVisible();

    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 60_000);

test('models.dev settings use their own route and current catalog defaults', () => runtime.run(async page => {
 const fixture = await connectDashboard(page, true);
 const { modelsDevManifest, pageErrors } = fixture;
    await page.goto(`${runtime.origin}/#/plugins/models-dev${modelsDevManifest.contributes.settings}`);
    await expect(page.getByTestId('models-dev-settings')).toBeVisible();
    await expect(page.getByTestId('token-stats-settings')).toHaveCount(0);
    await expect(page.getByRole('spinbutton')).toHaveCount(2);
    await expect(page.getByTestId('models-dev-interval')).toHaveValue('24');
    await expect(page.getByTestId('models-dev-timeout')).toHaveValue('15');
    await expect(page.getByTestId('models-dev-state')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);

 fixture.network.assertSettled(); expect(pageErrors).toEqual([]);
}), 60_000);

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
