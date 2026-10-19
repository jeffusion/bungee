import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { expect } from 'playwright/test';
import { editorFixture } from '../helpers/editors/component-fixture';
const { withPage, fixtureUrl } = editorFixture(['dialogs']);

test('dialog focus and close interactions',async()=>{
await withPage('scenario=dialogs',async page=>{
const base=fixtureUrl('dialogs');
const dialog=page.getByRole('dialog');
  const settleDialog = async () => {
    await dialog.waitFor();
    await dialog.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    await expect.poll(() => dialog.evaluate(element => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return transform.a === 1 && transform.d === 1;
    }), { timeout: 10000 }).toBe(true);
  };
  for (const kind of ['industrial', 'standard']) {
    await page.goto(`${base}?dialog=${kind}`);
    await page.setViewportSize({ width: 900, height: 700 });
    const opener = page.getByRole('button', { name: 'Open focus fixture', exact: true });
    const closeButton = dialog.getByRole('button', { name: 'Close', exact: true });
    const closeStyle = () => closeButton.evaluate(element => {
      const style = getComputedStyle(element);
      return { focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'),
        shadow: style.boxShadow, ring: style.getPropertyValue('--tw-ring-shadow').trim(), offset: style.getPropertyValue('--tw-ring-offset-shadow').trim(),
        border: style.borderTopColor, borderWidth: style.borderTopWidth, color: style.color, background: style.backgroundColor,
        outline: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor };
    });
    const assertIndustrial = (style: Awaited<ReturnType<typeof closeStyle>>, active = true) => {
      assert.equal(style.shadow, 'none'); assert.equal(style.outlineWidth, '0px');
      assert.equal(style.borderWidth, '2px');
      assert.equal(style.border, active ? 'rgb(249, 115, 22)' : 'rgb(55, 61, 74)');
      assert(style.ring.includes('calc(0px + 0px)'), `ring must be zero: ${style.ring}`);
      assert(style.offset.startsWith('0 0 0 0px'), `offset must be zero: ${style.offset}`);
    };
    const closeScreenshot = async (state: string) => {
      const box = await closeButton.boundingBox(); assert(box && await closeButton.isVisible());
      const clip = { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
      assert(clip.x >= 0 && clip.y >= 0 && clip.x + clip.width <= 900 && clip.y + clip.height <= 700);
      await page.screenshot({ path: `/tmp/bungee-dialog-${kind}-close-${state}.png`, clip });
    };
    await opener.click(); await dialog.waitFor(); await settleDialog();
    await expect(closeButton).toBeFocused();
    if (kind === 'industrial') {
      const focus = await closeStyle(); assert(focus.focused && !focus.focusVisible, JSON.stringify(focus)); assertIndustrial(focus);
      await closeScreenshot('focus');
      await closeButton.evaluate(element => (element as HTMLElement).blur());
      const idle = await closeStyle(); assert(!idle.focused); assertIndustrial(idle, false);
      await closeScreenshot('default');
      await closeButton.hover();
      const hover = await closeStyle(); assert(!hover.focused); assertIndustrial(hover);
      await closeScreenshot('hover-only');
      await page.mouse.move(5, 5);
      await closeButton.evaluate(element => (element as HTMLElement).focus());
      const programmatic = await closeStyle(); assert(programmatic.focused && !programmatic.focusVisible); assertIndustrial(programmatic);
      await closeScreenshot('programmatic-pointer');
      console.log('CLOSE ALL STATES industrial', JSON.stringify({ idle, hover, focus, programmatic }));
    }
    await closeButton.hover();
    const mouse = await closeStyle();
    assert(mouse.focused && !mouse.focusVisible, `${kind}: mouse-opened close keeps focus without focus-visible`);
    assert.equal(mouse.shadow, 'none', `${kind}: mouse hover has no ring/offset shadow`);
    assert(mouse.outline === 'none' || mouse.outlineWidth === '0px', `${kind}: mouse hover has no extra outline`);
    if (kind === 'industrial') assertIndustrial(mouse);
    await closeScreenshot('mouse-hover');
    await page.screenshot({ path: `/tmp/bungee-dialog-${kind}-mouse-hover.png` });
    await page.mouse.move(5, 5);
    await page.keyboard.press('Tab');
    const keyboard = await closeStyle();
    assert(keyboard.focused && keyboard.focusVisible, `${kind}: keyboard close has visible focus`);
    if (kind === 'industrial') {
      assertIndustrial(keyboard);
      assert.equal(keyboard.color, 'rgb(253, 186, 116)');
      assert.equal(keyboard.background, 'rgba(249, 115, 22, 0.1)');
      await closeButton.evaluate(element => { (element as HTMLElement).blur(); (element as HTMLElement).focus(); });
      const programmatic = await closeStyle();
      assert(programmatic.focusVisible); assertIndustrial(programmatic);
      await closeScreenshot('programmatic-keyboard');
      console.log('CLOSE PROGRAMMATIC industrial', JSON.stringify(programmatic));
    } else {
      assert(keyboard.shadow.includes('rgb(249, 115, 22) 0px 0px 0px 4px'), `${kind}: keyboard retains orange ring: ${keyboard.shadow}`);
      assert(keyboard.shadow.includes('rgb(10, 11, 14) 0px 0px 0px 2px'), `${kind}: keyboard retains carbon offset: ${keyboard.shadow}`);
    }
    await page.screenshot({ path: `/tmp/bungee-dialog-${kind}-keyboard-focus.png` });
    await closeScreenshot('keyboard-focus');
    console.log(`CLOSE FOCUS ${kind}`, JSON.stringify({ mouse, keyboard }));
    for (const key of ['Tab', 'Shift+Tab', 'Tab']) {
      await page.keyboard.press(key);
      assert(await dialog.evaluate(element => element.contains(document.activeElement)), `${kind}: focus stays trapped`);
    }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Open focus fixture');
    assert(await opener.evaluate(element => element === document.activeElement));
    for (const key of ['Enter', 'Space']) {
      await opener.click(); await dialog.waitFor(); await settleDialog();
      await expect(closeButton).toBeFocused();
      await page.keyboard.press('Tab');
      assert((await closeStyle()).focusVisible);
      await page.keyboard.press(key); await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Open focus fixture');
      assert(await opener.evaluate(element => element === document.activeElement), `${kind}: ${key} restores opener focus`);
    }
  }

});
},240_000);

