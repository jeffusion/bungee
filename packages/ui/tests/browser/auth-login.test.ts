import {test} from 'bun:test';
import {expect} from 'playwright/test';
import {mockApplication} from '../helpers/auth/application';
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
     await expect(page).toHaveURL(/#\/login\?oidcError=unknown_identity$/);
     await expect(submit).toBeDisabled();
    await form.getByRole('button',{name:'重试验证',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats?.renders)).toBe(1);
    expect(loads).toBe(2);
    expect(await page.evaluate(() => ({sitekey:(window as any).challengeOptions.sitekey, action:(window as any).challengeOptions.action}))).toEqual({sitekey:'test-site',action:'local-login'});
    await form.getByLabel('账号',{exact:true}).fill('admin'); await form.getByLabel('密码',{exact:true}).fill(' test password ');
    await form.evaluate(element => (element as HTMLFormElement).requestSubmit()); expect(loginBodies).toHaveLength(0);
    await page.evaluate(() => (window as any).challengeOptions.callback('first-token')); await expect(submit).toBeEnabled();
    await page.evaluate(() => (window as any).challengeOptions['expired-callback']()); await expect(submit).toBeDisabled();
    await page.evaluate(() => (window as any).challengeOptions.callback('fresh-token')); await submit.click();
     await expect(submit).toBeDisabled();
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.resets)).toBe(2);
    await expect(form.getByRole('alert')).toBeVisible();
    expect(loginBodies).toEqual([{username:'admin',password:' test password ',transport:'cookie',turnstileToken:'fresh-token'}]);
    await page.evaluate(() => (window as any).challengeOptions['error-callback']());
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.resets)).toBe(3);
    await form.getByRole('button',{name:'重试验证',exact:true}).click();
    await expect.poll(() => page.evaluate(() => (window as any).challengeStats.renders)).toBe(2); expect(loads).toBe(2);

    await page.route('https://identity.example/**', route => route.fulfill({contentType:'text/html',body:'Identity provider'}));
    await page.getByRole('button',{name:'Partner SSO · GitHub',exact:true}).click(); await expect(page).toHaveURL('https://identity.example/authorize?state=fixture');
    expect(errors).toEqual([]); await context.close();
  } finally { await closeAuthContexts(); }
}, 60_000);

test('local login remains available without Turnstile, rejects unusable options and recovers from an invalid origin', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    for (const scenario of ['off','unavailable','invalid-origin'] as const) {
      const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),bodies:unknown[]=[],errors:string[]=[];let challengeRequests=0,available=scenario!=='unavailable';
      let loginRequests=0,verifyRequests=0,signedIn=false;
      page.on('pageerror',error=>errors.push(error.message));

      await page.route('https://challenges.cloudflare.com/**',route=>{challengeRequests++;return route.fulfill({body:''});});
      await mockApplication(page,(path,_method,body)=>{
        if(path==='/api/auth/login/options')return available?{local:{enabled:true,turnstile:{enabled:false}},methods:[]} : {};
        if(path==='/api/auth/login'){
          bodies.push(body);loginRequests++;
          if(scenario==='invalid-origin'){
            if(loginRequests===1)return {success:false,error:'invalid_origin'};
            signedIn=true;return {success:true};
          }
          return {success:false,error:'invalid_credentials'};
        }
        if(path==='/api/auth/verify'){verifyRequests++;if(signedIn)return {success:true,mode:'plugin',subject:{id:'admin',provider:'user-auth'},csrfToken:'csrf'};}
      },false);
      await page.goto(`${runtime.origin}/#/login`);
      const form=page.getByRole('form',{name:'账号登录',exact:true}),submit=form.getByRole('button',{name:'登录',exact:true});
      await form.getByLabel('账号',{exact:true}).fill('admin');await form.getByLabel('密码',{exact:true}).fill('local password');
      if(scenario==='unavailable'){
        await expect(form.getByRole('alert')).toBeVisible();await expect(submit).toBeDisabled();
        await form.evaluate(form=>(form as HTMLFormElement).requestSubmit());expect(bodies).toHaveLength(0);
        available=true;await form.getByRole('button',{name:'重新读取',exact:true}).click();
      }
       if(scenario==='invalid-origin'){
         const verificationsBeforeLogin=verifyRequests;
         await submit.click();await expect(form.getByRole('alert')).toBeVisible();
         await expect(page).toHaveURL(/#\/login$/);await expect(form.getByLabel('密码',{exact:true})).toHaveValue('');
         expect(loginRequests).toBe(1);expect(verifyRequests).toBe(verificationsBeforeLogin);
        await expect(form.getByRole('link')).toHaveAttribute('href','https://public.example/#/login');
        await form.getByLabel('密码',{exact:true}).fill('local password');await submit.click();
        await expect(page.getByTestId('page-dashboard')).toBeVisible();
         expect(loginRequests).toBe(2);expect(challengeRequests).toBe(0);expect(errors).toEqual([]);
        await context.close();continue;
      }
      await expect(submit).toBeEnabled();await submit.click();await expect(form.getByRole('alert')).toBeVisible();
      expect(bodies).toEqual([{username:'admin',password:'local password',transport:'cookie'}]);expect(challengeRequests).toBe(0);expect(errors).toEqual([]);
      await context.close();
    }
  }finally { await closeAuthContexts(); }
},60_000);
