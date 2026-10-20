import {test} from 'bun:test';
import {expect} from 'playwright/test';
import {configurationRuntimeFixture, publicationFixture} from '../helpers/publication';
import {control, administrator, mockApplication} from '../helpers/auth/application';
import {createAuthRuntime} from '../helpers/auth/runtime';

const {authRuntime, closeAuthContexts} = createAuthRuntime();

test('authenticated identity linking starts through protected control and finishes once before returning to login', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    for (const scenario of ['start','finish','unsafe-error'] as const) {
      const context = await browser.newContext({viewport:{width:390,height:1000},locale:'zh-CN'});
      await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
      const page = await context.newPage(), calls: string[] = [], errors:string[]=[];

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
        await expect(page.getByRole('alert')).toBeVisible(); expect(await page.locator('img').count()).toBe(0); await expect(page.locator('body')).not.toContainText('<img src=x');
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
  }finally { await closeAuthContexts(); }
},60_000);

test('profile preserves self revocation and recover from profile read or binding completion failures', async () => {
  const {runtime, browser} = await authRuntime();

  try {
    for (const scenario of ['unbind','load-failed','finish-failed','sso-only'] as const) {
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
          if(path===control+'/login-connections') return {connections:[{id:'first',label:'Company',provider:'google',configuration:{},enabled:true,issuer:'https://identity.example',clientId:'client',scopes:['openid'],hasSecret:true,version:1}]};
          if(path===control+'/identities?userId=admin') return {identities:[{id:'bound',userId:'admin',connectionId:'first',issuer:'https://identity.example',subject:'my-sub'}]};
          if(path===control+'/identities/link/finish') return {fixtureError:'invalid_oidc_flow'};
          if(path===control+'/identities') return {ok:true};
        });
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile${scenario==='finish-failed'?'?oidcLink=failed-flow':''}`);
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

        } else if(scenario==='sso-only') {

          await expect(profile.getByRole('form',{name:'修改登录密码',exact:true})).toHaveCount(0);

          await expect(profile.getByRole('button',{name:'绑定 Company',exact:true})).toHaveCount(0);
        } else if(scenario==='unbind') {
          await profile.getByRole('button',{name:'解除绑定 Company my-sub',exact:true}).click();
          const confirmation = page.getByRole('dialog', {name:'解除第三方账号绑定',exact:true});
          await expect(confirmation).toContainText('my-sub');
          expect(writes).toEqual([]);
          await confirmation.getByRole('button',{name:'解除绑定',exact:true}).click();
          await expect(page.getByTestId('page-login')).toBeVisible();
          expect(writes).toEqual([{path:'/identities',body:{id:'bound'}}]);
        }
        expect(reads.some(path=>path===control+'/users')).toBe(false);
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally { await closeAuthContexts(); }
},90_000);

test('GitHub binding reports actionable provider errors and callback configuration never falls back to the request origin', async () => {
  const {runtime, browser} = await authRuntime();
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
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
        expect(starts).toEqual([{connectionId:'github'}]);
        await page.goto(`${runtime.origin}/#/plugins/user-auth/settings`);
        await page.getByRole('button',{name:'添加连接',exact:true}).click();
        const editor = page.getByRole('dialog');
        await expect(editor.getByTestId('login-callback')).toHaveValue('');
        await expect(editor.getByRole('alert')).toBeVisible();
        expect(errors).toEqual([]);
      } finally {await context.close();}
    }
  } finally { await closeAuthContexts(); }
},60_000);

test('profile binding rows identify providers and custom OIDC connections and start verification directly without offering another identity', async () => {
  const {runtime, browser} = await authRuntime();

  try {
    for (const multiple of [false, true]) {
      const context = await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
      let releaseStart = () => {};
      try {
        await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), errors:string[]=[], starts:unknown[]=[], csrf:string[]=[];
        page.on('pageerror',error=>errors.push(error.message));

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
            ...(multiple?[{id:'another-bound-id',userId:'admin',connectionId:'github',issuer:'https://github.com',subject:'another-existing-subject'}]:[]),
            ...(multiple?[{id:'unmatched-id',userId:'admin',connectionId:'unavailable-connection',issuer:'https://unavailable.example',subject:'unmatched-subject'}]:[]),
          ]};
          if(path===control+'/identities/link/start') {expect(method).toBe('POST');starts.push(body);await response;return {authorizationUrl:'https://login.partner.example/authorize',flowId:'flow'};}
        });
        await page.route('https://login.partner.example/**',route=>route.fulfill({contentType:'text/html',body:'Provider verification'}));
        await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
        const section = page.getByTestId('identity-bindings'), github = section.locator('[data-connection-id="github"]');

        await expect(github.getByRole('heading',{name:'GitHub',exact:true})).toBeVisible();

        await expect(github).toContainText('18018352');

        await expect(github.getByRole('button',{name:/^绑定 /})).toHaveCount(0);
        await expect(github.getByRole('button',{name:/^解除绑定 /})).toHaveCount(multiple?2:1);
        if(multiple)await expect(section.getByRole('button',{name:'解除绑定 unmatched-subject',exact:true})).toBeEnabled();

        await expect(section).not.toContainText('https://github.com');

        const disabled = section.locator('[data-connection-id="disabled-bound"]');

        await expect(disabled.getByRole('button',{name:/^解除绑定 /})).toBeEnabled();
        await expect(disabled.getByRole('button',{name:/^绑定 /})).toHaveCount(0);
        await expect(section.getByRole('combobox')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await section.scrollIntoViewIfNeeded();
        const bind = section.getByRole('button',{name:'绑定 合作伙伴',exact:true});
        await page.evaluate(()=>scrollTo(0,0));

        await bind.click();
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
  } finally { await closeAuthContexts(); }
},90_000);

