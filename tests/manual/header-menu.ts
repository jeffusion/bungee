import { chromium, type Page } from 'playwright';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run against this checkout's UI and a disposable real management service.
// No API mocking, route interception, or production credentials.
const base = process.env.HEADER_UI_URL;
assert.ok(base, 'HEADER_UI_URL must identify a disposable local UI');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const evidence = resolve(process.env.HEADER_UI_EVIDENCE ?? '/tmp/bungee-header-menu-browser');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
const errors: string[] = [];
const results: object[] = [];
let writes = 0;
const matrix = [
  ['narrow', 320, 740], ['mobile', 390, 844], ['landscape', 667, 320],
  ['collapsed-edge', 767, 900], ['desktop-edge', 768, 900], ['desktop', 1440, 900],
] as const;
const stableMenu = async (page: Page) => {
  await page.getByTestId('header-menu').waitFor();
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-testid="header-menu"]');
    return menu && Math.abs(menu.getBoundingClientRect().left) < 1;
  });
};
const noOverflow = async (page: Page) => {
  // The reference page contains unrelated wide demos; check the actual shell.
  assert.equal(await page.getByTestId('app-header').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.left < 0 || rect.right > innerWidth || el.scrollWidth > el.clientWidth;
  }), false);
  assert.equal(await page.getByTestId('header-menu').evaluate(el => {
    // Corner brackets intentionally extend 2px beyond the chassis border.
    const body = el.querySelector('nav')!.parentElement!;
    const rect = el.getBoundingClientRect();
    return body.scrollWidth > body.clientWidth || [...el.querySelectorAll('button, a')].some(control => {
      const box = control.getBoundingClientRect();
      return box.left < rect.left || box.right > rect.right;
    });
  }), false);
};
const accent = 'rgb(249, 115, 22)';
try {
  for (const language of ['zh-CN', 'en']) {
    for (const [name, width, height] of matrix) {
      const id = `${language}-${name}`;
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addInitScript(value => localStorage.setItem('locale', value), language);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${id}: ${error.message}`));
      page.on('console', message => { if (message.type() === 'error') errors.push(`${id}: ${message.text()}`); });
      page.on('requestfailed', request => errors.push(`${id}: ${request.url()}: ${request.failure()?.errorText}`));
      page.on('response', response => { if (response.status() >= 400) errors.push(`${id}: HTTP ${response.status()} ${response.url()}`); });
      page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes++; });
      await page.goto(`${base}/#/design`);
      await page.getByRole('heading', { name: 'Design System', exact: true }).waitFor();
      // The canonical default-size Button on the live component reference.
      const reference = page.getByRole('button', { name: 'MD', exact: true });
      const referenceStyle = await reference.evaluate(el => ({
        height: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize,
      }));
      assert.deepEqual(referenceStyle, { height: 34, font: '11px' });
      const trigger = page.locator('#header-menu-trigger');
      if (width >= 768) {
        assert.equal(await trigger.isVisible(), false);
        assert.equal(await page.locator('.header-navigation').isVisible(), true);
        await page.screenshot({ path: resolve(evidence, `${id}.png`) });
        results.push({ id, desktopNavigation: true });
        await context.close();
        continue;
      }
      assert.deepEqual(await trigger.evaluate(el => ({
        height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width,
        border: getComputedStyle(el).borderWidth, separator: getComputedStyle(el.parentElement!).borderRightWidth,
      })), { height: 44, width: 44, border: '0px', separator: '0px' });
      await trigger.hover();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('header-menu-trigger')!).backgroundColor === 'rgb(26, 29, 36)');
      await page.mouse.move(0, height - 1);
      await trigger.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await trigger.evaluate(el => el.matches(':focus-visible')), true);
      assert.equal(await trigger.evaluate(el => getComputedStyle(el).outlineColor), accent);
      assert.equal(await trigger.evaluate(el => getComputedStyle(el).outlineWidth), '2px');
      await page.screenshot({ path: resolve(evidence, `${id}-trigger-focus.png`) });
      await page.keyboard.press('Enter');
      await stableMenu(page);
      const menu = page.getByTestId('header-menu');
      const controls = await menu.locator('button, a').evaluateAll(els => els.map(el => ({
        text: el.textContent?.trim(), height: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize,
      })));
      // Four built-in business pages plus close; plugin contributions may add more.
      assert.ok(controls.length >= 5);
      assert.equal(await menu.locator('a[href="/#/config"], a[href="/#/plugins"]').count(), 0);
      for (const control of controls) assert.deepEqual({ height: control.height, font: control.font }, referenceStyle, control.text);
      await noOverflow(page);
      await page.screenshot({ path: resolve(evidence, `${id}-menu.png`) });
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
      // Language selection has its own header entry, separate from both navigation menus.
      const alternate = language === 'en' ? '中文' : 'English';
      const alternateCode = language === 'en' ? 'zh-CN' : 'en';
      const languageTrigger = page.locator('#header-language-trigger');
      const languageMenu = page.getByTestId('header-language-menu');
      await languageTrigger.click();
      await page.getByRole('menuitemradio', { name: alternate, exact: true }).click();
      await languageMenu.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => localStorage.getItem('locale')), alternateCode);
      assert.equal(await languageTrigger.getAttribute('aria-label'), alternateCode === 'en' ? 'Language' : '语言');
      await languageTrigger.click();
      assert.equal(await page.getByRole('menuitemradio', { name: alternate, exact: true }).getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Escape');
      await languageMenu.waitFor({ state: 'detached' });
      assert.equal(await languageTrigger.evaluate(el => document.activeElement === el), true);
      await trigger.click();
      await stableMenu(page);
      await menu.locator('a[href="/#/services"]').focus();
      await page.keyboard.press('Enter');
      await menu.waitFor({ state: 'detached' });
      assert.equal(new URL(page.url()).hash, '#/services');
      await trigger.click();
      await stableMenu(page);
      assert.equal(await menu.locator('a[href="/#/services"]').getAttribute('aria-current'), 'page');
      assert.equal(await menu.locator('[aria-current="page"]').count(), 1);
      const close = menu.getByRole('button', { name: /关闭菜单|Close menu/ });
      await close.scrollIntoViewIfNeeded();
      await close.click();
      await menu.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
      await trigger.click();
      await stableMenu(page);
      await page.mouse.click(width - 4, Math.floor(height / 2));
      await menu.waitFor({ state: 'detached' });
      await trigger.click();
      await stableMenu(page);
      await page.setViewportSize({ width: 768, height: 900 });
      await menu.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.header-navigation').isVisible(), true);
      assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).overflow), 'hidden');
      results.push({ id, referenceStyle, controls, keyboard: true, language: true, navigation: true, dismissal: true, resize: true });
      await context.close();
    }
  }
  assert.equal(writes, 0, 'header appearance/navigation must not write to the management service');
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(resolve(evidence, 'report.json'), JSON.stringify({ results, errors, writes }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ cases: results.length, errors, writes, evidence }));
