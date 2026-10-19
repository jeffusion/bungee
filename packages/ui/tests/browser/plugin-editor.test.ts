import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['plugin']);

test('protected plugin bindings cannot be edited or removed', async () => {
  await withPage('scenario=plugin&protected', async page => {
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeDisabled();
    await expect(page.getByTestId('plugins')).toContainText('"_uid":"owner"');
  });
}, 60_000);

test('plugin editing preserves identity, disabled state and unknown options; cancelling leaves the original untouched', async () => {
  await withPage('scenario=plugin', async page => {
    const output = page.getByTestId('plugins');
    const original = await output.textContent();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('cancelled');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(output).toHaveText(original!);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByRole('textbox').fill('after');
    await page.getByTestId('plugin-config-save-button').click();
    await expect(output).toHaveText(JSON.stringify([{ _uid: 'owner', _position: 4, name: 'fixture-plugin', enabled: false,
      options: { accountRef: 'account', unknown: { nested: [1, 2] }, visible: 'after' } }]));
  });
}, 60_000);


test('plugin mouse selection, keyboard selection and reselection close the dropdown; editing locks plugin identity', async () => {
  const schemas = Object.fromEntries(['alpha', 'beta'].map(name => [name, {
    name, version: '1.0.0', runtimeScope: 'scoped', metadata: { name }, configSchema: [],
  }]));
  await withPage('scenario=plugin', async page => {
    await page.getByRole('button', { name: 'Add Plugin', exact: true }).click();
    const dialog = page.getByRole('dialog'), select = dialog.getByRole('combobox');
    for (const [name, keyboard] of [['alpha', false], ['beta', true], ['beta', false]] as const) {
      await select.click();
      await expect(page.getByRole('option', { name: `${name} (v1.0.0)`, exact: true })).toBeVisible();
      if (keyboard) { await page.keyboard.press('End'); await page.keyboard.press('Enter'); }
      else await page.getByRole('option', { name: `${name} (v1.0.0)`, exact: true }).click();
      await expect(select).toContainText(name); await expect(select).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('listbox')).toHaveCount(0); await expect(dialog).toBeVisible();
    }
    await dialog.getByTestId('plugin-config-save-button').click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit', exact: true }).last().click();
    await expect(dialog.getByRole('combobox')).toBeDisabled(); await expect(dialog.getByRole('combobox')).toContainText('beta');
    await dialog.getByTestId('plugin-config-save-button').click(); await expect(dialog).toHaveCount(0);
  }, { beforeMount: async page => {
    // Install this case's catalog before mounting instead of aborting the first
    // catalog requests with a reload while they may still be in flight.
    await page.route(/^https?:\/\/[^/]+\/api\/plugins\/schemas(?:\?.*)?$/, route => {
      const url=new URL(route.request().url());
      return route.request().method()==='GET' && url.pathname==='/api/plugins/schemas' && url.searchParams.get('enabledOnly')==='true' && url.searchParams.get('scope')==='route'
        ? route.fulfill({json:schemas}) : route.fallback();
    });
    await page.route('**/api/plugins', route => route.request().method() === 'GET'
      ? route.fulfill({ json: Object.values(schemas).map(schema => ({ ...schema, enabled: true })) }) : route.fallback());
  } });
}, 60_000);