test('unlink confirmation preserves identities on cancel and failure and revokes the current session only after confirmed success', async () => {
  const {runtime, browser} = await authRuntime();

  let releaseDelete = () => {};
  try {
    const context = await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page = await context.newPage(), writes:unknown[]=[], errors:string[]=[];
      let subject = '18018352';
      page.on('pageerror',error=>errors.push(error.message));

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

      await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);
      expect(writes).toEqual([]);
      await unbind.click();await dialog.getByRole('button',{name:'解除绑定',exact:true}).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
      await expect(page.getByTestId('identity-bindings')).toContainText('18018352');
      await expect(page.getByTestId('identity-bindings').getByRole('button',{name:/^绑定 /})).toHaveCount(0);
      await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);
      subject = 'subject-'.repeat(64);
      await page.reload();
      await page.getByTestId('identity-bindings').getByRole('button',{name:/^解除绑定 GitHub /}).click();

      const confirm = dialog.getByRole('button',{name:'解除绑定',exact:true});

      await confirm.click();await expect(confirm).toBeDisabled();
      await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeDisabled();
      await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
      expect(writes).toEqual([{id:'bound'},{id:'bound'}]);
      releaseDelete();await expect(page.getByTestId('page-login')).toBeVisible();
      expect(errors).toEqual([]);
    }finally{releaseDelete();await context.close();}
  }finally { await closeAuthContexts(); }
},60_000);

