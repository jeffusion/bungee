import {test} from 'bun:test';
import {chromium, expect, type Page, type Locator} from 'playwright/test';
import {mkdir} from 'node:fs/promises';
import {createDefaultMenuLayout} from '@jeffusion/bungee-types';
import manifest from '../../../../plugins/user-auth/manifest.json';
import {configurationRuntimeFixture, publicationFixture} from '../helpers/publication';
import {fulfillMenuIcons, menuSnapshot} from '../helpers/menus';
import {startUiRuntime} from '../../../../tests/helpers/ui-runtime';

const control = '/api/plugins/user-auth/control';
const administrator = {id: 'admin', username: 'admin', displayName: 'Administrator', disabled: false, hasLocalPassword: true, requiresPasswordChange: false};
const evidence = '/tmp/bungee-user-auth';
async function expectVerticalFields(container: Locator) {
  await expect.poll(() => container.locator('input:not([type=checkbox]):not([type=hidden]):visible, textarea:visible').evaluateAll(elements => {
    const bounds = elements.map(element => element.getBoundingClientRect());
    return bounds.length > 1 && bounds.every((bound, index) => index === 0 ||
      (bound.top >= bounds[index - 1]!.bottom && Math.abs(bound.left - bounds[0]!.left) < 1));
  })).toBe(true);
}
async function mockApplication(page: Page, handle: (path: string, method: string, body: any) => unknown, signedIn = true) {
  const config = configurationRuntimeFixture();
  const menus = menuSnapshot();
  const catalog = [...menus.catalog, ...manifest.contributes.navigation.map(nav => ({
    id: `plugin:user-auth:${encodeURIComponent(nav.path)}`, label: nav.label, href: `/#/extensions/user-auth${nav.path}`,
    source: 'plugin' as const, pluginName: manifest.name, defaultIcon: 'lucide:user', available: true,
  }))];
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({contentType: 'text/css', body: ''}));
  await page.route(/^https?:\/\/[^/]+\/api(?:\/|$)/, async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postData() ? request.postDataJSON() : undefined;
    const supplied = await handle(url.pathname + url.search, request.method(), body);
    if (supplied !== undefined) {
      if (typeof supplied === 'object' && supplied !== null && 'fixtureError' in supplied) return route.fulfill({status: (supplied as {fixtureStatus?: number}).fixtureStatus ?? 409, json: {error: (supplied as any).fixtureError}});
      if (url.pathname === control + '/login-connections' && request.method() === 'GET') return route.fulfill({json: {publicOrigin: 'https://public.example', ...supplied as object}});
      return route.fulfill({json: supplied});
    }
    if (url.pathname === '/api/auth/mode') return route.fulfill({json: {mode: 'plugin', initialized: true, publicOrigin: 'https://public.example', provider: {name: manifest.name, ...manifest.management}}});
    if (url.pathname === '/api/auth/verify') return route.fulfill({json: {mode: 'plugin', success: signedIn, ...(signedIn ? {subject: {id: 'admin', provider: manifest.name}, csrfToken: 'csrf'} : {})}});
    if (url.pathname === '/api/auth/login/options') return route.fulfill({json: {local: {enabled: true, turnstile: {enabled: false}}, methods: []}});
    if (url.pathname === '/api/ui/menus') return route.fulfill({json: {...menus, catalog, layout: createDefaultMenuLayout(catalog)}});
    if (url.pathname === '/api/ui/icons/data') return fulfillMenuIcons(route);
    if (url.pathname === '/api/plugin-translations') return route.fulfill({json: Object.fromEntries(Object.entries(manifest.translations).map(([language, messages]) => [language, {plugins: {[manifest.name]: messages}}]))});
    if (url.pathname === '/api/plugins') return route.fulfill({json: [{name: manifest.name, enabled: true, version: manifest.version, management: manifest.management, metadata: {...manifest.metadata, contributes: manifest.contributes}}]});
    if (url.pathname === control + '/self') return route.fulfill({json: {administrator}});
    if (url.pathname === control + '/session-policy') return route.fulfill({json: {version: 1, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}}});
    if (url.pathname === '/api/config/runtime') return route.fulfill({json: config});
    if (url.pathname === '/api/config') return route.fulfill({json: {revision: 1, content_hash: config.content_hash, config: config.config}});
    return route.fulfill({json: {}});
  });
}

test('user and login settings operate with exact DTOs, global provisioning, write-only secrets and mobile layout', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  await mkdir(evidence, {recursive: true});
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'zh-CN'});
    await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
    const page = await context.newPage(), errors: string[] = [], writes: {path: string; body: any}[] = [], reads: string[] = [];
    page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) errors.push(message.text()); });
    let users = [administrator], connections = [
      {id: 'first', label: 'Company', provider: 'google', configuration: {}, enabled: true, issuer: 'https://identity.example', clientId: 'client', scopes: ['openid', 'profile'], hasSecret: true, version: 1},
      {id: 'second', label: 'Partner', provider: 'google', configuration: {}, enabled: false, issuer: 'https://partner.example', clientId: 'partner', scopes: ['openid'], hasSecret: true, version: 1},
    ];
    let settings = {version: 1, autoCreateUsers: false};
    let turn = {version: 1, enabled: false, siteKey: '', hostnames: [] as string[], hasSecret: false};
    let identities = [{id: 'identity', userId: 'admin', connectionId: 'first', issuer: 'https://identity.example', subject: 'old-sub'}];
    let conflict = false;
    let finishCreate!: () => void;
    const createResponse = new Promise<void>(resolve => { finishCreate = resolve; });
    await mockApplication(page, async (path, method, body) => {
      if (!path.startsWith(control)) return;
      if (method === 'GET') reads.push(path.slice(control.length));
      if (method !== 'GET') writes.push({path: path.slice(control.length), body});
      if (path === control + '/users') {
        if (method === 'POST') { expect(Object.keys(body).sort()).toEqual(['displayName','password','passwordConfirmation','username']); await createResponse; const user = {...administrator, username: body.username, displayName: body.displayName, id: 'created'}; users.push(user); return {user}; }
        return {users};
      }
      if (path === control + '/users/update') { expect(Object.keys(body).sort()).toEqual(['disabled','displayName','id','username']); users = users.map(user => user.id === body.id ? {...user, ...body} : user); return {user: users.find(user => user.id === body.id)}; }
      if (path === control + '/users/password') { expect(body).toEqual({id: 'created', password: ' 新 密码 ', passwordConfirmation: ' 新 密码 '}); return {ok: true}; }
      if (path.startsWith(control + '/identities')) {
        if (method === 'GET') return {identities: identities.filter(identity => new URL('https://example.test' + path).searchParams.get('userId') === identity.userId)};
        if (method === 'POST') identities.push({id:'created-identity', userId:body.userId, connectionId:body.connectionId, issuer:'https://identity.example', subject:body.subject});
        if (method === 'DELETE') identities = identities.filter(identity => identity.id !== body.id);
        return {ok: true};
      }
      if (path === control + '/login-connections') {
        if (method === 'GET') return {connections};
        expect(body.hasSecret).toBeUndefined(); expect(body.autoCreateUsers).toBeUndefined();
        if (method === 'PUT') { expect(body.clientSecret).toBeUndefined(); expect(body.version).toBe(1); }
        else { expect(body.enabled).toBe(false); expect(body.clientSecret).toBe('client-secret'); }
        const connection = {...body, issuer:'https://accounts.google.com', scopes:['openid','profile','email'], hasSecret: true, version: 2}; delete connection.clientSecret;
        connections = [...connections.filter(item => item.id !== connection.id), connection]; return {connection};
      }
      if (path === control + '/login-settings') {
        if (method === 'PUT') { expect(Object.keys(body).sort()).toEqual(['autoCreateUsers', 'version']); settings = {...body, version: settings.version + 1}; if (conflict) { conflict = false; return {fixtureError: 'version_conflict'}; } }
        return settings;
      }
      if (path === control + '/turnstile') {
        if (method === 'PUT') { expect(body.hasSecret).toBeUndefined(); if (!turn.hasSecret) expect(body.secret).toBe('turn-secret'); else expect(body.secret).toBeUndefined(); turn = {version: turn.version + 1, enabled: body.enabled, siteKey: body.siteKey, hostnames: body.hostnames, hasSecret: true}; }
        return turn;
      }
    });
    await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
    const userPanel = page.getByTestId('auth-users'), loginPanel = page.getByTestId('auth-login-settings');
    await expect(userPanel).toHaveCount(0);
    await expect(page.getByTestId('auth-user-profile')).toHaveCount(0);
    await expect(loginPanel.getByRole('form', {name:'第三方登录表单'})).toHaveCount(0);
    await expect(loginPanel.getByTestId('login-connection-row')).toHaveCount(2);
    await expect(page.getByTestId('session-policy-form')).toHaveCount(0);
    await page.getByRole('region', {name: '登录会话', exact: true}).getByRole('button', {name: '编辑', exact: true}).click();
    await expectVerticalFields(page.getByTestId('session-policy-form'));
    await page.getByRole('dialog').getByRole('button', {name: '取消', exact: true}).click();
    await loginPanel.getByRole('switch', {name:'自动创建第三方登录用户', exact:true}).click();
    await expect(loginPanel.getByRole('switch', {name:'自动创建第三方登录用户', exact:true})).toBeChecked();
    conflict = true; await loginPanel.getByRole('switch', {name:'自动创建第三方登录用户', exact:true}).click();
    await expect(loginPanel.getByRole('alert')).toContainText('已重新读取');
    await loginPanel.getByTestId('login-connection-row').first().getByRole('button', {name: '编辑', exact:true}).click();
    const oidc = page.getByRole('dialog');
    await expect(oidc.getByRole('heading', {name:'编辑第三方登录', exact:true})).toHaveCount(1);
    await expect(oidc.getByRole('button', {name:/检查|Check/})).toHaveCount(0);
    await expect(oidc.getByLabel('Client secret', {exact:true})).toHaveValue('');
    await expect(oidc.getByTestId('login-callback')).toHaveValue('https://public.example/api/auth/login/callback/first');
    await expect(oidc.getByRole('switch', {name:'启用连接',exact:true})).toBeChecked();
    await expectVerticalFields(oidc);
    await oidc.evaluate(async element => { await Promise.all(element.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({path:`${evidence}/oidc-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:1000});
    await expectVerticalFields(oidc);
    await expect.poll(() => oidc.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; })).toBe(true);
    await oidc.getByLabel('Client secret', {exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:`${evidence}/oidc-mobile.png`,fullPage:true});
    await expect(oidc.getByRole('button', {name:'保存',exact:true})).toBeInViewport();
    await page.setViewportSize({width:1440,height:1000});
    await oidc.getByLabel('连接显示名称').fill('Company renamed'); await oidc.getByRole('button', {name:'保存', exact:true}).click();
    await expect(loginPanel.getByTestId('login-connection-row').last()).toContainText('Company renamed');
    await loginPanel.getByRole('button', {name:'添加连接', exact:true}).click();
    await expect(oidc.getByRole('heading', {name:'添加第三方登录', exact:true})).toHaveCount(1);
    await expect(oidc.getByTestId('login-callback')).toHaveValue(/https:\/\/public.example\/api\/auth\/login\/callback\/[0-9a-f-]{36}$/);
    await oidc.getByRole('button', {name:'Google', exact:true}).click();
    await oidc.getByLabel('连接显示名称').fill('Third'); await oidc.getByLabel('Client ID', {exact:true}).fill('third'); await oidc.getByLabel('Client secret', {exact:true}).fill('client-secret');
    await expect(oidc.getByRole('button', {name:/检查|Check|测试登录/})).toHaveCount(0);
    await expect(oidc.getByRole('switch', {name:'启用连接',exact:true})).toHaveCount(0);
    const callbackBeforeSave = await oidc.getByTestId('login-callback').inputValue();
    await oidc.getByRole('button', {name:'保存', exact:true}).click(); await expect(loginPanel.getByTestId('login-connection-row')).toHaveCount(3);
    const createdConnection = writes.filter(write => write.path === '/login-connections').at(-1)!.body;
    expect(createdConnection).toEqual({id: callbackBeforeSave.split('/').at(-1), label:'Third', enabled:false, provider:'google',clientId:'third',clientSecret:'client-secret',configuration:{}});
    const turnSection = page.getByRole('region', {name: 'Turnstile 人机验证', exact: true});
    const turnStatus = turnSection.getByTestId('turnstile-saved-status');
    const openTurn = () => turnSection.getByRole('button', {name: '配置', exact: true}).click();
    const turnDialog = page.getByRole('dialog', {name: 'Turnstile 人机验证', exact: true});
    const turnForm = turnDialog.getByRole('form', {name: 'Turnstile 人机验证', exact: true});
    await expect(turnForm).toHaveCount(0);
    await expect(turnStatus).toHaveText('未启用');
    await openTurn();
    await expectVerticalFields(turnForm);
    const turnToggle = turnForm.getByRole('switch', {name:'启用 Turnstile',exact:true});
    await expect.poll(async () => {
      const toggle = await turnToggle.boundingBox(), field = await turnForm.getByLabel('Site key', {exact:true}).boundingBox();
      return !!toggle && !!field && Math.abs(toggle.x - field.x) < 2;
    }).toBe(true);
    await turnToggle.click(); await turnForm.getByLabel('Site key', {exact:true}).fill('site-key'); await turnForm.getByLabel('Turnstile secret', {exact:true}).fill('turn-secret'); await turnForm.getByLabel('允许的 hostname（每行一个）', {exact:true}).fill('public.example\nother.example');
    await expect(turnForm.getByRole('status')).toHaveText('更改未保存');
    await expect(turnDialog.getByRole('button', {name:'保存并启用',exact:true})).toBeVisible();
    await turnDialog.getByRole('button', {name:/^保存/}).click();
    await expect(turnDialog).toHaveCount(0);
    await expect(turnStatus).toHaveText('已启用');
    expect(turn.enabled).toBe(true);
    expect(writes.filter(write => write.path === '/turnstile').at(-1)!.body.enabled).toBe(true);
    await openTurn();
    await expect(turnForm.getByLabel('Turnstile secret', {exact:true})).toHaveValue('');
    await expect(turnToggle).toBeChecked();
    await turnDialog.getByRole('button', {name:/^保存/}).click();
    await expect(turnDialog).toHaveCount(0);
    await page.reload(); await openTurn();
    await expect(turnToggle).toBeChecked();
    await expect(turnForm.getByLabel('Site key', {exact:true})).toHaveValue('site-key');
    await turnToggle.click();
    await turnDialog.getByRole('button', {name:/^保存/}).click();
    await expect(turnDialog).toHaveCount(0);
    await expect.poll(() => turn.enabled).toBe(false);
    await page.reload(); await openTurn();
    await expect(turnToggle).not.toBeChecked();
    await expect(turnStatus).toHaveText('已配置，未启用');
    await page.screenshot({path:`${evidence}/turnstile-configured-disabled-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:1000});
    await expectVerticalFields(turnForm);
    await page.screenshot({path:`${evidence}/turnstile-configured-disabled-mobile.png`,fullPage:true});
    await page.setViewportSize({width:1440,height:1000});
    await expect(turnForm.getByLabel('Site key', {exact:true})).toHaveValue('site-key');
    await expect(turnForm.getByLabel('Turnstile secret', {exact:true})).toHaveAttribute('placeholder', manifest.translations['zh-CN']['admin.secretRetained']);
    await turnToggle.click();
    await turnDialog.getByRole('button', {name:/^保存/}).click();
    await expect(turnDialog).toHaveCount(0);
    await expect.poll(() => turn.enabled).toBe(true);
    expect(writes.filter(write => write.path === '/turnstile').at(-1)!.body.secret).toBeUndefined();
    const userReadOffset = reads.length;
    await page.getByTestId('app-header').getByRole('link', {name:'用户管理',exact:true}).click();
    await expect(loginPanel).toHaveCount(0);
    await expect(userPanel).toContainText('所有已登录用户拥有完整管理能力');
    await expect(userPanel.getByRole('form')).toHaveCount(0);
    await userPanel.getByRole('button', {name:'创建用户',exact:true}).click();
    const create = page.getByRole('dialog', {name:'创建用户', exact:true});
    await expectVerticalFields(create);
    await create.getByLabel('用户密码（5–32 个字符）',{exact:true}).fill('discarded-password');
    await page.keyboard.press('Escape'); await expect(create).toHaveCount(0);
    await expect(userPanel.getByRole('button',{name:'创建用户',exact:true})).toBeFocused();
    await userPanel.getByRole('button',{name:'创建用户',exact:true}).click();
    await expect(create.getByLabel('用户密码（5–32 个字符）',{exact:true})).toHaveValue('');
    await create.getByLabel('账号', {exact:true}).fill('new-user'); await create.getByLabel('显示名称').fill('New User'); await create.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill('😀'.repeat(4)); await create.getByLabel('确认用户密码', {exact:true}).fill('😀'.repeat(4)); await create.getByRole('button', {name:'保存', exact:true}).click(); await expect(create.getByRole('alert')).toContainText('密码须为 5–32'); expect(writes.filter(write => write.path === '/users')).toHaveLength(0); await create.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill(' 密码 空格 '); await create.getByLabel('确认用户密码', {exact:true}).fill(' 密码 空格 '); await create.getByRole('button', {name:'保存', exact:true}).click();
    await expect(create.getByRole('button', {name:'保存', exact:true})).toBeDisabled();
    await expect(create.getByLabel('账号', {exact:true})).toBeDisabled();
    await expect(create.getByRole('button', {name:'关闭', exact:true})).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(create).toBeVisible();
    await page.mouse.click(4, 4); await expect(create).toBeVisible();
    await create.getByRole('form').evaluate(element => (element as HTMLFormElement).requestSubmit());
    expect(writes.filter(write => write.path === '/users')).toHaveLength(1);
    finishCreate();
    const row = userPanel.getByTestId('auth-user-row').filter({hasText:'new-user'}); await expect(row).toContainText('New User');
    await row.getByRole('switch').click(); await expect(row).toContainText('停用'); await row.getByRole('switch').click(); await expect(row).toContainText('启用');
    await row.getByRole('button', {name:'编辑', exact:true}).click(); const edit = page.getByRole('dialog', {name:'编辑用户', exact:true}); await edit.getByLabel('显示名称').fill('Edited'); await edit.getByRole('button', {name:'保存', exact:true}).click(); await expect(row).toContainText('Edited');
    await row.getByRole('button', {name:'重设密码', exact:true}).click(); const reset = page.getByRole('dialog', {name:'重设密码', exact:true}); await reset.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill(' 新 密码 '); await reset.getByLabel('确认用户密码', {exact:true}).fill(' 新 密码 '); await reset.getByRole('button', {name:'重设密码', exact:true}).click(); await expect(reset).toHaveCount(0);
    await row.getByRole('button', {name:'编辑', exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('dialog')).not.toContainText('外部身份');
    expect(reads.slice(userReadOffset).some(path => path.startsWith('/identities') || path === '/login-connections')).toBe(false);
    expect(writes.some(write => write.path.startsWith('/identities'))).toBe(false);
    const dialog = page.getByRole('dialog');
    const fitsViewport = () => dialog.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.x >= 0 && bounds.y >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    });
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {}))); });
    await expect.poll(fitsViewport).toBe(true);
    await expectVerticalFields(dialog);
    await page.screenshot({path:`${evidence}/users-desktop.png`, fullPage:true});
    await page.setViewportSize({width:390,height:1000});
    await expect.poll(fitsViewport).toBe(true);
    await expectVerticalFields(dialog);
    await page.screenshot({path:`${evidence}/users-mobile.png`,fullPage:true});
    expect(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(writes.some(write => write.path === '/users' && write.body.password === ' 密码 空格 ')).toBe(true);
    expect(errors).toEqual([]); await context.close();
  } finally { try { await browser.close(); } finally { await runtime.close(); } }
}, 90_000);

