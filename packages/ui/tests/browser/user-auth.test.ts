import {test} from 'bun:test';
import {expect} from 'playwright/test';
import {control, administrator, mockApplication} from '../helpers/auth/application';
import {createAuthRuntime} from '../helpers/auth/runtime';

const {authRuntime, closeAuthContexts} = createAuthRuntime();

test('user management preserves exact DTOs, isolates identities and prevents duplicate creates', async () => {
  const {runtime, browser} = await authRuntime();

  let finishCreate = () => {};
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
    await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
    const page = await context.newPage(), errors: string[] = [], reads: string[] = [], writes: {path:string;body:any}[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let users = [administrator];
    const createResponse = new Promise<void>(resolve => {finishCreate = resolve;});
    await mockApplication(page, async (path, method, body) => {
      if (!path.startsWith(control)) return;
      if (method === 'GET') reads.push(path.slice(control.length));
      else writes.push({path:path.slice(control.length),body});
      if (path === control + '/users') {
        if (method === 'GET') return {users};
        expect(method).toBe('POST');
        expect(Object.keys(body).sort()).toEqual(['displayName','password','passwordConfirmation','username']);
        await createResponse;
        const user = {...administrator,id:'created',username:body.username,displayName:body.displayName}; users.push(user); return {user};
      }
      if (path === control + '/users/update') {
        expect(method).toBe('PUT'); expect(Object.keys(body).sort()).toEqual(['disabled','displayName','id','username']);
        users = users.map(user => user.id === body.id ? {...user,...body} : user); return {user:users.find(user => user.id === body.id)};
      }
      if (path === control + '/users/password') {
        expect(method).toBe('POST'); expect(body).toEqual({id:'created',password:' 新 密码 ',passwordConfirmation:' 新 密码 '}); return {ok:true};
      }
    });
    const userReadOffset = reads.length;
    await page.goto(`${runtime.origin}/#/extensions/user-auth/users`);
    const userPanel = page.getByTestId('auth-users');

    await expect(userPanel.getByRole('form')).toHaveCount(0);
    await userPanel.getByRole('button', {name:'创建用户',exact:true}).click();
    const create = page.getByRole('dialog', {name:'创建用户', exact:true});

    await create.getByLabel('用户密码（5–32 个字符）',{exact:true}).fill('discarded-password');
    await page.keyboard.press('Escape'); await expect(create).toHaveCount(0);

    await userPanel.getByRole('button',{name:'创建用户',exact:true}).click();
    await expect(create.getByLabel('用户密码（5–32 个字符）',{exact:true})).toHaveValue('');
    await create.getByLabel('账号', {exact:true}).fill('new-user'); await create.getByLabel('显示名称').fill('New User'); await create.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill('😀'.repeat(4)); await create.getByLabel('确认用户密码', {exact:true}).fill('😀'.repeat(4)); await create.getByRole('button', {name:'保存', exact:true}).click(); await expect(create.getByRole('alert')).toBeVisible(); expect(writes.filter(write => write.path === '/users')).toHaveLength(0); await create.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill(' 密码 空格 '); await create.getByLabel('确认用户密码', {exact:true}).fill(' 密码 空格 '); await create.getByRole('button', {name:'保存', exact:true}).click();
    await expect(create.getByRole('button', {name:'保存', exact:true})).toBeDisabled();
    await expect(create.getByLabel('账号', {exact:true})).toBeDisabled();
    await expect(create.getByRole('button', {name:'关闭', exact:true})).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(create).toBeVisible();
    await page.mouse.click(4, 4); await expect(create).toBeVisible();
    await create.getByRole('form').evaluate(element => (element as HTMLFormElement).requestSubmit());
    expect(writes.filter(write => write.path === '/users')).toHaveLength(1);
    finishCreate();
    const row = userPanel.getByTestId('auth-user-row').filter({hasText:'new-user'}); await expect(row).toContainText('New User');
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).not.toBeChecked();
    expect(writes.filter(write => write.path === '/users/update').map(write => write.body)).toEqual([
      {id:'created',username:'new-user',displayName:'New User',disabled:true},
    ]);
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toBeChecked();
    expect(writes.filter(write => write.path === '/users/update').map(write => write.body)).toEqual([
      {id:'created',username:'new-user',displayName:'New User',disabled:true},
      {id:'created',username:'new-user',displayName:'New User',disabled:false},
    ]);
    await row.getByRole('button', {name:'编辑', exact:true}).click(); const edit = page.getByRole('dialog', {name:'编辑用户', exact:true}); await edit.getByLabel('显示名称').fill('Edited'); await edit.getByRole('button', {name:'保存', exact:true}).click(); await expect(row).toContainText('Edited');
    await row.getByRole('button', {name:'重设密码', exact:true}).click(); const reset = page.getByRole('dialog', {name:'重设密码', exact:true}); await reset.getByLabel('用户密码（5–32 个字符）', {exact:true}).fill(' 新 密码 '); await reset.getByLabel('确认用户密码', {exact:true}).fill(' 新 密码 '); await reset.getByRole('button', {name:'重设密码', exact:true}).click(); await expect(reset).toHaveCount(0);
    await row.getByRole('button', {name:'编辑', exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveCount(0);

    expect(reads.slice(userReadOffset).some(path => path.startsWith('/identities') || path === '/login-connections')).toBe(false);
    expect(writes.some(write => write.path.startsWith('/identities'))).toBe(false);
    expect(writes.some(write => write.path === '/users' && write.body.password === ' 密码 空格 ')).toBe(true);
    expect(errors).toEqual([]); await context.close();
  } finally { finishCreate(); await closeAuthContexts(); }
}, 90_000);

test('editing users never loads identities and resetting the active user revokes its session', async () => {
  const {runtime, browser} = await authRuntime();
  try {
    for (const scenario of ['edit-no-binding','reset-self'] as const) {
      const context = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});
      try {
        await context.addInitScript(() => localStorage.setItem('locale','zh-CN'));
        const page = await context.newPage(), reads:string[] = [], writes:{path:string;body:unknown}[] = [];
        await mockApplication(page,(path,method,body) => {
          if (!path.startsWith(control)) return;
          if (method === 'GET') reads.push(path); else writes.push({path:path.slice(control.length),body});
          if (path === control + '/users' && method === 'GET') return {users:[administrator]};
          if (path === control + '/users/password' && method === 'POST') return {ok:true};
        });
        await page.goto(`${runtime.origin}/#/extensions/user-auth/users`);
        const users = page.getByTestId('auth-users');
        if (scenario === 'reset-self') {
          await users.getByRole('button',{name:'重设密码',exact:true}).click();
          const form = page.getByRole('dialog',{name:'重设密码',exact:true});
          await form.getByLabel('用户密码（5–32 个字符）',{exact:true}).fill('reset-password');
          await form.getByLabel('确认用户密码',{exact:true}).fill('reset-password');
          await form.getByRole('button',{name:'重设密码',exact:true}).click();
          expect(writes).toEqual([{path:'/users/password',body:{id:'admin',password:'reset-password',passwordConfirmation:'reset-password'}}]);
          await expect(page.getByTestId('page-login')).toBeVisible();
        } else {
          await users.getByRole('button',{name:'编辑',exact:true}).click();
          const dialog = page.getByRole('dialog');
          await expect(dialog.getByRole('combobox')).toHaveCount(0);

          await dialog.getByLabel('账号',{exact:true}).press('Escape');
          await expect(dialog).toHaveCount(0);
          expect(reads).toEqual([control + '/users']); expect(writes).toEqual([]);
        }
      } finally { await context.close(); }
    }
  } finally { await closeAuthContexts(); }
}, 90_000);