test('dialog stationary chrome and focus trap',async()=>{
await withPage('scenario=dialogs',async page=>{
const base=fixtureUrl('dialogs');
const dialog=page.getByRole('dialog');
  const settleDialog = async () => {
    await dialog.waitFor();
    await dialog.evaluate(async element => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
    });
    await expect.poll(() => dialog.evaluate(element => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return transform.a === 1 && transform.d === 1;
    }), { timeout: 10000 }).toBe(true);
  };
  await page.setViewportSize({width:1100,height:850});
  await page.goto(`${base}?design`);
  const exampleTrigger = page.getByRole('button', { name: /Open industrial dialog/ });
  await exampleTrigger.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-catalog.png' });
  await exampleTrigger.click(); await dialog.waitFor(); await settleDialog();
  const standardDialog = async () => {
    await settleDialog();
    const labelledBy = await dialog.getAttribute('aria-labelledby'), describedBy = await dialog.getAttribute('aria-describedby');
    assert(labelledBy && describedBy);
    assert(await page.locator(`[id="${labelledBy}"]`).textContent());
    assert(await page.locator(`[id="${describedBy}"]`).textContent());
    assert.equal(await dialog.locator('button.absolute').count(), 1, 'Content owns the close button');
    assert(await dialog.evaluate(element => element.matches('.nx-panel-raised.nx-bracketed')));
    assert.equal(await dialog.getByRole('button', { name: '关闭 / Close', exact: true }).count(), 1);
    const structure = await dialog.evaluate(element => {
      const header = element.querySelector('header')!, footer = element.querySelector('footer')!, body = element.querySelector('[data-dialog-body]')!;
      const style = getComputedStyle(element);
      return { overflow: style.overflow, display: style.display, direction: style.flexDirection,
        headerShrink: getComputedStyle(header).flexShrink, footerShrink: getComputedStyle(footer).flexShrink,
        footerBorder: getComputedStyle(footer).borderTopWidth, footerPadding: getComputedStyle(footer).paddingTop,
        border: style.borderTopColor, radius: style.borderRadius,
        siblings: header.parentElement === body.parentElement && footer.parentElement === body.parentElement };
    });
    assert.equal(structure.overflow, 'visible'); assert.equal(structure.display, 'flex'); assert.equal(structure.direction, 'column');
    assert.equal(structure.headerShrink, '0'); assert.equal(structure.footerShrink, '0'); assert(structure.siblings);
    assert.equal(structure.footerBorder, '1px'); assert.notEqual(structure.footerPadding, '0px'); assert.equal(structure.radius, '0px');
    assert.notEqual(structure.border, 'rgb(255, 255, 255)');
  };
  await standardDialog();
  const body = dialog.locator('[data-dialog-body]');
  const before = await dialog.locator('header, footer').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
  await body.evaluate(element => element.scrollTop = element.scrollHeight);
  assert(await body.evaluate(element => element.scrollTop > 0));
  assert.deepEqual(await dialog.locator('header, footer').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON())), before);
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/bungee-industrial-dialog-design-mobile.png' });
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); assert(await dialog.evaluate(element => element.contains(document.activeElement)), 'focus stays trapped'); }
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert(await exampleTrigger.evaluate(element => element === document.activeElement), 'focus returns to opener');
  await exampleTrigger.click(); await dialog.waitFor(); await settleDialog();
  await page.mouse.click(3, 3); await dialog.waitFor({ state: 'hidden' });

});
},240_000);