test('Turnstile uses external explicit rendering, retries failed loads and cannot submit without a fresh token', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
    await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
    const page = await context.newPage(), errors: string[] = [], loginBodies: any[] = [];
    page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    let loads = 0;
    await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => {
      loads++;
      if (loads === 1) return route.fulfill({contentType:'application/javascript',body:'/* unavailable API */'});
      return route.fulfill({contentType:'application/javascript',body:`
        window.challengeStats = {renders:0,resets:0,removes:0};
        window.turnstile = {
          render(container, options) { window.challengeStats.renders++; window.challengeOptions = options; return 'widget'; },
          reset() { window.challengeStats.resets++; }, remove() { window.challengeStats.removes++; }
        };
      `});
    });
    await mockApplication(page, (path, _method, body) => {
      if (path === '/api/auth/login/options') return {local:{enabled:true,turnstile:{enabled:true,siteKey:'test-site'}},methods:[{id:'first',label:'Company SSO',provider:'google'},{id:'second',label:'Partner SSO',provider:'github'}]};
      if (path === '/api/auth/login') { loginBodies.push(body); return {success:false,error:'invalid_credentials'}; }
      if (path === '/api/auth/login/start') { expect(body).toEqual({methodId:'second'}); return {authorizationUrl:'https://identity.example/authorize?state=fixture',flowId:'flow'}; }
    }, false);
    await page.goto(`${runtime.origin}/#/login?oidcError=unknown_identity`);
    const form = page.getByRole('form', {name:'账号登录',exact:true}), submit = form.getByRole('button',{name:'登录',exact:true});
    await expect(form).toContainText('该外部身份尚未绑定用户'); await expect(page).toHaveURL(/#\/login\?oidcError=unknown_identity$/);
    await expect(form).toContainText('人机验证不可用'); await expect(submit).toBeDisabled();
    await form.getByRole('button',{name:'重试验证',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats?.renders)).toBe(1);
    expect(loads).toBe(2);
    expect(await page.evaluate(() => ({sitekey:(window as any).challengeOptions.sitekey, action:(window as any).challengeOptions.action}))).toEqual({sitekey:'test-site',action:'local-login'});
    await form.getByLabel('账号',{exact:true}).fill('admin'); await form.getByLabel('密码',{exact:true}).fill(' test password ');
    await form.evaluate(element => (element as HTMLFormElement).requestSubmit()); expect(loginBodies).toHaveLength(0);
    await page.evaluate(() => (window as any).challengeOptions.callback('first-token')); await expect(submit).toBeEnabled();
    await page.evaluate(() => (window as any).challengeOptions['expired-callback']()); await expect(submit).toBeDisabled();
    await page.evaluate(() => (window as any).challengeOptions.callback('fresh-token')); await submit.click();
    await expect(form).toContainText('账号或密码不正确'); await expect(submit).toBeDisabled();
    expect(loginBodies).toEqual([{username:'admin',password:' test password ',transport:'cookie',turnstileToken:'fresh-token'}]);
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.resets)).toBe(2);
    await page.evaluate(() => (window as any).challengeOptions['error-callback']()); await expect(form).toContainText('人机验证不可用');
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.resets)).toBe(3);
    await form.getByRole('button',{name:'重试验证',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.renders)).toBe(2); expect(loads).toBe(2);
    await page.screenshot({path:`${evidence}/login-challenge-mobile.png`,fullPage:true});
    await page.route('https://identity.example/**', route => route.fulfill({contentType:'text/html',body:'Identity provider'}));
    await page.getByRole('button',{name:'Partner SSO · GitHub',exact:true}).click(); await expect(page).toHaveURL('https://identity.example/authorize?state=fixture');
    expect(errors).toEqual([]); await context.close();
  } finally {try{await browser.close();}finally{await runtime.close();}}
}, 60_000);

