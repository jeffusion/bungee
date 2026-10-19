import { expect, test } from 'bun:test';
import { authFixture, PUBLIC_ORIGIN, request } from '../helpers/auth-fixture';
import { startIdentityProvider } from '../fixtures/oidc-provider';

function metadata(issuer='https://idp.example') { return {issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/keys',token_endpoint_auth_methods_supported:['client_secret_basic'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']}; }

test('protected discovery supports issuer and arbitrary discovery URLs without storing metadata or secrets',async()=>{
    const calls:string[]=[];const f=await authFixture({fetch:async(input,init)=>{calls.push(String(input));expect(init?.redirect).toBe('error');expect(init?.signal).toBeInstanceOf(AbortSignal);return Response.json(metadata());}}),owner=await f.login();
    for(const mode of ['issuer','discovery']){
        const before=await f.state.list(), response=await f.call(owner,'/login-connections/discover','POST',{mode,url:mode==='issuer'?'https://idp.example':'https://metadata.example/custom?format=json'});
        expect(response.status).toBe(200);expect(await response.json()).toMatchObject({issuer:'https://idp.example',authorizationEndpoint:'https://idp.example/authorize',tokenEndpointAuthMethods:['client_secret_basic'],idTokenSigningAlgs:['RS256']});
        expect((await f.state.list()).filter(r=>r.key!=='session:0'&&r.key!=='clock')).toEqual(before.filter(r=>r.key!=='session:0'&&r.key!=='clock'));expect(f.secrets.values.size).toBe(0);
    }
    expect(calls).toEqual(['https://idp.example/.well-known/openid-configuration','https://metadata.example/custom?format=json']);
});

test('discovery is authenticated and Cookie requests require Origin and CSRF before any network request',async()=>{
    let calls=0;const f=await authFixture({fetch:async()=>{calls++;return Response.json(metadata());}});
    const handler=f.control.api.find(a=>a.path==='/login-connections/discover')!;
    const invoke=async(headers:Record<string,string>)=>{const req=request('/login-connections/discover','POST',{mode:'issuer',url:'https://idp.example'},headers),subject=await f.control.authenticate(req);return handler.invoke({...f.host,request:req,requestSignal:req.signal,subject:subject??undefined});};
    expect((await invoke({})).status).toBe(403);
    const login=await f.control.login(request('/login','POST',{username:'owner',password:'Local owner password'},{origin:PUBLIC_ORIGIN}));const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await invoke({cookie,origin:PUBLIC_ORIGIN})).status).toBe(403);
    const csrf=f.control.csrfToken(request('/test','GET',undefined,{cookie}))!;
    expect((await invoke({cookie,origin:'https://evil.example','x-csrf-token':csrf})).status).toBe(403);expect(calls).toBe(0);
    expect((await invoke({cookie,origin:PUBLIC_ORIGIN,'x-csrf-token':csrf})).status).toBe(200);expect(calls).toBe(1);
});

test.each(['issuer-mismatch','unsafe-endpoint','oversize','redirect','unsupported-method','unsupported-alg','unsupported-pkce','network'] as const)('discovery rejects %s and saving a disabled connection applies the same validation',async fault=>{
    const f=await authFixture({fetch:async()=>{
        if(fault==='network')throw new Error('unavailable');
        if(fault==='oversize')return new Response(' '.repeat(1024*1024+1));
        if(fault==='redirect')return new Response(null,{status:302,headers:{location:'https://evil.example'}});
        const m=metadata();if(fault==='issuer-mismatch')m.issuer='https://different.example';if(fault==='unsafe-endpoint')m.token_endpoint='http://remote.example/token';if(fault==='unsupported-method')m.token_endpoint_auth_methods_supported=['private_key_jwt'];if(fault==='unsupported-alg')m.id_token_signing_alg_values_supported=['HS256'];if(fault==='unsupported-pkce')m.code_challenge_methods_supported=['plain'];return Response.json(m);
    }}),owner=await f.login();
    const discover=await f.call(owner,'/login-connections/discover','POST',{mode:'issuer',url:'https://idp.example'});expect(discover.status).toBeGreaterThanOrEqual(400);
    const save=await f.call(owner,'/login-connections','POST',{id:crypto.randomUUID(),label:'Disabled',provider:'oidc',configuration:{mode:'issuer',issuer:'https://idp.example'},clientId:'client'});expect(save.status).toBeGreaterThanOrEqual(400);expect(f.secrets.values.size).toBe(0);expect(await (await f.call(owner,'/login-connections')).json()).toEqual({publicOrigin:PUBLIC_ORIGIN, connections:[]});
});

