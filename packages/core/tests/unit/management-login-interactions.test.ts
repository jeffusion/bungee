import {describe,expect,test} from 'bun:test';
import {loginInteractionRequest as request,managementLoginFixture} from '../helpers/management-login';

const START_HEADERS = {origin:'https://dashboard.example','x-bungee-auth-provider':'test-auth'};
const INTERACTIONS = [
  {path:'/api/auth/login/options',method:'GET',handler:'loginOptions'},
  {path:'/api/auth/login/start',method:'POST',handler:'beginLogin'},
  {path:'/api/auth/login/callback/example?code=secret-code&state=secret-state',method:'GET',handler:'completeLogin'},
] as const;

describe('selected management provider login interactions',() => {
  test('options are anonymous and provider Response bodies are not wrapped',async () => {
    const f = managementLoginFixture();
    const response = (await f.api.handle(request('/api/auth/login/options')))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({methods:[{id:'example',type:'redirect'}]});
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await f.api.handle(request('/api/config')))!.status).toBe(401);
  });

  test('start leaves body ownership and this binding to the provider',async () => {
    const f = managementLoginFixture();
    f.provider.beginLogin = async function (incoming) {
      expect(this).toBe(f.provider);
      expect(incoming.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      return new Response(await incoming.text(),{status:202,headers:{'x-provider-result':'preserved'}});
    };
    const response = (await f.api.handle(request('/api/auth/login/start','POST',{
      ...START_HEADERS,'content-type':'application/x-www-form-urlencoded',
    },'method=example&opaque=unchanged%2Bvalue')))!;
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('method=example&opaque=unchanged%2Bvalue');
    expect(response.headers.get('x-provider-result')).toBe('preserved');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('start requires the exact public Origin and a mandatory current-provider pin',async () => {
    const f = managementLoginFixture();
    for (const origin of [undefined,'null','http://localhost','https://dashboard.example/','https://attacker.example']) {
      const headers:Record<string,string> = {'x-bungee-auth-provider':'test-auth','x-forwarded-host':'dashboard.example'};
      if (origin !== undefined) headers.origin = origin;
      const response = (await f.api.handle(request('/api/auth/login/start','POST',headers,'opaque')))!;
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({error:'invalid_origin'});
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const pin of [undefined,'other-auth','test-auth, other-auth','invalid/provider']) {
      const headers:Record<string,string> = {origin:START_HEADERS.origin};
      if (pin !== undefined) headers['x-bungee-auth-provider'] = pin;
      const response = (await f.api.handle(request('/api/auth/login/start','POST',headers,'opaque')))!;
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({error:'authentication_provider_changed'});
    }
    expect(f.calls).toHaveLength(0);
  });

  test('no selected provider means no interaction dispatch and preserves anonymous management',async () => {
    const f = managementLoginFixture(); f.select(null);
    for (const interaction of INTERACTIONS) {
      const response = (await f.api.handle(request(interaction.path,interaction.method,START_HEADERS)))!;
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.calls).toHaveLength(0);
    expect((await f.api.handle(request('/api/config')))!.status).toBe(200);
    expect(await (await f.api.handle(request('/api/auth/login','POST',{},'{}')))!.json())
      .toMatchObject({success:true,mode:'anonymous'});
  });

  test('missing provider capabilities explicitly reject each interaction',async () => {
    const f = managementLoginFixture();
    for (const interaction of INTERACTIONS) {
      delete f.provider[interaction.handler];
      const response = (await f.api.handle(request(interaction.path,interaction.method,START_HEADERS)))!;
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({error:'login_interaction_not_supported'});
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('each fixed route rejects every unsupported HTTP method before dispatch',async () => {
    const f = managementLoginFixture();
    for (const interaction of INTERACTIONS) {
      for (const method of ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']) {
        if (method === interaction.method) continue;
        const response = (await f.api.handle(request(interaction.path,method,START_HEADERS)))!;
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe(interaction.method);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(f.calls).toHaveLength(0);
  });

  test('paths are exact and options/start do not accept query selectors',async () => {
    const f = managementLoginFixture();
    for (const path of [
      '/api/auth/login/options/','/api/auth/login/options-extra','/api/auth/login/start/extra',
      '/api/auth/login/callback','/api/auth/login/callback/','/api/auth/login/callback/example/extra',
      '/api/auth/login/callback/example%2Fextra','/api/auth/login/callback/example%5Cextra',
      '/api/auth/login/callback/%ZZ',
    ]) {
      const response = (await f.api.handle(request(path)))!;
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    for (const [path,method] of [['/api/auth/login/options?plugin=other-auth','GET'],['/api/auth/login/start?provider=other-auth','POST']]) {
      expect((await f.api.handle(request(path!,method!,START_HEADERS)))!.status).toBe(400);
    }
    expect(f.calls).toHaveLength(0);
  });

  test('callback query and flow cookie reach the selected provider without a management session',async () => {
    const f = managementLoginFixture();
    const incoming = request(INTERACTIONS[2].path,'GET',{cookie:'flow=opaque'});
    const response = (await f.api.handle(incoming))!;
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/#/');
    expect(response.headers.getSetCookie()).toEqual([
      'session=issued; Path=/; HttpOnly; SameSite=Lax','flow=; Path=/api/auth/login; Max-Age=0; HttpOnly',
    ]);
    expect(f.calls[0]?.request).toBe(incoming);
    const unknown = (await f.api.handle(request('/api/auth/login/callback/unknown')))!;
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({error:'unknown_login_method'});
  });

  test('selection is checked again at the final asynchronous return boundary',async () => {
    const f = managementLoginFixture();
    const capture = f.auth.capture.bind(f.auth);
    f.auth.capture = () => {
      const current = capture();
      return () => {
        const valid = current();
        if (valid) queueMicrotask(f.invalidate);
        return valid;
      };
    };
    const response = (await f.api.handle(request('/api/auth/login/callback/example')))!;
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  for (const interaction of INTERACTIONS) {
    test(`${interaction.handler} fails closed and redacts thrown provider or repository details`,async () => {
      const f = managementLoginFixture();
      f.provider[interaction.handler] = async () => {throw new Error('secret client key and code');};
      for (const state of ['throw','unavailable','repository'] as const) {
        if (state === 'unavailable') f.setReady(false);
        if (state === 'repository') {f.setReady(true); f.setRepositoryReady(false);}
        const response = (await f.api.handle(request(interaction.path,interaction.method,START_HEADERS)))!;
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain('secret');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.getSetCookie()).toEqual([]);
      }
    });

    for (const change of ['generation','selection','instance','transition'] as const) {
      test(`${interaction.handler} drops old body, redirect and cookies after ${change} changes`,async () => {
        const f = managementLoginFixture();
        let finish!:(response:Response) => void,entered!:() => void;
        const started = new Promise<void>(resolve => {entered = resolve;});
        f.provider[interaction.handler] = async () => {
          entered(); return new Promise<Response>(resolve => {finish = resolve;});
        };
        const pending = f.api.handle(request(interaction.path,interaction.method,START_HEADERS));
        await started;
        if (change === 'generation') f.invalidate();
        if (change === 'selection') f.select('other-auth');
        if (change === 'instance') f.replaceProvider();
        if (change === 'transition') f.auth.beginTransition('pending-transition');
        finish(new Response('secret stale body',{status:302,headers:{location:'https://secret.example','set-cookie':'session=stale'}}));
        const response = (await pending)!;
        expect(response.status).toBe(409);
        expect(response.headers.getSetCookie()).toEqual([]);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toContain('secret');
      });
    }
  }
});