test('authenticated identity linking starts through protected control and finishes once before returning to login', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  try {
    for (const scenario of ['start','finish','unsafe-error'] as const) {
      const context = await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
      await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
      const page = await context.newPage(), calls: string[] = [], errors:string[]=[];
      page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
      await mockApplication(page, (path,method,body) => {
        if (path === control+'/users') return {users:[administrator]};
        if (path === control+'/login-connections') return {connections:[{id:'first',label:'Company',provider:'google',configuration:{},enabled:true,issuer:'https://identity.example',clientId:'client',scopes:['openid'],hasSecret:true,version:1}]};
        if (path === control+'/login-settings') return {version:1,autoCreateUsers:false};
        if (path === control+'/turnstile') return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
        if (path.startsWith(control+'/identities?')) return {identities:[]};
        if (path === control+'/identities/link/start') {expect(body).toEqual({connectionId:'first'}); calls.push(path); return {authorizationUrl:'https://identity.example/link',flowId:'flow'};}
        if (path === control+'/identities/link/finish') {expect(method).toBe('POST');expect(body).toEqual({flowId:'flow'});calls.push(path);return {ok:true};}
      },scenario!=='unsafe-error');
      if (scenario==='unsafe-error') {
        await page.goto(`${runtime.origin}/#/login?oidcError=${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
        await expect(page.getByRole('alert')).toContainText('登录未完成'); expect(await page.locator('img').count()).toBe(0); await expect(page.locator('body')).not.toContainText('<img src=x');
      } else if (scenario==='start') {
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
        const panel=page.getByTestId('auth-user-profile');
        await page.route('https://identity.example/**',route=>route.fulfill({contentType:'text/html',body:'Link identity'}));
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await panel.getByRole('button',{name:'绑定 Company',exact:true}).click();await expect(page).toHaveURL('https://identity.example/link');
        expect(calls).toEqual([control+'/identities/link/start']);
      } else {
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile?oidcLink=flow`);
        await expect(page.getByTestId('page-login')).toBeVisible();await expect(page).toHaveURL(/#\/login$/);
        expect(calls).toEqual([control+'/identities/link/finish']);
      }
      expect(errors).toEqual([]);await context.close();
    }
  }finally{try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('local login remains available with Turnstile off and rejects submission when login options are unavailable', async () => {
  const runtime=await startUiRuntime({mode:'built-page'}),browser=await chromium.launch({headless:true});
  try {
    for (const scenario of ['off','unavailable'] as const) {
      const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),bodies:unknown[]=[],errors:string[]=[];let challengeRequests=0,available=scenario==='off';
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
      page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
      await page.route('https://challenges.cloudflare.com/**',route=>{challengeRequests++;return route.fulfill({body:''});});
      await mockApplication(page,(path,_method,body)=>{
        if(path==='/api/auth/login/options')return available?{local:{enabled:true,turnstile:{enabled:false}},methods:[]} : {};
        if(path==='/api/auth/login'){bodies.push(body);return {success:false,error:'invalid_credentials'};}
      },false);
      await page.goto(`${runtime.origin}/#/login`);
      const form=page.getByRole('form',{name:'账号登录',exact:true}),submit=form.getByRole('button',{name:'登录',exact:true});
      await form.getByLabel('账号',{exact:true}).fill('admin');await form.getByLabel('密码',{exact:true}).fill('local password');
      if(scenario==='unavailable'){
        await expect(form.getByRole('alert')).toContainText('账号服务暂时不可用');await expect(submit).toBeDisabled();
        await form.evaluate(form=>(form as HTMLFormElement).requestSubmit());expect(bodies).toHaveLength(0);
        available=true;await form.getByRole('button',{name:'重新读取',exact:true}).click();
      }
      await expect(submit).toBeEnabled();await submit.click();await expect(form.getByRole('alert')).toContainText('账号或密码不正确');
      expect(bodies).toEqual([{username:'admin',password:'local password',transport:'cookie'}]);expect(challengeRequests).toBe(0);expect(errors).toEqual([]);
      await context.close();
    }
  }finally{try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('split user pages preserve self revocation and recover from profile read or binding completion failures', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  try {
    for (const scenario of ['unbind','reset-self','edit-no-binding','load-failed','finish-failed','sso-only'] as const) {
      const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
      try {
        await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), errors: string[] = [], writes: {path:string;body:unknown}[] = [], reads: string[] = [];
        page.on('pageerror',error=>errors.push(error.message));
        let failRead = scenario==='load-failed';
        await mockApplication(page,(path,method,body)=>{
          if(!path.startsWith(control)) return;
          if(method==='GET') reads.push(path); else writes.push({path:path.slice(control.length),body});
          if(path===control+'/self') {
            if(failRead) {failRead=false;return {fixtureError:'provider_unavailable'};}
            return {administrator:{...administrator,hasLocalPassword:scenario!=='sso-only'}};
          }
          if(path===control+'/users') return {users:[administrator]};
          if(path===control+'/login-connections') return {connections:[{id:'first',label:'Company',provider:'google',configuration:{},enabled:true,issuer:'https://identity.example',clientId:'client',scopes:['openid'],hasSecret:true,version:1}]};
          if(path===control+'/identities?userId=admin') return {identities:[{id:'bound',userId:'admin',connectionId:'first',issuer:'https://identity.example',subject:'my-sub'}]};
          if(path===control+'/identities/link/finish') return {fixtureError:'invalid_oidc_flow'};
          if(path===control+'/users/password' || path===control+'/identities') return {ok:true};
        });
        const manage = scenario==='reset-self' || scenario==='edit-no-binding';
        await page.goto(`${runtime.origin}/#/extensions/user-auth/${manage?'users':'profile'}${scenario==='finish-failed'?'?oidcLink=failed-flow':''}`);
        const profile = page.getByTestId('auth-user-profile');
        if(scenario==='finish-failed') {
          await expect(profile.getByRole('alert')).toBeVisible();
          await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
          await profile.getByRole('button',{name:'重新读取',exact:true}).click();
          await expect(profile).toContainText('Administrator');
          expect(writes).toEqual([{path:'/identities/link/finish',body:{flowId:'failed-flow'}}]);
        } else if(scenario==='load-failed') {
          await expect(profile.getByRole('alert')).toBeVisible();
          await profile.getByRole('button',{name:'重新读取',exact:true}).click();
          await expect(profile).toContainText('Administrator');
          await expect(profile.getByRole('alert')).toHaveCount(0);
          await expect(profile).toContainText('my-sub');
          await expect(page.getByTestId('auth-users')).toHaveCount(0);
          await expect(page.getByTestId('auth-login-management')).toHaveCount(0);
          await page.screenshot({path:`${evidence}/profile-desktop.png`,fullPage:true});
          await page.setViewportSize({width:390,height:1000});
          await page.screenshot({path:`${evidence}/profile-mobile.png`,fullPage:true});
          expect(await page.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
        } else if(scenario==='sso-only') {
          await expect(profile).toContainText('尚未设置本地密码');
          await expect(profile.getByRole('form',{name:'修改登录密码',exact:true})).toHaveCount(0);
          await expect(profile.locator('[data-connection-id="first"]')).toContainText('已绑定');
          await expect(profile.getByRole('button',{name:'绑定 Company',exact:true})).toHaveCount(0);
        } else if(scenario==='unbind') {
          await profile.getByRole('button',{name:'解除绑定 Company my-sub',exact:true}).click();
          const confirmation = page.getByRole('dialog', {name:'解除第三方账号绑定',exact:true});
          await expect(confirmation).toContainText('my-sub');
          expect(writes).toEqual([]);
          await confirmation.getByRole('button',{name:'解除绑定',exact:true}).click();
          await expect(page.getByTestId('page-login')).toBeVisible();
          expect(writes).toEqual([{path:'/identities',body:{id:'bound'}}]);
        } else {
          const users = page.getByTestId('auth-users');
          if(scenario==='reset-self') {
            await users.getByRole('button',{name:'重设密码',exact:true}).click();
            const form = page.getByRole('dialog',{name:'重设密码',exact:true});
            await form.getByLabel('用户密码（5–32 个字符）',{exact:true}).fill('reset-password');
            await form.getByLabel('确认用户密码',{exact:true}).fill('reset-password');
            await form.getByRole('button',{name:'重设密码',exact:true}).click();
            expect(writes).toEqual([{path:'/users/password',body:{id:'admin',password:'reset-password',passwordConfirmation:'reset-password'}}]);
          } else {
            await users.getByRole('button',{name:'编辑',exact:true}).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog.getByRole('combobox')).toHaveCount(0);
            await expect(dialog).not.toContainText('外部身份');
            await page.keyboard.press('Escape');
            expect(reads).toEqual([control+'/users']);
            expect(writes).toEqual([]);
          }
          if(scenario==='reset-self') await expect(page.getByTestId('page-login')).toBeVisible();
        }
        if(!manage) expect(reads.some(path=>path===control+'/users')).toBe(false);
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally {try{await browser.close();}finally{await runtime.close();}}
},90_000);


test('third-party sign-in management table filters, toggles and confirms deletion without duplicate requests or lost-ACK ambiguity', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  await mkdir(evidence, {recursive: true});
  try {
    for (const scenario of ['normal', 'lost-ack', 'self', 'self-lost-ack', 'conflict', 'originless'] as const) {
      const context = await browser.newContext({viewport: {width: 1440, height: 1000}, locale: 'zh-CN'});
      try {
        await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
        const page = await context.newPage(), errors: string[] = [], deletions: unknown[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {if (message.type() === 'error' && !message.text().includes('409 (Conflict)') && !(scenario === 'self-lost-ack' && message.text().includes('401 (Unauthorized)'))) errors.push(message.text());});
        let connections = [
          {id: 'first', label: 'Company', provider: 'google', configuration: {}, enabled: true, issuer: 'https://identity.example', clientId: 'company-client', scopes: ['openid'], hasSecret: true, version: 1},
          {id: 'second', label: 'Partner', provider: 'google', configuration: {}, enabled: false, issuer: 'https://partner.example', clientId: 'partner-client', scopes: ['openid'], hasSecret: true, version: 1},
        ];
        let fail = scenario === 'normal', conflict = scenario === 'conflict';
        let finish!: () => void; const completion = new Promise<void>(resolve => {finish = resolve;});
        await mockApplication(page, async (path, method, body) => {
          if (path === '/api/auth/mode' && scenario === 'originless') return {mode: 'plugin', initialized: true, provider: {name: manifest.name, ...manifest.management}};
          if (path === control + '/login-settings') return {version: 1, autoCreateUsers: false};
          if (path === control + '/turnstile') return {version: 1, enabled: false, siteKey: '', hostnames: [], hasSecret: false};
          if (path !== control + '/login-connections') return;
          if (method === 'GET') return scenario === 'self-lost-ack' && !connections.some(connection => connection.id === 'first') ? {fixtureError: 'unauthorized', fixtureStatus: 401} : {connections};
          if (method === 'PUT') {
            expect(body).toEqual({id: 'first', version: 1, label: 'Company', provider: 'google', configuration: {}, enabled: false, clientId: 'company-client'});
            connections = connections.map(connection => connection.id === body.id ? {...connection, enabled: body.enabled, version: 2} : connection);
            return {connection: connections[0]};
          }
          expect(method).toBe('DELETE'); expect(Object.keys(body).sort()).toEqual(['id', 'version']);
          deletions.push(body);
          if (conflict) {conflict = false; connections[0] = {...connections[0]!, label: 'Company changed', version: 3}; return {fixtureError: 'version_conflict'};}
          if (fail) {fail = false; return {fixtureError: 'provider_unavailable'};}
          if (scenario === 'normal') await completion;
          connections = connections.filter(connection => connection.id !== body.id);
          return scenario === 'lost-ack' || scenario === 'self-lost-ack' ? {fixtureError: 'provider_unavailable'} : {ok: true, sessionRevoked: scenario === 'self'};
        });
        await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
        const panel = page.getByTestId('auth-login-settings'), table = panel.getByRole('table', {name: '第三方登录', exact: true});
        if (scenario === 'originless') {
          await expect(page.getByRole('alert')).toBeVisible();
          await expect(panel).toHaveCount(0);
          await expect(page.getByTestId('page-login')).toHaveCount(0);
          expect(deletions).toEqual([]); expect(errors).toEqual([]); continue;
        }
        await expect(table.getByRole('columnheader')).toHaveText(['连接显示名称', '提供商', 'Client ID', '状态', '操作']);
        const rows = table.getByTestId('login-connection-row'); await expect(rows).toHaveCount(2);
        await panel.getByRole('searchbox', {name: '搜索连接', exact: true}).fill('partner-client');
        await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText('Partner');
        await panel.getByRole('searchbox', {name: '搜索连接', exact: true}).fill('no-match');
        await expect(table).toContainText('没有匹配的连接');
        await panel.getByRole('searchbox', {name: '搜索连接', exact: true}).fill('');
        await panel.getByRole('combobox', {name: '状态', exact: true}).click(); await page.getByRole('option', {name: '停用', exact: true}).click();
        await expect(rows).toHaveCount(1);
        await panel.getByRole('combobox', {name: '状态', exact: true}).click(); await page.getByRole('option', {name: '全部状态', exact: true}).click();
        await rows.first().getByRole('button', {name: '停用', exact: true}).click();
        const company = rows.filter({hasText: 'Company'});
        await expect(company.getByRole('button', {name: '启用', exact: true})).toBeVisible();
        await company.getByRole('button', {name: '删除', exact: true}).click();
        const dialog = page.getByRole('dialog', {name: '删除第三方登录', exact: true});
        await expect(dialog).toContainText('清理该连接的外部身份绑定');
        await expect(dialog).toContainText('退出受影响用户的所有会话');
        await expect(dialog).toContainText('平台用户保留');
        await dialog.getByRole('button', {name: '取消', exact: true}).click(); expect(deletions).toEqual([]);
        await company.getByRole('button', {name: '删除', exact: true}).click();
        await dialog.getByRole('button', {name: '删除', exact: true}).click();
        if (scenario === 'conflict') {
          await expect(dialog).toHaveCount(0); await expect(panel.getByRole('alert')).toContainText('已重新读取');
          await company.getByRole('button', {name: '删除', exact: true}).click();
          await expect(dialog).toContainText('Company changed');
          await dialog.getByRole('button', {name: '删除', exact: true}).click();
          expect(deletions).toEqual([{id: 'first', version: 2}, {id: 'first', version: 3}]);
        } else if (scenario === 'normal') {
          await expect(dialog.getByRole('alert')).toBeVisible(); await expect(rows).toHaveCount(2);
          await dialog.getByRole('button', {name: '删除', exact: true}).click();
          await expect(dialog.getByRole('button', {name: '删除', exact: true})).toBeDisabled();
          await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
          expect(deletions).toHaveLength(2); finish();
        }
        if (scenario === 'self' || scenario === 'self-lost-ack') await expect(page.getByTestId('page-login')).toBeVisible();
        else {await expect(dialog).toHaveCount(0); await expect(rows).toHaveCount(1); await expect(rows.first()).toContainText('Partner');}
        if (scenario === 'normal') {
          await page.screenshot({path: `${evidence}/oidc-table-desktop.png`, fullPage: true});
          await page.setViewportSize({width: 390, height: 1000});
          await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          await rows.first().getByRole('button', {name: '删除', exact: true}).click();
          await page.screenshot({path: `${evidence}/oidc-delete-mobile.png`, fullPage: true});
          await dialog.getByRole('button', {name: '取消', exact: true}).click();
        }
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally {try {await browser.close();} finally {await runtime.close();}}
}, 90_000);

test('connection deletion only signs out its initiating session when a response finishes after another login', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  await mkdir(evidence, {recursive: true});
  try {
    for (const scenario of ['current-session', 'new-session'] as const) {
      const context = await browser.newContext({viewport: {width: 1301, height: 900}, locale: 'zh-CN'});
      try {
        // Delay JSON delivery after fetch and body consumption: aborting fetch alone cannot suppress this response.
        await context.addInitScript(() => {
          localStorage.setItem('locale', 'zh-CN');
          const original = window.fetch;
          window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>) => {
            const response = await original(...args);
            if (new URL(response.url).pathname === '/api/plugins/user-auth/control/login-connections' && args[1]?.method === 'DELETE') {
              const data = await response.json();
              const delayed = new Promise(resolve => { (window as any).releaseConnectionDeletion = () => resolve(data); });
              response.json = () => delayed;
              (window as any).connectionDeletionReceived = true;
            }
            return response;
          }, original);
        });
        const page = await context.newPage(), errors: string[] = [], deletions: unknown[] = [], logins: unknown[] = [];
        let active = administrator;
        page.on('pageerror', error => errors.push(error.message));
        page.on('requestfailed', request => {if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url());});
        await mockApplication(page, (path, method, body) => {
          if (path === '/api/config/runtime') return configurationRuntimeFixture(publicationFixture({operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1}));
          if (path === '/api/auth/verify') return {mode: 'plugin', success: true, subject: {id: active.id, provider: manifest.name}, csrfToken: `csrf-${active.id}`};
          if (path === '/api/auth/login') {
            logins.push(body); active = {...administrator, id: 'other-user', username: 'other', displayName: 'Other user'};
            return {success: true};
          }
          if (path === control + '/self') return {administrator: active};
          if (path.startsWith(control + '/identities?')) return {identities: []};
          if (path === control + '/login-settings') return {version: 1, autoCreateUsers: false};
          if (path === control + '/turnstile') return {version: 1, enabled: false, siteKey: '', hostnames: [], hasSecret: false};
          if (path === control + '/login-connections') {
            if (method === 'GET') return {connections: [{id: 'github', label: 'GitHub', provider: 'github', configuration: {}, enabled: true, issuer: 'https://github.com', clientId: 'client', scopes: ['read:user'], hasSecret: true, version: 1}]};
            expect(method).toBe('DELETE'); deletions.push(body); return {ok: true, sessionRevoked: true};
          }
        });
        await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
        await page.getByTestId('login-connection-row').getByRole('button', {name: '删除', exact: true}).click();
        const dialog = page.getByRole('dialog', {name: '删除第三方登录', exact: true});
        await dialog.getByRole('button', {name: '删除', exact: true}).click();
        await page.waitForFunction(() => (window as any).connectionDeletionReceived === true);
        await expect(dialog.getByRole('button', {name: '删除', exact: true})).toBeDisabled();
        expect(deletions).toEqual([{id: 'github', version: 1}]);
        if (scenario === 'new-session') {
          await page.evaluate(() => {window.location.hash = '#/login';});
          const login = page.getByTestId('page-login');
          await expect(login).toBeVisible();
          await login.getByLabel('账号', {exact: true}).fill('other');
          await login.getByLabel('密码', {exact: true}).fill('other password');
          await login.getByRole('button', {name: '登录', exact: true}).click();
          await expect(page.getByTestId('page-dashboard')).toBeVisible();
          expect(logins).toEqual([{username: 'other', password: 'other password', transport: 'cookie'}]);
        }
        await page.evaluate(() => (window as any).releaseConnectionDeletion());
        await page.waitForLoadState('networkidle');
        if (scenario === 'current-session') {
          await expect(page.getByTestId('page-login')).toBeVisible();
          await expect(page).toHaveURL(/#\/login$/);
          expect(logins).toEqual([]);
        } else {
          await expect(page.getByTestId('page-dashboard')).toBeVisible();
          await expect(page.getByTestId('app-header')).toBeVisible();
          await expect(page.getByTestId('page-login')).toHaveCount(0);
          await page.getByTestId('app-header').getByRole('link', {name: '用户信息', exact: true}).click();
          await expect(page.getByTestId('account-details')).toContainText('other');
          await expect(page.getByTestId('account-details')).toContainText('Other user');
          await page.screenshot({path: `${evidence}/late-delete-preserves-new-session.png`, fullPage: true});
        }
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally {try {await browser.close();} finally {await runtime.close();}}
}, 60_000);

test('connection toolbar separates adding from filters and distinguishes empty lists from unmatched searches', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  await mkdir(evidence, {recursive: true});
  try {
    for (const locale of ['zh-CN', 'en'] as const) {
      const context = await browser.newContext({viewport: {width: 1301, height: 900}, locale});
      try {
        await context.addInitScript(language => localStorage.setItem('locale', language), locale);
        const page = await context.newPage(), errors: string[] = [], deletions: unknown[] = [];
        page.on('pageerror', error => errors.push(error.message));
        let connections = [{id: 'github', label: 'GitHub team', provider: 'github', configuration: {}, enabled: true,
          issuer: 'https://github.com', clientId: 'github-client', scopes: ['read:user'], hasSecret: true, version: 1}];
        await mockApplication(page, (path, method, body) => {
          if (path === '/api/config/runtime') return configurationRuntimeFixture(publicationFixture({operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1}));
          if (path === control + '/login-settings') return {version: 1, autoCreateUsers: false};
          if (path === control + '/turnstile') return {version: 1, enabled: false, siteKey: '', hostnames: [], hasSecret: false};
          if (path === control + '/login-connections') {
            if (method === 'GET') return {connections};
            expect(method).toBe('DELETE'); deletions.push(body); connections = [];
            return {ok: true, sessionRevoked: false};
          }
        });
        await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
        const messages = manifest.translations[locale];
        const toolbar = page.getByTestId('login-connections-toolbar');
        const add = page.getByRole('button', {name: messages['connections.add'], exact: true});
        const search = page.getByRole('searchbox', {name: messages['connections.search'], exact: true});
        const status = page.getByRole('combobox', {name: messages['connections.status'], exact: true});
        await expect(toolbar).toBeVisible();
        await expect(search).toHaveAttribute('placeholder', messages['connections.searchPlaceholder']);
        await expect(add.locator('svg[aria-hidden="true"]')).toHaveCount(1);
        const subduedBackground = await add.evaluate(element => getComputedStyle(element).backgroundColor);
        for (const width of [1301, 768, 640, 390, 320]) {
          await page.setViewportSize({width, height: 900});
          await expect(add).toBeInViewport();
          await expect(search).toBeInViewport();
          await expect(status).toBeInViewport();
          await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
          const bounds = await Promise.all([add, search, status].map(element => element.boundingBox()));
          const [action, input, select] = bounds as NonNullable<typeof bounds[number]>[];
          expect(input!.height).toBeCloseTo(action!.height, 0);
          expect(select!.height).toBeCloseTo(action!.height, 0);
          if (width >= 640) {
            expect(input!.x).toBeGreaterThanOrEqual(action!.x + action!.width);
            expect(select!.x).toBeGreaterThanOrEqual(input!.x + input!.width);
            expect(Math.abs(action!.y - input!.y)).toBeLessThan(1);
            expect(Math.abs(select!.y - input!.y)).toBeLessThan(1);
            const filterBounds = await page.getByTestId('login-connections-filters').boundingBox();
            const toolbarBounds = await toolbar.boundingBox();
            expect(Math.abs(filterBounds!.x + filterBounds!.width - toolbarBounds!.x - toolbarBounds!.width)).toBeLessThan(1);
          } else {
            expect(input!.y).toBeGreaterThanOrEqual(action!.y + action!.height);
            expect(select!.y).toBeGreaterThanOrEqual(input!.y + input!.height);
          }
          if (width === 1301 || width === 390) await page.screenshot({path: `${evidence}/connections-toolbar-${locale}-${width}.png`, fullPage: true});
        }
        await search.fill('no-matching-connection');
        await expect(page.getByRole('cell', {name: messages['connections.noMatches'], exact: true})).toBeVisible();
        await expect(toolbar).toBeVisible();
        await expect(page.getByTestId('login-connections-empty')).toHaveCount(0);
        expect(await add.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(subduedBackground);
        await search.fill('');
        await page.setViewportSize({width: 1301, height: 900});
        await page.getByTestId('login-connection-row').getByRole('button', {name: messages['connections.remove'], exact: true}).click();
        await page.getByRole('dialog').getByRole('button', {name: messages['connections.remove'], exact: true}).click();
        await expect(page.getByTestId('login-connections-empty')).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        expect(deletions).toEqual([{id: 'github', version: 1}]);
        await expect(toolbar).toHaveCount(0);
        await expect(search).toHaveCount(0);
        await expect(status).toHaveCount(0);
        await expect(page.getByRole('table')).toHaveCount(0);
        await expect(add).toHaveCount(1);
        expect(await add.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(subduedBackground);
        await page.screenshot({path: `${evidence}/connections-empty-${locale}.png`, fullPage: true});
        await add.click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('heading', {name: messages['connections.new'], exact: true})).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(add).toBeFocused();
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await runtime.close(); }
}, 90_000);

test('provider presets expose only required fields, preserve callback IDs and keep every new connection disabled', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
    try {
      await context.addInitScript(() => {
        localStorage.setItem('locale', 'zh-CN');
        // LAN HTTP exposes getRandomValues but not the secure-context randomUUID API.
        Object.defineProperty(Crypto.prototype, 'randomUUID', {value: undefined, configurable: true});
      });
      const page = await context.newPage(), writes:any[]=[], errors:string[]=[];
      page.on('pageerror',error=>errors.push(error.message));
      const connections:any[]=[];
      await mockApplication(page,(path,method,body)=>{
        if(path===control+'/login-settings')return {version:1,autoCreateUsers:false};
        if(path===control+'/turnstile')return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
        if(path===control+'/login-connections') {
          if(method==='GET')return {connections};
          writes.push(body);
          const connection={...body,issuer:'https://provider.example',scopes:body.provider==='github'?['read:user']:['openid','profile','email'],hasSecret:true,version:1};
          delete connection.clientSecret;connections.push(connection);return {connection};
        }
      });
      await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
      const add = page.getByRole('button', {name: '添加连接', exact: true});
      const search = page.getByRole('searchbox', {name: '搜索连接', exact: true});
      const status = page.getByRole('combobox', {name: '状态', exact: true});
      await expect(add).toBeVisible();
      await add.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(search).toHaveCount(0);
      await expect(status).toHaveCount(0);
      await page.screenshot({path: `${evidence}/login-toolbar-desktop.png`, fullPage: true});
      await page.setViewportSize({width: 390, height: 1000});
      await expect(add).toBeInViewport();
      await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({path: `${evidence}/login-toolbar-mobile.png`, fullPage: true});
      await page.setViewportSize({width: 1440, height: 1000});
      for(const provider of ['google','microsoft','github'] as const) {
        await page.getByRole('button',{name:'添加连接',exact:true}).click();
        const dialog=page.getByRole('dialog'), callback=dialog.getByTestId('login-callback');
        const callbackUrl=await callback.inputValue();
        expect(callbackUrl).toMatch(/^https:\/\/public\.example\/api\/auth\/login\/callback\/[0-9a-f-]{36}$/);
        await expect(dialog.getByLabel('Client ID',{exact:true})).toHaveCount(0);
        const title=provider==='google'?'Google':provider==='microsoft'?'Microsoft':'GitHub';
        await dialog.getByRole('button',{name:title,exact:true}).click();
        await expect(callback).toHaveValue(callbackUrl);
        await expect(dialog.getByRole('link',{name:'创建应用 ↗',exact:true})).toHaveAttribute('href',/^https:\/\//);
        for(const field of ['Issuer URL','Discovery URL','授权端点','令牌端点','JWKS URL','Scopes（空格分隔）']) await expect(dialog.getByLabel(field,{exact:true})).toHaveCount(0);
        await expect(dialog.getByRole('button',{name:/检查|测试登录/})).toHaveCount(0);
        await expect(dialog.getByRole('switch',{name:'启用连接',exact:true})).toHaveCount(0);
        await dialog.getByLabel('连接显示名称').fill(`${title} team`);
        await dialog.getByLabel('Client ID',{exact:true}).fill(`${provider}-client`);
        await dialog.getByLabel('Client secret',{exact:true}).fill(`${provider}-secret`);
        if(provider==='microsoft') {
          await expect(dialog.getByRole('combobox',{name:'账号范围',exact:true})).toHaveValue('tenant');
          await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
          await dialog.getByLabel('Tenant ID',{exact:true}).fill('not-a-tenant');
          await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeDisabled();
          for(const accountType of ['organizations','consumers','common']) {
            await dialog.getByRole('combobox',{name:'账号范围',exact:true}).selectOption(accountType);
            await expect(dialog.getByLabel('Tenant ID',{exact:true})).toHaveCount(0);
            await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
          }
          await dialog.getByRole('combobox',{name:'账号范围',exact:true}).selectOption('tenant');
          await dialog.getByLabel('Tenant ID',{exact:true}).fill('12345678-1234-1234-1234-123456789abc');
          expect(await dialog.getByLabel('Tenant ID',{exact:true}).evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
          await page.screenshot({path:`${evidence}/microsoft-desktop.png`,fullPage:true});
          await page.setViewportSize({width:390,height:1000});
          await expectVerticalFields(dialog);
          await page.screenshot({path:`${evidence}/microsoft-mobile.png`,fullPage:true});
          await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeInViewport();
          await page.setViewportSize({width:1440,height:1000});
        }
        await dialog.getByRole('button',{name:'保存',exact:true}).click();
        await expect(dialog).toHaveCount(0);
        expect(writes.at(-1)).toEqual({id:callbackUrl.split('/').at(-1),label:`${title} team`,enabled:false,provider,clientId:`${provider}-client`,clientSecret:`${provider}-secret`,configuration:provider==='microsoft'?{accountType:'tenant',tenantId:'12345678-1234-1234-1234-123456789abc'}:{}});
        await expect(page.getByTestId('auth-login-settings').getByRole('status').filter({hasText:'配置已保存'})).toContainText('尚未验证实际登录');
      }
      for (const field of [search, status]) {
        expect(await add.evaluate((button, field) => field !== null && !!(button.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING), await field.elementHandle())).toBe(true);
        const buttonBounds = await add.boundingBox(), fieldBounds = await field.boundingBox();
        expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(fieldBounds!.x);
      }
      for (const width of [1440, 390]) {
        await page.setViewportSize({width, height:1000});
        for (const focused of [false, true]) {
          if (focused) await search.focus();
          const heights = await Promise.all([add, search, status].map(field => field.evaluate(element => element.getBoundingClientRect().height)));
          expect(heights).toEqual([34, 34, 34]);
        }
      }
      await page.setViewportSize({width:1440, height:1000});
      expect(new Set(writes.map(write=>write.id)).size).toBe(3);
      const row=page.getByTestId('login-connection-row').filter({hasText:'GitHub team'});
      await row.getByRole('button',{name:'编辑',exact:true}).click();
      const edit=page.getByRole('dialog');
      await expect(edit.getByTestId('login-callback')).toHaveValue(`https://public.example/api/auth/login/callback/${writes.at(-1).id}`);
      await expect(edit).toContainText('提供商不可修改');
      await expect(edit.getByRole('switch',{name:'启用连接',exact:true})).toBeEnabled();
      await expect(edit.getByRole('button',{name:'Google',exact:true})).toHaveCount(0);
      await expect(edit.getByLabel('Client secret',{exact:true})).toHaveValue('');
      await page.keyboard.press('Escape');expect(errors).toEqual([]);
    } finally {await context.close();}
  } finally {try{await browser.close();}finally{await runtime.close();}}
},90_000);

test('custom OIDC discovers on blur, rejects failures and stale responses, and saves only the chosen mode fields', async () => {
  const runtime=await startUiRuntime({mode:'built-page'}),browser=await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
    let releaseOld=()=>{}, releaseMode=()=>{}, releaseClosing=()=>{};
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),writes:any[]=[],discoveryBodies:any[]=[],errors:string[]=[];
      page.on('pageerror',error=>errors.push(error.message));
      const metadata=(issuer:string)=>({issuer,discoveryUrl:issuer+'/.well-known/openid-configuration',authorizationEndpoint:issuer+'/authorize',tokenEndpoint:issuer+'/token',jwksUri:issuer+'/jwks',tokenEndpointAuthMethods:['client_secret_basic'],idTokenSigningAlgs:['RS256']});
      const oldResponse=new Promise<void>(resolve=>{releaseOld=resolve;});
      const modeResponse=new Promise<void>(resolve=>{releaseMode=resolve;});
      const closingResponse=new Promise<void>(resolve=>{releaseClosing=resolve;});
      await mockApplication(page,async(path,method,body)=>{
        if(path===control+'/login-settings')return {version:1,autoCreateUsers:false};
        if(path===control+'/turnstile')return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
        if(path===control+'/login-connections/discover') {
          discoveryBodies.push(body);
          if(body.url==='https://failure.example')return {fixtureError:'oidc_metadata_failed'};
          if(body.url==='https://old.example')await oldResponse;
          if(body.url==='https://mode.example')await modeResponse;
          if(body.url==='https://closing.example')await closingResponse;
          return metadata(body.mode==='discovery'?'https://discovered.example':body.url);
        }
        if(path===control+'/login-connections') {
          if(method==='GET')return {connections:[]};
          writes.push(body);return {connection:{...body,issuer:body.configuration.issuer,scopes:body.scopes,hasSecret:true,version:1}};
        }
      });
      await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
      const open=async()=>{
        await page.getByRole('button',{name:'添加连接',exact:true}).click();
        await page.getByRole('dialog').getByRole('button',{name:'自定义 OIDC',exact:true}).click();
        await page.getByRole('dialog').getByLabel('连接显示名称').fill('Custom identity');
      };
      await open();
      const dialog=page.getByRole('dialog'),save=dialog.getByRole('button',{name:'保存',exact:true});
      const blur=async()=>{await dialog.getByLabel('连接显示名称').focus();};
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('http://unsafe.example');await blur();
      await expect(dialog.getByRole('alert')).toContainText('HTTPS');expect(discoveryBodies).toHaveLength(0);
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://failure.example');await blur();
      await expect(dialog.getByRole('alert')).toContainText('无法读取提供商配置');
      await expect(dialog.getByLabel('Issuer URL',{exact:true})).toHaveValue('https://failure.example');
      await expect(save).toBeDisabled();await expect(dialog.getByLabel('Client ID',{exact:true})).toHaveCount(0);
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://old.example');await blur();
      await expect.poll(()=>discoveryBodies.some(body=>body.url==='https://old.example')).toBe(true);
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://current.example');await blur();
      await expect(dialog.getByTestId('discovered-metadata')).toContainText('https://current.example');
      releaseOld();
      await expect(dialog.getByTestId('discovered-metadata')).not.toContainText('old.example');
      await dialog.getByLabel('Client ID',{exact:true}).fill('custom-client');
      await dialog.getByLabel('Client secret',{exact:true}).fill('custom-secret');
      await dialog.getByText('高级设置',{exact:true}).click();
      await dialog.getByLabel('Scopes（空格分隔）',{exact:true}).fill('profile email');await expect(save).toBeDisabled();
      await dialog.getByLabel('Scopes（空格分隔）',{exact:true}).fill('openid profile email');await expect(save).toBeEnabled();
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://changed.example');await expect(save).toBeDisabled();
      await blur();await expect(dialog.getByTestId('discovered-metadata')).toContainText('https://changed.example');
      await save.click();await expect(dialog).toHaveCount(0);
      expect(writes.at(-1).configuration).toEqual({mode:'issuer',issuer:'https://changed.example'});
      expect(writes.at(-1).scopes).toEqual(['openid','profile','email']);
      await open();
      await dialog.getByRole('combobox',{name:'配置方式',exact:true}).selectOption('discovery');
      await dialog.getByLabel('Discovery URL',{exact:true}).fill('https://metadata.example/document');await blur();
      await expect(dialog.getByTestId('discovered-metadata')).toContainText('https://discovered.example');
      await dialog.getByLabel('Client ID',{exact:true}).fill('discovery-client');await dialog.getByLabel('Client secret',{exact:true}).fill('discovery-secret');
      await page.screenshot({path:`${evidence}/discovery-desktop.png`,fullPage:true});
      await page.setViewportSize({width:390,height:1000});await expectVerticalFields(dialog);
      await page.screenshot({path:`${evidence}/discovery-mobile.png`,fullPage:true});
      await expect(save).toBeInViewport();await page.setViewportSize({width:1440,height:1000});
      await save.click();await expect(dialog).toHaveCount(0);
      expect(writes.at(-1).configuration).toEqual({mode:'discovery',issuer:'https://discovered.example',discoveryUrl:'https://metadata.example/document'});
      await open();await dialog.getByRole('combobox',{name:'配置方式',exact:true}).selectOption('manual');
      await expect(dialog.getByTestId('discovered-metadata')).toHaveCount(0);
      for(const [field,url] of [['Issuer URL','https://manual.example'],['授权端点','https://manual.example/authorize'],['令牌端点','https://manual.example/token'],['JWKS URL','https://manual.example/jwks']])await dialog.getByLabel(field!,{exact:true}).fill(url!);
      await dialog.getByLabel('Client ID',{exact:true}).fill('manual-client');await dialog.getByLabel('Client secret',{exact:true}).fill('manual-secret');
      await expect(dialog.getByRole('combobox',{name:'客户端认证方式',exact:true})).toHaveValue('client_secret_basic');
      await expect(dialog.getByRole('combobox',{name:'ID Token 签名算法',exact:true})).toHaveValue('RS256');
      await expect(dialog.getByRole('combobox',{name:'ID Token 签名算法',exact:true}).locator('option')).toHaveText(['RS256','PS256','ES256']);
      await dialog.getByRole('combobox',{name:'ID Token 签名算法',exact:true}).selectOption('ES256');
      await save.click();await expect(dialog).toHaveCount(0);
      expect(writes.at(-1).configuration).toEqual({mode:'manual',issuer:'https://manual.example',authorizationEndpoint:'https://manual.example/authorize',tokenEndpoint:'https://manual.example/token',jwksUri:'https://manual.example/jwks',tokenEndpointAuthMethod:'client_secret_basic',idTokenSigningAlg:'ES256'});
      await open();await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://mode.example');await blur();
      await expect.poll(()=>discoveryBodies.some(body=>body.url==='https://mode.example')).toBe(true);
      await dialog.getByRole('combobox',{name:'配置方式',exact:true}).selectOption('manual');releaseMode();
      await expect(dialog.getByTestId('discovered-metadata')).toHaveCount(0);
      await expect(dialog.getByLabel('授权端点',{exact:true})).toHaveValue('');
      await expect(save).toBeDisabled();
      await dialog.getByRole('combobox',{name:'配置方式',exact:true}).selectOption('issuer');
      await dialog.getByLabel('Issuer URL',{exact:true}).fill('https://closing.example');await blur();
      await expect.poll(()=>discoveryBodies.some(body=>body.url==='https://closing.example')).toBe(true);
      await page.keyboard.press('Escape');await open();releaseClosing();
      await expect(dialog.getByTestId('discovered-metadata')).toHaveCount(0);
      await expect(dialog.getByLabel('Issuer URL',{exact:true})).toHaveValue('');
      await page.keyboard.press('Escape');expect(errors).toEqual([]);
    } finally {releaseOld();releaseMode();releaseClosing();await context.close();}
  } finally {try{await browser.close();}finally{await runtime.close();}}
},90_000);

test('login settings overview and single-column dialogs isolate drafts, handle failed saves and preserve saved summaries', async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  await mkdir(evidence, {recursive: true});
  let finishSave = () => {};
  try {
    const context = await browser.newContext({viewport: {width: 1306, height: 820}, locale: 'zh-CN'});
    try {
      await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
      const page = await context.newPage(), errors: string[] = [], writes: {path: string; body: any}[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) errors.push(message.text()); });
      page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ERR_ABORTED')) errors.push(request.url()); });
      const config = configurationRuntimeFixture(publicationFixture({operation: null, recovery: null, retryable: false, serving_complete: true, serving_revision: 1, target_revision: 1}));
      let turn = {version: 1, enabled: false, siteKey: 'saved-site', hostnames: ['public.example'], hasSecret: true};
      let session = {version: 1, policy: {idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480}};
      let failTurn = false, conflictTurn = false, conflictSession = false;
      let pendingSave: Promise<void> | undefined;
      await mockApplication(page, async (path, method, body) => {
        if (path === '/api/config/runtime') return config;
        if (path === control + '/login-settings') return {version: 1, autoCreateUsers: true};
        if (path === control + '/login-connections') return {connections: [
          {id: 'google', label: 'Google 工作账号', provider: 'google', configuration: {}, clientId: '589473928475-abcdef.apps.googleusercontent.com', enabled: true, issuer: 'https://accounts.google.com', scopes: ['openid','profile','email'], hasSecret: true, version: 1},
          {id: 'microsoft', label: 'Microsoft 企业账号', provider: 'microsoft', configuration: {accountType: 'organizations'}, clientId: '7f8e9d0a-1b2c-4d3e-9f00-123456789abc', enabled: true, issuer: 'https://login.microsoftonline.com/organizations/v2.0', scopes: ['openid','profile','email'], hasSecret: true, version: 1},
        ]};
        if (path === control + '/turnstile') {
          if (method === 'PUT') {
            writes.push({path, body});
            if (failTurn) { failTurn = false; return {fixtureError: 'turnstile_incomplete'}; }
            if (conflictTurn) { conflictTurn = false; turn = {...turn, version: turn.version + 1, siteKey: 'updated-elsewhere'}; return {fixtureError: 'version_conflict'}; }
            await pendingSave;
            turn = {version: turn.version + 1, enabled: body.enabled, siteKey: body.siteKey, hostnames: body.hostnames, hasSecret: true};
          }
          return turn;
        }
        if (path === control + '/session-policy') {
          if (method === 'PUT') {
            writes.push({path, body});
            if (conflictSession) { conflictSession = false; session = {version: 2, policy: {idleTimeoutMinutes: 45, absoluteTimeoutMinutes: 480}}; return {fixtureError: 'version_conflict'}; }
            await pendingSave; session = {version: session.version + 1, policy: body.policy};
          }
          return session;
        }
      });
      await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
      const turnSection = page.getByRole('region', {name: 'Turnstile 人机验证', exact: true});
      const sessionSection = page.getByRole('region', {name: '登录会话', exact: true});
      const summary = page.getByTestId('session-policy-summary');
      const turnStatus = turnSection.getByRole('status');
      const configure = turnSection.getByRole('button', {name: '配置', exact: true});
      const edit = sessionSection.getByRole('button', {name: '编辑', exact: true});
      const turnDialog = page.getByRole('dialog', {name: 'Turnstile 人机验证', exact: true});
      const sessionDialog = page.getByRole('dialog', {name: '登录会话', exact: true});
      await expect(turnStatus).toHaveText('已配置，未启用');
      await expect(summary).toHaveText('空闲超时 30 分钟 · 登录最长有效期 8 小时');
      await expect(page.getByRole('form')).toHaveCount(0);
      await expect(page.getByRole('tablist')).toHaveCount(0);
      await expect(edit).toBeInViewport();
      await page.screenshot({path: `${evidence}/settings-overview-desktop.png`, animations: 'disabled'});
      for (const width of [320, 390, 768]) {
        await page.setViewportSize({width, height: 820});
        await expect.poll(() => page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
        if (width === 390) await page.screenshot({path: `${evidence}/settings-overview-mobile.png`, fullPage: true, animations: 'disabled'});
      }
      await page.setViewportSize({width: 1306, height: 820});
      await configure.click();
      await turnDialog.getByRole('switch').click();
      await turnDialog.getByLabel('Site key', {exact: true}).fill('discarded-site');
      await turnDialog.getByLabel('Turnstile secret', {exact: true}).fill('discarded-secret');
      await turnDialog.getByRole('button', {name: '取消', exact: true}).click();
      await expect(turnDialog).toHaveCount(0); await expect(configure).toBeFocused();
      expect(writes).toHaveLength(0);
      await expect(turnStatus).toHaveText('已配置，未启用');
      await configure.click();
      await expect(turnDialog.getByLabel('Site key', {exact: true})).toHaveValue('saved-site');
      await expect(turnDialog.getByLabel('Turnstile secret', {exact: true})).toHaveValue('');
      await expect(turnDialog.getByRole('switch')).not.toBeChecked();
      await turnDialog.getByRole('switch').click();
      await turnDialog.getByLabel('Site key', {exact: true}).fill('new-site');
      await turnDialog.getByLabel('Turnstile secret', {exact: true}).fill('new-secret');
      failTurn = true;
      await turnDialog.getByRole('button', {name: '保存并启用', exact: true}).click();
      await expect(turnDialog.getByRole('alert')).toBeVisible();
      await expect(turnDialog.getByLabel('Site key', {exact: true})).toHaveValue('new-site');
      await expect(turnDialog.getByLabel('Turnstile secret', {exact: true})).toHaveValue('new-secret');
      expect(turn.enabled).toBe(false);
      pendingSave = new Promise(resolve => {finishSave = resolve;});
      await turnDialog.getByRole('button', {name: '保存并启用', exact: true}).click();
      await expect(turnDialog.getByRole('button', {name: '保存并启用', exact: true})).toBeDisabled();
      await expect(turnDialog.getByRole('button', {name: '关闭', exact: true})).toBeDisabled();
      await page.keyboard.press('Escape'); await page.mouse.click(2, 2); await expect(turnDialog).toBeVisible();
      await turnDialog.getByRole('form').evaluate(element => (element as HTMLFormElement).requestSubmit());
      expect(writes).toHaveLength(2);
      finishSave(); pendingSave = undefined;
      await expect(turnDialog).toHaveCount(0); await expect(configure).toBeFocused(); await expect(turnStatus).toHaveText('已启用');
      expect(writes.at(-1)).toEqual({path: control + '/turnstile', body: {version: 1, enabled: true, siteKey: 'new-site', hostnames: ['public.example'], secret: 'new-secret'}});
      await configure.click();
      await expect(turnDialog.getByLabel('Turnstile secret', {exact: true})).toHaveValue('');
      conflictTurn = true;
      await turnDialog.getByLabel('Site key', {exact: true}).fill('stale-site');
      await turnDialog.getByRole('button', {name: '保存配置', exact: true}).click();
      await expect(turnDialog.getByRole('alert')).toContainText('已重新读取');
      await expect(turnDialog.getByLabel('Site key', {exact: true})).toHaveValue('updated-elsewhere');
      await expect(turnDialog.getByRole('switch')).toBeFocused();
      await page.keyboard.press('Escape');
      await edit.click();
      await sessionDialog.locator('#session-idleTimeoutMinutes').fill('99');
      await sessionDialog.getByRole('button', {name: '取消', exact: true}).click();
      await expect(edit).toBeFocused();
      await expect(summary).toContainText('30 分钟');
      await edit.click();
      await expect(sessionDialog.locator('#session-idleTimeoutMinutes')).toHaveValue('30');
      await expect(sessionDialog.getByRole('button', {name: '保存会话设置', exact: true})).toBeDisabled();
      await sessionDialog.locator('#session-idleTimeoutMinutes').fill('50');
      conflictSession = true;
      await sessionDialog.getByRole('button', {name: '保存会话设置', exact: true}).click();
      await expect(sessionDialog.getByRole('alert')).toContainText('重新读取');
      await expect(sessionDialog.locator('#session-idleTimeoutMinutes')).toHaveValue('50');
      await sessionDialog.getByRole('button', {name: '重新读取', exact: true}).click();
      await expect(sessionDialog.locator('#session-idleTimeoutMinutes')).toHaveValue('45');
      await sessionDialog.locator('#session-idleTimeoutMinutes').fill('0');
      await sessionDialog.locator('#session-absoluteTimeoutMinutes').fill('1');
      pendingSave = new Promise(resolve => {finishSave = resolve;});
      await sessionDialog.getByRole('button', {name: '保存会话设置', exact: true}).click();
      await expect(sessionDialog.getByRole('button', {name: '正在保存…', exact: true})).toBeDisabled();
      await page.keyboard.press('Escape'); await expect(sessionDialog).toBeVisible();
      await sessionDialog.getByTestId('session-policy-form').evaluate(element => (element as HTMLFormElement).requestSubmit());
      expect(writes.filter(write => write.path.endsWith('/session-policy'))).toHaveLength(2);
      finishSave(); pendingSave = undefined;
      await expect(sessionDialog).toHaveCount(0);
      await expect(edit).toBeFocused();
      await expect(summary).toHaveText('空闲超时 不限制 · 登录最长有效期 1 小时');
      expect(writes.at(-1)).toEqual({path: control + '/session-policy', body: {version: 2, policy: {idleTimeoutMinutes: 0, absoluteTimeoutMinutes: 60}}});
      await page.reload();
      await expect(summary).toHaveText('空闲超时 不限制 · 登录最长有效期 1 小时');
      for (const width of [1306, 390, 320]) {
        await page.setViewportSize({width, height: 820});
        await configure.click(); await expectVerticalFields(turnDialog);
        await expect(turnDialog.getByRole('button', {name: '保存配置', exact: true})).toBeInViewport();
        await page.screenshot({path: `${evidence}/turnstile-dialog-${width}.png`, fullPage: true, animations: 'disabled'});
        await page.keyboard.press('Escape');
        await edit.click(); await expectVerticalFields(sessionDialog);
        for (const unit of await sessionDialog.getByRole('combobox').all()) {
          await expect.poll(() => unit.evaluate(element => {
            const label = element.querySelector('[data-select-value]');
            return !!label && label.scrollWidth <= label.clientWidth;
          })).toBe(true);
        }
        await sessionDialog.getByRole('combobox', {name: '空闲超时 · 时长单位', exact: true}).click();
        await expect(page.getByRole('option', {name: '天', exact: true})).toBeInViewport();
        await page.getByRole('option', {name: '天', exact: true}).click();
        await expect(sessionDialog.getByRole('button', {name: '保存会话设置', exact: true})).toBeInViewport();
        await page.screenshot({path: `${evidence}/session-dialog-${width}.png`, fullPage: true, animations: 'disabled'});
        await page.keyboard.press('Escape');
      }
      expect(errors).toEqual([]);
    } finally {finishSave(); await context.close();}
  } finally {try {await browser.close();} finally {await runtime.close();}}
}, 90_000);

for (const resource of ['turnstile', 'session-policy'] as const) test(`${resource} summary never reports defaults when its settings read fails`, async () => {
  const runtime = await startUiRuntime({mode: 'built-page'}), browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext({locale: 'zh-CN'});
    try {
      await context.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
      const page = await context.newPage(); let unavailable = true;
      await mockApplication(page, (path) => {
        if (path === control + '/login-settings') return {version: 1, autoCreateUsers: false};
        if (path === control + '/login-connections') return {connections: []};
        if (path === control + '/turnstile') return resource === 'turnstile' && unavailable ? {fixtureError: 'unavailable'} : {version: 1, enabled: true, siteKey: 'site', hostnames: ['public.example'], hasSecret: true};
        if (path === control + '/session-policy') return resource === 'session-policy' && unavailable ? {fixtureError: 'unavailable'} : {version: 1, policy: {idleTimeoutMinutes: 15, absoluteTimeoutMinutes: 120}};
      });
      await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
      const section = page.getByRole('region', {name: resource === 'turnstile' ? 'Turnstile 人机验证' : '登录会话', exact: true});
      await expect(section.getByRole('alert')).toBeVisible();
      await expect(section.getByRole('button', {name: resource === 'turnstile' ? '配置' : '编辑', exact: true})).toBeDisabled();
      await expect(section.getByRole('status')).toHaveCount(0);
      await expect(section.getByTestId('session-policy-summary')).toHaveCount(0);
      unavailable = false;
      await section.getByRole('button', {name: '重新读取', exact: true}).click();
      await expect(section.getByRole('alert')).toHaveCount(0);
      await expect(section.getByRole('button', {name: resource === 'turnstile' ? '配置' : '编辑', exact: true})).toBeEnabled();
      if (resource === 'turnstile') await expect(section.getByRole('status')).toHaveText('已启用');
      else await expect(section.getByTestId('session-policy-summary')).toContainText('15 分钟');
    } finally {await context.close();}
  } finally {try {await browser.close();} finally {await runtime.close();}}
}, 30_000);


test('GitHub binding reports actionable provider errors and callback configuration never falls back to the request origin', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  try {
    for (const code of ['management_origin_required', 'oidc_network_failed'] as const) {
      const context = await browser.newContext({viewport:{width:1306,height:820},locale:'zh-CN'});
      try {
        await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), errors:string[]=[], starts:unknown[]=[];
        page.on('pageerror', error => errors.push(error.message));
        await mockApplication(page, (path, method, body) => {
          if(path===control+'/login-connections') return {publicOrigin:null,connections:[{id:'github', label:'GitHub team', provider:'github', configuration:{}, enabled:true, clientId:'client', scopes:['read:user'], hasSecret:true, version:1}]};
          if(path===control+'/identities?userId=admin') return {identities:[]};
          if(path===control+'/identities/link/start') {expect(method).toBe('POST'); starts.push(body); return {fixtureError:code,fixtureStatus:503};}
          if(path===control+'/login-settings') return {version:1,autoCreateUsers:false};
          if(path===control+'/turnstile') return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
        });
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
        await page.getByRole('button',{name:'绑定 GitHub team',exact:true}).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('alert')).toContainText(code==='management_origin_required'?'BUNGEE_PUBLIC_ORIGIN':'无法连接');
        await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
        expect(starts).toEqual([{connectionId:'github'}]);
        await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
        await page.getByRole('button',{name:'添加连接',exact:true}).click();
        const editor = page.getByRole('dialog');
        await expect(editor.getByTestId('login-callback')).toHaveValue('');
        await expect(editor.getByRole('alert')).toContainText('BUNGEE_PUBLIC_ORIGIN');
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally {try{await browser.close();}finally{await runtime.close();}}
},60_000);


test('GitHub callback errors explain the failed step without exposing provider responses', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  try {
    for (const [code, message] of [
      ['oauth_client_rejected', 'Client ID 和 Client Secret'],
      ['oauth_callback_mismatch', '回调地址不匹配'],
      ['oauth_code_rejected', '授权码无效或已过期'],
      ['oauth_email_unverified', '验证主邮箱'],
      ['oauth_token_failed', '未能验证 GitHub 授权响应'],
    ]) {
      const context = await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
      try {
        await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), errors:string[]=[];
        page.on('pageerror',error=>errors.push(error.message));
        await mockApplication(page, ()=>undefined, false);
        await page.goto(`${runtime.origin}/#/login?oidcError=${code}`);
        await expect(page.getByRole('alert')).toContainText(message!);
        await expect(page.getByRole('form',{name:'账号登录',exact:true})).toBeVisible();
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally {try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('profile binding rows identify providers and custom OIDC connections and start verification directly without offering another identity', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  try {
    for (const width of [1301,390,320]) {
      const context = await browser.newContext({viewport:{width,height:820},locale:'zh-CN'});
      let releaseStart = () => {};
      try {
        await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), errors:string[]=[], starts:unknown[]=[], csrf:string[]=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
        page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
        page.on('request',request=>{if(new URL(request.url()).pathname===control+'/identities/link/start')csrf.push(request.headers()['x-csrf-token'] ?? '');});
        const response = new Promise<void>(resolve=>{releaseStart=resolve;});
        await mockApplication(page,async(path,method,body)=>{
          if(path==='/api/config/runtime')return configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1}));
          if(path===control+'/login-connections') return {connections:[
            {id:'github',label:'GitHub',provider:'github',enabled:true,issuer:'https://github.com'},
            {id:'google',label:'Google 工作账号',provider:'google',enabled:true,issuer:'https://accounts.google.com'},
            {id:'custom',label:'公司统一认证',provider:'oidc',enabled:true,issuer:'https://login.company.example'},
            {id:'custom-other',label:'合作伙伴',provider:'oidc',enabled:true,issuer:'https://login.partner.example'},
            {id:'hidden',label:'尚未启用的连接',provider:'oidc',enabled:false,issuer:'https://disabled.example'},
            {id:'disabled-bound',label:'停用的工作账号',provider:'microsoft',enabled:false,issuer:'https://login.microsoftonline.com'},
          ]};
          if(path===control+'/identities?userId=admin') return {identities:[
            {id:'github-id',userId:'admin',connectionId:'github',issuer:'https://github.com',subject:'18018352'},
            {id:'disabled-id',userId:'admin',connectionId:'disabled-bound',issuer:'https://login.microsoftonline.com',subject:'existing-subject'},
            ...(width===320?[{id:'another-bound-id',userId:'admin',connectionId:'github',issuer:'https://github.com',subject:'another-existing-subject'}]:[]),
            ...(width===320?[{id:'unmatched-id',userId:'admin',connectionId:'unavailable-connection',issuer:'https://unavailable.example',subject:'unmatched-subject'}]:[]),
          ]};
          if(path===control+'/identities/link/start') {expect(method).toBe('POST');starts.push(body);await response;return {authorizationUrl:'https://login.partner.example/authorize',flowId:'flow'};}
        });
        await page.route('https://login.partner.example/**',route=>route.fulfill({contentType:'text/html',body:'Provider verification'}));
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
        const section = page.getByTestId('identity-bindings'), github = section.locator('[data-connection-id="github"]');
        await expect(section).toContainText('公司统一认证');
        await expect(section).toContainText('合作伙伴');
        await expect(section).toContainText('自定义 OIDC');
        await expect(github.getByRole('heading',{name:'GitHub',exact:true})).toBeVisible();
        await expect(github).toContainText('身份 ID');
        await expect(github).toContainText('18018352');
        await expect(github).toContainText('已绑定');
        await expect(github.getByRole('button',{name:/^绑定 /})).toHaveCount(0);
        await expect(github.getByRole('button',{name:/^解除绑定 /})).toHaveCount(width===320?2:1);
        if(width===320)await expect(section.getByRole('button',{name:'解除绑定 unmatched-subject',exact:true})).toBeEnabled();
        await expect(section).not.toContainText('绑定另一个账号');
        await expect(section).not.toContainText('https://github.com');
        await expect(section).not.toContainText('尚未启用的连接');
        const disabled = section.locator('[data-connection-id="disabled-bound"]');
        await expect(disabled).toContainText('停用');
        await expect(disabled.getByRole('button',{name:/^解除绑定 /})).toBeEnabled();
        await expect(disabled.getByRole('button',{name:/^绑定 /})).toHaveCount(0);
        await expect(section.getByRole('combobox')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await section.scrollIntoViewIfNeeded();
        const bind = section.getByRole('button',{name:'绑定 合作伙伴',exact:true});
        await page.evaluate(()=>scrollTo(0,0));
        await page.screenshot({path:`${evidence}/bindings-${width}.png`,fullPage:true});
        await bind.focus();await bind.hover();
        await section.screenshot({path:`${evidence}/bindings-section-${width}.png`});
        expect(await page.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
        expect(await section.locator('img').evaluateAll(elements=>elements.every(image=>(image as HTMLImageElement).complete&&(image as HTMLImageElement).naturalWidth>0))).toBe(true);
        await bind.press('Enter');
        await expect.poll(()=>starts.length).toBe(1);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(bind).toBeDisabled();
        await expect(section.getByRole('button',{name:'绑定 Google 工作账号',exact:true})).toBeDisabled();
        expect(starts).toEqual([{connectionId:'custom-other'}]);expect(csrf).toEqual(['csrf']);
        releaseStart();
        await expect(page).toHaveURL('https://login.partner.example/authorize');
        expect(errors).toEqual([]);
      } finally {releaseStart();await context.close();}
    }
  } finally {try{await browser.close();}finally{await runtime.close();}}
},90_000);

test('unlink confirmation preserves identities on cancel and failure and revokes the current session only after confirmed success', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  let releaseDelete = () => {};
  try {
    const context = await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page = await context.newPage(), writes:unknown[]=[], errors:string[]=[];
      let subject = '18018352';
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('503 (Service Unavailable)'))errors.push(message.text());});
      page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
      const response = new Promise<void>(resolve=>{releaseDelete=resolve;});
      await mockApplication(page,async(path,method,body)=>{
        if(path==='/api/config/runtime')return configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1}));
        if(path===control+'/login-connections') return {connections:[{id:'github',label:'GitHub',provider:'github',enabled:true,issuer:'https://github.com'}]};
        if(path===control+'/identities?userId=admin') return {identities:[{id:'bound',userId:'admin',connectionId:'github',issuer:'https://github.com',subject}]};
        if(path===control+'/identities') {
          expect(method).toBe('DELETE');writes.push(body);
          if(writes.length===1)return {fixtureError:'provider_unavailable',fixtureStatus:503};
          await response;return {ok:true};
        }
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const unbind = page.getByRole('button',{name:'解除绑定 GitHub 18018352',exact:true});
      const dialog = page.getByRole('dialog',{name:'解除第三方账号绑定',exact:true});
      await unbind.click();await expect(dialog).toContainText('18018352');
      await expect(dialog).toContainText('所有会话');
      await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
      await expect(unbind).toBeFocused();expect(writes).toEqual([]);
      await unbind.click();await dialog.getByRole('button',{name:'解除绑定',exact:true}).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
      await expect(page.getByTestId('identity-bindings')).toContainText('18018352');
      await expect(page.getByTestId('identity-bindings').getByRole('button',{name:/^绑定 /})).toHaveCount(0);
      for(const width of [1301,390]) {
        await page.setViewportSize({width,height:820});
        await dialog.evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});
        await expect.poll(()=>dialog.evaluate(element=>{const b=element.getBoundingClientRect();return b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})).toBe(true);
        await page.screenshot({path:`${evidence}/unbind-${width}.png`});
      }
      await dialog.getByRole('button',{name:'取消',exact:true}).press('Escape');await expect(dialog).toHaveCount(0);
      subject = 'subject-'.repeat(64);
      await page.setViewportSize({width:320,height:480});await page.reload();
      await page.getByTestId('identity-bindings').getByRole('button',{name:/^解除绑定 GitHub /}).click();
      await dialog.evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});
      await expect.poll(()=>dialog.locator('[data-dialog-body]').evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
      const confirm = dialog.getByRole('button',{name:'解除绑定',exact:true});
      await expect(confirm).toBeInViewport();
      expect(await page.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
      await page.screenshot({path:`${evidence}/unbind-long-320.png`});
      await confirm.click();await expect(confirm).toBeDisabled();
      await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeDisabled();
      await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
      expect(writes).toEqual([{id:'bound'},{id:'bound'}]);
      releaseDelete();await expect(page.getByTestId('page-login')).toBeVisible();
      expect(errors).toEqual([]);
    }finally{releaseDelete();await context.close();}
  }finally{try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('profile only links configured sign-in methods while custom OIDC configuration stays in plugin settings', async () => {
  const runtime = await startUiRuntime({mode:'built-page'}), browser = await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({viewport:{width:390,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[];
      let state:'empty'|'disabled'|'enabled'='empty';
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
      await mockApplication(page,path=>{
        if(path===control+'/login-connections')return {connections:state==='empty'?[]:[{id:'custom',label:'公司统一认证',provider:'oidc',enabled:state==='enabled',issuer:'https://login.company.example',clientId:'client',configuration:{mode:'issuer',issuer:'https://login.company.example'},scopes:['openid'],hasSecret:true,version:1}]};
        if(path===control+'/identities?userId=admin')return {identities:[]};
        if(path===control+'/login-settings')return {version:1,autoCreateUsers:false};
        if(path===control+'/turnstile')return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const section=page.getByTestId('identity-bindings');
      for(const current of ['empty','disabled','enabled'] as const) {
        state=current;await page.reload();
        if(current==='enabled') {
          await expect(section).toContainText('公司统一认证');
          await expect(section.getByRole('button',{name:'绑定 公司统一认证',exact:true})).toBeEnabled();
        } else {
          await expect(section).toContainText('暂无可绑定的登录方式');
          await expect(section).not.toContainText('自定义 OIDC');
          await expect(section.getByRole('button',{name:/^绑定 /})).toHaveCount(0);
        }
        await expect(section.getByRole('link')).toHaveCount(0);
        await expect(section.getByRole('form')).toHaveCount(0);
        await expect(section.getByRole('button',{name:/配置|添加/})).toHaveCount(0);
      }
      await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
      await expect(page.getByTestId('auth-login-management')).toBeVisible();
      await page.getByRole('button',{name:'添加连接',exact:true}).click();
      const editor=page.getByRole('dialog');
      await editor.getByRole('button',{name:'自定义 OIDC',exact:true}).click();
      await expect(editor.getByLabel('Issuer URL',{exact:true})).toBeVisible();
      expect(errors).toEqual([]);
    }finally{await context.close();}
  }finally{try{await browser.close();}finally{await runtime.close();}}
},30_000);

test('merged account summary follows the selected layout, wraps long details and preserves password-less and unavailable states', async () => {
  const runtime=await startUiRuntime({mode:'built-page'}),browser=await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  try {
    const context=await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[];
      let user={...administrator,displayName:'admin'},unavailable=false;
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('503 (Service Unavailable)'))errors.push(message.text());});
      page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
      await mockApplication(page,path=>{
        if(path==='/api/config/runtime')return configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1}));
        if(path===control+'/self')return unavailable?{fixtureError:'provider_unavailable',fixtureStatus:503}:{administrator:user};
        if(path===control+'/login-connections')return {connections:[{id:'github',label:'GitHub',provider:'github',enabled:true,issuer:'https://github.com'}]};
        if(path===control+'/identities?userId=admin')return {identities:[{id:'github-id',userId:'admin',connectionId:'github',issuer:'https://github.com',subject:'18018352'}]};
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const profile=page.getByTestId('auth-user-profile'),summary=page.getByTestId('account-summary');
      const details=summary.getByTestId('account-details'),actions=summary.getByTestId('account-actions');
      await expect(profile.locator('article')).toHaveCount(2);
      await expect(profile.getByText('修改登录密码',{exact:true})).toHaveCount(0);
      await expect(summary).toContainText('有本地密码');
      await expect(summary.locator('dd').first()).toHaveText('admin');
      await expect(summary.locator('dd').nth(1)).toHaveText('admin');
      await expect(profile.getByTestId('identity-bindings')).toContainText('18018352');
      for(const width of [1301,390,320]) {
        await page.setViewportSize({width,height:820});
        await expect.poll(async()=>{
          const account=await details.boundingBox(),buttons=await actions.boundingBox();
          return !!account&&!!buttons&&(width>=640?buttons.x>=account.x+account.width:buttons.y>=account.y+account.height);
        }).toBe(true);
        const bounds=await actions.locator('button').evaluateAll(elements=>elements.map(element=>{const b=element.getBoundingClientRect();return {x:b.x,width:b.width,height:b.height};}));
        expect(bounds).toHaveLength(2);expect(bounds[0]!.width).toBe(bounds[1]!.width);
        expect(bounds.every(bound=>bound.height===34)).toBe(true);
        if(width>=640)expect((await profile.locator('article').first().boundingBox())!.height).toBeLessThan(220);
        expect(await page.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
        await actions.getByRole('button',{name:'修改密码',exact:true}).focus();
        await actions.getByRole('button',{name:'修改密码',exact:true}).hover();
        await page.screenshot({path:`${evidence}/account-summary-${width}.png`,fullPage:true});
        await profile.locator('article').first().screenshot({path:`${evidence}/account-panel-${width}.png`});
      }
      user={...user,username:'a'.repeat(64),displayName:'无间断的很长显示名称'.repeat(12)};
      await page.reload();await expect(summary.locator('dd').first()).toHaveText(user.username);
      await expect(summary.locator('dd').nth(1)).toHaveText(user.displayName);
      expect(await page.locator('main').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
      user={...user,username:'admin',displayName:'',hasLocalPassword:false};
      await page.reload();await expect(summary).toContainText('尚未设置本地密码');
      await expect(summary.locator('dd').nth(1)).toHaveText('admin');
      await expect(summary.getByRole('button',{name:'修改密码',exact:true})).toHaveCount(0);
      await expect(summary.getByRole('button',{name:'退出当前会话',exact:true})).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      unavailable=true;await page.reload();await expect(profile.getByRole('alert')).toBeVisible();
      await expect(summary.getByTestId('account-actions')).toHaveCount(0);
      expect(errors).toEqual([]);
    }finally{await context.close();}
  }finally{try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('summary password action keeps the existing single-column dialog, current-password verification and successful session revocation', async () => {
  const runtime=await startUiRuntime({mode:'built-page'}),browser=await chromium.launch({headless:true});
  await mkdir(evidence,{recursive:true});
  let releaseChange=()=>{};
  try {
    const context=await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),writes:unknown[]=[],errors:string[]=[],csrf:string[]=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('401 (Unauthorized)'))errors.push(message.text());});
      page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
      page.on('request',request=>{if(new URL(request.url()).pathname===control+'/password')csrf.push(request.headers()['x-csrf-token']??'');});
      const changed=new Promise<void>(resolve=>{releaseChange=resolve;});
      await mockApplication(page,async(path,method,body)=>{
        if(path===control+'/login-connections')return {connections:[]};
        if(path===control+'/identities?userId=admin')return {identities:[]};
        if(path===control+'/password') {
          expect(method).toBe('POST');writes.push(body);
          if(writes.length===1)return {fixtureError:'invalid_credentials',fixtureStatus:401};
          await changed;return {ok:true};
        }
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const summary=page.getByTestId('account-summary'),open=summary.getByRole('button',{name:'修改密码',exact:true});
      const dialog=page.getByRole('dialog',{name:'修改登录密码',exact:true});
      await open.click();await expectVerticalFields(dialog);
      await dialog.getByLabel('当前密码',{exact:true}).fill('discarded password');
      await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(open).toBeFocused();
      expect(writes).toEqual([]);
      await open.click();await expect(dialog.getByLabel('当前密码',{exact:true})).toHaveValue('');
      const fill=async(current:string)=>{
        await dialog.getByLabel('当前密码',{exact:true}).fill(current);
        await dialog.getByLabel('新密码（5–32 个字符）',{exact:true}).fill(' 空 格😀 ');
        await dialog.getByLabel('确认新密码',{exact:true}).fill(' 空 格😀 ');
      };
      await fill('wrong password');await dialog.getByRole('button',{name:'修改并重新登录',exact:true}).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
      for(const input of await dialog.locator('input').all())await expect(input).toHaveValue('');
      expect(writes).toEqual([{currentPassword:'wrong password',password:' 空 格😀 ',passwordConfirmation:' 空 格😀 '}]);
      for(const width of [1301,390]) {
        await page.setViewportSize({width,height:820});
        await dialog.evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});
        await expectVerticalFields(dialog);
        await expect.poll(()=>dialog.evaluate(element=>{const b=element.getBoundingClientRect();return b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;})).toBe(true);
        await page.screenshot({path:`${evidence}/account-password-${width}.png`});
      }
      await fill(' current password ');await dialog.getByRole('button',{name:'修改并重新登录',exact:true}).click();
      await expect(dialog.getByRole('button',{name:'正在更新…',exact:true})).toBeDisabled();
      await expect(dialog.getByRole('button',{name:'关闭',exact:true})).toBeDisabled();
      await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
      await dialog.getByRole('form').evaluate(element=>(element as HTMLFormElement).requestSubmit());
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({currentPassword:' current password ',password:' 空 格😀 ',passwordConfirmation:' 空 格😀 '});
      expect(csrf).toEqual(['csrf','csrf']);
      releaseChange();await expect(page.getByTestId('page-login')).toBeVisible();
      expect(errors).toEqual([]);
    }finally{releaseChange();await context.close();}
  }finally{try{await browser.close();}finally{await runtime.close();}}
},60_000);

