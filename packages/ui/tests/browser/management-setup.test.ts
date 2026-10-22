import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import { test } from 'bun:test';
import { expect } from 'playwright/test';
import manifest from '../../../../plugins/user-auth/manifest.json';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { createAuthRuntime } from '../helpers/auth/runtime';
import {menuSnapshot, fulfillMenuIcons} from '../helpers/menus';

const {authRuntime} = createAuthRuntime();
const activationOperationId = '10000000-0000-4000-8000-000000000009';

test('management setup gates protected requests, confirms initialization, and joins the ordinary login shell', async () => {
  const {runtime, browser} = await authRuntime();
  for (const scenario of ['setup', 'unavailable', 'foreign-component', 'activation-uninitialized', 'activation-initialize', 'activation-ready', 'activation-unavailable', 'activation-changed', 'activation-initialized-elsewhere', 'activation-conflict', 'activation-commit-failed', 'activation-recover', 'activation-initialize-recover', 'activation-initialize-draining', 'activation-verify-draining'] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'zh-CN' });
      try {
        await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        const page = await context.newPage();
        const errors: string[] = [], requests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        let expectedEnableFailure = ['activation-conflict', 'activation-commit-failed'].includes(scenario) ? 1 : 0;
        page.on('console', message => {
          if (message.type() !== 'error') return;
          if (expectedEnableFailure && message.location().url === runtime.origin + '/api/plugins/user-auth/enable'
            && message.text().includes(scenario === 'activation-conflict' ? '409' : '500')) { expectedEnableFailure--; return; }
          errors.push(message.text());
        });
        page.on('requestfailed', request => { errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`); });
        // The UI font stylesheets are not part of this authentication flow.
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        let initialized = false, authenticated = false, setupReads = 0, selected = false, loginAttempts = 0;
        let enableAttempts = 0;
        let accountReady = ['activation-ready', 'activation-unavailable', 'activation-recover', 'activation-changed', 'activation-verify-draining'].includes(scenario);
        const activation = scenario.startsWith('activation-');
        const recoverSession = scenario === 'activation-recover' || scenario === 'activation-initialize-recover';
        const backgroundPublication = scenario === 'activation-initialize-draining' || scenario === 'activation-verify-draining';
        let publicationConverged = false;
        const initialPassword = ' 😀 甲 ';
        const provider = { name: manifest.name, ...manifest.management,
          ...(scenario === 'foreign-component' ? { setupComponent: 'TokenStatsChart' } : {}) };
        const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
          retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          const json = (value: unknown) => route.fulfill({ json: value });
          if (request.method() === 'GET' && url.pathname === '/api/auth/mode') return json(activation && !selected
            ? {mode: 'anonymous', initialized: true, publicOrigin: url.origin}
            : { mode: 'plugin', initialized: initialized || selected, publicOrigin: url.origin, provider });
          if (request.method() === 'GET' && url.pathname === '/api/plugins/user-auth/management-setup') {
            setupReads++;
            if (selected && !authenticated) return route.fulfill({status:401,json:{error:'unauthorized'}});
            if (scenario === 'activation-unavailable' && setupReads === 1) return json({});
            if (scenario === 'activation-changed' && setupReads > 1) accountReady = false;
            if (scenario === 'activation-initialized-elsewhere' && setupReads > 1) accountReady = true;
            return json({initialized: accountReady});
          }
          if (request.method() === 'POST' && url.pathname === '/api/plugins/user-auth/enable') {
            enableAttempts++;
            expect(request.postDataJSON()).toEqual({managementSetup: accountReady
              ? {operation:'verify',username:'owner',password:'fixture-password'}
              : {operation:'initialize',username:'owner',password:'fixture-password',passwordConfirmation:'fixture-password'}});
            accountReady = true;
            if (enableAttempts === 1 && ['activation-conflict', 'activation-commit-failed'].includes(scenario)) {
              return route.fulfill({status: scenario === 'activation-conflict' ? 409 : 500,
                json:{error: scenario === 'activation-conflict' ? 'bootstrap_conflict' : 'configuration_commit_failed'}});
            }
            selected = true;
            return route.fulfill({status:202,json:{operation_id:activationOperationId,operation:{mutation_id:activationOperationId,state:backgroundPublication ? 'draining' : 'committed',result_status:null},workers:[]}});
          }
          if (['GET','POST'].includes(request.method()) && url.pathname === '/api/auth/setup') {
            if (scenario === 'unavailable') return json({});
            if (request.method() === 'POST') {
              expect(request.headers()['x-bungee-auth-provider']).toBe(manifest.name);
              expect(request.postDataJSON()).toEqual({ username: 'admin',
                password: initialPassword, passwordConfirmation: initialPassword });
              initialized = true; return json({ success: true });
            }
            return json({ initialized, provider });
          }
          if (request.method() === 'GET' && url.pathname === '/api/auth/login/options') return json({local: {enabled: true, turnstile: {enabled: false}}, methods: []});
          if (request.method() === 'POST' && url.pathname === '/api/auth/login') {
            loginAttempts++;
            expect(request.postDataJSON()).toEqual({username: activation ? 'owner' : 'admin', password: activation ? 'fixture-password' : initialPassword, transport:'cookie'});
            authenticated = !recoverSession || loginAttempts > 1;
            return json({ success: true });
          }
          if (request.method() === 'GET' && url.pathname === '/api/auth/verify') return json({ mode: activation && !selected ? 'anonymous' : 'plugin', success: (activation && !selected) || authenticated,
            ...(authenticated ? { subject: { id: 'fixture-admin', provider: manifest.name }, csrfToken: 'fixture-csrf' } : {}) });
          if (request.method() === 'GET' && url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
            .map(([language, messages]) => [language, { plugins: { [manifest.name]: messages } }])));
          if (request.method() === 'GET' && url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled: !activation || selected, version: manifest.version,
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
          if (request.method() === 'GET' && url.pathname === '/api/config/runtime') {
            if (!backgroundPublication || !selected) return json(config);
            return json(configurationRuntimeFixture(publicationFixture({
              operation:{operation_id:activationOperationId,committed_revision:1,state:publicationConverged ? 'converged' : 'draining',
                result_status:publicationConverged ? 200 : null,error_code:null,updated_at:1},
              recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1,
            })));
          }
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
        if (activation) {
          await expect(page.getByTestId('page-plugins')).toBeVisible();
          await page.getByTestId('page-plugins').getByRole('switch').click();
          const dialog = page.getByRole('dialog');
          const verify = dialog.getByRole('button', {name: '验证并启用', exact: true});
          const create = dialog.getByRole('button', {name: '创建账号并启用', exact: true});
          const username = dialog.getByLabel('管理员账号', {exact: true});
          const password = dialog.getByLabel('管理员密码', {exact: true});
          const confirmation = dialog.getByLabel('确认管理员密码', {exact: true});
          if (scenario === 'activation-unavailable') {
            await expect(dialog.getByRole('alert')).toBeVisible();
            await expect(username).toHaveCount(0);
            await expect(verify).toHaveCount(0);
            await expect(create).toHaveCount(0);
            await dialog.getByRole('button', {name: '重新检查状态', exact: true}).click();
          }
          await expect(username).toBeVisible();
          await username.fill('owner');
          await password.fill('fixture-password');
          if (!accountReady) await confirmation.fill('fixture-password');
          if (scenario === 'activation-uninitialized') {
            // Unicode length and confirmation errors never submit or re-read server state.
            for (const invalid of ['x'.repeat(4), '😀'.repeat(4), 'x'.repeat(33), '😀'.repeat(33)]) {
              await password.fill(invalid); await confirmation.fill(invalid); await create.click();
              await expect(dialog.getByRole('alert')).toBeVisible();
              expect(enableAttempts).toBe(0);
            }
            await password.fill('fixture-password'); await confirmation.fill('different'); await create.click();
            await expect(dialog.getByRole('alert')).toBeVisible();
            expect(setupReads).toBe(1);
            await dialog.getByRole('button', {name:'取消',exact:true}).click();
            await expect(dialog).toHaveCount(0);
            expect(enableAttempts).toBe(0);
          } else if (scenario === 'activation-changed' || scenario === 'activation-initialized-elsewhere') {
            await (scenario === 'activation-changed' ? verify : create).click();
            await expect(dialog.getByRole('alert')).toBeVisible();
            await expect(scenario === 'activation-changed' ? create : verify).toBeEnabled();
            await expect(confirmation).toHaveCount(scenario === 'activation-changed' ? 1 : 0);
            expect(setupReads).toBe(2);
            expect(enableAttempts).toBe(0);
          } else if (scenario === 'activation-ready' || scenario === 'activation-unavailable') {
            await expect(verify).toBeEnabled();
            await expect(confirmation).toHaveCount(0);
            await dialog.getByRole('button', {name:'取消',exact:true}).click();
            expect(enableAttempts).toBe(0);
          } else {
            await (accountReady ? verify : create).click();
            if (scenario === 'activation-conflict' || scenario === 'activation-commit-failed') {
              await expect(dialog.getByRole('alert')).toBeVisible();
              await expect(verify).toBeEnabled();
              await expect(confirmation).toHaveCount(0);
              expect(enableAttempts).toBe(1);
              expect(setupReads).toBe(3);
              // Retain the same credentials, but require an explicit verification submit.
              await verify.click();
            }
            if (recoverSession) {
              await expect(dialog.getByRole('button', {name:'重试',exact:true})).toBeEnabled();
              await expect(dialog.getByRole('alert')).toBeVisible();
              expect(authenticated).toBe(false);
              await dialog.getByRole('button', {name:'重试',exact:true}).click();
            }
            await expect(dialog.getByRole('button', {name:'完成',exact:true})).toBeVisible();
            expect(authenticated).toBe(true);
            expect(loginAttempts).toBe(recoverSession ? 2 : 1);
            expect(enableAttempts).toBe(['activation-conflict', 'activation-commit-failed'].includes(scenario) ? 2 : 1);
            expect(requests.some(value => value.startsWith('GET /api/config/operations/'))).toBe(false);
            expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('bungee:settings-publication')!)))
              .toEqual({version:1,mutationId:activationOperationId,accepted:true});
            if (backgroundPublication) {
              // The request is saved and login is usable while old workers still drain.
              expect(publicationConverged).toBe(false);
              await expect(dialog.locator('form')).toHaveAttribute('aria-busy','false');
              await dialog.getByRole('button', {name:'完成',exact:true}).click();
              const banner = page.getByTestId('configuration-publication-banner');
              await expect(banner).toBeVisible();
              expect(enableAttempts).toBe(1);
              publicationConverged = true;
              await expect(banner).toHaveCount(0);
              expect(enableAttempts).toBe(1);
            }
            if (recoverSession) {
              expect(setupReads).toBe(2);
              expect(requests.some(value => value.startsWith('GET /api/config/operations/'))).toBe(false);
            }
          }
          if (enableAttempts === 0) expect(requests.filter(value => value.startsWith('POST '))).toEqual([]);
          expect(expectedEnableFailure).toBe(0);
          expect(errors).toEqual([]);
          continue;
        }
        const setup = page.getByTestId('page-setup');
        await expect(setup).toBeVisible();
        const protectedRequests = () => requests.filter(request => !/^\w+ \/api\/auth\//.test(request));
        const form = setup.getByRole('form');
        if (scenario !== 'setup') {
          await expect(setup.getByRole('alert')).toBeVisible();
          await expect(form).toHaveCount(0);
          await expect(setup.locator('code')).toHaveCount(0);
          expect(protectedRequests()).toEqual([]);

          expect(errors).toEqual([]); continue;
        }
        await expect(form).toBeVisible();
        expect(protectedRequests()).toEqual([]);
        expect(requests).not.toContain('GET /api/auth/verify');
        await expect(page).toHaveURL(/#\/setup$/);
        await form.getByLabel('账号', { exact: true }).fill('admin');
        for (const invalid of ['x'.repeat(4), '😀'.repeat(4), 'x'.repeat(33), '😀'.repeat(33)]) {
          await form.getByLabel('密码（5–32 个字符）', { exact: true }).fill(invalid);
          await form.getByLabel('确认密码', { exact: true }).fill(invalid);
          await form.getByRole('button', { name: '初始化账号', exact: true }).click();
          await expect(form.getByRole('alert')).toBeVisible();
          expect(requests).not.toContain('POST /api/auth/setup');
        }
        await form.getByLabel('密码（5–32 个字符）', { exact: true }).fill(initialPassword);
        await form.getByLabel('确认密码', { exact: true }).fill(initialPassword);

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

        await page.locator('#header-menu-trigger').click();
        const navigation = page.getByTestId('header-menu');
        await expect(navigation.getByRole('link', { name: '用户信息', exact: true })).toBeVisible();
        await expect(navigation.getByRole('button', {name: '系统管理', exact: true})).toHaveAttribute('aria-expanded', 'true');
        await navigation.getByRole('link', { name: '插件管理', exact: true }).click();
        await expect(navigation).toHaveCount(0);
        await expect(page.getByTestId('page-plugins')).toBeVisible();

        const toggle = page.getByTestId('page-plugins').getByRole('switch');
        await toggle.click();
        const dialog = page.getByRole('dialog');

        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', {name:'停用', exact:true})).toBeDisabled();
        await dialog.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
        expect(requests).not.toContain('POST /api/plugins/user-auth/disable');
        await dialog.getByRole('button', {name:'取消', exact:true}).click();
        await expect(toggle).toBeChecked();

        expect(errors).toEqual([]);
      } finally { await context.close(); }
  }
}, 90_000);
