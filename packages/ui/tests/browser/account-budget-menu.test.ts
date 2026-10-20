import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import {menuSnapshot, fulfillMenuIcons} from '../helpers/menus';
import { test as browserTest } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

browserTest('account budget menu', async () => {
const uiRuntime = await startUiRuntime({ mode: 'built-page' });
try {
// Render the real UI with simulated API responses; never change a live account or budget.
const base = uiRuntime.origin;
const manifests = await Promise.all(['user-auth', 'token-budget', 'key-access'].map(name =>
  Bun.file(new URL(`../../../../plugins/${name}/manifest.json`, import.meta.url)).json()));
const runtime = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
  retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));

const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  {
    const language = 'zh-CN';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: language });
    await context.addInitScript(value => localStorage.setItem('locale', value), language);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.location().url}: ${message.text()}`); });
    let activeBookmark: string | undefined;
    const cancelledBookmarkFrames: string[] = [];
    page.on('requestfailed', request => {
      // The root bookmark redirects through /extensions/token-budget before selecting its page.
      // Its transient sandbox document is cancelled by that observed navigation only.
      if (activeBookmark === '/plugins/token-budget?from=bookmark'
        && request.method() === 'GET' && request.isNavigationRequest()
        && request.frame().parentFrame() === page.mainFrame()
        && request.url() === `${base}/plugins/token-budget/index.html`
        && request.failure()?.errorText === 'net::ERR_ABORTED'
        && cancelledBookmarkFrames.length === 0) { cancelledBookmarkFrames.push(activeBookmark); return; }
      errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
    });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType:'text/css',body:''}));
    const authenticated = true; let budgetEnabled = true;
    const session = { version: 1, policy: { idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480 } };
    let policy = { mode: 'daily', unit: 'tokens', limit: 1000 };
    const key = { id: 'key-test', name: 'demo-app', prefix: 'bk_example', createdAt: Date.now(), expiresAt: null, revokedAt: null };
    const administrator = {id:'admin-test',username:'admin',displayName:'admin',disabled:false,hasLocalPassword:true,requiresPasswordChange:false};
    const writes: Array<{ path: string; body: unknown }> = [];
    const t = (name: string, message: string) => manifests.find(item => item.name === name).translations[language][message];
    await page.route('**/plugins/token-budget/index.html', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Plugin navigation</title>'}));
    await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ json: value });
      if (request.method() === 'GET' && url.pathname === '/api/auth/mode') return json({ mode: 'plugin', initialized: true, publicOrigin: url.origin,
        provider: { name: 'user-auth', loginComponent: 'UserAuthLogin' } });
      if (request.method() === 'GET' && url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: authenticated,
        ...(authenticated ? { subject: { id: 'admin-test', provider: 'user-auth' }, csrfToken: 'test-csrf' } : {}) });
      if (request.method() === 'GET' && url.pathname === '/api/auth/login/options') return json({local:{enabled:true,turnstile:{enabled:false}},methods:[]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins') return json(manifests.map(manifest => ({ name: manifest.name,
        enabled: manifest.name !== 'token-budget' || budgetEnabled, version: manifest.version,
        metadata: { ...manifest.metadata, contributes: manifest.contributes } })));
      if (request.method() === 'GET' && url.pathname === '/api/plugin-translations') return json(Object.fromEntries(['zh-CN', 'en'].map(code =>
        [code, { plugins: Object.fromEntries(manifests.map(item => [item.name, item.translations[code]])) }])));
      if (request.method() === 'GET' && url.pathname === '/api/ui/menus') {
        const snapshot = menuSnapshot();
        const catalog = [...snapshot.catalog, ...manifests.filter(item => item.name !== 'token-budget' || budgetEnabled).flatMap(item => (item.contributes.navigation ?? []).map((nav: any) => ({
          id:`plugin:${item.name}:${encodeURIComponent(nav.path)}`,label:nav.label,href:`/#/extensions/${item.name}${nav.path}`,
          source:'plugin' as const,pluginName:item.name,defaultIcon:'lucide:user',available:true,
        })))];
        return json({...snapshot,catalog,layout:createDefaultMenuLayout(catalog)});
      }
      if (request.method() === 'GET' && url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
      if (request.method() === 'GET' && url.pathname === '/api/runtime/upstreams') return json({schema:'bungee-runtime-upstreams-v1',generated_at:Date.now(),availability:'complete',reason:null,admission:{revision:1},workers:{observed:[],missing:[]},upstreams:[]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/token-budget/sandbox') return json({sandbox:'allow-scripts',allowedHostActions:[],controlAllowlist:[]});
      if (request.method() === 'GET' && url.pathname === '/api/config/runtime') return json(runtime);
      if (request.method() === 'GET' && url.pathname === '/api/config') return json({ revision: 1, content_hash: runtime.content_hash, config: runtime.config });
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/identities') return json({identities:[]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/self') return json({administrator});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/users') return json({users:[administrator]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/login-connections') return json({publicOrigin:url.origin,connections:[]});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/login-settings') return json({version:1,autoCreateUsers:false});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/turnstile') return json({version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false});
      if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/session-policy') return json(session);
      if (request.method() === 'GET' && url.pathname === '/api/resources/api-key') return json({ keys: [key] });
      if (request.method() === 'GET' && url.pathname === '/api/resources/api-key/key-test/extensions') return json({ extensions: [{
        plugin: 'token-budget', component: 'TokenBudgetKeyPolicy', path: '/keys/:keyId', active: true, ready: true,
        value: policy, usage: { cumulative: 0, monthly: {}, weekly: {}, daily: {}, unresolved: {} } }] });
      if (['PUT'].includes(request.method()) && url.pathname === '/api/plugins/token-budget/control/keys/key-test') {
        const body = request.postDataJSON(); writes.push({ path: url.pathname, body }); policy = body;
        return json({ value: policy });
      }
      errors.push(`Unexpected API ${request.method()} ${url.pathname}`);
      return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}});
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
      {

        {
          const link = page.getByTestId('header-top-menu').getByRole('link', { name: t(name, label), exact: true });
          await expect(link).toHaveAttribute('aria-current', 'page');
          await link.click();
        }

      }
      if (name === 'token-budget') for (const oldPath of [`/plugins/${name}/settings?from=bookmark`, `/plugins/${name}?from=bookmark`]) {
        activeBookmark = oldPath;
        await page.goto(`${base}/#${oldPath}`);
        await expect.poll(() => new URL(page.url()).hash).toBe(`#${canonical}?from=bookmark`);
        await expect(settings).toBeVisible();
        activeBookmark = undefined;
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
        await page.goto(`${base}/#/plugins/token-budget/settings?keyId=key-test`);
        await expect.poll(() => new URL(page.url()).hash).toBe('#/extensions/token-budget/settings?keyId=key-test');
        await expect(page.getByRole('dialog')).toContainText(key.name);
        await page.getByRole('dialog').getByRole('contentinfo').getByRole('button', { name: t(name, 'ui.close'), exact: true }).click();
      }
    }
    expect(cancelledBookmarkFrames).toEqual(['/plugins/token-budget?from=bookmark']);

    await page.goto(`${base}/#/plugins`);
    const authCard = page.getByTestId('page-plugins').locator('.plugin-management-card').filter({hasText:t('user-auth','metadata.name')});
    await authCard.locator('a[href="/#/plugins/user-auth/settings"]').click();
    const loginSettings = page.getByTestId('auth-login-management');
    const waitForLoginSettings = async () => {
      await expect(loginSettings.getByTestId('session-policy-summary')).toBeVisible();
      await expect(loginSettings.getByTestId('turnstile-saved-status')).toBeVisible();
      await expect(loginSettings.getByRole('switch', { name: t('user-auth', 'connections.autoCreate'), exact: true })).toBeEnabled();
    };
    await waitForLoginSettings();
    await expect(page.getByTestId('auth-users')).toHaveCount(0);
    await expect(page.getByTestId('auth-user-profile')).toHaveCount(0);
    await page.reload(); await waitForLoginSettings();
    budgetEnabled = false; await page.reload(); await waitForLoginSettings(); await page.goto(`${base}/#/plugins`);
    await expect(authCard).toBeVisible();
    await expect(page.getByTestId('app-header').getByRole('link', { name: t('user-auth', 'profile.title'), exact: true })).toBeVisible();
    await expect(page.getByTestId('app-header').getByRole('link', { name: t('token-budget', 'metadata.name'), exact: true })).toHaveCount(0);
    await context.close();
  }
  expect(errors).toEqual([]);

} finally { await browser.close(); }
} finally { await uiRuntime.close(); }
}, 240_000);
