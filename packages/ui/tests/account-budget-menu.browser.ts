import { chromium, expect } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from './fixtures/publication';

// Render the real UI with simulated API responses; never change a live account or budget.
const base = process.env.ACCOUNT_BUDGET_UI_URL ?? 'http://127.0.0.1:5185';
const evidence = '/tmp/bungee-account-budget-menu';
const manifests = await Promise.all(['local-accounts', 'token-budget', 'key-access'].map(name =>
  Bun.file(new URL(`../../../plugins/${name}/manifest.json`, import.meta.url)).json()));
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  for (const language of ['zh-CN', 'en']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: language });
    await context.addInitScript(value => localStorage.setItem('locale', value), language);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    let authenticated = true, budgetEnabled = true;
    let session = { version: 1, policy: { idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480 } };
    let policy = { mode: 'daily', unit: 'tokens', limit: 1000 };
    const key = { id: 'key-test', name: 'demo-app', prefix: 'bk_example', createdAt: Date.now(), expiresAt: null, revokedAt: null };
    const writes: Array<{ path: string; body: unknown }> = [];
    const t = (name: string, message: string) => manifests.find(item => item.name === name).translations[language][message];
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ json: value });
      if (url.pathname === '/api/auth/mode') return json({ mode: 'plugin', publicOrigin: url.origin,
        provider: { name: 'local-accounts', loginComponent: 'LocalAccountsLogin' } });
      if (url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: authenticated,
        ...(authenticated ? { subject: { id: 'admin-test', provider: 'local-accounts' }, csrfToken: 'test-csrf' } : {}) });
      if (url.pathname === '/api/plugins') return json(manifests.map(manifest => ({ name: manifest.name,
        enabled: manifest.name !== 'token-budget' || budgetEnabled, version: manifest.version,
        metadata: { ...manifest.metadata, contributes: manifest.contributes } })));
      if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(['zh-CN', 'en'].map(code =>
        [code, { plugins: Object.fromEntries(manifests.map(item => [item.name, item.translations[code]])) }])));
      if (url.pathname === '/api/config/runtime') return json(runtime);
      if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
      if (url.pathname === '/api/plugins/local-accounts/control/self') return json({ administrator: { id: 'admin-test', username: 'admin' } });
      if (url.pathname === '/api/plugins/local-accounts/control/session-policy') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          session = { version: session.version + 1, policy: body.policy };
        }
        return json(session);
      }
      if (url.pathname === '/api/plugins/local-accounts/control/password') {
        writes.push({ path: url.pathname, body: request.postDataJSON() }); authenticated = false;
        return json({ success: true });
      }
      if (url.pathname === '/api/resources/api-key') return json({ keys: [key] });
      if (url.pathname === '/api/resources/api-key/key-test/extensions') return json({ extensions: [{
        plugin: 'token-budget', component: 'TokenBudgetKeyPolicy', path: '/keys/:keyId', active: true, ready: true,
        value: policy, usage: { cumulative: 0, monthly: {}, weekly: {}, daily: {}, unresolved: {} } }] });
      if (url.pathname === '/api/plugins/token-budget/control/keys/key-test') {
        const body = request.postDataJSON(); writes.push({ path: url.pathname, body }); policy = body;
        return json({ value: policy });
      }
      return json({});
    });
    for (const [name, testId] of [['local-accounts', 'management-auth-settings'], ['token-budget', 'policy-settings-budget']]) {
      const canonical = `/extensions/${name}/settings`;
      await page.goto(`${base}/#/plugins`);
      const card = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({ hasText: t(name, 'metadata.name') });
      await expect(card).toBeVisible();
      await expect(card.locator(`a[href^="/#/plugins/${name}"]`)).toHaveCount(0);
      await expect(card.locator(`a[href="/#${canonical}"]`)).toBeVisible();
      const menu = page.getByTestId('app-header').getByRole('link', { name: t(name, 'metadata.name'), exact: true });
      await menu.click();
      const settings = page.getByTestId(testId);
      await expect(settings).toContainText(name === 'local-accounts' ? 'admin' : key.name);
      await page.reload(); await expect(settings).toContainText(name === 'local-accounts' ? 'admin' : key.name);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        if (width < 768) {
          await page.locator('#header-menu-trigger').click();
          const sheet = page.getByTestId('header-menu');
          const link = sheet.getByRole('link', { name: t(name, 'metadata.name'), exact: true });
          await expect(link).toHaveAttribute('aria-current', 'page');
          if (language === 'zh-CN' && width === 390 && name === 'token-budget') await page.screenshot({
            path: `${evidence}/menu-390.png`, fullPage: true, animations: 'disabled' });
          await link.click(); await expect(sheet).toHaveCount(0);
        } else await expect(menu).toHaveAttribute('aria-current', 'page');
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        if (language === 'zh-CN' && [390, 1440].includes(width)) await page.screenshot({
          path: `${evidence}/${name}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      for (const oldPath of [`/plugins/${name}/settings?from=bookmark`, `/plugins/${name}?from=bookmark`]) {
        await page.goto(`${base}/#${oldPath}`);
        await expect.poll(() => new URL(page.url()).hash).toBe(`#${canonical}?from=bookmark`);
        await expect(settings).toBeVisible();
      }
      if (name === 'local-accounts') {
        await settings.locator('#session-idleTimeoutMinutes').fill('45');
        await settings.getByRole('button', { name: t(name, 'session.save'), exact: true }).click();
        await expect(settings.getByRole('status')).toHaveText(t(name, 'session.saved'));
        expect(writes.at(-1)).toEqual({ path: '/api/plugins/local-accounts/control/session-policy',
          body: { version: 1, policy: { idleTimeoutMinutes: 45, absoluteTimeoutMinutes: 480 } } });
      } else {
        await expect(settings.getByRole('link', { name: t(name, 'ui.manageKeys'), exact: true }))
          .toHaveAttribute('href', '/#/extensions/key-access/settings');
        await settings.getByRole('button', { name: t(name, 'ui.edit'), exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel(t(name, 'ui.tokenLimit'), { exact: true }).fill('2000');
        await dialog.getByRole('button', { name: t(name, 'ui.save'), exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(writes.at(-1)).toEqual({ path: '/api/plugins/token-budget/control/keys/key-test',
          body: { mode: 'daily', unit: 'tokens', limit: 2000 } });
        await expect(settings).toContainText('2,000');
        await page.goto(`${base}/#/plugins/token-budget/settings?keyId=key-test`);
        await expect.poll(() => new URL(page.url()).hash).toBe('#/extensions/token-budget/settings?keyId=key-test');
        await expect(page.getByRole('dialog')).toContainText(key.name);
        await page.getByRole('dialog').getByRole('contentinfo').getByRole('button', { name: t(name, 'ui.close'), exact: true }).click();
      }
    }
    budgetEnabled = false; await page.goto(`${base}/#/plugins`); await page.reload();
    await expect(page.getByTestId('app-header').getByRole('link', { name: t('token-budget', 'metadata.name'), exact: true })).toHaveCount(0);
    await page.goto(`${base}/#/extensions/local-accounts/settings`);
    const auth = page.getByTestId('management-auth-settings');
    await auth.getByLabel(t('local-accounts', 'settings.currentPassword'), { exact: true }).fill('fixture-old-password');
    await auth.getByLabel(t('local-accounts', 'settings.newPassword'), { exact: true }).fill('fixture-new-password');
    await auth.getByLabel(t('local-accounts', 'settings.confirmation'), { exact: true }).fill('fixture-new-password');
    await auth.getByRole('button', { name: t('local-accounts', 'settings.submit'), exact: true }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/login');
    await expect(page.getByText(t('local-accounts', 'login.description'), { exact: true })).toBeVisible();
    expect(writes.at(-1)).toEqual({ path: '/api/plugins/local-accounts/control/password', body: {
      currentPassword: 'fixture-old-password', password: 'fixture-new-password', passwordConfirmation: 'fixture-new-password' } });
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ languages: 2, widths: 4, pages: 2, legacyRedirects: true,
    sessionSave: true, budgetSave: true, passwordFlow: true, errors, evidence }));
} finally { await browser.close(); }
