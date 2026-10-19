import { test } from 'bun:test';
import { chromium, expect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import manifest from '../../../../plugins/user-auth/manifest.json';
import { configurationRuntimeFixture, publicationFixture } from '../helpers/publication';
import { startUiRuntime } from '../../../../tests/helpers/ui-runtime';

test('management setup gates protected requests, confirms initialization, and joins the ordinary login shell', async () => {
  const runtime = await startUiRuntime({ mode: 'built-page' });
  const browser = await chromium.launch({ headless: true });
  const evidence = '/tmp/bungee-management-setup';
  await mkdir(evidence, { recursive: true });
  try {
    for (const scenario of ['setup', 'unavailable', 'foreign-component'] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: 'zh-CN' });
      try {
        await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        const page = await context.newPage();
        const errors: string[] = [], requests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
        // The UI font stylesheets are not part of this authentication flow.
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        let initialized = false, authenticated = false;
        const initialPassword = ' 😀 甲 ', changedPassword = '😀'.repeat(32);
        const provider = { name: manifest.name, ...manifest.management,
          ...(scenario === 'foreign-component' ? { setupComponent: 'TokenStatsChart' } : {}) };
        const config = configurationRuntimeFixture(publicationFixture({ operation: null, recovery: null,
          retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1 }));
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          const json = (value: unknown) => route.fulfill({ json: value });
          if (url.pathname === '/api/auth/mode') return json({ mode: 'plugin', initialized, publicOrigin: url.origin, provider });
          if (url.pathname === '/api/auth/setup') {
            if (scenario === 'unavailable') return json({});
            if (request.method() === 'POST') {
              expect(request.headers()['x-bungee-auth-provider']).toBe(manifest.name);
              expect(request.postDataJSON()).toEqual({ setupCode: 'fixture-code', username: 'admin',
                password: initialPassword, passwordConfirmation: initialPassword });
              initialized = true; return json({ success: true });
            }
            return json({ initialized, provider });
          }
          if (url.pathname === '/api/auth/login/options') return json({local: {enabled: true, turnstile: {enabled: false}}, methods: []});
          if (url.pathname === '/api/auth/login') { authenticated = true; return json({ success: true }); }
          if (url.pathname === '/api/auth/verify') return json({ mode: 'plugin', success: authenticated,
            ...(authenticated ? { subject: { id: 'fixture-admin', provider: manifest.name }, csrfToken: 'fixture-csrf' } : {}) });
          if (url.pathname === '/api/plugin-translations') return json(Object.fromEntries(Object.entries(manifest.translations)
            .map(([language, messages]) => [language, { plugins: { [manifest.name]: messages } }])));
          if (url.pathname === '/api/plugins') return json([{ name: manifest.name, enabled: true, version: manifest.version,
            management: manifest.management, metadata: { ...manifest.metadata, contributes: manifest.contributes } }]);
          if (url.pathname === '/api/plugins/user-auth/control/identities') return json({identities: []});
          if (url.pathname === '/api/plugins/user-auth/control/users') return json({users: []});
          if (url.pathname === '/api/plugins/user-auth/control/login-connections') return json({publicOrigin: url.origin, connections: []});
          if (url.pathname === '/api/plugins/user-auth/control/login-settings') return json({version: 1, autoCreateUsers: false});
          if (url.pathname === '/api/plugins/user-auth/control/turnstile') return json({version: 1, enabled: false, siteKey: '', hostnames: [], hasSecret: false});
          if (url.pathname === '/api/plugins/user-auth/control/self') return json({administrator: {id: 'fixture-admin', username: 'admin', displayName: 'admin', disabled: false, hasLocalPassword: true, requiresPasswordChange: false}});
          if (url.pathname === '/api/plugins/user-auth/control/session-policy') return json({version: 1, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}});
          if (url.pathname === '/api/plugins/user-auth/control/password') {
            expect(request.postDataJSON()).toEqual({currentPassword: initialPassword, password: changedPassword, passwordConfirmation: changedPassword});
            authenticated = false; return json({ok: true});
          }
          if (url.pathname === '/api/config/runtime') return json(config);
          if (url.pathname === '/api/config') return json({ revision: 1, content_hash: config.content_hash, config: config.config });
          if (url.pathname === '/api/runtime/upstreams') return json({ schema: 'bungee-runtime-upstreams-v1', generated_at: Date.now(),
            availability: 'complete', reason: null, admission: { revision: 1 }, workers: { observed: [], missing: [] }, upstreams: [] });
          if (url.pathname === '/api/stats/dashboard') return json({ startTime: Date.now() - 3600000, endTime: Date.now(), range: '1h',
            history: { timestamps: [], requests: [], errors: [], responseTime: [], successRate: [], failureRate: [],
              requestCounts: { success: [], failed: [] } }, upstreams: [], requestCounts: { success: 0, failed: 0 } });
          if (url.pathname === '/api/resources/api-key') return json({ keys: [] });
          return json({});
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

        await page.getByTestId('app-header').getByRole('link', {name: '用户信息', exact: true}).click();
        const settings = page.getByTestId('auth-user-profile');
        await settings.getByRole('button',{name:'修改密码',exact:true}).click();
        const passwordDialog = page.getByRole('dialog');
        const submitPassword = passwordDialog.getByRole('button', {name: '修改并重新登录', exact: true});
        await expect(submitPassword).toBeEnabled();
        await page.setViewportSize({width: 390, height: 1000});
        await passwordDialog.getByLabel('当前密码', {exact: true}).fill(initialPassword);
        for (const invalid of ['x'.repeat(4), '😀'.repeat(4), 'x'.repeat(33), '😀'.repeat(33)]) {
          await passwordDialog.getByLabel('新密码（5–32 个字符）', {exact: true}).fill(invalid);
          await passwordDialog.getByLabel('确认新密码', {exact: true}).fill(invalid);
          await submitPassword.click();
          await expect(passwordDialog.getByRole('alert')).toContainText('密码须为 5–32 个字符');
          expect(requests).not.toContain('POST /api/plugins/user-auth/control/password');
        }
        await passwordDialog.getByLabel('新密码（5–32 个字符）', {exact: true}).fill(changedPassword);
        await passwordDialog.getByLabel('确认新密码', {exact: true}).fill(changedPassword);
        await page.screenshot({path: `${evidence}/password-390.png`, fullPage: true});
        await submitPassword.click();
        await expect(login).toBeVisible();
        await expect(page).toHaveURL(/#\/login$/);
        expect(requests.filter(request => request === 'POST /api/plugins/user-auth/control/password')).toHaveLength(1);

        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await runtime.close(); }
}, 90_000);

test('current setup page resolves uncertain initialization and keeps late reads bound to its provider and lifetime', async () => {
  const runtime = await startUiRuntime({ mode: 'component-fixture', entries: ['index.html'] });
  const browser = await chromium.launch({ headless: true });
  const evidence = '/tmp/bungee-management-setup';
  await mkdir(evidence, { recursive: true });
  try {
    for (const scenario of ['ack-lost', 'verification-lost', 'already-initialized', 'initial-read-lost', 'provider-change', 'unmounted', 'english'] as const) {
      const language = scenario === 'english' ? 'en' : 'zh-CN';
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: language });
      try {
        await context.addInitScript(language => localStorage.setItem('locale', language), language);
        const page = await context.newPage();
        const errors: string[] = [], requests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        let initialized = false, lost = false;
        let release!: () => void, reading!: () => void, readFinished!: () => void;
        const waitingRead = new Promise<void>(resolve => { reading = resolve; });
        const finishedRead = new Promise<void>(resolve => { readFinished = resolve; });
        const provider = { name: manifest.name, ...manifest.management };
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          expect(request.headers()['authorization']).toBeUndefined();
          expect(request.headers()['x-csrf-token']).toBeUndefined();
          if (url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'plugin', initialized, publicOrigin: url.origin, provider } });
          if (url.pathname === '/api/auth/login/options') return route.fulfill({json: {local: {enabled: true, turnstile: {enabled: false}}, methods: []}});
          if (url.pathname !== '/api/auth/setup') throw new Error(`Unexpected protected request: ${url.pathname}`);
          if (request.method() === 'POST') {
            initialized = true;
            if (scenario === 'ack-lost') return route.fulfill({ body: '{', contentType: 'application/json' });
            if (scenario === 'already-initialized') return route.fulfill({ status: 409, json: { error: 'already_initialized' } });
            return route.fulfill({ json: { success: true } });
          }
          if (!lost && ((scenario === 'initial-read-lost' && !initialized) || (scenario === 'verification-lost' && initialized))) {
            lost = true;
            return route.fulfill({ body: '{', contentType: 'application/json' });
          }
          if (initialized && (scenario === 'provider-change' || scenario === 'unmounted')) {
            reading();
            await new Promise<void>(resolve => { release = resolve; });
            await route.fulfill({ json: { initialized, provider } });
            readFinished(); return;
          }
          return route.fulfill({ json: { initialized, provider } });
        });
        await page.goto(`${runtime.origin}/#/setup`);
        const setup = page.getByTestId('page-setup');
        const form = setup.getByRole('form');
        if (scenario === 'initial-read-lost') {
          await expect(setup.getByRole('alert')).toBeVisible();
          await expect(form).toHaveCount(0);
          await setup.getByRole('button', { name: '刷新', exact: true }).click();
          await expect(form).toBeVisible();
          expect(requests).toEqual(['GET /api/auth/mode', 'GET /api/auth/setup', 'GET /api/auth/setup']);
        }
        await expect(form).toBeVisible();
        const fill = async () => {
          await form.getByLabel(language === 'en' ? 'One-time setup code' : '一次性初始化码', { exact: true }).fill('fixture-code');
          await form.getByLabel(language === 'en' ? 'Username' : '账号', { exact: true }).fill('admin');
          await form.getByLabel(language === 'en' ? 'Password (5–32 characters)' : '密码（5–32 个字符）', { exact: true }).fill('fixture setup password');
          await form.getByLabel(language === 'en' ? 'Confirm password' : '确认密码', { exact: true }).fill('fixture setup password');
        };
        await fill();
        await form.getByRole('button', { name: language === 'en' ? 'Initialize account' : '初始化账号', exact: true }).click();
        if (scenario === 'provider-change' || scenario === 'unmounted') {
          await waitingRead;
          await page.evaluate(async scenario => {
            const path = '/src/stores/auth.ts';
            const { authMode } = await import(/* @vite-ignore */ path);
            authMode.update((mode: any) => scenario === 'unmounted'
              ? { ...mode, initialized: true } : { ...mode, provider: { ...mode.provider, name: 'other-provider' } });
          }, scenario);
          if (scenario === 'unmounted') await expect(page.getByTestId('page-login')).toBeVisible();
          else {
            await expect(setup.getByRole('alert')).toBeVisible();
            await expect(setup.locator('code')).toHaveCount(0);
            await expect(setup).not.toContainText('user-auth');
          }
          release(); await finishedRead;
          await page.waitForLoadState('networkidle');
          expect(requests.filter(request => request === 'GET /api/auth/mode')).toHaveLength(1);
          await expect(page).toHaveURL(/#\/setup$/);
          await expect(form).toHaveCount(0);
        } else {
          if (scenario === 'verification-lost') {
            await expect(form.getByRole('alert')).toContainText('未能确认初始化结果');
            await fill();
            await form.getByRole('button', { name: language === 'en' ? 'Initialize account' : '初始化账号', exact: true }).click();
          }
          const login = page.getByTestId('page-login');
          await expect(login).toBeVisible();
          await expect(page).toHaveURL(/#\/login$/);
          expect(requests.filter(request => request === 'POST /api/auth/setup')).toHaveLength(1);
          expect(requests).not.toContain('POST /api/auth/login');
          expect(requests).not.toContain('GET /api/auth/verify');
          await login.getByText(language === 'en' ? 'Forgot your username or password?' : '忘记账号或密码？', { exact: true }).click();
          await expect(login.locator('code')).toHaveText([
            'bungee recover --plugin user-auth --action reset',
            'bun packages/core/dist/main.js --recover /usr/app/data/bungee.db --plugin user-auth --action reset',
          ]);
          await expect(login).toContainText(language === 'en' ? 'original instance’s database path' : '数据库路径须指向原实例');
          await expect(login).toContainText('entrypoint');
        }
        await page.screenshot({ path: `${evidence}/${scenario}-390.png`, fullPage: true });
        const unexpectedErrors = errors.filter(message => !(scenario === 'already-initialized' && message.includes('409 (Conflict)')));
        expect(unexpectedErrors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { try { await browser.close(); } finally { await runtime.close(); } }
}, 240_000);