test('summary sign-out preserves the page on failure and only clears it after cookie-only verification confirms revocation', async () => {
  const runtime=await startUiRuntime({mode:'built-page'}),browser=await chromium.launch({headless:true});
  let releaseLogout=()=>{};
  try {
    const context=await browser.newContext({viewport:{width:390,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[],csrf:string[]=[];
      let attempts=0,revoked=false;
      page.on('pageerror',error=>errors.push(error.message));
      page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('503 (Service Unavailable)'))errors.push(message.text());});
      page.on('requestfailed',request=>{if(!request.failure()?.errorText.includes('ERR_ABORTED'))errors.push(request.url());});
      page.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/logout')csrf.push(request.headers()['x-csrf-token']??'');});
      const logoutResponse=new Promise<void>(resolve=>{releaseLogout=resolve;});
      await mockApplication(page,async(path,method)=>{
        if(path===control+'/login-connections')return {connections:[]};
        if(path===control+'/identities?userId=admin')return {identities:[]};
        if(path==='/api/auth/verify'&&revoked)return {mode:'plugin',success:false};
        if(path==='/api/auth/logout') {
          expect(method).toBe('POST');attempts++;
          if(attempts===1)return {fixtureError:'provider_unavailable',fixtureStatus:503};
          if(attempts===3){await logoutResponse;revoked=true;}
          return {ok:true};
        }
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const summary=page.getByTestId('account-summary'),leave=summary.getByRole('button',{name:'退出当前会话',exact:true});
      for(let attempt=1;attempt<=2;attempt++) {
        await leave.click();await expect(page.getByRole('alert')).toBeVisible();
        await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
        await expect(summary).toContainText('admin');await expect(leave).toBeEnabled();expect(attempts).toBe(attempt);
      }
      await leave.click();await expect(leave).toBeDisabled();
      await expect(summary.getByRole('button',{name:'修改密码',exact:true})).toBeDisabled();
      expect(attempts).toBe(3);expect(csrf).toEqual(['csrf','csrf','csrf']);
      releaseLogout();await expect(page.getByTestId('page-login')).toBeVisible();
      expect(errors).toEqual([]);
    }finally{releaseLogout();await context.close();}
  }finally{try{await browser.close();}finally{await runtime.close();}}
},45_000);
