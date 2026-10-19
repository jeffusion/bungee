import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('account budget menu', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
try {
// Render the real UI with simulated API responses; never change a live account or budget.
const base = uiRuntime.origin;
const evidence = '/tmp/bungee-account-budget-menu';
const manifests = await Promise.all(['user-auth', 'token-budget', 'key-access'].map(name =>
  Bun.file(new URL(`../../../../plugins/${name}/manifest.json`, import.meta.url)).json()));
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
    const administrator = {id:'admin-test',username:'admin',displayName:'admin',disabled:false,hasLocalPassword:true,requiresPasswordChange:false};
    const writes: Array<{ path: string; body: unknown }> = [];
    const t = (name: string, message: string) => manifests.find(item => item.name === name).translations[language][message];
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ json: value });
      if (url.pathname === '/api/auth/mode') return json({ mode: 'plugin', initialized: true, publicOrigin: url.origin,
        provider: { name: 'user-auth', loginComponent: 'UserAuthLogin' } });
      if (url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: authenticated,
        ...(authenticated ? { subject: { id: 'admin-test', provider: 'user-auth' }, csrfToken: 'test-csrf' } : {}) });
      if (url.pathname === '/api/auth/login/options') return json({local:{enabled:true,turnstile:{enabled:false}},methods:[]});
      if (url.pathname === '/api/plugins') return json(manifests.map(manifest => ({ name: manifest.name,
        enabled: manifest.name !== 'token-budget' || budgetEnabled, version: manifest.version,
        metadata: { ...manifest.metadata, contributes: manifest.contributes } })));
      if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(['zh-CN', 'en'].map(code =>
        [code, { plugins: Object.fromEntries(manifests.map(item => [item.name, item.translations[code]])) }])));
      if (url.pathname === '/api/config/runtime') return json(runtime);
      if (url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
      if (url.pathname === '/api/plugins/user-auth/control/identities') return json({identities:[]});
      if (url.pathname === '/api/plugins/user-auth/control/self') return json({administrator});
      if (url.pathname === '/api/plugins/user-auth/control/users') return json({users:[administrator]});
      if (url.pathname === '/api/plugins/user-auth/control/login-connections') return json({publicOrigin:url.origin,connections:[]});
      if (url.pathname === '/api/plugins/user-auth/control/login-settings') return json({version:1,autoCreateUsers:false});
      if (url.pathname === '/api/plugins/user-auth/control/turnstile') return json({version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false});
      if (url.pathname === '/api/plugins/user-auth/control/session-policy') {
        if (request.method() === 'PUT') {
          const body = request.postDataJSON(); writes.push({ path: url.pathname, body });
          session = { version: session.version + 1, policy: body.policy };
        }
        return json(session);
      }
      if (url.pathname === '/api/plugins/user-auth/control/password') {
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
    for (const [name, testId, path, label] of [['user-auth', 'auth-users', '/users', 'users.title'], ['user-auth', 'auth-user-profile', '/profile', 'profile.title'], ['token-budget', 'policy-settings-budget', '/settings', 'metadata.name']]) {
      const canonical = `/extensions/${name}${path}`;
      await page.goto(`${base}/#/plugins`);
      const card = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({ hasText: t(name, 'metadata.name') });
      await expect(card).toBeVisible();
      await expect(card.getByRole('link',{name:language==='zh-CN'?'页面':'Page',exact:true})).toHaveCount(0);
      if (name === 'user-auth') {
        const settingsLink = card.getByRole('link', {name:language==='zh-CN'?'设置':'Settings',exact:true});
        await expect(settingsLink).toHaveAttribute('href','/#/plugins/user-auth/settings');
        for (const width of [390,1440]) {
          await page.setViewportSize({width,height:1000});
          await expect(settingsLink.locator('svg')).toBeVisible();
          await expect(settingsLink.locator('svg')).toHaveAttribute('aria-hidden','true');
          await settingsLink.screenshot({path:`${evidence}/plugin-settings-${language}-${width}.png`});
        }
      }
      else {
        await expect(card.locator(`a[href^="/#/plugins/${name}"]`)).toHaveCount(0);
        await expect(card.locator('a[href^="/#/extensions/"]')).toHaveCount(0);
      }
      const menu = page.getByTestId('header-top-menu').getByRole('link', { name: t(name, label), exact: true });
      await menu.click();
      const settings = page.getByTestId(testId);
      await expect(settings).toContainText(name === 'user-auth' ? 'admin' : key.name);
      await page.reload(); await expect(settings).toContainText(name === 'user-auth' ? 'admin' : key.name);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        {
          const link = page.getByTestId('header-top-menu').getByRole('link', { name: t(name, label), exact: true });
          await expect(link).toHaveAttribute('aria-current', 'page');
          if (language === 'zh-CN' && width === 390 && name === 'token-budget') await page.screenshot({
            path: `${evidence}/menu-390.png`, fullPage: true, animations: 'disabled' });
          await link.click();
        }
        expect(await page.locator('main').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
        if (language === 'zh-CN' && [390, 1440].includes(width)) await page.screenshot({
          path: `${evidence}/${name}-${path.slice(1)}-${width}.png`, fullPage: true, animations: 'disabled' });
      }
      if (name === 'token-budget') for (const oldPath of [`/plugins/${name}/settings?from=bookmark`, `/plugins/${name}?from=bookmark`]) {
        await page.goto(`${base}/#${oldPath}`);
        await expect.poll(() => new URL(page.url()).hash).toBe(`#${canonical}?from=bookmark`);
        await expect(settings).toBeVisible();
      }
      if (name === 'token-budget') {
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
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${base}/#/plugins`);
    const authCard = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({hasText:t('user-auth','metadata.name')});
    await authCard.locator('a[href="/#/plugins/user-auth/settings"]').click();
    const loginSettings = page.getByTestId('auth-login-management');
    await expect(loginSettings).toBeVisible();
    await expect(page.getByTestId('auth-users')).toHaveCount(0);
    await expect(page.getByTestId('auth-user-profile')).toHaveCount(0);
    await page.reload(); await expect(loginSettings).toBeVisible();
    await page.getByRole('region', {name:t('user-auth','session.title'),exact:true}).getByRole('button', {name:t('user-auth','admin.edit'),exact:true}).click();
    const sessionDialog = page.getByRole('dialog', {name:t('user-auth','session.title'),exact:true});
    await sessionDialog.locator('#session-idleTimeoutMinutes').fill('45');
    await sessionDialog.getByRole('button', {name:t('user-auth','session.save'),exact:true}).click();
    await expect(sessionDialog).toHaveCount(0);
    await expect(page.getByRole('region', {name:t('user-auth','session.title'),exact:true}).getByRole('status')).toHaveText(t('user-auth','session.saved'));
    expect(writes.at(-1)).toEqual({path:'/api/plugins/user-auth/control/session-policy',body:{version:1,policy:{idleTimeoutMinutes:45,absoluteTimeoutMinutes:480}}});
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      expect(await page.locator('main').evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
      if(language==='zh-CN' && [390,1440].includes(width)) await page.screenshot({path:`${evidence}/login-settings-${width}.png`,fullPage:true,animations:'disabled'});
    }
    budgetEnabled = false; await page.goto(`${base}/#/plugins`); await page.reload();
    await expect(page.getByTestId('app-header').getByRole('link', { name: t('token-budget', 'metadata.name'), exact: true })).toHaveCount(0);
    await page.goto(`${base}/#/extensions/user-auth/profile`);
    const auth = page.getByTestId('auth-user-profile');
    await auth.getByRole('button',{name:t('user-auth','profile.changePassword'),exact:true}).click();
    const passwordDialog = page.getByRole('dialog');
    await passwordDialog.getByLabel(t('user-auth', 'settings.currentPassword'), { exact: true }).fill('fixture-old-password');
    await passwordDialog.getByLabel(t('user-auth', 'settings.newPassword'), { exact: true }).fill('fixture-new-password');
    await passwordDialog.getByLabel(t('user-auth', 'settings.confirmation'), { exact: true }).fill('fixture-new-password');
    await passwordDialog.getByRole('button', { name: t('user-auth', 'settings.submit'), exact: true }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/login');
    await expect(page.getByRole('form', {name:t('user-auth', 'login.title'),exact:true})).toBeVisible();
    expect(writes.at(-1)).toEqual({ path: '/api/plugins/user-auth/control/password', body: {
      currentPassword: 'fixture-old-password', password: 'fixture-new-password', passwordConfirmation: 'fixture-new-password' } });
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ languages: 2, widths: 4, pages: 4, budgetBookmarkRedirects: true,
    sessionSave: true, budgetSave: true, passwordFlow: true, errors, evidence }));
} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
