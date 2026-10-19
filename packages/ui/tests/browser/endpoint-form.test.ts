import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { editorFixture } from '../helpers/editors/component-fixture';
const {withPage,fixtureUrl}=editorFixture(['endpoint']);
test('endpoint modal and inline form each own one chassis',async()=>{
await withPage('scenario=endpoint',async page=>{
const base=fixtureUrl('endpoint');const dialog=page.getByRole('dialog');
  // The real endpoint modal retains its own chassis, but UpstreamForm adds no second outer panel.
  await page.setViewportSize({width:1100,height:850});
  await page.goto(`${base}?endpoint=modal`);
  await page.getByRole('button', { name: 'Open endpoint', exact: true }).click();
  const form = dialog.getByTestId('upstream-form');
  await form.getByText('Plugin-managed upstream', { exact: true }).waitFor();
  assert.equal((await form.getAttribute('class')) ?? '', '');
  assert.equal(await form.locator(':scope > .nx-panel-body').count(), 0);
  assert.equal(await dialog.locator(':scope > .nx-panel-raised.nx-bracketed').count(), 1);
  assert(await form.getByText('Plugin-managed upstream', { exact: true }).evaluate(element => !!element.closest('.nx-panel-raised, .nx-panel')));
  assert.deepEqual(await form.evaluate(element => {
    const style = getComputedStyle(element);
    return { border: style.borderTopWidth, background: style.backgroundColor, padding: style.padding };
  }), { border: '0px', background: 'rgba(0, 0, 0, 0)', padding: '0px' });
  await page.screenshot({ path: '/tmp/bungee-endpoint-modal-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-endpoint-modal-mobile.png' });
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto(`${base}?endpoint=inline`);
  await page.getByTestId('upstream-form').getByText('Plugin-managed upstream', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('upstream-form').getAttribute('class'), 'nx-panel-raised');
  assert.equal(await page.getByTestId('upstream-form').locator(':scope > .nx-panel-body').count(), 1);

});
},60_000);
