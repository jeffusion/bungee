import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import { test } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import manifest from '../../../../plugins/user-auth/manifest.json';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { createAuthRuntime } from '../helpers/auth/runtime';
import {menuSnapshot, fulfillMenuIcons} from '../helpers/menus';


const {authRuntime} = createAuthRuntime();

test('management setup gates protected requests, confirms initialization, and joins the ordinary login shell', async () => {
  const {runtime, browser} = await authRuntime();
  const evidence = '/tmp/bungee-management-setup';
  await mkdir(evidence, { recursive: true });
  for (const scenario of ['setup', 'unavailable', 'foreign-component'] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'zh-CN' });
      try {
        await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        const page = await context.newPage();
        const errors: string[] = [], requests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => { errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`); });
        // The UI font stylesheets are not part of this authentication flow.
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        let initialized = false, authenticated = false;
        const initialPassword = ' 😀 甲 ';
        const provider = { name: manifest.name, ...manifest.management,
          ...(scenario === 'foreign-component' ? { setupComponent: 'TokenStatsChart' } : {}) };
        const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
          retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          const json = (value: unknown) => route.fulfill({ json: value });
          if (request.method() === 'GET' && url.pathname === '/api/auth/mode') return json({ mode: 'plugin', initialized, publicOrigin: url.origin, provider });
          if (['GET','POST'].includes(request.method()) && url.pathname === '/api/auth/setup') {
            if (scenario === 'unavailable') return json({});
            if (request.method() === 'POST') {
              expect(request.headers()['x-bungee-auth-provider']).toBe(manifest.name);
              expect(request.postDataJSON()).toEqual({ setupCode: 'fixture-code', username: 'admin',
                password: initialPassword, passwordConfirmation: initialPassword });
              initialized = true; return json({ success: true });
            }
            return json({ initialized, provider });
          }
          if (request.method() === 'GET' && url.pathname === '/api/auth/login/options') return json({local: {enabled: true, turnstile: {enabled: false}}, methods: []});
          if (request.method() === 'POST' && url.pathname === '/api/auth/login') { authenticated = true; return json({ success: true }); }
          if (request.method() === 'GET' && url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: authenticated,
            ...(authenticated ? { subject: { id: 'fixture-admin', provider: manifest.name }, csrfToken: 'fixture-csrf' } : {}) });
          if (request.method() === 'GET' && url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
            .map(([language, messages]) => [language, { plugins: { [manifest.name]: messages } }])));
          if (request.method() === 'GET' && url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled: true, version: manifest.version,
            management: manifest.management, metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/identities') return json({identities: []});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/users') return json({users: []});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/login-connections') return json({publicOrigin: url.origin, connections: []});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/login-settings') return json({version: 1, autoCreateUsers: false});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/turnstile') return json({version: 1, enabled: false, siteKey: '', hostnames: [], hasSecret: false});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/self') return json({administrator: {id: 'fixture-admin', username: 'admin', displayName: 'admin', disabled: false, hasLocalPassword: true, requiresPasswordChange: false}});
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/control/session-policy') return json({version: 1, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}});
          if (request.method() === 'GET' && url.pathname === '/api/ui/menus') {
            const snapshot = menuSnapshot();
            const catalog = [...snapshot.catalog,...manifest.contributes.navigation.map(nav => ({id:`plugin:user-auth:${encodeURIComponent(nav.path)}`,label:nav.label,href:`/#/extensions/user-auth${nav.path}`,source:'plugin' as const,pluginName:manifest.name,defaultIcon:'lucide:user',available:true}))];
            return json({...snapshot,catalog,layout:createDefaultMenuLayout(catalog)});
          }
          if (request.method() === 'GET' && url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
          if (request.method() === 'GET' && url.pathname === '/api/config/runtime') return json(config);
          if (request.method() === 'GET' && url.pathname === '/api/config') return json({ revision: 1, content_hash: config.content_hash, config: config.config });
          if (request.method() === 'GET' && url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
            availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
          if (request.method() === 'GET' && url.pathname === '/api/stats/dashboard') return json({ startTime: Date.now() - 3600000, endTime: Date.now(), range: '1h',
            history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [],
              requestCounts: { success: [], failed: [] } }, upstreams: [], requestCounts: { success: 0, failed: 0 } });
          if (request.method() === 'GET' && url.pathname === '/api/resources/api-key') return json({ keys: [] });
          errors.push(`Unexpected API ${request.method()} ${url.pathname}`);
          return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}});
        });
        await page.goto(`${runtime.origin}/#/plugins`);
        const setup = page.getByTestId('page-setup');
        await expect(setup).toBeVisible();
        const protectedRequests = () => requests.filter(request => !/^\w+ \/api\/auth\//.test(request));
        const form = setup.getByRole('form');
        if (scenario !== 'setup') {
          await expect(setup.getByRole('alert')).toBeVisible();
          await expect(form).toHaveCount(0);
          await expect(setup.locator('code')).toHaveCount(0);
          expect(protectedRequests()).toEqual([]);
          await page.screenshot({ path: `${evidence}/${scenario}.png`, fullPage: true });
          expect(errors).toEqual([]); continue;
        }
        await expect(form).toBeVisible();
        expect(protectedRequests()).toEqual([]);
        expect(requests).not.toContain('GET /api/auth/verify');
        await expect(page).toHaveURL(/#\/setup$/);
        await form.getByLabel('一次性初始化码', { exact: true }).fill('fixture-code');
        await form.getByLabel('账号', { exact: true }).fill('admin');
        for (const invalid of ['x'.repeat(4), '😀'.repeat(4), 'x'.repeat(33), '😀'.repeat(33)]) {
          await form.getByLabel('密码（5–32 个字符）', { exact: true }).fill(invalid);
          await form.getByLabel('确认密码', { exact: true }).fill(invalid);
          await form.getByRole('button', { name: '初始化账号', exact: true }).click();
          await expect(form.getByRole('alert')).toContainText('密码须为 5–32 个字符');
          expect(requests).not.toContain('POST /api/auth/setup');
        }
        await form.getByLabel('密码（5–32 个字符）', { exact: true }).fill(initialPassword);
        await form.getByLabel('确认密码', { exact: true }).fill(initialPassword);
        await page.screenshot({ path: `${evidence}/setup-390.png`, fullPage: true });
        await form.getByRole('button', { name: '初始化账号', exact: true }).click();
        const login = page.getByTestId('page-login');
        await expect(login).toBeVisible();
        await expect(page).toHaveURL(/#\/login$/);
        expect(requests.slice(1, 5)).toEqual(['GET /api/auth/setup', 'POST /api/auth/setup', 'GET /api/auth/setup', 'GET /api/auth/mode']);
        expect(requests).not.toContain('POST /api/auth/login');
        expect(protectedRequests()).toEqual([]);
        await page.reload(); await expect(login).toBeVisible();
        await login.getByLabel('账号', { exact: true }).fill('admin');
        await login.getByLabel('密码', { exact: true }).fill(initialPassword);
        await login.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.getByTestId('page-dashboard')).toBeVisible();
        await expect(page.getByTestId('app-header')).toBeVisible();
        expect(protectedRequests()).toContain('GET /api/plugin-translations');
        expect(protectedRequests()).toContain('GET /api/plugins');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await expect(page.getByTestId('app-header').getByRole('link', { name: '用户信息', exact: true })).toBeVisible();
        await page.getByTestId('header-top-menu').getByRole('button', {name: '系统管理', exact: true}).click();
        await page.getByRole('menuitem', { name: '插件管理', exact: true }).click();
        await expect(page.getByTestId('page-plugins')).toBeVisible();
        await page.screenshot({ path: `${evidence}/plugins-1440.png`, fullPage: true });
        const toggle = page.getByTestId('page-plugins').getByRole('switch');
        await toggle.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('强制认证不能在线解除');
        await expect(dialog).toContainText('本地解除后保留账号');
        await expect(dialog).toContainText('bungee recover --plugin user-auth --action release-auth');
        await expect(dialog.getByRole('button', {name:'停用', exact:true})).toBeDisabled();
        await dialog.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
        expect(requests).not.toContain('POST /api/plugins/user-auth/disable');
        await dialog.getByRole('button', {name:'取消', exact:true}).click();
        await expect(toggle).toBeChecked();

        expect(errors).toEqual([]);
      } finally { await context.close(); }
  }
}, 90_000);
