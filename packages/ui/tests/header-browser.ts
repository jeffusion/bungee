import { chromium, expect } from 'playwright/test';
import { mkdirSync } from 'node:fs';

// Run against an isolated real management backend, never API mocks or production.
const base = process.env.HEADER_BASE_URL;
if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) {
  throw new Error('HEADER_BASE_URL must point to an isolated loopback instance');
}
const evidence = process.env.HEADER_EVIDENCE_DIR ?? '/tmp/opencode/header-browser';
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
const errors: string[] = [];
const checks: string[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('requestfailed', request => {
  if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(`${request.url()}: ${request.failure()?.errorText}`);
});
const header = page.getByTestId('app-header');
const trigger = page.locator('#header-management-trigger');
const menu = page.getByTestId('header-management-menu');
async function settled() {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); });
}
async function shot(name: string) { await settled(); await page.screenshot({ path: `${evidence}/${name}.png` }); }
async function openSystem() { await trigger.click(); await expect(menu).toBeVisible(); await settled(); }
async function login() {
  await expect(page.getByTestId('page-login')).toBeVisible();
  await page.locator('input[autocomplete="username"]').fill(process.env.HEADER_USERNAME!);
  await page.locator('input[autocomplete="current-password"]').fill(process.env.HEADER_PASSWORD!);
  await page.locator('form button[type="submit"], form button').click();
  await expect(header).toBeVisible({ timeout: 30000 });
}
try {
  await page.goto(`${base}/#/routes`);
  const mode = await (await context.request.get(`${base}/api/auth/mode`)).json();
  if (mode.mode === 'plugin') {
    if (!process.env.HEADER_USERNAME || !process.env.HEADER_PASSWORD) throw new Error('Real login credentials required');
    await login();
    await page.goto(`${base}/#/routes`);
  }
  await expect(header).toBeVisible();
  const plugins = await (await context.request.get(`${base}/api/plugins`)).json();
  const contributions = plugins.filter((p: any) => p.enabled).flatMap((p: any) =>
    (p.metadata?.contributes?.navigation ?? []).filter((n: any) => ['header', 'sidebar'].includes(n.target))
      .map((n: any) => `/#/extensions/${p.name}${n.path}`));
  for (const href of contributions) await expect(header.locator(`.header-tab[href="${href}"]`)).toBeVisible();
  await expect(header.locator('.header-tab[href="/#/config"], .header-tab[href="/#/plugins"]')).toHaveCount(0);
  await shot('desktop-business');
  await trigger.hover(); await shot('desktop-hover');
  await trigger.focus(); await shot('desktop-focus');
  await trigger.press('Enter'); await expect(menu).toBeVisible();
  await shot('desktop-system-menu');
  await expect(menu.getByRole('menuitem', { name: /退出登录/ })).toHaveCount(mode.mode === 'plugin' ? 1 : 0);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  await openSystem(); await page.locator('h1').click(); await expect(menu).toHaveCount(0);
  checks.push('business/admin separation; real enabled plugin contributions; hover/focus; Enter/Escape/outside dismissal');

  await openSystem(); await menu.locator('a[href="/#/plugins"]').focus(); await page.keyboard.press('Enter');
  await expect(page.getByTestId('page-plugins')).toBeVisible();
  await expect(header.locator('.header-tab[aria-current="page"]')).toHaveCount(0);
  await openSystem(); await expect(menu.locator('a[href="/#/plugins"]')).toHaveAttribute('aria-current', 'page');
  await shot('desktop-management-active');
  await menu.locator('a[href="/#/config"]').click();
  await expect(page.getByTestId('page-config')).toBeVisible();
  await openSystem(); await expect(menu.locator('a[href="/#/config"]')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  checks.push('keyboard/native administration links and correct active states');

  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('#config-request-limit').fill('51mb');
    await openSystem(); await menu.locator('a[href="/#/plugins"]').click();
    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect(confirmation).toContainText('草稿');
    await confirmation.getByTestId('confirmation-cancel').click();
    await expect(page.locator('#config-request-limit')).toHaveValue('51mb');
    await expect(trigger).toBeFocused();
    if (width === 390) {
      await page.locator('#header-menu-trigger').click();
      await page.getByTestId('header-menu').locator('a[href="/#/routes"]').click();
      await expect(page.getByTestId('header-menu')).toHaveCount(0);
      await expect(confirmation).toBeVisible();
      await confirmation.getByTestId('confirmation-cancel').click();
      await expect(page.locator('#header-menu-trigger')).toBeFocused();
      await expect(page.locator('#config-request-limit')).toHaveValue('51mb');
    }
    await page.locator('#config-request-limit').fill('');
  }
  checks.push('unsaved draft preserved and confirmation focus restored at 1440/768/390');

  await openSystem(); await menu.getByRole('menuitem', { name: /语言/ }).focus();
  await page.keyboard.press('ArrowRight');
  const english = page.getByRole('menuitemradio', { name: 'English', exact: true });
  await expect(english).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: '中文', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(english).toBeFocused(); await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-label', 'System');
  await page.setViewportSize({ width: 768, height: 844 });
  await page.goto(`${base}/#/routes`);
  if (contributions.length) {
    const last = header.locator(`.header-tab[href="${contributions.at(-1)}"]`);
    await last.focus(); await page.keyboard.press('Enter');
    await expect(last).toHaveAttribute('aria-current', 'page');
    const rect = await last.boundingBox(), buttonRect = await trigger.boundingBox();
    if (!rect || !buttonRect || rect.x + rect.width > buttonRect.x + 1) throw new Error('Active plugin navigation hidden behind administration');
  }
  await shot('tablet-english-plugin');
  await openSystem(); await menu.getByRole('menuitem', { name: /Language/ }).click();
  await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-label', '系统管理');
  checks.push('real plugin navigation with overflow; Chinese/English language selection');

  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 667, height: 320 }]) {
    await page.setViewportSize(viewport);
    const pageTrigger = page.locator('#header-menu-trigger');
    await pageTrigger.click();
    const sheet = page.getByTestId('header-menu');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('a[href="/#/config"], a[href="/#/plugins"]')).toHaveCount(0);
    await expect(sheet.getByText('语言', { exact: true })).toHaveCount(0);
    for (const href of contributions) await expect(sheet.locator(`a[href="${href}"]`)).toBeVisible();
    await shot(`mobile-pages-${viewport.width}`);
    await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0); await expect(pageTrigger).toBeFocused();
    await openSystem(); await shot(`mobile-system-${viewport.width}`);
    const box = await menu.boundingBox();
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) throw new Error(`Menu overflow at ${viewport.width}`);
    await menu.getByRole('menuitem', { name: /语言/ }).click();
    await expect(page.getByRole('menuitemradio', { name: 'English', exact: true })).toBeVisible();
    await page.getByRole('menuitemradio', { name: '中文', exact: true }).click();
  }
  await openSystem(); await page.setViewportSize({ width: 1024, height: 844 });
  await expect(menu).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
  checks.push('separate mobile pages/system entry, touch language selection, 320/390/667 landscape bounds, breakpoint dismissal');

  if (mode.mode === 'plugin') {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`${base}/#/config`);
      await expect(page.locator('#config-request-limit')).toBeVisible();
      await page.locator('#config-request-limit').fill('51mb');
      await openSystem(); await menu.getByRole('menuitem', { name: '退出登录', exact: true }).click();
      const confirmation = page.getByRole('dialog');
      await expect(confirmation).toBeVisible(); await expect(menu).toHaveCount(0);
      await expect(confirmation).toContainText('草稿');
      await shot(`logout-confirmation-${width}`);
      await confirmation.getByTestId('confirmation-cancel').click();
      await expect(trigger).toBeFocused(); await expect(page.locator('#config-request-limit')).toHaveValue('51mb');
      await openSystem(); await menu.getByRole('menuitem', { name: '退出登录', exact: true }).click();
      await confirmation.getByRole('button', { name: '确认', exact: true }).click();
      await expect(header).toHaveCount(0); await expect(page.getByTestId('page-login')).toBeVisible();
      await login();
    }
    checks.push('real cookie login/logout: cancel preserves draft, accepted logout hides shell at desktop/mobile');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/#/routes`); await expect(header).toBeVisible();
  await shot('desktop-business'); await openSystem(); await shot('desktop-system-menu');

  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true });
  try {
    const touchPage = await touchContext.newPage();
    touchPage.on('pageerror', error => errors.push(error.message));
    await touchPage.goto(`${base}/#/routes`);
    if (mode.mode === 'plugin') {
      await touchPage.locator('input[autocomplete="username"]').fill(process.env.HEADER_USERNAME!);
      await touchPage.locator('input[autocomplete="current-password"]').fill(process.env.HEADER_PASSWORD!);
      await touchPage.locator('form button').tap();
    }
    await expect(touchPage.getByTestId('app-header')).toBeVisible();
    await touchPage.locator('#header-management-trigger').tap();
    const touchMenu = touchPage.getByTestId('header-management-menu');
    await expect(touchMenu).toBeVisible();
    await touchMenu.getByRole('menuitem', { name: /语言/ }).tap();
    await touchPage.getByRole('menuitemradio', { name: 'English', exact: true }).tap();
    await expect(touchPage.locator('#header-management-trigger')).toHaveAttribute('aria-label', 'System');
    await expect(touchMenu).toHaveCount(0);
    await touchPage.locator('#header-menu-trigger').tap();
    await expect(touchPage.getByTestId('header-menu')).toBeVisible();
    await touchPage.getByTestId('header-menu').locator('a[href="/#/services"]').tap();
    await expect(touchPage.getByTestId('page-services')).toBeVisible();
    checks.push('touch-enabled mobile: tap opens language submenu, selects locale and navigates business pages; keyboard submenu arrows');
  } finally { await touchContext.close(); }
  expect(errors).toEqual([]);
  console.log('HEADER_BROWSER_PASS', JSON.stringify(checks));
} finally {
  await Bun.write(`${evidence}/report.json`, JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
