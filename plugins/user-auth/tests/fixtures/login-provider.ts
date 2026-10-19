import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { LoginProvider } from '../../shared/login-connections';
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const TENANT = '11111111-2222-4333-8444-555555555555';
export const OTHER_TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
/** Deterministic transport fixture; exercises openid-client and real RSA signatures. */
export function loginProvider(provider: Exclude<LoginProvider, 'oidc'>, accountType = 'common', tenantId = TENANT) {
    const authority = provider === 'google' ? 'https://accounts.google.com' : provider === 'github' ? 'https://github.com' : 'https://login.microsoftonline.com/' + (accountType === 'tenant' ? tenantId : accountType) + '/v2.0';
    const authorizationEndpoint = provider === 'github' ? authority + '/login/oauth/authorize' : authority + '/authorize';
    const tokenEndpoint = provider === 'github' ? authority + '/login/oauth/access_token' : authority + '/token';
    const jwksUri = authority + '/keys';
    const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
    const codes = new Map<string, {nonce: string | null; challenge: string; redirectUri: string; clientId: string}>();
    const mutation = {
        tenantId: accountType === 'consumers' ? CONSUMERS : tenantId,
        subject: 'stable-subject', userId: 42 as unknown, login: 'renameable-login', name: 'Fixture User',
        issuer: undefined as string | undefined, keyIssuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' as string | undefined,
        invalidSignature: false, audience: undefined as string | undefined, nonce: undefined as string | undefined,
        expired: false, beforeToken: undefined as (() => Promise<void>) | undefined,
    };
    const calls: {url: string; init?: RequestInit}[] = [];
    const issuer = () => provider === 'microsoft' ? 'https://login.microsoftonline.com/' + mutation.tenantId + '/v2.0' : authority;
    const metadataIssuer = provider === 'github' ? 'https://github.com/login/oauth' : provider === 'microsoft' ? accountType === 'consumers' ? 'https://login.microsoftonline.com/' + CONSUMERS + '/v2.0' : accountType === 'tenant' ? authority : 'https://login.microsoftonline.com/{tenantid}/v2.0' : authority;
    const authorize = (url: string) => {
        const auth = new URL(url); if (auth.origin + auth.pathname !== authorizationEndpoint) throw new Error('Unexpected authorization endpoint');
        const code = crypto.randomUUID(); codes.set(code, {nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge')!, redirectUri: auth.searchParams.get('redirect_uri')!, clientId: auth.searchParams.get('client_id')!});
        const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', code);
        if (provider === 'github') callback.searchParams.set('iss', metadataIssuer);
        return callback.href;
    };
    const transport = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input); calls.push({url, init});
        if (url === authority + '/.well-known/openid-configuration') return Response.json({issuer: metadataIssuer, ...(provider === 'github' ? {authorization_response_iss_parameter_supported:true} : {}), authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint, jwks_uri: jwksUri, id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'], response_types_supported: ['code'], subject_types_supported: ['public']});
        if (url === jwksUri) return Response.json({keys: [{...keys.publicKey.export({format: 'jwk'}), kid: 'provider-key', alg: 'RS256', use: 'sig', ...(provider === 'microsoft' && mutation.keyIssuer !== undefined ? {issuer: mutation.keyIssuer} : {})}]});
        if (url === tokenEndpoint) {
            await mutation.beforeToken?.();
            const fields = new URLSearchParams(init?.body as string), code = fields.get('code')!, flow = codes.get(code); codes.delete(code);
            if (!flow || fields.get('client_id') !== flow.clientId || fields.get('client_secret') !== 'provider-secret' || fields.get('redirect_uri') !== flow.redirectUri || createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') !== flow.challenge) return Response.json({error:'invalid_grant'}, {status: 400});
            if (provider === 'github') return Response.json({access_token: 'github-access', token_type: 'bearer', scope: 'read:user'});
            const now = Math.floor(Date.now()/1000), header = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'provider-key'})).toString('base64url');
            const payload = Buffer.from(JSON.stringify({iss: mutation.issuer ?? issuer(), tid: mutation.tenantId, sub: mutation.subject, aud: mutation.audience ?? flow.clientId, nonce: mutation.nonce ?? flow.nonce, iat: now, exp: mutation.expired ? now - 600 : now + 300, name: mutation.name, email: 'same@example.com'})).toString('base64url');
            const value = header + '.' + payload, signature = mutation.invalidSignature ? Buffer.alloc(256) : sign('RSA-SHA256', Buffer.from(value), keys.privateKey);
            return Response.json({access_token: 'provider-access', refresh_token: 'provider-refresh', token_type: 'Bearer', id_token: value + '.' + signature.toString('base64url')});
        }
        if (url === 'https://api.github.com/user') {
            if (new Headers(init?.headers).get('authorization') !== 'Bearer github-access') return new Response(null,{status:401});
            return Response.json({id:mutation.userId, login:mutation.login, name: mutation.name, email:'same@example.com'});
        }
        throw new Error('Unexpected fixture network target: ' + url);
    };
    return {authority, authorize, transport, mutation, calls};
}
