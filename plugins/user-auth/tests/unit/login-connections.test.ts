import { expect, test } from 'bun:test';
import { LoginProviders, parseProvider, providerUrl } from '../../server/control';
const TENANT = '11111111-2222-4333-8444-555555555555';

test('strict provider configurations derive fixed preset issuers and scopes',()=>{
    expect(parseProvider('google',{})).toMatchObject({issuer:'https://accounts.google.com',scopes:['openid','profile','email']});
    expect(parseProvider('github',{})).toMatchObject({issuer:'https://github.com',scopes:['read:user']});
    for(const accountType of ['organizations','consumers','common']) expect(parseProvider('microsoft',{accountType}).issuer).toBe('https://login.microsoftonline.com/'+accountType+'/v2.0');
    expect(parseProvider('microsoft',{accountType:'tenant',tenantId:TENANT}).issuer).toBe('https://login.microsoftonline.com/'+TENANT+'/v2.0');
});

test('configuration accepts only fields belonging to the selected provider and mode',()=>{
    for(const [provider,configuration,scopes] of [
        ['google',{issuer:'https://evil.example'}],['github',{},['read:user']],['microsoft',{accountType:'tenant'}],['microsoft',{accountType:'tenant',tenantId:'contoso.onmicrosoft.com'}],['microsoft',{accountType:'common',tenantId:TENANT}],['microsoft',{accountType:'unknown'}],
        ['oidc',{mode:'issuer',issuer:'https://idp.example',discoveryUrl:'https://idp.example/custom'}],['oidc',{mode:'discovery',issuer:'https://idp.example'}],['oidc',{mode:'manual',issuer:'https://idp.example'}],['oidc',{mode:'issuer',issuer:'https://idp.example'},['profile']],['oidc',{mode:'unknown',issuer:'https://idp.example'}],
    ] as const) expect(()=>parseProvider(provider,configuration,scopes)).toThrow();
});

test('provider URL policy allows private HTTPS and loopback HTTP, and rejects credentials and fragments',()=>{
    for(const value of ['https://10.0.0.2/idp','http://127.0.0.1:1234','http://localhost:1234','http://[::1]:1234','https://idp.example/discovery?format=json'])expect(providerUrl(value)).toBeInstanceOf(URL);
    for(const value of ['http://10.0.0.2','https://user:secret@idp.example','https://idp.example/#fragment','https://idp.example/#','https://@idp.example','file:///tmp/data','invalid'])expect(()=>providerUrl(value)).toThrow();
});


test.each([200, 500])('provider response limit cancels streaming bodies even on HTTP %s', async status => {
    let cancelled = false;
    const providers = new LoginProviders(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
        cancel() { cancelled = true; },
    }), {status}), new AbortController().signal);
    await expect(providers.discover('issuer','https://idp.example')).rejects.toMatchObject({code:'oidc_metadata_limit'});
    expect(cancelled).toBe(true);
});


test('GitHub verifies the documented authorization server issuer separately from the platform identity namespace', async () => {
    const provider = new LoginProviders(async () => {throw new Error('Unexpected network request');}, new AbortController().signal);
    const connection = {...parseProvider('github',{}),clientId:'fixture-client'};
    const config = await provider.configuration(connection,'fixture-secret');
    expect(config.serverMetadata()).toMatchObject({issuer:'https://github.com/login/oauth',authorization_response_iss_parameter_supported:true,authorization_endpoint:'https://github.com/login/oauth/authorize',token_endpoint:'https://github.com/login/oauth/access_token'});
    expect(connection.issuer).toBe('https://github.com');
});