test('discovery URL pins the submitted issuer and rechecks it when beginning a login',async()=>{
    let issuer='https://idp.example';const f=await authFixture({fetch:async()=>Response.json(metadata(issuer))}),owner=await f.login(),configuration={mode:'discovery',issuer,discoveryUrl:'https://metadata.example/custom'};
    const saved=await f.call(owner,'/login-connections','POST',{id:crypto.randomUUID(),label:'Pinned',provider:'oidc',configuration,clientId:'client',clientSecret:'secret',enabled:true});expect(saved.status).toBe(201);const connection=(await saved.json() as {connection:{id:string}}).connection;
    issuer='https://other.example';const start=await f.control.beginLogin(request('/start','POST',{methodId:connection.id},{origin:PUBLIC_ORIGIN}));expect(await start.json()).toEqual({error:'oidc_issuer_mismatch'});
    expect((await f.call(owner,'/login-connections','POST',{id:crypto.randomUUID(),label:'Mismatch',provider:'oidc',configuration,clientId:'client'})).status).toBe(400);
});

test.each(['discovery','manual'] as const)('custom OIDC %s completes signed code flow with strict pinned issuer',async mode=>{
    const idp=startIdentityProvider('client_secret_basic');
    try{
        const f=await authFixture(),owner=await f.login(),configuration=mode==='discovery'?{mode,issuer:idp.issuer,discoveryUrl:idp.issuer+'/.well-known/openid-configuration'}:{mode,issuer:idp.issuer,authorizationEndpoint:idp.issuer+'/authorize',tokenEndpoint:idp.issuer+'/token',jwksUri:idp.issuer+'/jwks'};
        const saved=await f.call(owner,'/login-connections','POST',{id:crypto.randomUUID(),label:mode,provider:'oidc',configuration,clientId:'fixture-client',clientSecret:'fixture-client-secret',enabled:true});expect(saved.status).toBe(201);const connection=(await saved.json() as {connection:{id:string}}).connection;
        const settings=await(await f.call(owner,'/login-settings')).json() as {version:number};await f.call(owner,'/login-settings','PUT',{version:settings.version,autoCreateUsers:true});
        const started=await f.control.beginLogin(request('/start','POST',{methodId:connection.id},{origin:PUBLIC_ORIGIN})),flow=await started.json() as {authorizationUrl:string};
        const authorization=await fetch(flow.authorizationUrl,{redirect:'manual'}),response=await f.control.completeLogin(new Request(authorization.headers.get('location')!,{headers:{cookie:started.headers.get('set-cookie')!.split(';')[0]!}}));
        expect(response.headers.get('location')).toBe(PUBLIC_ORIGIN+'/#/');expect(response.headers.getSetCookie().some(c=>c.startsWith('bungee_user_session='))).toBe(true);
    }finally{idp.stop();}
});


test('discovery metadata request aborts after its five-second network deadline',async()=>{
    let aborted=false;const f=await authFixture({fetch:async(_input,init)=>new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>{aborted=true;reject(init!.signal!.reason);},{once:true});})}),owner=await f.login();
    const response=await f.call(owner,'/login-connections/discover','POST',{mode:'issuer',url:'https://idp.example'});expect(await response.json()).toEqual({error:'oidc_network_failed'});expect(aborted).toBe(true);
},10000);