test('dialog select popup crosses the chassis without clipping and its final option stays actionable',async()=>{
await withPage('scenario=dialogs',async page=>{
const base=fixtureUrl('dialogs');const dialog=page.getByRole('dialog');
await page.setViewportSize({width:1100,height:850});
await page.goto(`${base}?select`);
await page.getByRole('button',{name:'Open selection',exact:true}).click();
  const verifyDropdown = async (size: string) => {
    await dialog.getByLabel('Choose service', { exact: true }).click();
    const list = page.getByRole('listbox');
    await list.waitFor();
    await list.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)); });
    assert.equal(await list.getByRole('option').count(), 13);
    const geometry = await list.evaluate(element => {
      const rect = element.getBoundingClientRect(), modal = document.querySelector('[role="dialog"]')!.getBoundingClientRect();
      const ancestors = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        ancestors.push({ tag: parent.tagName, overflowX: style.overflowX, overflowY: style.overflowY });
      }
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: innerHeight, width: innerWidth,
        outside: rect.bottom > modal.bottom || rect.top < modal.top,
        overflow: getComputedStyle(element).overflowY, scrollable: element.scrollHeight > element.clientHeight, ancestors };
    });
    assert(geometry.top >= 0 && geometry.left >= 0 && geometry.bottom <= geometry.height && geometry.right <= geometry.width);
    assert(geometry.outside, 'dropdown must visibly cross the modal boundary');
    assert.equal(geometry.overflow, 'auto'); assert(geometry.scrollable);
    assert(geometry.ancestors.every(parent => !['auto', 'scroll', 'hidden', 'clip'].includes(parent.overflowY) || parent.tag === 'BODY' || parent.tag === 'HTML'), 'no clipping/scrolling ancestor around inline dropdown');
    const last = list.getByRole('option').last();
    await last.scrollIntoViewIfNeeded();
    assert(await last.evaluate(element => {
      const r = element.getBoundingClientRect(), list = element.closest('[role="listbox"]')!.getBoundingClientRect();
      return r.top >= list.top && r.bottom <= list.bottom && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), 'last option is inside list viewport and actually hit-testable');
    await page.screenshot({ path: `/tmp/bungee-oauth-service-select-${size}.png` });
    await last.click();
    assert.match(await dialog.getByRole('combobox').innerText(), /Service 11/);
  };

await verifyDropdown('desktop');
await page.setViewportSize({width:390,height:844});
await verifyDropdown('mobile');
});
},60_000);
