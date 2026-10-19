import {test} from 'bun:test';
import {expect} from 'playwright/test';
import {mkdir} from 'node:fs/promises';
import {control, administrator, evidence, expectVerticalFields, mockApplication} from '../helpers/auth/application';
import {createAuthRuntime} from '../helpers/auth/runtime';

const {authRuntime, closeAuthContexts} = createAuthRuntime();

test('Turnstile uses external explicit rendering, retries failed loads and cannot submit without a fresh token', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    const context = await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
    await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
    const page = await context.newPage(), errors: string[] = [], loginBodies: any[] = [];

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
  } finally { await closeAuthContexts(); }
}, 60_000);

test('local login remains available with Turnstile off and rejects submission when login options are unavailable', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    for (const scenario of ['off','unavailable'] as const) {
      const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),bodies:unknown[]=[],errors:string[]=[];let challengeRequests=0,available=scenario==='off';
      page.on('pageerror',error=>errors.push(error.message));

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
  }finally { await closeAuthContexts(); }
},60_000);

test('GitHub callback errors explain the failed step without exposing provider responses', async () => {
  const {runtime, browser} = await authRuntime();
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
  } finally { await closeAuthContexts(); }
},60_000);