test('profile only links configured sign-in methods while custom OIDC configuration stays in plugin settings', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    const context=await browser.newContext({viewport:{width:390,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[];
      let state:'empty'|'disabled'|'enabled'='empty';
      const pendingReads = new Set<import('playwright').Request>();
      page.on('request', request => { if (request.method() === 'GET' && request.url().startsWith(runtime.origin)) pendingReads.add(request); });
      page.on('requestfinished', request => pendingReads.delete(request));
      page.on('requestfailed', request => pendingReads.delete(request));
      page.on('pageerror',error=>errors.push(error.message));

      await mockApplication(page,path=>{
        if(path===control+'/login-connections')return {connections:state==='empty'?[]:[{id:'custom',label:'公司统一认证',provider:'oidc',enabled:state==='enabled',issuer:'https://login.company.example',clientId:'client',configuration:{mode:'issuer',issuer:'https://login.company.example'},scopes:['openid'],hasSecret:true,version:1}]};
        if(path===control+'/identities?userId=admin')return {identities:[]};
        if(path===control+'/login-settings')return {version:1,autoCreateUsers:false};
        if(path===control+'/turnstile')return {version:1,enabled:false,siteKey:'',hostnames:[],hasSecret:false};
      });
      const section=page.getByTestId('identity-bindings');
      for(const current of ['empty','disabled','enabled'] as const) {
        state=current;
        if (current === 'empty') await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
        else await page.reload();
        await expect(page.getByTestId('account-details')).toBeVisible();
        await expect.poll(() => pendingReads.size).toBe(0);
        if(current==='enabled') {

          await expect(section.getByRole('button',{name:'绑定 公司统一认证',exact:true})).toBeEnabled();
        } else {

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
  }finally { await closeAuthContexts(); }
},30_000);

test('account summary preserves password-less and unavailable states', async () => {
  const {runtime, browser} = await authRuntime();

  try {
    const context=await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[];
      let user={...administrator,displayName:'admin'},unavailable=false;
      page.on('pageerror',error=>errors.push(error.message));

      await mockApplication(page,path=>{
        if(path==='/api/config/runtime')return configurationRuntimeFixture(publicationFixture({operation:null,recovery:null,retryable:false,serving_complete:true,serving_revision:1,target_revision:1}));
        if(path===control+'/self')return unavailable?{fixtureError:'provider_unavailable',fixtureStatus:503}:{administrator:user};
        if(path===control+'/login-connections')return {connections:[{id:'github',label:'GitHub',provider:'github',enabled:true,issuer:'https://github.com'}]};
        if(path===control+'/identities?userId=admin')return {identities:[{id:'github-id',userId:'admin',connectionId:'github',issuer:'https://github.com',subject:'18018352'}]};
      });
      await page.goto(`${runtime.origin}/#/extensions/user-auth/profile`);
      const profile=page.getByTestId('auth-user-profile'),summary=page.getByTestId('account-summary');
      await expect(profile.getByText('修改登录密码',{exact:true})).toHaveCount(0);

      await expect(summary.locator('dd').first()).toHaveText('admin');
      await expect(summary.locator('dd').nth(1)).toHaveText('admin');
      await expect(profile.getByTestId('identity-bindings')).toContainText('18018352');
      user={...user,username:'a'.repeat(64),displayName:'无间断的很长显示名称'.repeat(12)};
      await page.reload();await expect(summary.locator('dd').first()).toHaveText(user.username);
      await expect(summary.locator('dd').nth(1)).toHaveText(user.displayName);

      user={...user,username:'admin',displayName:'',hasLocalPassword:false};
      await page.reload();
      await expect(summary.locator('dd').nth(1)).toHaveText('admin');
      await expect(summary.getByRole('button',{name:'修改密码',exact:true})).toHaveCount(0);
      await expect(summary.getByRole('button',{name:'退出当前会话',exact:true})).toBeEnabled();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      unavailable=true;await page.reload();await expect(profile.getByRole('alert')).toBeVisible();
      await expect(summary.getByTestId('account-actions')).toHaveCount(0);
      expect(errors).toEqual([]);
    }finally{await context.close();}
  }finally { await closeAuthContexts(); }
},60_000);

test('password changes verify the current password and revoke the session only after success', async () => {
  const {runtime, browser} = await authRuntime();

  let releaseChange=()=>{};
  try {
    const context=await browser.newContext({viewport:{width:1301,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),writes:unknown[]=[],errors:string[]=[],csrf:string[]=[];
      page.on('pageerror',error=>errors.push(error.message));

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
      await open.click();
      await dialog.getByLabel('当前密码',{exact:true}).fill('discarded password');
      await dialog.getByRole('button',{name:'关闭',exact:true}).click();await expect(dialog).toHaveCount(0);
      expect(writes).toEqual([]);
      await open.click();await expect(dialog.getByLabel('当前密码',{exact:true})).toHaveValue('');
      const fill=async(current:string,password=' 空 格😀 ')=>{
        await dialog.getByLabel('当前密码',{exact:true}).fill(current);
        await dialog.getByLabel('新密码（5–32 个字符）',{exact:true}).fill(password);
        await dialog.getByLabel('确认新密码',{exact:true}).fill(password);
      };
      const submit = dialog.getByRole('button',{name:'修改并重新登录',exact:true});
      await dialog.getByLabel('当前密码',{exact:true}).fill('current password');
      for (const invalid of ['x'.repeat(4),'😀'.repeat(4),'x'.repeat(33),'😀'.repeat(33)]) {
        await dialog.getByLabel('新密码（5–32 个字符）',{exact:true}).fill(invalid);
        await dialog.getByLabel('确认新密码',{exact:true}).fill(invalid);
        await submit.click(); await expect(dialog.getByRole('alert')).toBeVisible();
        expect(writes).toEqual([]);
      }
      await fill('wrong password');await dialog.getByRole('button',{name:'修改并重新登录',exact:true}).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(page).toHaveURL(/#\/extensions\/user-auth\/profile$/);
      for(const input of await dialog.locator('input').all())await expect(input).toHaveValue('');
      expect(writes).toEqual([{currentPassword:'wrong password',password:' 空 格😀 ',passwordConfirmation:' 空 格😀 '}]);
      await fill(' current password ', '😀'.repeat(32));await dialog.getByRole('button',{name:'修改并重新登录',exact:true}).click();
      await expect(dialog.getByRole('button',{name:'正在更新…',exact:true})).toBeDisabled();
      await expect(dialog.getByRole('button',{name:'关闭',exact:true})).toBeDisabled();
      await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
      await dialog.getByRole('form').evaluate(element=>(element as HTMLFormElement).requestSubmit());
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({currentPassword:' current password ',password:'😀'.repeat(32),passwordConfirmation:'😀'.repeat(32)});
      expect(csrf).toEqual(['csrf','csrf']);
      releaseChange();await expect(page.getByTestId('page-login')).toBeVisible();
      expect(errors).toEqual([]);
    }finally{releaseChange();await context.close();}
  }finally { await closeAuthContexts(); }
},60_000);

test('summary sign-out preserves the page on failure and only clears it after cookie-only verification confirms revocation', async () => {
  const {runtime, browser} = await authRuntime();
  let releaseLogout=()=>{};
  try {
    const context=await browser.newContext({viewport:{width:390,height:820},locale:'zh-CN'});
    try {
      await context.addInitScript(()=>localStorage.setItem('locale','zh-CN'));
      const page=await context.newPage(),errors:string[]=[],csrf:string[]=[];
      let attempts=0,revoked=false;
      page.on('pageerror',error=>errors.push(error.message));

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
  }finally { await closeAuthContexts(); }
},45_000);
