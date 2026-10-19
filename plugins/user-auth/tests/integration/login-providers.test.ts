import { expect, test } from 'bun:test';
import { authFixture, PUBLIC_ORIGIN, request } from '../helpers/auth-fixture';
import { loginProvider, TENANT, OTHER_TENANT } from '../fixtures/login-provider';
import type { LoginProvider, MicrosoftConfiguration } from '../../shared/login-connections';

async function fixture(provider: Exclude<LoginProvider, 'oidc'>, accountType: MicrosoftConfiguration['accountType'] = 'common', transform?: (url: string, response: Response) => Promise<Response>) {
    const idp = loginProvider(provider, accountType), f = await authFixture({fetch: async (input, init) => { const response = await idp.transport(input, init); return transform ? transform(String(input), response) : response; }}), owner = await f.login();
    const input = {id: crypto.randomUUID(), label: provider, enabled:true, provider, clientId:'provider-client', clientSecret:'provider-secret', configuration:provider === 'microsoft' ? {accountType, ...(accountType === 'tenant' ? {tenantId:TENANT} : {})} : {}};
    const saved = await f.call(owner, '/login-connections','POST',input); expect(saved.status).toBe(201);
    const connection = (await saved.json() as {connection:{id:string;version:number}}).connection;
    const settings = await (await f.call(owner, '/login-settings')).json() as {version:number};
    expect((await f.call(owner,'/login-settings','PUT',{version:settings.version,autoCreateUsers:true})).status).toBe(200);
    const start = async () => { const res = await f.control.beginLogin(request('/start','POST',{methodId: connection.id},{origin:PUBLIC_ORIGIN})); expect(res.status).toBe(200); const flow = await res.json() as {authorizationUrl:string;flowId:string}; return {...flow, cookie:res.headers.get('set-cookie')!.split(';')[0]!, callback:idp.authorize(flow.authorizationUrl)}; };
    const callback = (flow: Awaited<ReturnType<typeof start>>) => f.control.completeLogin(new Request(flow.callback,{headers:{cookie:flow.cookie}}));
    return {...f, idp, owner, input, connection, start, callback};
}
function successful(response: Response) { expect(response.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/'); expect(response.headers.getSetCookie().some(c=>c.startsWith('bungee_user_session='))).toBe(true); }
function rejected(response: Response) { expect(response.headers.get('location')).toContain('/#/login?oidcError='); expect(response.headers.getSetCookie().some(c=>c.startsWith('bungee_user_session='))).toBe(false); }

test('Google preset verifies its fixed issuer, signs in, and never persists provider tokens',async()=>{
    const f = await fixture('google'); const flow = await f.start();
    const url = new URL(flow.authorizationUrl); expect(url.origin).toBe('https://accounts.google.com'); expect(url.searchParams.get('scope')).toBe('openid profile email'); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    successful(await f.callback(flow));
    const records = JSON.stringify(await f.state.list()); for (const secret of ['provider-access','provider-refresh','provider-secret']) expect(records).not.toContain(secret);
    expect(await (await f.control.loginOptions(request('/options'))).json()).toMatchObject({methods:[{id:f.connection.id,provider:'google'}]});
});

test.each(['tenant','organizations','consumers','common'] as const)('Microsoft %s scope verifies actual tenant issuer and binds it as the identity',async scope=>{
    const f = await fixture('microsoft',scope); successful(await f.callback(await f.start()));
    const identities = await (await f.call(f.owner,'/identities')).json() as {identities:{issuer:string;protocol:string}[]};
    expect(identities.identities[0]).toMatchObject({issuer:'https://login.microsoftonline.com/'+f.idp.mutation.tenantId+'/v2.0',protocol:'oidc'});
    if(scope !== 'tenant') expect(identities.identities[0]!.issuer).not.toBe(f.idp.authority);
});

test('Microsoft common preserves different tenants with the same subject as separate users',async()=>{
    const f = await fixture('microsoft'); successful(await f.callback(await f.start())); f.idp.mutation.tenantId=OTHER_TENANT; successful(await f.callback(await f.start()));
    const records=await f.state.list(); expect(records.filter(r=>r.key.startsWith('user:'))).toHaveLength(3); expect(records.filter(r=>r.key.startsWith('identity:'))).toHaveLength(2);
});

for (const invalid of ['tid','issuer','key-issuer','missing-key-issuer','signature','audience','nonce','expiry'] as const) test('Microsoft common rejects invalid '+invalid,async()=>{
    const f=await fixture('microsoft');
    if(invalid==='tid') f.idp.mutation.tenantId='not-a-guid';
    if(invalid==='issuer') f.idp.mutation.issuer='https://login.microsoftonline.com/'+OTHER_TENANT+'/v2.0';
    if(invalid==='key-issuer') f.idp.mutation.keyIssuer='https://login.microsoftonline.com/'+OTHER_TENANT+'/v2.0';
    if(invalid==='missing-key-issuer') f.idp.mutation.keyIssuer=undefined;
    if(invalid==='signature') f.idp.mutation.invalidSignature=true;
    if(invalid==='audience') f.idp.mutation.audience='other-client';
    if(invalid==='nonce') f.idp.mutation.nonce='wrong';
    if(invalid==='expiry') f.idp.mutation.expired=true;
    rejected(await f.callback(await f.start())); expect((await f.state.list()).filter(r=>r.key.startsWith('user:'))).toHaveLength(1);
});

test.each(['tenant','organizations','consumers'] as const)('Microsoft %s rejects accounts outside the configured scope',async scope=>{
    const f=await fixture('microsoft',scope); f.idp.mutation.tenantId=scope==='organizations'?'9188040d-6c67-4c5b-b112-36a304b66dad':OTHER_TENANT; rejected(await f.callback(await f.start()));
});

test('Microsoft verified binding retains actual issuer and blocks ambiguous manual binding',async()=>{
    const f=await fixture('microsoft');
    const ownerId=(await (await f.call(f.owner,'/self')).json() as {administrator:{id:string}}).administrator.id;
    expect(await (await f.call(f.owner,'/identities','POST',{userId:ownerId,connectionId:f.connection.id,subject:'stable-subject'})).json()).toEqual({error:'verified_identity_required'});
    const response=await f.call(f.owner,'/identities/link/start','POST',{connectionId:f.connection.id}), flow=await response.json() as {authorizationUrl:string;flowId:string};
    const callback=await f.control.completeLogin(new Request(f.idp.authorize(flow.authorizationUrl),{headers:{cookie:response.headers.get('set-cookie')!.split(';')[0]!}}));
    expect(callback.headers.get('location')).toContain('oidcLink=');
    expect((await f.call(f.owner,'/identities/link/finish','POST',{flowId:flow.flowId})).status).toBe(200);
    const identity=(await f.state.list()).find(r=>r.key.startsWith('identity:'))!.value as {identity:{issuer:string}};
    expect(identity.identity.issuer).toBe('https://login.microsoftonline.com/'+TENANT+'/v2.0');
});

test('GitHub OAuth uses numeric id, S256 and state without ID token or email merging',async()=>{
    const f=await fixture('github'), flow=await f.start(), url=new URL(flow.authorizationUrl);
    expect(url.origin+url.pathname).toBe('https://github.com/login/oauth/authorize'); expect(url.searchParams.get('scope')).toBe('read:user'); expect(url.searchParams.get('nonce')).toBeNull(); expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const bad={...flow,callback:flow.callback.replace(/state=[^&]+/,'state=wrong')};rejected(await f.callback(bad));
    successful(await f.callback(flow));rejected(await f.callback(flow)); f.idp.mutation.login='changed-login'; successful(await f.callback(await f.start()));
    let records=await f.state.list(); expect(records.filter(r=>r.key.startsWith('user:'))).toHaveLength(2);
    expect((records.find(r=>r.key.startsWith('identity:'))!.value as {identity:unknown}).identity).toMatchObject({issuer:'https://github.com',subject:'42',protocol:'oauth2'});
    f.idp.mutation.userId=43; successful(await f.callback(await f.start())); records=await f.state.list(); expect(records.filter(r=>r.key.startsWith('user:'))).toHaveLength(3);
    for(const value of ['github-access','provider-secret'])expect(JSON.stringify(records)).not.toContain(value);
});

test.each(['42',null,-1,1.5,Number.MAX_SAFE_INTEGER+1])('GitHub rejects malformed profile id %s',async id=>{const f=await fixture('github');f.idp.mutation.userId=id;rejected(await f.callback(await f.start()));});

test('preset scopes and endpoint overrides are rejected and connection POST is create-only with caller UUID',async()=>{
    const f=await fixture('github');
    expect((await f.call(f.owner,'/login-connections','POST',f.input)).status).toBe(409);
    for(const extra of [{scopes:['read:user']},{configuration:{issuer:'https://evil.example'}},{id:'bad'}]) expect((await f.call(f.owner,'/login-connections','POST',{...f.input,id:crypto.randomUUID(),...extra})).status).toBe(400);
    expect((await f.call(f.owner,'/login-connections','DELETE',{id:f.connection.id,version:f.connection.version})).status).toBe(200);
    const replacement={...f.input,id:crypto.randomUUID()};expect((await f.call(f.owner,'/login-connections','POST',replacement)).status).toBe(201);expect((await f.call(f.owner,'/login-connections','POST',replacement)).status).toBe(409);
    expect((await (await f.call(f.owner,'/login-connections')).json() as {connections:unknown[]}).connections).toHaveLength(1);
});


test('GitHub rechecks auto-create and account disable after external token exchange',async()=>{
    const f=await fixture('github');successful(await f.callback(await f.start()));
    const users=(await(await f.call(f.owner,'/users')).json() as {users:{id:string;username:string;displayName:string}[]}).users,target=users.find(u=>u.username!=='owner')!;
    f.idp.mutation.beforeToken=async()=>{f.idp.mutation.beforeToken=undefined;expect((await f.call(f.owner,'/users/update','PUT',{id:target.id,username:target.username,displayName:target.displayName,disabled:true})).status).toBe(200);};
    rejected(await f.callback(await f.start()));expect((await f.state.list()).filter(r=>r.key.startsWith('user:'))).toHaveLength(2);
    f.idp.mutation.userId=43;f.idp.mutation.beforeToken=async()=>{f.idp.mutation.beforeToken=undefined;const settings=await(await f.call(f.owner,'/login-settings')).json() as {version:number};await f.call(f.owner,'/login-settings','PUT',{version:settings.version,autoCreateUsers:false});};
    rejected(await f.callback(await f.start()));expect((await f.state.list()).filter(r=>r.key.startsWith('user:'))).toHaveLength(2);
});


test('disabling a connection remains local during provider outage and revokes its sessions', async () => {
    let offline = false, requests = 0;
    const f = await fixture('google', 'common', async (_url, response) => { requests++; if (offline) throw new Error('provider down'); return response; });
    const login = await f.callback(await f.start()); successful(login);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('bungee_user_session='))!.split(';')[0]!;
    expect(await f.control.authenticate(request('/verify', 'GET', undefined, {cookie}))).not.toBeNull();
    const pending = await f.start(); offline = true; const before = requests;
    const {clientSecret: _secret, ...input} = f.input;
    const disabled = await f.call(f.owner, '/login-connections', 'PUT', {...input, version: f.connection.version, enabled: false});
    expect(disabled.status).toBe(200); expect(requests).toBe(before);
    expect(await f.control.authenticate(request('/verify', 'GET', undefined, {cookie}))).toBeNull();
    rejected(await f.callback(pending)); expect(requests).toBe(before);
    const current = await disabled.json() as {connection: {version: number}};
    expect((await f.call(f.owner, '/login-connections', 'PUT', {...input, version: current.connection.version, enabled: true})).status).toBe(502);
});

test('provider cannot change through the API or publish a replacement secret', async () => {
    let requests = 0;
    const f = await fixture('google', 'common', async (_url, response) => { requests++; return response; });
    const before = requests, secrets = [...f.secrets.values.entries()];
    for (const replacement of [undefined, 'replacement-secret']) {
        const response = await f.call(f.owner, '/login-connections', 'PUT', {id:f.connection.id, version:f.connection.version, label:'GitHub', enabled:true, provider:'github', configuration:{}, clientId:'github-client', ...(replacement ? {clientSecret:replacement} : {})});
        expect(await response.json()).toEqual({error:'invalid_input'}); expect(response.status).toBe(400);
        expect(requests).toBe(before); expect([...f.secrets.values.entries()]).toEqual(secrets);
    }
    expect(await (await f.call(f.owner, '/login-connections')).json()).toMatchObject({connections:[{provider:'google',version:f.connection.version}]});
});

for (const target of ['token', 'keys'] as const) for (const status of [200, 400]) test(`oversized Google ${target} response (${status}) cannot create a user or session`, async () => {
    let cancelled = false;
    const f = await fixture('google', 'common', async (url, response) => {
        if (!url.endsWith('/' + target)) return response;
        const value = status === 200 ? await response.json() as Record<string, unknown> : {error:'invalid_grant'};
        const bytes = new TextEncoder().encode(JSON.stringify({...value, padding:'x'.repeat(2*1024*1024)}));
        let offset = 0;
        return new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) { controller.close(); return; }
                controller.enqueue(bytes.slice(offset, offset + 256*1024)); offset += 256*1024;
            },
            cancel() { cancelled = true; },
        }), {status, headers:{'content-type':'application/json'}});
    });
    const callback = await f.callback(await f.start()); rejected(callback);
    expect(cancelled).toBe(true);
    expect((await f.state.list()).filter(record => record.key.startsWith('user:'))).toHaveLength(1);
});


