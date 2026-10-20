import { test } from 'bun:test';
import { expect } from 'playwright/test';
import manifest from '../../../../plugins/user-auth/manifest.json';
import { createAuthRuntime } from '../helpers/auth/runtime';

const {authRuntime} = createAuthRuntime('component-fixture', ['index.html']);

test('current setup page resolves uncertain initialization and keeps late reads bound to its provider and lifetime', async () => {
  const {runtime, browser} = await authRuntime();

  for (const scenario of ['ack-lost', 'verification-lost', 'already-initialized', 'initial-read-lost', 'provider-change', 'unmounted'] as const) {
      const language = 'zh-CN';
      const context = await browser.newContext({ viewport: { width: 390, height: 1000 }, locale: language });
      try {
        await context.addInitScript(language => localStorage.setItem('locale', language), language);
        if (scenario === 'provider-change' || scenario === 'unmounted') await context.addInitScript(() => {
          const original = window.fetch;
          window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>) => {
            const response = await original(...args);
            if (new URL(response.url).pathname !== '/api/auth/setup' || (args[1]?.method ?? 'GET') !== 'GET') return response;
            const data = await response.json();
            if (data.initialized !== true) { response.json = async () => data; return response; }
            const pending = new Promise(resolve => { (window as any).releaseSetupVerification = () => resolve(data); });
            (window as any).setupVerificationReceived = true;
            response.json = async () => {
              const result = await pending;
              queueMicrotask(() => queueMicrotask(() => { (window as any).setupVerificationDelivered = true; }));
              return result;
            };
            return response;
          }, original);
        });
        const page = await context.newPage();
        const errors: string[] = [], requests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        let expectedConflict = scenario === 'already-initialized' ? 1 : 0;
        page.on('console', message => {
          if (message.type() !== 'error') return;
          if (expectedConflict > 0 && message.location().url === runtime.origin + '/api/auth/setup' && message.text().includes('409')) { expectedConflict--; return; }
          errors.push(`${message.location().url}: ${message.text()}`);
        });
        page.on('requestfailed', request => { errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`); });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
        let initialized = false, lost = false;

        const provider = { name: manifest.name, ...manifest.management };
        await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
          const request = route.request(), url = new URL(request.url());
          requests.push(`${request.method()} ${url.pathname}`);
          expect(request.headers()['authorization']).toBeUndefined();
          expect(request.headers()['x-csrf-token']).toBeUndefined();
          if (request.method() === 'GET' && url.pathname === '/api/auth/mode') return route.fulfill({ json: { mode: 'plugin', initialized, publicOrigin: url.origin, provider } });
          if (request.method() === 'GET' && url.pathname === '/api/auth/login/options') return route.fulfill({json: {local: {enabled: true, turnstile: {enabled: false}}, methods: []}});
          if (url.pathname !== '/api/auth/setup' || !['GET','POST'].includes(request.method())) { errors.push(`Unexpected API ${request.method()} ${url.pathname}`); return route.fulfill({status:501,json:{error:'unexpected_fixture_request'}}); }
          if (request.method() === 'POST') {
            expect(request.postDataJSON()).toEqual({username:'admin',password:'fixture setup password',passwordConfirmation:'fixture setup password'});
            initialized = true;
            if (scenario === 'ack-lost') return route.fulfill({ body: '{', contentType: 'application/json' });
            if (scenario === 'already-initialized') return route.fulfill({ status: 409, json: { error: 'already_initialized' } });
            return route.fulfill({ json: { success: true } });
          }
          if (!lost && ((scenario === 'initial-read-lost' && !initialized) || (scenario === 'verification-lost' && initialized))) {
            lost = true;
            return route.fulfill({ body: '{', contentType: 'application/json' });
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
          await form.getByLabel('账号', { exact: true }).fill('admin');
          await form.getByLabel('密码（5–32 个字符）', { exact: true }).fill('fixture setup password');
          await form.getByLabel('确认密码', { exact: true }).fill('fixture setup password');
        };
        await fill();
        await form.getByRole('button', { name: '初始化账号', exact: true }).click();
        if (scenario === 'provider-change' || scenario === 'unmounted') {
          await page.waitForFunction(() => (window as any).setupVerificationReceived === true);
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
          await page.evaluate(() => (window as any).releaseSetupVerification());
          await page.waitForFunction(() => (window as any).setupVerificationDelivered === true);
          expect(requests.filter(request => request === 'GET /api/auth/mode')).toHaveLength(1);
          await expect(page).toHaveURL(/#\/setup$/);
          await expect(form).toHaveCount(0);
        } else {
          if (scenario === 'verification-lost') {
            await expect(form.getByRole('alert')).toBeVisible();
            await fill();
            await form.getByRole('button', { name: '初始化账号', exact: true }).click();
          }
          const login = page.getByTestId('page-login');
          await expect(login).toBeVisible();
          await expect(page).toHaveURL(/#\/login$/);
          expect(requests.filter(request => request === 'POST /api/auth/setup')).toHaveLength(1);
          expect(requests).not.toContain('POST /api/auth/login');
          expect(requests).not.toContain('GET /api/auth/verify');
        }

        expect(expectedConflict).toBe(0);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
  }
}, 240_000);
