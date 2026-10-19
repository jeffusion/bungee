import {expect,test} from 'bun:test';
import {managementLoginFixture} from '../helpers/management-login';

test('HTTP login interactions preserve redirects and separate Set-Cookie headers without a prior session',async () => {
  const f = managementLoginFixture();
  let callbackRequest:{query:string;cookie:string|null;authorization:string|null}|undefined;
  const completeLogin = f.provider.completeLogin!;
  f.provider.completeLogin = async function (request) {
    callbackRequest = {query:new URL(request.url).search,cookie:request.headers.get('cookie'),authorization:request.headers.get('authorization')};
    return completeLogin.call(this,request);
  };
  const server = Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request =>
    await f.api.handle(request) ?? new Response(null,{status:404})});
  try {
    const options = await fetch(new URL('/api/auth/login/options',server.url));
    expect(options.status).toBe(200);
    expect(options.headers.get('cache-control')).toBe('no-store');
    expect(await options.json()).toEqual({methods:[{id:'example',type:'redirect'}]});

    const start = await fetch(new URL('/api/auth/login/start',server.url),{
      method:'POST',headers:{origin:'https://dashboard.example','x-bungee-auth-provider':'test-auth'},body:'opaque form',
    });
    expect(start.status).toBe(200);
    expect(await start.json()).toEqual({received:'opaque form'});

    const callback = await fetch(new URL('/api/auth/login/callback/example?code=opaque&state=pinned',server.url),{
      redirect:'manual',headers:{cookie:'flow=opaque'},
    });
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('/#/');
    expect(callback.headers.get('cache-control')).toBe('no-store');
    expect(callback.headers.getSetCookie()).toEqual([
      'session=issued; Path=/; HttpOnly; SameSite=Lax','flow=; Path=/api/auth/login; Max-Age=0; HttpOnly',
    ]);
    expect(await callback.text()).toBe('');
    expect(callbackRequest).toEqual({query:'?code=opaque&state=pinned',cookie:'flow=opaque',authorization:null});
    const config = await fetch(new URL('/api/config',server.url));
    expect(config.status).toBe(401);
    await config.body?.cancel();
  } finally {await server.stop(true);}
});