test.each(['http://manager.lan:18090', PUBLIC_ORIGIN])('GitHub binding uses the explicit %s callback and preserves browser and session verification', async publicOrigin => {
    const idp = loginProvider('github'), f = await authFixture({fetch: idp.transport}, publicOrigin), owner = await f.login();
    try {
        const ownerId = (await (await f.call(owner, '/self')).json() as {administrator:{id:string}}).administrator.id;
        const saved = await f.call(owner, '/login-connections', 'POST', {id:crypto.randomUUID(), label:'GitHub', enabled:true, provider:'github', clientId:'provider-client', clientSecret:'provider-secret', configuration:{}});
        expect(saved.status).toBe(201);
        const {connection} = await saved.json() as {connection:{id:string}};
        expect(await (await f.call(owner, '/login-connections')).json()).toMatchObject({publicOrigin, connections:[{id:connection.id}]});
        const response = await f.call(owner, '/identities/link/start', 'POST', {connectionId:connection.id});
        expect(response.status).toBe(200);
        const flow = await response.json() as {authorizationUrl:string;flowId:string}, authorization = new URL(flow.authorizationUrl);
        expect(authorization.origin + authorization.pathname).toBe('https://github.com/login/oauth/authorize');
        expect(authorization.searchParams.get('redirect_uri')).toBe(publicOrigin + '/api/auth/login/callback/' + connection.id);
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        const flowCookie = response.headers.get('set-cookie')!;
        expect(flowCookie).toContain('; HttpOnly; SameSite=Lax');
        expect(flowCookie.includes('; Secure')).toBe(publicOrigin.startsWith('https:'));
        const callbackUrl = idp.authorize(flow.authorizationUrl);
        const wrongBrowser = await f.control.completeLogin(new Request(callbackUrl));
        expect(wrongBrowser.headers.get('location')).toContain('/#/login?oidcError=invalid_oidc_state');
        expect(idp.calls.filter(call => call.url.endsWith('/login/oauth/access_token'))).toHaveLength(0);
        const callback = await f.control.completeLogin(new Request(callbackUrl, {headers:{cookie:flowCookie.split(';')[0]!, 'x-forwarded-host':'attacker.example'}}));
        expect(callback.headers.get('location')).toBe(publicOrigin + '/#/extensions/user-auth/profile?oidcLink=' + flow.flowId);
        expect(callback.headers.getSetCookie().some(cookie => cookie.startsWith('bungee_user_session='))).toBe(false);
        expect(await f.control.authenticate(request('/verify', 'GET', undefined, {authorization:'Bearer ' + owner}))).not.toBeNull();
        expect((await f.call(owner, '/identities/link/finish', 'POST', {flowId:flow.flowId})).status).toBe(200);
        expect(await f.control.authenticate(request('/verify', 'GET', undefined, {authorization:'Bearer ' + owner}))).toBeNull();
        const records = await f.state.list();
        expect(records.filter(record => record.key.startsWith('user:'))).toHaveLength(1);
        expect(records.filter(record => record.key.startsWith('identity:')).map(record => record.value)).toMatchObject([{identity:{userId:ownerId, connectionId:connection.id, issuer:'https://github.com', subject:'42', protocol:'oauth2'}}]);
        expect(idp.calls.every(call => call.url.startsWith('https://'))).toBe(true);
        const replay = await f.control.completeLogin(new Request(callbackUrl, {headers:{cookie:flowCookie.split(';')[0]!}}));
        expect(replay.headers.get('location')).toContain('/#/login?oidcError=');
    } finally { f.control.dispose(); }
});

