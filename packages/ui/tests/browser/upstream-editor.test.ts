import { test } from 'bun:test';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage } = editorFixture(['upstreams']);

for (const mixed of [false, true]) test(`filtered endpoint actions edit only the original endpoint and preserve hidden entries (mixed=${mixed})`, async () => {
  await withPage(`scenario=upstreams${mixed ? '&mixed=1' : ''}`, async page => {
    const output = page.getByTestId('endpoints');
    const before = JSON.parse((await output.textContent())!);
    const referencesBefore = await page.getByTestId('service-references').textContent();
    const search = page.getByRole('textbox', { name: 'Search target address, description or service' });
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
    await expect(page.getByRole('listitem')).toHaveCount(mixed ? 4 : 3);
    expect(await page.getByTestId('service-references').textContent()).toBe(referencesBefore);
  });
}, 60_000);

test('filtered drag targets use full-list group boundaries and keep hidden group members', async () => {
  for (const action of ['merge', 'before', 'after']) await withPage('scenario=upstreams', async page => {
    await page.getByRole('textbox', { name: 'Search target address, description or service' }).fill('backup');
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer();
      data.setData('application/json', JSON.stringify({ key: 'endpoint:visible' }));
      return data;
    });
    try {
    const target = action === 'merge'
      ? page.getByRole('group').filter({ has: page.getByRole('listitem') }).last()
      : page.getByRole('group', { name: 'Insert New Priority Group', exact: true }).nth(action === 'before' ? 0 : 1);
    await target.dispatchEvent('drop', { dataTransfer: transfer });
    const endpoints = JSON.parse((await page.getByTestId('endpoints').textContent())!);
    expect(endpoints.map((item: { _uid: string }) => item._uid)).toEqual(action === 'before'
      ? ['hidden', 'visible', 'other'] : ['hidden', 'other', 'visible']);
    expect(endpoints.map((item: { priority: number }) => item.priority)).toEqual(action === 'merge' ? [1, 2, 2] : [1, 2, 3]);
    } finally { await transfer.dispose(); }
  });
}, 60_000);


test('mixed rows reorder by actual drop position and move between priority groups', async () => {
  await withPage('scenario=upstreams&mixed=1', async page => {
    const list = page.getByTestId('service-mixed-targets');
    const reference = list.locator('[data-target-key="service:child-reference"]');
    const endpoint = list.locator('[data-target-key="endpoint:visible"]');
    await reference.dragTo(endpoint, { sourcePosition: {x: 10, y: 15}, targetPosition: {x: 10, y: 1} });
    await expect.poll(async () => JSON.parse((await page.getByTestId('service-references').textContent())!)[0].position).toBe(1);
    const reordered = JSON.parse((await page.getByTestId('endpoints').textContent())!);
    expect(reordered.map((item: any) => item._uid)).toEqual(['hidden', 'visible', 'other']);
    expect(reordered.find((item: any) => item._uid === 'visible')._position).toBe(2);
    await reference.dragTo(list.locator('[data-target-key="endpoint:hidden"]'), { sourcePosition: {x: 10, y: 15}, targetPosition: {x: 10, y: 1} });
    await expect.poll(async () => JSON.parse((await page.getByTestId('service-references').textContent())!)[0].priority).toBe(1);
    await expect.poll(async () => JSON.parse((await page.getByTestId('service-references').textContent())!)[0].position).toBe(0);
    await reference.dragTo(list.getByTestId('upstream-priority-boundary').last(), { sourcePosition: {x: 10, y: 15} });
    await expect.poll(async () => JSON.parse((await page.getByTestId('service-references').textContent())!)[0].priority).toBe(4);
  });
}, 60_000);

test('filtered mixed drops preserve hidden targets and use stable identity', async () => {
  await withPage('scenario=upstreams&mixed=1', async page => {
    await page.getByRole('textbox', {name: 'Search target address, description or service'}).fill(' CHILD-SERVICE ');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer(); data.setData('application/json', JSON.stringify({key: 'endpoint:visible'})); return data;
    });
    try {
      await page.getByTestId('upstream-priority-boundary').first().dispatchEvent('drop', {dataTransfer: transfer});
      const endpoints = JSON.parse((await page.getByTestId('endpoints').textContent())!);
      const references = JSON.parse((await page.getByTestId('service-references').textContent())!);
      expect(endpoints.map((item: any) => [item._uid, item.priority, item.weight])).toEqual([['hidden',1,100],['visible',2,20],['other',4,30]]);
      expect(references[0]).toMatchObject({id:'child-reference', priority:3, position:2, weight:100});
      await page.getByRole('listitem').getByRole('spinbutton').fill('55');
      expect(JSON.parse((await page.getByTestId('endpoints').textContent())!)).toEqual(endpoints);
      expect(JSON.parse((await page.getByTestId('service-references').textContent())!)[0].weight).toBe(55);
      await page.getByRole('textbox', {name: 'Search target address, description or service'}).fill('');
      await expect(page.getByRole('listitem')).toHaveCount(4);
    } finally { await transfer.dispose(); }
  });
}, 60_000);
