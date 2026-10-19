import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['upstreams']);

test('filtered endpoint actions edit only the original endpoint and preserve hidden entries', async () => {
  await withPage('scenario=upstreams', async page => {
    const output = page.getByTestId('endpoints');
    const before = JSON.parse((await output.textContent())!);
    const search = page.getByRole('textbox', { name: 'Search endpoint address or description' });
    await search.fill(' ALPHA ');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    const row = page.getByRole('listitem');
    await row.getByRole('spinbutton').fill('45');
    await row.getByRole('switch').click();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const description = dialog.getByPlaceholder('e.g., Primary database server');
    await description.fill('edited');
    await page.getByTestId('upstream-modal-save').click();
    await expect(dialog).toHaveCount(0);
    const edited = JSON.parse((await output.textContent())!);
    expect(edited[0]).toEqual(before[0]);
    expect(edited[1]).toMatchObject({ _uid: 'visible', description: 'edited', weight: 45, is_disabled: true });
    await row.getByRole('button', { name: 'Duplicate', exact: true }).click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    const copied = JSON.parse((await output.textContent())!);
    expect(copied[2]).toMatchObject({ description: 'edited', target: 'https://ALPHA.test-copy' });
    expect(copied[2]._uid).not.toBe('visible');
    await page.getByRole('listitem').first().getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(output).not.toContainText('"_uid":"visible"');
    expect(JSON.parse((await output.textContent())!)[0]).toEqual(before[0]);
    await search.fill('');
    await expect(page.getByRole('listitem')).toHaveCount(3);
  });
}, 60_000);

test('filtered drag targets use full-list group boundaries and keep hidden group members', async () => {
  for (const action of ['merge', 'before', 'after']) await withPage('scenario=upstreams', async page => {
    await page.getByRole('textbox', { name: 'Search endpoint address or description' }).fill('backup');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.setData('application/json', JSON.stringify({ originalIndex: 1 }));
      return data;
    });
    try {
    const target = action === 'merge'
      ? page.getByRole('group').filter({ has: page.getByRole('listitem') }).last()
      : page.getByRole('group', { name: 'Insert New Priority Group', exact: true }).nth(action === 'before' ? 0 : 1);
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    const endpoints = JSON.parse((await page.getByTestId('endpoints').textContent())!);
    expect(endpoints.map((item: { _uid: string }) => item._uid)).toEqual(action === 'after'
      ? ['hidden', 'other', 'visible'] : ['hidden', 'visible', 'other']);
    expect(endpoints.map((item: { priority: number }) => item.priority)).toEqual(action === 'merge' ? [1, 2, 2] : [1, 2, 3]);
    } finally { await transfer.dispose(); }
  });
}, 60_000);