test('missing callback origin is explicit in connection metadata and rejects binding without creating flows', async () => {
    const idp = loginProvider('github'), f = await authFixture({fetch:idp.transport}, null), owner = await f.login();
    try {
        const id = crypto.randomUUID();
        expect((await f.call(owner, '/login-connections', 'POST', {id, label:'GitHub', enabled:true, provider:'github', clientId:'provider-client', clientSecret:'provider-secret', configuration:{}})).status).toBe(201);
        expect(await (await f.call(owner, '/login-connections')).json()).toMatchObject({publicOrigin:null, connections:[{id}]});
        const before = [...f.secrets.values.entries()], requests = idp.calls.length;
        const start = await f.call(owner, '/identities/link/start', 'POST', {connectionId:id});
        expect(start.status).toBe(503); expect(await start.json()).toEqual({error:'management_origin_required'});
        expect((await f.state.list()).filter(record => record.key.startsWith('flow:'))).toHaveLength(0);
        expect([...f.secrets.values.entries()]).toEqual(before); expect(idp.calls).toHaveLength(requests);
        expect(await f.control.authenticate(request('/verify', 'GET', undefined, {authorization:'Bearer ' + owner}))).not.toBeNull();
    } finally { f.control.dispose(); }
});


for (const status of [200, 400]) test.each([
    ['incorrect_client_credentials', 'oauth_client_rejected'],
    ['redirect_uri_mismatch', 'oauth_callback_mismatch'],
    ['bad_verification_code', 'oauth_code_rejected'],
    ['unverified_user_email', 'oauth_email_unverified'],
    ['unexpected-provider-error', 'oauth_token_failed'],
])('GitHub HTTP '+status+' token error %s rejects binding with a redacted actionable error', async (providerError, expected) => {
    const marker = 'private-provider-diagnostic';
    const f = await fixture('github', 'common', async (url, response) => url.endsWith('/login/oauth/access_token')
        ? Response.json({error:providerError, error_description:marker, error_uri:'https://example.test/'+marker}, {status}) : response);
    try {
        const started = await f.call(f.owner, '/identities/link/start', 'POST', {connectionId:f.connection.id});
        expect(started.status).toBe(200);
        const flow = await started.json() as {authorizationUrl:string};
        const callbackUrl = f.idp.authorize(flow.authorizationUrl), cookie = started.headers.get('set-cookie')!.split(';')[0]!;
        const callback = await f.control.completeLogin(new Request(callbackUrl, {headers:{cookie}}));
        expect(callback.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/login?oidcError='+expected);
        expect(callback.headers.getSetCookie().some(cookie=>cookie.startsWith('bungee_user_session='))).toBe(false);
        const records = await f.state.list();
        expect(records.filter(record=>record.key.startsWith('identity:'))).toHaveLength(0);
        expect(records.filter(record=>record.key.startsWith('user:'))).toHaveLength(1);
        expect(JSON.stringify(records)).not.toContain(marker);
        expect(JSON.stringify(records)).not.toContain('github-access');
        expect(f.idp.calls.some(call=>call.url==='https://api.github.com/user')).toBe(false);
        expect(await f.control.authenticate(request('/verify','GET',undefined,{authorization:'Bearer '+f.owner}))).not.toBeNull();
    } finally {f.control.dispose();}
});


test('GitHub token network failures retain the safe plugin error through openid-client wrapping', async () => {
    const f = await fixture('github', 'common', async (url, response) => {if(url.endsWith('/login/oauth/access_token')) throw new Error('private-network-diagnostic'); return response;});
    try {
        const result = await f.callback(await f.start());
        expect(result.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/login?oidcError=oidc_network_failed');
        const records = await f.state.list();
        expect(records.filter(record=>record.key.startsWith('identity:'))).toHaveLength(0);
        expect(JSON.stringify(records)).not.toContain('private-network-diagnostic');
    } finally {f.control.dispose();}
});


test('GitHub rejects malformed token responses without exposing provider fields or binding an identity', async () => {
    const marker = 'private-token-diagnostic';
    const f = await fixture('github', 'common', async (url, response) => url.endsWith('/login/oauth/access_token') ? Response.json({access_token:marker, token_type:42, scope:'read:user', error_description:marker}) : response);
    try {
        const result = await f.callback(await f.start());
        expect(result.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/login?oidcError=oauth_token_failed');
        expect(JSON.stringify(await f.state.list())).not.toContain(marker);
        expect(f.idp.calls.some(call=>call.url==='https://api.github.com/user')).toBe(false);
        expect((await f.state.list()).filter(record=>record.key.startsWith('identity:'))).toHaveLength(0);
    } finally {f.control.dispose();}
});


test.each(['missing', 'wrong'])('GitHub rejects a %s authorization server issuer before exchanging the code', async invalid => {
    const f = await fixture('github');
    try {
        const flow = await f.start(), callback = new URL(flow.callback);
        if (invalid === 'missing') callback.searchParams.delete('iss');
        else callback.searchParams.set('iss','https://github.com');
        const result = await f.control.completeLogin(new Request(callback,{headers:{cookie:flow.cookie}}));
        rejected(result);
        expect(f.idp.calls.some(call=>call.url.endsWith('/login/oauth/access_token'))).toBe(false);
        expect((await f.state.list()).filter(record=>record.key.startsWith('identity:'))).toHaveLength(0);
        expect((await f.state.list()).filter(record=>record.key.startsWith('user:'))).toHaveLength(1);
    } finally {f.control.dispose();}
});
