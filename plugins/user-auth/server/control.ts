import * as oidc from 'openid-client';
import { isDeepStrictEqual } from 'node:util';
import { AccountError, fail } from './errors';
import type { LoginConfiguration, LoginProvider, MicrosoftConfiguration, OidcConfiguration, VerifiedIdentity } from '../shared/login-connections';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ControlHostContext, ControlApiHandlerContext, PluginControl, ControlPlugin } from '@jeffusion/bungee-core/plugin';
import type { ManagementProvider, ManagementSubject } from '@jeffusion/bungee-core/plugin';
import { isDurableStateConflictError, type DurableJson, type PluginDurableState, type DurableMutation, type DurableRecord } from '@jeffusion/bungee-core/plugin';
export interface ProviderConnection { provider: LoginProvider; issuer: string; configuration: LoginConfiguration; clientId: string; scopes: string[] }
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICROSOFT = 'https://login.microsoftonline.com/';
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
const ISSUER_TEMPLATE = MICROSOFT + '{tenantid}/v2.0';
const LIMIT = 1024 * 1024;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
function providerFields(value: Record<string, unknown>, fields: string[]) { if (Object.keys(value).some(key => !fields.includes(key))) fail('invalid_input'); }
function providerRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input'); return value as Record<string, unknown>; }
export function providerUrl(value: unknown): URL {
    let url: URL;
    try { if (typeof value !== 'string' || !value || value.length > 2048) fail('invalid_oidc_url'); url = new URL(value); } catch { return fail('invalid_oidc_url'); }
    if (url.username || url.password || url.hash || (typeof value === 'string' && (value.includes('#') || /^https?:\/\/[^/?#]*@/i.test(value))) || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('invalid_oidc_url');
    return url;
}
export function parseProvider(provider: unknown, input: unknown, scopesInput?: unknown): Pick<ProviderConnection, 'provider' | 'issuer' | 'configuration' | 'scopes'> {
    if (!['google', 'microsoft', 'github', 'oidc'].includes(provider as string)) fail('invalid_provider');
    const p = provider as LoginProvider, c = providerRecord(input);
    let issuer: string, configuration: LoginConfiguration;
    if (p === 'google' || p === 'github') { providerFields(c, []); issuer = p === 'google' ? 'https://accounts.google.com' : 'https://github.com'; configuration = {}; }
    else if (p === 'microsoft') {
        providerFields(c, ['accountType', 'tenantId']);
        if (!['tenant', 'organizations', 'consumers', 'common'].includes(c.accountType as string)) fail('invalid_microsoft_configuration');
        if (c.accountType === 'tenant' ? typeof c.tenantId !== 'string' || !GUID.test(c.tenantId) : Object.hasOwn(c, 'tenantId')) fail('invalid_microsoft_configuration');
        configuration = { accountType: c.accountType as MicrosoftConfiguration['accountType'], ...(c.accountType === 'tenant' ? { tenantId: (c.tenantId as string).toLowerCase() } : {}) };
        issuer = MICROSOFT + (configuration.tenantId ?? configuration.accountType) + '/v2.0';
    } else {
        if (!['issuer', 'discovery', 'manual'].includes(c.mode as string)) fail('invalid_oidc_configuration');
        const fields = c.mode === 'issuer' ? ['mode', 'issuer'] : c.mode === 'discovery' ? ['mode', 'issuer', 'discoveryUrl'] : ['mode', 'issuer', 'authorizationEndpoint', 'tokenEndpoint', 'jwksUri', 'tokenEndpointAuthMethod', 'idTokenSigningAlg'];
        providerFields(c, fields); providerUrl(c.issuer); issuer = c.issuer as string;
        if (new URL(issuer).search) fail('invalid_oidc_url');
        if (c.mode === 'discovery') providerUrl(c.discoveryUrl);
        if (c.mode === 'manual') {
            for (const field of ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri']) providerUrl(c[field]);
            if (c.tokenEndpointAuthMethod !== undefined && !['client_secret_basic', 'client_secret_post'].includes(c.tokenEndpointAuthMethod as string)) fail('oidc_auth_method_unsupported');
            if (c.idTokenSigningAlg !== undefined && !['RS256', 'PS256', 'ES256'].includes(c.idTokenSigningAlg as string)) fail('oidc_signing_alg_unsupported');
        }
        configuration = { ...c } as OidcConfiguration;
    }
    if (p !== 'oidc' && scopesInput !== undefined) fail('preset_scopes_fixed');
    const scopes = p === 'github' ? ['read:user'] : scopesInput ?? ['openid', 'profile', 'email'];
    if (!Array.isArray(scopes) || !scopes.length || scopes.length > 16 || scopes.some(s => typeof s !== 'string' || !s || s.length > 128 || /\s/.test(s)) || (p !== 'github' && !scopes.includes('openid'))) fail('invalid_input');
    return { provider: p, issuer, configuration, scopes };
}
async function boundedResponse(response: Response): Promise<Response> {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > LIMIT) { await reader.cancel(); fail('oidc_metadata_limit'); }
            chunks.push(chunk.value);
        }
    } finally { reader.releaseLock(); }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(Buffer.concat(chunks), {status: response.status, statusText: response.statusText, headers});
}
async function limitedJson(response: Response): Promise<unknown> {
    if (!response.ok) fail('oidc_metadata_failed', 502);
    const reader = response.body?.getReader(); if (!reader) fail('oidc_metadata_invalid');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > LIMIT) { await reader.cancel(); fail('oidc_metadata_limit'); } chunks.push(r.value); } }
    catch (error) { if (error instanceof AccountError) throw error; fail('oidc_network_failed', 502); }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('oidc_metadata_invalid'); }
}
export interface DiscoveryResult { issuer: string; discoveryUrl: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; tokenEndpointAuthMethods: string[]; idTokenSigningAlgs: string[] }
function discoveryUrl(issuer: string) { const url = providerUrl(issuer); url.pathname = url.pathname.replace(/\/$/, '') + '/.well-known/openid-configuration'; return url.href; }
function metadataCheck(value: unknown, expected?: string): oidc.ServerMetadata {
    const m = providerRecord(value);
    if (typeof m.issuer !== 'string') fail('oidc_metadata_invalid');
    if (providerUrl(m.issuer).search) fail('invalid_oidc_url');
    if (expected !== undefined && m.issuer !== expected) fail('oidc_issuer_mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) providerUrl(m[key]);
    for (const key of ['token_endpoint_auth_methods_supported', 'id_token_signing_alg_values_supported']) if (m[key] !== undefined && (!Array.isArray(m[key]) || (m[key] as unknown[]).some(v => typeof v !== 'string'))) fail('oidc_metadata_invalid');
    const methods = m.token_endpoint_auth_methods_supported as string[] | undefined;
    if (methods && !methods.some(m => ['client_secret_basic', 'client_secret_post'].includes(m))) fail('oidc_auth_method_unsupported');
    const algs = m.id_token_signing_alg_values_supported as string[] | undefined;
    if (!algs?.some(a => ['RS256', 'PS256', 'ES256'].includes(a))) fail('oidc_signing_alg_unsupported');
    if (m.code_challenge_methods_supported !== undefined && (!Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes('S256'))) fail('oidc_pkce_unsupported');
    return m as oidc.ServerMetadata;
}
export class LoginProviders {
    constructor(private readonly fetcher: Fetcher, private readonly signal: AbortSignal) {}
    private async network(input: string | URL | Request, init: RequestInit = {}) {
        providerUrl(input instanceof Request ? input.url : String(input));
        try { return await boundedResponse(await this.fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(5000), ...(init.signal ? [init.signal] : [])]) })); }
        catch (error) { if (error instanceof AccountError) throw error; fail('oidc_network_failed', 502); }
    }
    async discover(mode: unknown, value: unknown): Promise<DiscoveryResult> {
        if (mode !== 'issuer' && mode !== 'discovery') fail('invalid_input');
        const url = providerUrl(value); if (mode === 'issuer' && url.search) fail('invalid_oidc_url');
        const endpoint = mode === 'issuer' ? discoveryUrl(value as string) : url.href;
        const m = metadataCheck(await limitedJson(await this.network(endpoint)), mode === 'issuer' ? value as string : undefined);
        return { issuer: m.issuer, discoveryUrl: endpoint, authorizationEndpoint: m.authorization_endpoint!, tokenEndpoint: m.token_endpoint!, jwksUri: m.jwks_uri!, tokenEndpointAuthMethods: m.token_endpoint_auth_methods_supported ?? ['client_secret_basic'], idTokenSigningAlgs: m.id_token_signing_alg_values_supported! };
    }
    private async metadata(c: ProviderConnection): Promise<oidc.ServerMetadata> {
        // The authorization server issuer is distinct from the GitHub identity namespace.
        if (c.provider === 'github') return { issuer: 'https://github.com/login/oauth', authorization_response_iss_parameter_supported: true, authorization_endpoint: 'https://github.com/login/oauth/authorize', token_endpoint: 'https://github.com/login/oauth/access_token', token_endpoint_auth_methods_supported: ['client_secret_post'] };
        const configuration = c.configuration as OidcConfiguration;
        if (c.provider === 'oidc' && configuration.mode === 'manual') return metadataCheck({ issuer: c.issuer, authorization_endpoint: configuration.authorizationEndpoint, token_endpoint: configuration.tokenEndpoint, jwks_uri: configuration.jwksUri, token_endpoint_auth_methods_supported: [configuration.tokenEndpointAuthMethod ?? 'client_secret_basic'], id_token_signing_alg_values_supported: [configuration.idTokenSigningAlg ?? 'RS256'] }, c.issuer);
        const endpoint = c.provider === 'oidc' && configuration.mode === 'discovery' ? configuration.discoveryUrl! : discoveryUrl(c.issuer);
        const raw = await limitedJson(await this.network(endpoint));
        const ms = c.configuration as MicrosoftConfiguration;
        const expected = c.provider === 'microsoft' && ms.accountType !== 'tenant' ? (ms.accountType === 'consumers' ? MICROSOFT + CONSUMERS + '/v2.0' : ISSUER_TEMPLATE) : c.issuer;
        return metadataCheck(raw, expected);
    }
    async validate(c: ProviderConnection) { await this.metadata(c); }
    private microsoftIssuer(connection: ProviderConnection, claims: Record<string, unknown>): string {
        const c = connection.configuration as MicrosoftConfiguration, tid = claims.tid;
        if (typeof tid !== 'string' || !GUID.test(tid)) fail('invalid_microsoft_tenant', 401);
        const normalized = tid.toLowerCase();
        if (claims.iss !== MICROSOFT + tid + '/v2.0' || (c.accountType === 'tenant' && normalized !== c.tenantId) || (c.accountType === 'organizations' && normalized === CONSUMERS) || (c.accountType === 'consumers' && normalized !== CONSUMERS)) fail('microsoft_account_scope', 401);
        return claims.iss as string;
    }
    async configuration(c: ProviderConnection, secret: string): Promise<oidc.Configuration> {
        const metadata = await this.metadata(c);
        const custom = c.configuration as OidcConfiguration;
        const methods = metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
        const method = c.provider === 'oidc' && custom.mode === 'manual' ? custom.tokenEndpointAuthMethod ?? 'client_secret_basic' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
        const auth = method === 'client_secret_post' ? oidc.ClientSecretPost(secret) : oidc.ClientSecretBasic(secret);
        let actualIssuer: string | undefined;
        const customFetch: oidc.CustomFetch = async (input, init) => {
            const { body, ...options } = init;
            const response = await this.network(input, { ...options, body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body });
            if (c.provider === 'github' && String(input) === metadata.token_endpoint) {
                // GitHub returns OAuth errors in JSON even with HTTP 200.
                // Interpret only documented error codes; never expose descriptions or URLs.
                let value: unknown;
                try { value = await response.clone().json(); } catch { fail('oauth_token_failed', 502); }
                if (value && typeof value === 'object' && 'error' in value) {
                    switch (value.error) {
                        case 'incorrect_client_credentials': fail('oauth_client_rejected', 502);
                        case 'redirect_uri_mismatch': fail('oauth_callback_mismatch', 502);
                        case 'bad_verification_code': fail('oauth_code_rejected', 401);
                        case 'unverified_user_email': fail('oauth_email_unverified', 401);
                        default: fail('oauth_token_failed', 502);
                    }
                }
            }
            if (c.provider !== 'microsoft') return response;
            if (String(input) === metadata.token_endpoint && response.ok) {
                // Unverified claims only narrow the candidate key set. openid-client
                // must still verify the original token signature, issuer, audience,
                // nonce and lifetime before exchange() returns any identity.
                const value = await limitedJson(response.clone()) as {id_token?: unknown};
                try { if (typeof value.id_token !== 'string') fail('invalid_oidc_identity', 401); const claims = providerRecord(JSON.parse(Buffer.from(value.id_token.split('.')[1]!, 'base64url').toString())); actualIssuer = this.microsoftIssuer(c, claims); }
                catch (error) { if (error instanceof AccountError) throw error; fail('invalid_oidc_identity', 401); }
            }
            if (String(input) === metadata.jwks_uri) {
                if (!actualIssuer) fail('invalid_oidc_identity', 401);
                const value = providerRecord(await limitedJson(response));
                if (!Array.isArray(value.keys)) fail('oidc_metadata_invalid');
                const keys = value.keys.filter(key => key && typeof key === 'object' && typeof key.issuer === 'string' && key.issuer.replace('{tenantid}', actualIssuer!.slice(MICROSOFT.length, -'/v2.0'.length)) === actualIssuer);
                if (!keys.length) fail('microsoft_signing_key_issuer', 401);
                return Response.json({ keys });
            }
            return response;
        };
        const signingAlg = metadata.id_token_signing_alg_values_supported?.includes('RS256') ? 'RS256' : metadata.id_token_signing_alg_values_supported?.find(alg => ['PS256', 'ES256'].includes(alg));
        let config: oidc.Configuration;
        if (c.provider === 'microsoft') {
            // Discovery installs openid-client's Entra issuer-template validator. Feed
            // the metadata already checked above without a second network request.
            config = await oidc.discovery(new URL(c.issuer), c.clientId, {client_secret: secret, id_token_signed_response_alg: 'RS256'}, auth, { timeout: 5, [oidc.customFetch]: async () => Response.json(metadata) });
        } else config = new oidc.Configuration(metadata, c.clientId, { client_secret: secret, ...(c.provider !== 'github' ? {id_token_signed_response_alg: signingAlg} : {}) }, auth);
        config[oidc.customFetch] = customFetch; config.timeout = 5;
        if ([c.issuer, metadata.token_endpoint, metadata.jwks_uri].some(url => url?.startsWith('http:'))) oidc.allowInsecureRequests(config);
        if (c.provider !== 'github') oidc.enableNonRepudiationChecks(config);
        return config;
    }
    async exchange(c: ProviderConnection, config: oidc.Configuration, callback: URL, checks: {pkceCodeVerifier: string; expectedState: string; expectedNonce: string}): Promise<VerifiedIdentity> {
        const tokens = await oidc.authorizationCodeGrant(config, callback, c.provider === 'github' ? {pkceCodeVerifier: checks.pkceCodeVerifier, expectedState: checks.expectedState} : {...checks, idTokenExpected: true}).catch(error => {
            if (error instanceof AccountError) throw error;
            if (error instanceof oidc.ClientError && error.cause instanceof AccountError) throw error.cause;
            if (c.provider !== 'github') throw error;
            fail('oauth_token_failed', 502);
        });
        if (c.provider === 'github') {
            const response = await oidc.fetchProtectedResource(config, tokens.access_token, new URL('https://api.github.com/user'), 'GET', undefined, new Headers({'accept': 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Bungee'}));
            const user = providerRecord(await limitedJson(response));
            if (!Number.isSafeInteger(user.id) || (user.id as number) <= 0) fail('invalid_oauth_identity', 401);
            return {protocol: 'oauth2', issuer: 'https://github.com', subject: String(user.id), displayName: typeof user.name === 'string' ? [...user.name].slice(0,128).join('') : 'GitHub user'};
        }
        const claims = tokens.claims();
        if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || typeof claims.iss !== 'string') fail('invalid_oidc_identity', 401);
        if (c.provider === 'microsoft') this.microsoftIssuer(c, claims);
        return {protocol: 'oidc', issuer: claims.iss, subject: claims.sub, displayName: typeof claims.name === 'string' ? [...claims.name].slice(0,128).join('') : 'SSO user'};
    }
}

interface User {
    id: string;
    username: string;
    displayName: string;
    disabled: boolean;
    generation: number;
}
interface LocalCredential {
    passwordHash: string;
    temporary: boolean;
}
interface Administrator extends User {
    passwordHash: string;
    temporary: boolean;
}
interface Connection extends ProviderConnection {
    id: string;
    label: string;
    enabled: boolean;
    issuer: string;
    clientId: string;
    secretRef: string;
    scopes: string[];
    generation: number;
    deleting?: { secretRefs: string[] };
}
interface Identity {
    id: string;
    userId: string;
    connectionId: string;
    issuer: string;
    subject: string;
    protocol: VerifiedIdentity['protocol'];
}
interface LoginSettings {
    autoCreateUsers: boolean;
    sessionEpoch: number;
    failureEpoch: number;
}
interface Turnstile {
    enabled: boolean;
    siteKey: string;
    secretRef: string;
    hostnames: string[];
}
interface AuthFlow {
    id: string;
    state: string;
    nonce: string;
    verifierRef: string;
    connectionId: string;
    generation: number;
    created: number;
    expiresAt: number;
    epoch: number;
    returnTo: string;
    status: 'pending' | 'exchanging' | 'verified' | 'consumed';
    initiator?: {
        userId: string;
        generation: number;
        sessionDigest: string;
    };
    subject?: string;
    issuer?: string;
    protocol?: VerifiedIdentity['protocol'];
}
const MAX_USERS = 128, MAX_CONNECTIONS = 32, MAX_IDENTITIES = 512, MAX_FLOWS = 128, MAX_AUDIT = 128;
const MAX_SECRETS = 512;
const FLOW_COOKIE = 'bungee_user_flow';
const EMPTY_SETTINGS: LoginSettings = { autoCreateUsers: false, sessionEpoch: 1, failureEpoch: 1 };
const EMPTY_TURNSTILE: Turnstile = { enabled: false, siteKey: '', secretRef: '', hostnames: [] };
interface SessionPolicy {
    idleTimeoutMinutes: number;
    absoluteTimeoutMinutes: number;
}
interface Session {
    digest: string;
    administratorId: string;
    generation: number;
    created: number;
    touched: number;
    pendingTouch?: number;
    transport: 'cookie' | 'bearer';
    policy: SessionPolicy;
    epoch: number;
    connectionId?: string;
    connectionGeneration?: number;
}
interface Failure {
    key: string;
    count: number;
    until: number;
    epoch: number;
}
interface Slot<T> {
    key: string;
    version: number;
    value: T | null;
}
export interface Dependencies {
    now?: () => number;
    trustedSource?: (request: Request) => string;
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}
const PROVIDER = 'user-auth';
const COOKIE = 'bungee_user_session';
const DEFAULT_SESSION_POLICY: Readonly<SessionPolicy> = Object.freeze({ idleTimeoutMinutes: 30, absoluteTimeoutMinutes: 480 });
// Chromium caps persistent cookies at 400 days. Verification renews this browser lease,
// never the server-side absolute deadline. Browser/user cleanup remains outside our control.
const COOKIE_LEASE_SECONDS = 400 * 24 * 60 * 60;
const MAX_TIMEOUT_MINUTES = 43200;
const ALL = ['config.read', 'config.write', 'logs.read', 'logs.body', 'keys.read', 'keys.write', 'plugins.read', 'plugins.toggle', 'plugins.code', 'auth.mode', 'self.password', 'self.logout'];
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v))
    fail('invalid_input'); return v as Record<string, unknown>; }
function exact(v: Record<string, unknown>, fields: string[]) { if (Object.keys(v).some(k => !fields.includes(k)))
    fail('invalid_input'); }
function username(v: unknown): string { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(v))
    fail('invalid_input'); return v.toLowerCase(); }
function password(v: unknown): string { if (typeof v !== 'string' || [...v].length < 5 || [...v].length > 32)
    fail('invalid_password'); return v; }
function digest(v: string): string { return createHash('sha256').update(v).digest('hex'); }
function csrf(token: string): string { return createHmac('sha256', token).update('user-auth/csrf/v1').digest('base64url'); }
function constant(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function dto(m: Administrator) { return { id: m.id, username: m.username, displayName: m.displayName, disabled: m.disabled, hasLocalPassword: !!m.passwordHash, requiresPasswordChange: m.temporary }; }
function json(v: unknown, status = 200, headers: Record<string, string> = {}): Response { return Response.json(v, { status, headers: { 'cache-control': 'no-store', ...headers } }); }
function safe(error: unknown): Response { return error instanceof AccountError ? json({ error: error.code }, error.status) : json({ error: 'provider_unavailable' }, 503); }
async function body(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader)
        fail('invalid_input');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done)
                break;
            size += r.value.length;
            if (size > 8192) {
                await reader.cancel();
                fail('body_limit', 413);
            }
            chunks.push(r.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    try {
        return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }
    catch (e) {
        if (e instanceof AccountError)
            throw e;
        return fail('invalid_input');
    }
}
function credentials(request: Request): {
    token: string;
    transport: Session['transport'];
} | null {
    const auth = request.headers.get('authorization');
    if (auth !== null) {
        const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth);
        return m ? { token: m[1]!, transport: 'bearer' } : null;
    }
    const tokens = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE + '='));
    if (tokens.length !== 1)
        return null;
    const token = tokens[0]!.slice(COOKIE.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? { token, transport: 'cookie' } : null;
}
function origin(request: Request, expected?: string) { if (request.headers.get('origin') !== (expected ?? new URL(request.url).origin))
    fail('invalid_origin', 403); }
function cookie(request: Request, token: string, maxAge: number, managementOrigin?: string) { return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(managementOrigin ?? request.url).protocol === 'https:' ? '; Secure' : ''}`; }
function validateSessionPolicy(value: unknown, code = 'invalid_session_policy', status = 400): SessionPolicy {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(code, status);
    const p = value as SessionPolicy;
    if (Object.keys(p).some(key => !['idleTimeoutMinutes', 'absoluteTimeoutMinutes'].includes(key))
        || ![p.idleTimeoutMinutes, p.absoluteTimeoutMinutes].every(n => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TIMEOUT_MINUTES) || p.absoluteTimeoutMinutes === 0)
        fail(code, status);
    return { idleTimeoutMinutes: p.idleTimeoutMinutes, absoluteTimeoutMinutes: p.absoluteTimeoutMinutes };
}
// Fixed slots keep expired sessions, logout markers and throttles bounded. Reuse always
// compares the previous version; a stale touch cannot restore a replaced session.
export const ACCOUNT_RECORD_SCHEMA = 3;
export const MAX_SESSIONS = 512, MAX_FAILURES = 1024;
const asJson = (value: unknown) => value as DurableJson;
function validateUser(value: unknown): User {
    const u = value as User;
    if (!u || Object.keys(u).some(k => !['id', 'username', 'displayName', 'disabled', 'generation'].includes(k)) || typeof u.id !== 'string' || !/^[a-f0-9-]{36}$/.test(u.id) || typeof u.username !== 'string' || !/^[a-z0-9][a-z0-9_.@-]{0,63}$/.test(u.username) || typeof u.displayName !== 'string' || [...u.displayName].length > 128 || typeof u.disabled !== 'boolean' || !Number.isSafeInteger(u.generation) || u.generation < 1)
        fail('corrupt_state', 503);
    return u;
}
function localValue(record: DurableRecord | null | undefined): LocalCredential | null {
    if (!record)
        return null;
    const c = envelope(record.value, 'credential') as LocalCredential;
    if (!c || Object.keys(c).some(k => !['passwordHash', 'temporary'].includes(k)) || typeof c.passwordHash !== 'string' || !c.passwordHash.startsWith('$argon2id$') || typeof c.temporary !== 'boolean')
        fail('corrupt_state', 503);
    return c;
}
function entry<T>(records: readonly DurableRecord[], key: string, field: string, fallback: T): Slot<T> {
    const r = records.find(r => r.key === key);
    return { key, version: r?.version ?? 0, value: r ? envelope(r.value, field) as T : fallback };
}
function users(records: readonly DurableRecord[]): Administrator[] {
    const result = records.filter(r => r.key.startsWith('user:')).map(r => { const u = validateUser(envelope(r.value, 'user')); if (r.key !== 'user:' + u.id)
        fail('corrupt_state', 503); const c = localValue(records.find(r => r.key === 'credential:' + u.id)); return { ...u, passwordHash: c?.passwordHash ?? '', temporary: c?.temporary ?? false }; });
    if (result.length > MAX_USERS || new Set(result.map(u => u.username)).size !== result.length)
        fail('corrupt_state', 503);
    return result;
}
function settings(records: readonly DurableRecord[]): Slot<LoginSettings> {
    const s = entry(records, 'login-settings', 'settings', EMPTY_SETTINGS), v = s.value!;
    requireReadyRecord(records, s.version);
    if (!v || Object.keys(v).some(k => !['autoCreateUsers', 'sessionEpoch', 'failureEpoch'].includes(k)) || typeof v.autoCreateUsers !== 'boolean' || ![v.sessionEpoch, v.failureEpoch].every(n => Number.isSafeInteger(n) && n > 0))
        fail('corrupt_state', 503);
    return s;
}
function turnstile(records: readonly DurableRecord[]): Slot<Turnstile> {
    const s = entry(records, 'turnstile', 'turnstile', EMPTY_TURNSTILE), v = s.value!;
    requireReadyRecord(records, s.version);
    if (!v || Object.keys(v).some(k => !['enabled', 'siteKey', 'secretRef', 'hostnames'].includes(k)) || typeof v.enabled !== 'boolean' || typeof v.siteKey !== 'string' || typeof v.secretRef !== 'string' || !Array.isArray(v.hostnames) || v.hostnames.some(h => typeof h !== 'string') || (v.enabled && (!v.siteKey || !v.secretRef || !v.hostnames.length)))
        fail('corrupt_state', 503);
    return s;
}
function requireReadyRecord(records: readonly DurableRecord[], version: number) {
    const setup = records.find(r => r.key === 'setup');
    if (!version && setup && (envelope(setup.value, 'setup') as Setup).phase === 'ready') fail('corrupt_state', 503);
}
function connectionSlots(records: readonly DurableRecord[]): Slot<Connection>[] {
    const ids = new Set<string>();
    const result = records.filter(r => r.key.startsWith('connection:')).map(r => {
        const c = envelope(r.value, 'connection') as Connection | null;
        if (c === null) return { key: r.key, version: r.version, value: null };
        if (!c || (c.deleting !== undefined && (!c.deleting || c.enabled || Object.keys(c.deleting).some(k => k !== 'secretRefs') || !Array.isArray(c.deleting.secretRefs) || c.deleting.secretRefs.length > MAX_FLOWS + 1 || c.deleting.secretRefs.some(ref => typeof ref !== 'string' || !/^auth-secret:(\d+):([1-9]\d*)$/.test(ref)))) || Object.keys(c).some(k => !['id', 'label', 'enabled', 'issuer', 'provider', 'configuration', 'clientId', 'secretRef', 'scopes', 'generation', 'deleting'].includes(k)) || typeof c.id !== 'string' || !/^[a-f0-9-]{36}$/.test(c.id) || ids.has(c.id) || typeof c.label !== 'string' || typeof c.enabled !== 'boolean' || typeof c.issuer !== 'string' || typeof c.clientId !== 'string' || typeof c.secretRef !== 'string' || !Array.isArray(c.scopes) || (c.provider !== 'github' && !c.scopes.includes('openid')) || c.scopes.some(s => typeof s !== 'string') || !Number.isSafeInteger(c.generation) || c.generation < 1)
            fail('corrupt_state', 503);
        try { const parsed = parseProvider(c.provider, c.configuration, c.provider === 'oidc' ? c.scopes : undefined); if (JSON.stringify(parsed) !== JSON.stringify({provider: c.provider, issuer: c.issuer, configuration: c.configuration, scopes: c.scopes})) fail('corrupt_state', 503); } catch { fail('corrupt_state', 503); }
        ids.add(c.id);
        return { key: r.key, version: r.version, value: c };
    });
    if (result.length > MAX_CONNECTIONS)
        fail('corrupt_state', 503);
    return result;
}
function connections(records: readonly DurableRecord[]): Connection[] { return connectionSlots(records).flatMap(slot => slot.value && !slot.value.deleting ? [slot.value] : []); }
function identities(records: readonly DurableRecord[]): Identity[] {
    const result = records.filter(r => r.key.startsWith('identity:')).flatMap(r => { const i = envelope(r.value, 'identity') as Identity | null; if (i === null)
        return []; if (!i || Object.keys(i).some(k => !['id', 'userId', 'connectionId', 'issuer', 'subject', 'protocol'].includes(k)) || typeof i.userId !== 'string' || typeof i.connectionId !== 'string' || typeof i.issuer !== 'string' || !['oidc', 'oauth2'].includes(i.protocol) || typeof i.subject !== 'string' || !i.subject || r.key !== 'identity:' + i.id || i.id !== digest(i.issuer + '\0' + i.subject))
        fail('corrupt_state', 503); return [i]; });
    if (result.length > MAX_IDENTITIES)
        fail('corrupt_state', 503);
    return result;
}
function envelope(value: unknown, field: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('corrupt_state', 503);
    const v = value as Record<string, unknown>;
    if (v.schema !== ACCOUNT_RECORD_SCHEMA || !Object.hasOwn(v, field) || Object.keys(v).some(k => k !== 'schema' && k !== field))
        fail('corrupt_state', 503);
    return v[field];
}
function validateSession(value: unknown): Session | null {
    if (value === null)
        return null;
    const s = value as Session;
    if (!s || Object.keys(s).some(k => !['digest', 'administratorId', 'generation', 'created', 'touched', 'pendingTouch', 'transport', 'policy', 'epoch', 'connectionId', 'connectionGeneration'].includes(k)) || !/^[a-f0-9]{64}$/.test(s.digest) || typeof s.administratorId !== 'string' || !s.administratorId || !Number.isSafeInteger(s.generation) || s.generation < 1 || !Number.isSafeInteger(s.created) || s.created < 0 || !Number.isSafeInteger(s.touched) || s.touched < s.created || (s.pendingTouch !== undefined && (!Number.isSafeInteger(s.pendingTouch) || s.pendingTouch < s.touched)) || !Number.isSafeInteger(s.epoch) || s.epoch < 1 || (s.connectionId !== undefined && (typeof s.connectionId !== 'string' || !Number.isSafeInteger(s.connectionGeneration))) || !['cookie', 'bearer'].includes(s.transport))
        fail('corrupt_state', 503);
    validateSessionPolicy(s.policy, 'corrupt_state', 503);
    return s;
}
function validateFailure(value: unknown): Failure | null {
    if (value === null)
        return null;
    const f = value as Failure;
    if (!f || Object.keys(f).some(k => !['key', 'count', 'until', 'epoch'].includes(k)) || typeof f.key !== 'string' || !/^(account|source|challenge):[a-f0-9]{64}$/.test(f.key) || !Number.isSafeInteger(f.count) || f.count < 0 || !Number.isSafeInteger(f.until) || f.until < 0 || !Number.isSafeInteger(f.epoch) || f.epoch < 1)
        fail('corrupt_state', 503);
    return f;
}
function validateFlow(v: unknown): AuthFlow | null {
    if (v === null) return null;
    const f = v as AuthFlow;
    if (!f || Object.keys(f).some(k => !['id', 'state', 'nonce', 'verifierRef', 'connectionId', 'generation', 'created', 'expiresAt', 'epoch', 'returnTo', 'status', 'initiator', 'subject', 'issuer', 'protocol'].includes(k)) || typeof f.id !== 'string' || typeof f.state !== 'string' || typeof f.nonce !== 'string' || typeof f.verifierRef !== 'string' || typeof f.connectionId !== 'string' || !Number.isSafeInteger(f.generation) || !Number.isSafeInteger(f.created) || !Number.isSafeInteger(f.expiresAt) || !Number.isSafeInteger(f.epoch) || !['pending', 'exchanging', 'verified', 'consumed'].includes(f.status) || typeof f.returnTo !== 'string' || (f.subject !== undefined && typeof f.subject !== 'string') || (f.issuer !== undefined && typeof f.issuer !== 'string') || (f.protocol !== undefined && !['oidc', 'oauth2'].includes(f.protocol)) || (f.status === 'verified' && (!f.subject || !f.issuer || !f.protocol)) || (f.initiator !== undefined && (!f.initiator || typeof f.initiator.userId !== 'string' || typeof f.initiator.sessionDigest !== 'string' || !Number.isSafeInteger(f.initiator.generation))))
        fail('corrupt_state', 503);
    return f;
}
function slots<T extends Session | Failure | AuthFlow>(records: readonly DurableRecord[], kind: string, limit: number, validate: (v: unknown) => T | null): Slot<T>[] {
    const result: Slot<T>[] = Array.from({ length: limit }, (_, i) => ({ key: `${kind}:${i}`, version: 0, value: null }));
    const seen = new Set<string>();
    for (const r of records.filter(r => r.key.startsWith(kind + ':'))) {
        const index = Number(r.key.slice(kind.length + 1));
        if (!Number.isInteger(index) || index < 0 || index >= limit || r.key !== `${kind}:${index}`)
            fail('corrupt_state', 503);
        const value = validate(envelope(r.value, kind));
        const identity = value && (kind === 'session' ? (value as Session).digest : kind === 'failure' ? (value as Failure).key : (value as AuthFlow).id);
        if (identity && seen.has(identity))
            fail('corrupt_state', 503);
        if (identity)
            seen.add(identity);
        result[index] = { key: r.key, version: r.version, value };
    }
    return result;
}
const mutation = <T>(slot: Slot<T>, field: string, value: T | null): DurableMutation => ({ key: slot.key, expectedVersion: slot.version, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, [field]: value }) });
function next(value: number): number { if (!Number.isSafeInteger(value + 1))
    fail('generation_overflow'); return value + 1; }
interface Setup {
    phase: 'uninitialized' | 'ready';
}
interface Clock {
    version: number;
    value: number;
    readVersion?: number;
}
type StateReader = Pick<PluginDurableState, 'get' | 'list'>;
type RecoveryContext = {
    durableState: PluginDurableState;
    now?: () => number;
};
function validateKeys(records: readonly DurableRecord[]) {
    for (const r of records)
        if (!['setup', 'clock', 'session-policy', 'recovery-summary', 'recovery-anchor', 'login-settings', 'turnstile'].includes(r.key) && !['session:', 'failure:', 'user:', 'credential:', 'identity:', 'connection:', 'flow:', 'audit:'].some(p => r.key.startsWith(p)))
            fail('corrupt_state', 503);
}
function validateAudit(records:readonly DurableRecord[]){
    for(const record of records.filter(r=>r.key.startsWith('audit:'))){
        const index=Number(record.key.slice(6));
        const value=envelope(record.value,'audit') as {actor:string;action:string;result:string;at:number};
        if(!Number.isInteger(index)||index<0||index>=MAX_AUDIT||record.key!=='audit:'+index||!value||Object.keys(value).some(k=>!['actor','action','result','at'].includes(k))||[value.actor,value.action,value.result].some(v=>typeof v!=='string'||!v||v.length>128)||!Number.isSafeInteger(value.at)||value.at<0)fail('corrupt_state',503);
    }
}
function clockValue(record: DurableRecord | undefined | null): number {
    if (!record)
        fail('corrupt_state', 503);
    const value = envelope(record.value, 'observedThrough');
    if (!Number.isSafeInteger(value) || (value as number) < 0)
        fail('corrupt_state', 503);
    return value as number;
}
function wallTime(now: () => number): number { const value = now(); if (!Number.isSafeInteger(value) || value < 0)
    fail('invalid_clock', 503); return value; }
function clockMutation(clock: Clock): DurableMutation { return { key: 'clock', expectedVersion: clock.version, value: { schema: ACCOUNT_RECORD_SCHEMA, observedThrough: clock.value } }; }
async function observeClock(state: PluginDurableState, now: () => number): Promise<Clock> {
    for (let i = 0; i < 64; i++) {
        const record = await state.get('clock'), prior = clockValue(record), value = Math.max(prior, wallTime(now));
        if (value === prior)
            return { version: record!.version, value, readVersion: record!.version };
        try {
            const [saved] = await state.transact([clockMutation({ version: record!.version, value })]);
            return { version: saved!.version, value, readVersion: record!.version };
        }
        catch (e) {
            if (!isDurableStateConflictError(e))
                throw e;
        }
    }
    return fail('version_conflict', 409);
}
function setupRecord(records: readonly DurableRecord[]): {
    key: string;
    version: number;
    value: Setup;
} {
    validateKeys(records);
    const record = records.find(r => r.key === 'setup');
    if (!record)
        fail('corrupt_state', 503);
    const value = envelope(record.value, 'setup') as Setup;
    if (!value || !['uninitialized', 'ready'].includes(value.phase) || Object.keys(value).some(k => k !== 'phase'))
        fail('corrupt_state', 503);
    const all = users(records), anchor = records.find(r => r.key === 'recovery-anchor');
    if ((value.phase === 'ready') !== !!all.length || (value.phase === 'ready' && (!anchor || typeof envelope(anchor.value, 'userId') !== 'string')))
        fail('corrupt_state', 503);
    validateAudit(records);
    settings(records);
    turnstile(records);
    connections(records);
    identities(records);
    clockValue(records.find(r => r.key === 'clock'));
    return { key: 'setup', version: record.version, value };
}
export class UserAuthControl implements PluginControl, ManagementProvider {
    readonly management = this;
    readonly rpc = [];
    readonly api;
    private readonly state: PluginDurableState;
    private readonly now: () => number;
    private readonly subjects = new WeakMap<ManagementSubject, {
        generation: number;
        digest: string;
    }>();
    // Positive lookups only; bounded by the fixed session slots, never by attacker tokens.
    private readonly sessionSlots = new Map<string, string>();
    private dummy = '';
    private disposed = false;
    private stateTail: Promise<void> = Promise.resolve();
    private pendingStateOperations = 0;
    constructor(private readonly host: ControlHostContext, private readonly dependencies: Dependencies = {}) {
        if (!host.durableState)
            fail('durable_state_required', 503);
        this.state = host.durableState;
        this.now = dependencies.now ?? Date.now;
        const invoke = (fn: (c: ControlApiHandlerContext) => Promise<Response>) => async (c: ControlApiHandlerContext) => {
            try {
                this.alive();
                if (c.requestSignal.aborted)
                    fail('cancelled');
                return await fn(c);
            }
            catch (e) {
                return safe(e);
            }
        };
        this.api = [
            { path: '/password', methods: ['POST'], handler: 'changePassword', invoke: invoke(async (c) => {
                    await this.requireCapability(c, 'self.password', true);
                    const b = await body(c.request);
                    exact(b, ['currentPassword', 'password', 'passwordConfirmation']);
                    await this.changePassword(c, b);
                    return json({ ok: true }, 200, { 'set-cookie': cookie(c.request, '', 0, this.host.managementOrigin) });
                }) },
            { path: '/logout', methods: ['POST'], handler: 'logout', invoke: invoke(async (c) => { await this.requireCapability(c, 'self.logout', true); return this.logout(c.request); }) },
            { path: '/self', methods: ['GET'], handler: 'self', invoke: invoke(async (c) => {
                    await this.requireCapability(c, 'self.password');
                    return this.retry(async (time) => { const { user } = await this.guard(c, time), creds = credentials(c.request); return { mutations: [], result: json({ administrator: dto(user), ...(creds?.transport === 'cookie' ? { csrfToken: csrf(creds.token) } : {}) }) }; });
                }) },
            { path: '/session-policy', methods: ['GET', 'PUT'], handler: 'sessionPolicy', invoke: invoke(async (c) => {
                    await this.requireCapability(c, 'config.write', c.request.method === 'PUT');
                    if (c.request.method === 'GET')
                        return this.retry(async (time) => { const policy = await this.readSessionPolicy(); await this.guard(c, time); return { mutations: [], result: json(policy) }; });
                    const b = await body(c.request);
                    exact(b, ['version', 'policy']);
                    if (!Number.isSafeInteger(b.version) || (b.version as number) < 0)
                        fail('invalid_session_policy');
                    const policy = validateSessionPolicy(b.policy);
                    await this.requireCapability(c, 'config.write', true);
                    try {
                        await this.retry(async (time) => { await this.guard(c, time); return { mutations: [{ key: 'session-policy', expectedVersion: b.version as number, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, policy }) }], result: undefined }; });
                    }
                    catch (e) {
                        if (isDurableStateConflictError(e))
                            fail('version_conflict', 409);
                        throw e;
                    }
                    return json(await this.readSessionPolicy());
                }) },
            ...this.featureApi(invoke),
        ];
    }
    private alive() { if (this.disposed || this.host.signal.aborted)
        fail('provider_unavailable', 503); }
    private async readAdministrator(id?: string): Promise<Slot<Administrator>> {
        this.alive();
        if (!id) {
            const all = users(await this.records());
            id = all[0]?.id;
        }
        if (!id)
            return { key: 'user:missing', version: 0, value: null };
        const record = await this.state.get('user:' + id);
        if (!record)
            return { key: 'user:' + id, version: 0, value: null };
        const user = validateUser(envelope(record.value, 'user')), credential = localValue(await this.state.get('credential:' + id));
        if (user.id !== id)
            fail('corrupt_state', 503);
        return { key: record.key, version: record.version, value: { ...user, passwordHash: credential?.passwordHash ?? '', temporary: credential?.temporary ?? false } };
    }
    private userMutation(slot: Slot<Administrator>, value: Administrator): DurableMutation { const { passwordHash, temporary, ...user } = value; return mutation(slot, 'user', user); }
    private credentialMutation(records: readonly DurableRecord[], id: string, hash: string): DurableMutation { const r = records.find(r => r.key === 'credential:' + id); return { key: 'credential:' + id, expectedVersion: r?.version ?? 0, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, credential: { passwordHash: hash, temporary: false } }) }; }
    private async records() {
        this.alive();
        const records = await this.state.list();
        setupRecord(records);
        return records;
    }
    private async retry<T>(plan: (time: () => Promise<number>) => Promise<{
        mutations: DurableMutation[];
        result: T;
    }>): Promise<T> {
        // Serialize this instance's planners: parallel requests must not continually
        // invalidate each other's clock fences. Cross-instance changes still use CAS.
        if (this.pendingStateOperations >= 256)
            fail('provider_busy', 503);
        this.pendingStateOperations++;
        const task = this.stateTail.then(async () => {
            await this.cleanupDeletedConnections();
            const result = await this.retryState(plan);
            await this.cleanupDeletedConnections();
            return result;
        });
        this.stateTail = task.then(() => { }, () => { });
        try {
            return await task;
        }
        finally {
            this.pendingStateOperations--;
        }
    }
    private async retryState<T>(plan: (time: () => Promise<number>) => Promise<{
        mutations: DurableMutation[];
        result: T;
    }>): Promise<T> {
        for (let i = 0; i < 64; i++) {
            const before = await this.state.get('clock');
            clockValue(before);
            let clock: Clock | undefined;
            // Each planner reads its business records first and observes time last.
            // This prevents delayed reads from renewing an already expired session.
            const time = async () => { const prior = clock, observed = await observeClock(this.state, this.now); clock = prior && observed.readVersion === prior.version ? { ...observed, readVersion: prior.readVersion } : observed; return clock.value; };
            let planned: {
                mutations: DurableMutation[];
                result: T;
            };
            try {
                planned = await plan(time);
            }
            catch (error) {
                await time();
                throw error;
            }
            if (!clock)
                await time();
            // A different control may change identity or touch a slot while we read.
            // Its clock fence invalidates the entire read set, including read-only authorization.
            if (clock!.readVersion !== before!.version)
                continue;
            if (!planned.mutations.length)
                return planned.result;
            this.alive();
            try {
                await this.state.transact([...planned.mutations, clockMutation(clock!)]);
                return planned.result;
            }
            catch (e) {
                if (!isDurableStateConflictError(e))
                    throw e;
            }
        }
        return fail('version_conflict', 409);
    }
    private async cleanupDeletedConnections(): Promise<void> {
        // Ordinary authentication must not add clock transactions for an absent job.
        // A concurrent deletion still invalidates the caller's business read via CAS;
        // its durable marker is resumed by the next cleanup check.
        if (!connectionSlots(await this.state.list()).some(slot => slot.value?.deleting)) return;
        // The deletion fence and user revocations commit together. The connection
        // retains all secret references until cleanup is confirmed, including after
        // a process exit or lost ACK. Cleanup does not depend on the deleting session.
        for (;;) {
            const pending = await this.retryState(async () => {
                const records = await this.records();
                const slot = connectionSlots(records).find(s => s.value?.deleting);
                if (!slot) return { mutations: [], result: { done: true, connection: null as Connection | null } };
                const id = slot.value!.id;
                const bindings = identities(records).filter(i => i.connectionId === id);
                const flows = this.flows(records).filter(f => f.value?.connectionId === id);
                const changes = [
                    ...bindings.map(i => mutation(entry(records, 'identity:' + i.id, 'identity', null), 'identity', null)),
                    ...flows.map(f => mutation(f, 'flow', null)),
                ];
                // Reserve the last mutation for the clock fence.
                return { mutations: changes.slice(0, 255), result: { done: false, connection: changes.length ? null : slot.value } };
            });
            if (pending.done) return;
            if (!pending.connection) continue;
            for (const ref of pending.connection.deleting!.secretRefs) {
                const match = /^auth-secret:(\d+):([1-9]\d*)$/.exec(ref)!;
                const key = 'auth-secret:' + match[1], version = Number(match[2]);
                const saved = await this.host.secretStore.get(key);
                // Another control may already have removed or reused the secret slot.
                if (saved?.version === version) await this.host.secretStore.delete(key, version);
            }
            await this.retryState(async () => {
                const records = await this.records();
                const slot = connectionSlots(records).find(s => s.value?.id === pending.connection!.id && s.value.deleting);
                return { mutations: slot ? [mutation(slot, 'connection', null)] : [], result: undefined };
            });
        }
    }
    private async readSessionPolicy(): Promise<{
        version: number;
        policy: SessionPolicy;
    }> {
        this.alive();
        const record = await this.state.get('session-policy');
        return { version: record?.version ?? 0, policy: record ? validateSessionPolicy(envelope(record.value, 'policy'), 'corrupt_state', 503) : { ...DEFAULT_SESSION_POLICY } };
    }
    async start() {
        await clearSetupCode(this.state);
        await ensureSetup(this.state, this.now);
        await readManagementSetup(this.state);
        await observeClock(this.state, this.now);
        await this.readSessionPolicy();
        const records = await this.records();
        slots(records, 'session', MAX_SESSIONS, validateSession);
        slots(records, 'failure', MAX_FAILURES, validateFailure);
        this.flows(records);
        for (const r of records.filter(r => r.key.startsWith('credential:'))) {
            localValue(r);
            if (!users(records).some(u => r.key === 'credential:' + u.id))
                fail('corrupt_state', 503);
        }
        await this.cleanupDeletedConnections();
        this.dummy = await this.hash(randomBytes(32).toString('base64url'));
    }
    dispose() { this.disposed = true; }
    private hash(p: string) { return Bun.password.hash(p, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 }); }
    async setupStatus(): Promise<'uninitialized' | 'ready'> { return (await readManagementSetup(this.state)).initialized ? 'ready' : 'uninitialized'; }
    async hasIdentity() { return await this.setupStatus() === 'ready' && users(await this.records()).some(u => !u.disabled); }
    async revokeSessions() { await this.retry(async () => { const s = settings(await this.records()); return { mutations: [mutation(s, 'settings', { ...s.value!, sessionEpoch: next(s.value!.sessionEpoch) })], result: undefined }; }); }
    async bootstrap(input: unknown) {
        try {
            const b = object(input);
            if (b.operation === 'initialize') {
                exact(b, ['operation', 'username', 'password', 'passwordConfirmation']);
                await this.createInitialUser(b);
                return;
            }
            if (b.operation !== 'verify') fail('invalid_input');
            exact(b, ['operation', 'username', 'password']);
            const name = username(b.username), p = password(b.password);
            if (await this.setupStatus() !== 'ready') fail('initialization_required', 409);
            const prior = users(await this.records()).find(u => u.username === name);
            if (!prior?.passwordHash || prior.disabled || !await Bun.password.verify(p, prior.passwordHash))
                fail('invalid_credentials', 401);
            const latest = (await this.readAdministrator(prior.id)).value;
            if (!latest || latest.generation !== prior.generation || latest.username !== prior.username || latest.disabled)
                fail('invalid_credentials', 401);
        } catch (error) {
            if (error instanceof AccountError && ['invalid_password', 'password_confirmation'].includes(error.code))
                fail('invalid_input');
            throw error;
        }
    }
    private async createInitialUser(b: Record<string, unknown>) {
        const name = username(b.username), p = this.confirmPassword(b);
        if (validateState(await this.records()).value.phase !== 'uninitialized') fail('already_initialized', 409);
        const passwordHash = await this.hash(p);
        await this.retry(async () => {
            const records = await this.records();
            if (validateState(records).value.phase !== 'uninitialized') fail('already_initialized', 409);
            const account: User = { id: randomUUID(), username: name, displayName: name, disabled: false, generation: 1 };
            return { mutations: initialUserMutations(records, account, passwordHash), result: undefined };
        });
    }
    private source(request: Request): string { return (this.dependencies.trustedSource ?? this.host.trustedSource)?.(request) ?? 'unknown'; }
    private async reserve(keys: string[]): Promise<number> {
        return this.retry(async (time) => {
            const epoch = settings(await this.records()).value!.failureEpoch;
            const failures = slots(await this.records(), 'failure', MAX_FAILURES, validateFailure), selected: Slot<Failure>[] = [], now = await time();
            for (const key of keys) {
                let slot = failures.find(x => !selected.includes(x) && x.value?.key === key);
                const active = slot?.value && slot.value.epoch === epoch && slot.value.until > now;
                if (active && slot!.value!.count >= 10)
                    fail('login_limited', 429);
                slot ??= failures.find(x => !selected.includes(x) && (!x.value || x.value.epoch !== epoch || x.value.until <= now));
                if (!slot)
                    fail('login_limited', 429);
                selected.push(slot);
            }
            return { mutations: selected.map((slot, i) => { const prior = slot.value; return mutation(slot, 'failure', { key: keys[i]!, count: prior && prior.key === keys[i] && prior.epoch === epoch && prior.until > now ? prior.count + 1 : 1, until: prior && prior.key === keys[i] && prior.epoch === epoch && prior.until > now ? prior.until : now + 15 * 60000, epoch }); }), result: epoch };
        });
    }
    async initialize(request: Request): Promise<Response> {
        try {
            this.alive();
            if (request.method !== 'POST')
                fail('method_not_allowed', 405);
            origin(request, this.host.managementOrigin);
            const b = await body(request);
            exact(b, ['username', 'password', 'passwordConfirmation']);
            await this.createInitialUser(b);
            return json({ initialized: true });
        }
        catch (e) {
            return safe(e);
        }
    }
    private live(m: Administrator | null, session: Session, now: number, records: readonly DurableRecord[]): Administrator | undefined {
        if (session.epoch !== settings(records).value!.sessionEpoch)
            return;
        if (session.connectionId) {
            const c = connections(records).find(c => c.id === session.connectionId);
            if (!c?.enabled || c.generation !== session.connectionGeneration)
                return;
        }
        const policy = session.policy;
        if (now < session.touched || now < session.created || (policy.idleTimeoutMinutes > 0 && now - session.touched >= policy.idleTimeoutMinutes * 60000) || now - session.created >= policy.absoluteTimeoutMinutes * 60000)
            return;
        return m && m.id === session.administratorId && !m.disabled && m.generation === session.generation ? m : undefined;
    }
    private async findSession(d: string): Promise<Slot<Session> | undefined> {
        this.alive();
        const key = this.sessionSlots.get(d);
        if (key) {
            const record = await this.state.get(key), value = record && validateSession(envelope(record.value, 'session'));
            if (record && value?.digest === d)
                return { key, version: record.version, value };
            this.sessionSlots.delete(d);
        }
        const found = slots(await this.records(), 'session', MAX_SESSIONS, validateSession).find(x => x.value?.digest === d);
        if (found) {
            if (this.sessionSlots.size >= MAX_SESSIONS)
                this.sessionSlots.clear();
            this.sessionSlots.set(d, found.key);
        }
        return found;
    }
    private cookieAge(policy: SessionPolicy, elapsedMs = 0): number { return Math.max(0, Math.min(COOKIE_LEASE_SECONDS, Math.floor((policy.absoluteTimeoutMinutes * 60000 - elapsedMs) / 1000))); }
    async sessionCookie(request: Request): Promise<string | undefined> {
        this.alive();
        const creds = credentials(request);
        if (creds?.transport !== 'cookie')
            return;
        return this.retry(async (time) => {
            const slot = await this.findSession(digest(creds.token)), session = slot?.value, m = (await this.readAdministrator(session?.administratorId)).value, records = await this.records(), now = await time();
            return { mutations: [], result: session && session.transport === 'cookie' && this.live(m, session, now, records) ? cookie(request, creds.token, this.cookieAge(session.policy, now - session.created), this.host.managementOrigin) : undefined };
        });
    }
    async authenticate(request: Request): Promise<ManagementSubject | null> {
        this.alive();
        const c = credentials(request);
        if (!c)
            return null;
        const d = digest(c.token);
        // A queued write or a lost ACK must never publish an unchecked extension.
        // Pending activity shares the fixed slot but live() only trusts touched.
        const prepared = await this.retry(async (time) => {
            const slot = await this.findSession(d), session = slot?.value, m = (await this.readAdministrator(session?.administratorId)).value, records = await this.records(), now = await time();
            const administrator = session && session.transport === c.transport && this.live(m, session, now, records);
            if (!slot || !session || !administrator)
                return { mutations: [], result: false };
            return { mutations: session.pendingTouch === undefined ? [mutation(slot, 'session', { ...session, pendingTouch: now })] : [], result: true };
        }).catch(async (error) => {
            // A failed/unknown prepare still observes the error-return time when
            // storage is reachable. Preserve the original failure if the clock also
            // cannot be persisted; pending itself never extends the session.
            try {
                await observeClock(this.state, this.now);
            }
            catch { }
            throw error;
        });
        if (!prepared)
            return null;
        const authenticated = await this.retry(async (time) => {
            const slot = await this.findSession(d), session = slot?.value, m = (await this.readAdministrator(session?.administratorId)).value, records = await this.records(), now = await time();
            const administrator = session && session.transport === c.transport && this.live(m, session, now, records);
            if (!slot || !session || !administrator)
                return { mutations: [], result: null };
            // Observing committed pending activity before the old deadline qualifies
            // its renewal. Slot + clock CAS bind this observation to the exact session
            // and identity generation. Another reader may already have confirmed it.
            const { pendingTouch, ...confirmed } = session;
            // A pending marker may outlive a lost ACK; successful activity renews from
            // this confirmation observation, not from the earlier preparation time.
            return { mutations: pendingTouch === undefined ? [] : [mutation(slot, 'session', { ...confirmed, touched: now })], result: administrator };
        });
        if (!authenticated)
            return null;
        const subject = Object.freeze({ id: authenticated.id, provider: PROVIDER, capabilities: Object.freeze([...ALL]), requiresPasswordChange: authenticated.temporary });
        this.subjects.set(subject, { generation: authenticated.generation, digest: d });
        return await this.authorize(subject, 'config.read') ? subject : null;
    }
    async authorize(subject: ManagementSubject, _capability: string): Promise<boolean> {
        this.alive();
        const issued = this.subjects.get(subject);
        if (!issued || subject.provider !== PROVIDER)
            return false;
        return this.retry(async (time) => {
            const slot = await this.findSession(issued.digest), session = slot?.value, account = (await this.readAdministrator(session?.administratorId)).value, records = await this.records(), now = await time(), m = session && this.live(account, session, now, records);
            return { mutations: [], result: !!m && m.id === subject.id && m.generation === issued.generation };
        });
    }
    private async requireCapability(c: ControlApiHandlerContext, capability: string, write = false) { if (!c.subject || !credentials(c.request) || this.subjects.get(c.subject)?.digest !== digest(credentials(c.request)!.token) || !await this.authorize(c.subject, capability))
        fail('forbidden', 403); if (write)
        this.checkWrite(c.request); }
    validateWrite(request: Request) { this.checkWrite(request); }
    csrfToken(request: Request): string | undefined { const c = credentials(request); return c?.transport === 'cookie' ? csrf(c.token) : undefined; }
    private checkWrite(request: Request) { const c = credentials(request); if (!c)
        fail('unauthorized', 401); if (c.transport === 'cookie') {
        origin(request, this.host.managementOrigin);
        if (!constant(request.headers.get('x-csrf-token') ?? '', csrf(c.token)))
            fail('invalid_csrf', 403);
    } }
    async login(request: Request): Promise<Response> {
        try {
            this.alive();
            if (request.method !== 'POST')
                fail('method_not_allowed', 405);
            const b = await body(request);
            exact(b, ['username', 'password', 'transport', 'turnstileToken']);
            const name = username(b.username), p = typeof b.password === 'string' ? b.password : '';
            const transport = b.transport ?? 'cookie';
            if (transport !== 'cookie' && transport !== 'bearer')
                fail('invalid_input');
            if (transport === 'cookie' || request.headers.has('origin'))
                origin(request, this.host.managementOrigin);
            const keys = ['account:' + digest(name), 'source:' + digest(this.source(request))];
            const reservation = await this.reserve(keys);
            if (await this.setupStatus() !== 'ready')
                fail('invalid_credentials', 401);
            const turn = turnstile(await this.records());
            await this.verifyTurnstile(b.turnstileToken, turn.value!, request);
            const administrator = users(await this.records()).find(u => u.username === name);
            const valid = await Bun.password.verify(p, administrator?.passwordHash || this.dummy || await this.hash('dummy-invalid-password'));
            if (!valid || !administrator || !administrator.passwordHash || administrator.disabled)
                fail('invalid_credentials', 401);
            const token = randomBytes(32).toString('base64url');
            let policy: SessionPolicy = { ...DEFAULT_SESSION_POLICY };
            const created = await this.retry(async (time) => {
                const m = (await this.readAdministrator(administrator.id)).value;
                if (!m || m.id !== administrator.id || m.username !== administrator.username || m.disabled || m.generation !== administrator.generation)
                    fail('invalid_credentials', 401);
                const records = await this.records();
                policy = (await this.readSessionPolicy()).policy;
                if (settings(records).value!.failureEpoch !== reservation || turnstile(records).version !== turn.version)
                    fail('version_conflict', 409);
                const now = await time(), sessions = slots(records, 'session', MAX_SESSIONS, validateSession), slot = sessions.find(x => !x.value || !this.live(users(records).find(u => u.id === x.value!.administratorId) ?? null, x.value, now, records));
                if (!slot)
                    fail('session_limit', 429);
                const changes = [mutation(slot, 'session', { digest: digest(token), administratorId: m.id, generation: m.generation, created: now, touched: now, transport, policy, epoch: settings(records).value!.sessionEpoch }), this.audit(records, m.id, 'local.login', now)];
                const failures = slots(records, 'failure', MAX_FAILURES, validateFailure);
                const account = failures.find(x => x.value?.key === keys[0] && x.value.epoch === reservation);
                if (account)
                    changes.push(mutation(account, 'failure', null));
                const source = failures.find(x => x.value?.key === keys[1] && x.value.epoch === reservation);
                if (source)
                    changes.push(mutation(source, 'failure', { ...source.value!, count: Math.max(0, source.value!.count - 1) }));
                return { mutations: changes, result: now };
            });
            const latest = (await this.readAdministrator(administrator.id)).value;
            if (!latest || latest.disabled || latest.generation !== administrator.generation || latest.id !== administrator.id)
                fail('invalid_credentials', 401);
            return transport === 'cookie' ? json({ administrator: dto(administrator), csrfToken: csrf(token) }, 200, { 'set-cookie': cookie(request, token, this.cookieAge(policy, (await observeClock(this.state, this.now)).value - created), this.host.managementOrigin) }) : json({ administrator: dto(administrator), token, expiresIn: policy.absoluteTimeoutMinutes * 60 });
        }
        catch (e) {
            await this.recordFailure('local.login',e);
            return safe(e);
        }
    }
    async logout(request: Request): Promise<Response> {
        try {
            this.alive();
            if (request.method !== 'POST')
                fail('method_not_allowed', 405);
            this.checkWrite(request);
            const c = credentials(request)!;
            await this.retry(async () => { const slot = await this.findSession(digest(c.token)); return { mutations: slot?.value ? [mutation(slot, 'session', null)] : [], result: undefined }; });
            return json({ ok: true }, 200, { 'set-cookie': cookie(request, '', 0, this.host.managementOrigin) });
        }
        catch (e) {
            return safe(e);
        }
    }
    private async changePassword(c: ControlApiHandlerContext, b: Record<string, unknown>) {
        const p = password(b.password);
        if (b.passwordConfirmation !== p)
            fail('password_confirmation');
        const id = c.subject!.id, m = (await this.readAdministrator(id)).value;
        if (!m || !m.passwordHash || m.id !== id || typeof b.currentPassword !== 'string' || !await Bun.password.verify(b.currentPassword, m.passwordHash))
            fail('invalid_credentials', 401);
        if (constant(p, b.currentPassword))
            fail('password_unchanged');
        const hashed = await this.hash(p);
        await this.retry(async (time) => {
            this.checkWrite(c.request);
            const a = await this.readAdministrator(id), current = a.value, records = await this.records();
            if (!current || current.id !== id || current.disabled || current.generation !== m.generation)
                fail('version_conflict', 409);
            const issued = this.subjects.get(c.subject!)!, slot = await this.findSession(issued.digest), now = await time();
            if (!slot?.value || !this.live(current, slot.value, now, records))
                fail('forbidden', 403);
            return { mutations: [this.userMutation(a, { ...current, generation: next(current.generation) }), this.credentialMutation(records, id, hashed), mutation(slot, 'session', null), this.audit(records, id, 'user.password.change', now)], result: undefined };
        });
    }
    private async guard(c: ControlApiHandlerContext, time: () => Promise<number>): Promise<{
        user: Administrator;
        records: readonly DurableRecord[];
    }> {
        this.checkWriteIfNeeded(c.request);
        const issued = c.subject && this.subjects.get(c.subject), creds = credentials(c.request);
        if (!issued || !creds || issued.digest !== digest(creds.token))
            fail('forbidden', 403);
        const slot = await this.findSession(issued.digest), records = await this.records(), user = users(records).find(u => u.id === c.subject!.id), now = await time();
        if (!slot?.value || slot.value.transport !== creds.transport || !user || user.generation !== issued.generation || !this.live(user, slot.value, now, records))
            fail('forbidden', 403);
        return { user, records };
    }
    private checkWriteIfNeeded(request: Request) { if (!['GET', 'HEAD'].includes(request.method))
        this.checkWrite(request); }
    private audit(records: readonly DurableRecord[], actor: string, action: string, at: number,result='success'): DurableMutation {
        const recordsBySlot = Array.from({ length: MAX_AUDIT }, (_, i) => records.find(r => r.key === 'audit:' + i));
        const index = recordsBySlot.findIndex(r => !r);
        const slot = index >= 0 ? index : recordsBySlot.reduce((best, r, i) => ((envelope(r!.value, 'audit') as {
            at: number;
        }).at < (envelope(recordsBySlot[best]!.value, 'audit') as {
            at: number;
        }).at ? i : best), 0);
        return { key: 'audit:' + slot, expectedVersion: recordsBySlot[slot]?.version ?? 0, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, audit: { actor, action, result, at } }) };
    }
    private async recordFailure(action:string,error:unknown){try{await this.retry(async time=>{const records=await this.records(),at=await time();return {mutations:[this.audit(records,'anonymous',action,at,error instanceof AccountError?error.code:'provider_unavailable')],result:undefined};});}catch{/* Audit failures cannot make a rejected authentication succeed. */}}
    private featureApi(invoke: (fn: (c: ControlApiHandlerContext) => Promise<Response>) => (c: ControlApiHandlerContext) => Promise<Response>) {
        const route = (path: string, methods: string[], handler: string, fn: (c: ControlApiHandlerContext) => Promise<Response>) => ({ path, methods, handler, invoke: invoke(fn) });
        return [
            route('/users', ['GET', 'POST'], 'users', async (c) => {
                await this.requireCapability(c, 'config.write', c.request.method === 'POST');
                if (c.request.method === 'GET')
                    return this.retry(async (time) => { const { records } = await this.guard(c, time); return { mutations: [], result: json({ users: users(records).map(dto) }) }; });
                const b = await body(c.request);
                exact(b, ['username', 'displayName', 'password', 'passwordConfirmation']);
                const name = username(b.username), displayName = this.displayName(b.displayName ?? name);
                const hash = b.password === undefined ? '' : await this.hash(this.confirmPassword(b)), id = randomUUID();
                return this.retry(async (time) => {
                    const { records, user } = await this.guard(c, time), all = users(records);
                    if (all.length >= MAX_USERS)
                        fail('user_limit', 409);
                    if (all.some(u => u.username === name))
                        fail('username_exists', 409);
                    const u: Administrator = { id, username: name, displayName, disabled: false, generation: 1, passwordHash: hash, temporary: false };
                    return { mutations: [this.userMutation({ key: 'user:' + id, version: 0, value: null }, u), ...(hash ? [this.credentialMutation(records, id, hash)] : []), this.audit(records, user.id, 'user.create', await time())], result: json({ user: dto(u) }, 201) };
                });
            }),
            route('/users/update', ['PUT'], 'updateUser', async (c) => {
                await this.requireCapability(c, 'config.write', true);
                const b = await body(c.request);
                exact(b, ['id', 'username', 'displayName', 'disabled']);
                const id = this.text(b.id, 64), name = username(b.username), displayName = this.displayName(b.displayName);
                if (typeof b.disabled !== 'boolean')
                    fail('invalid_input');
                return this.retry(async (time) => {
                    const { records, user } = await this.guard(c, time), all = users(records), u = all.find(u => u.id === id);
                    if (!u)
                        fail('not_found', 404);
                    if (all.some(u => u.id !== id && u.username === name))
                        fail('username_exists', 409);
                    if (b.disabled && !u.disabled && u.passwordHash && !all.some(x => x.id !== id && !x.disabled && x.passwordHash))
                        fail('last_local_user', 409);
                    const updated = { ...u, username: name, displayName, disabled: b.disabled as boolean, generation: b.disabled !== u.disabled ? next(u.generation) : u.generation };
                    const r = records.find(r => r.key === 'user:' + id)!;
                    return { mutations: [this.userMutation({ key: r.key, version: r.version, value: u }, updated), this.audit(records, user.id, 'user.update', await time())], result: json({ user: dto(updated) }) };
                });
            }),
            route('/users/password', ['POST'], 'resetUserPassword', async (c) => {
                await this.requireCapability(c, 'config.write', true);
                const b = await body(c.request);
                exact(b, ['id', 'password', 'passwordConfirmation']);
                const id = this.text(b.id, 64), hash = await this.hash(this.confirmPassword(b));
                return this.retry(async (time) => {
                    const { records, user } = await this.guard(c, time), u = users(records).find(u => u.id === id);
                    if (!u)
                        fail('not_found', 404);
                    const r = records.find(r => r.key === 'user:' + id)!;
                    return { mutations: [this.userMutation({ key: r.key, version: r.version, value: u }, { ...u, generation: next(u.generation) }), this.credentialMutation(records, id, hash), this.audit(records, user.id, 'user.password.reset', await time())], result: json({ ok: true }) };
                });
            }),
            route('/identities', ['GET', 'POST', 'DELETE'], 'identities', async (c) => {
                await this.requireCapability(c, 'config.write', c.request.method !== 'GET');
                const b = c.request.method === 'GET' ? {} : await body(c.request);
                exact(b, c.request.method === 'POST' ? ['userId', 'connectionId', 'subject'] : ['id']);
                return this.retry(async (time) => {
                    const { records, user } = await this.guard(c, time), all = identities(records);
                    if (c.request.method === 'GET') {
                        const id = new URL(c.request.url).searchParams.get('userId');
                        return { mutations: [], result: json({ identities: all.filter(i => !id || i.userId === id) }) };
                    }
                    let identity: Identity;
                    if (c.request.method === 'POST') {
                        const connection = connections(records).find(x => x.id === b.connectionId);
                        if (!connection)
                            fail('not_found', 404);
                        const ms = connection.configuration as MicrosoftConfiguration;
                        if (connection.provider === 'microsoft' && ['common', 'organizations'].includes(ms.accountType)) fail('verified_identity_required');
                        const identityIssuer = connection.provider === 'microsoft' && ms.accountType === 'consumers' ? 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' : connection.issuer;
                        const sub = this.text(b.subject, 255), id = digest(identityIssuer + '\0' + sub);
                        if (connection.provider === 'github' && (!/^[1-9][0-9]*$/.test(sub) || !Number.isSafeInteger(Number(sub)))) fail('invalid_oauth_identity');
                        if (all.some(x => x.id === id))
                            fail('identity_exists', 409);
                        if (all.length >= MAX_IDENTITIES)
                            fail('identity_limit', 409);
                        identity = { id, userId: this.text(b.userId, 64), connectionId: connection.id, issuer: identityIssuer, subject: sub, protocol: connection.provider === 'github' ? 'oauth2' : 'oidc' };
                    }
                    else {
                        const found = all.find(i => i.id === b.id);
                        if (!found)
                            fail('not_found', 404);
                        identity = found;
                    }
                    const target = users(records).find(u => u.id === identity.userId);
                    if (!target)
                        fail('not_found', 404);
                    const r = records.find(r => r.key === 'user:' + target.id)!, prior = entry(records, 'identity:' + identity.id, 'identity', null);
                    return { mutations: [mutation(prior, 'identity', c.request.method === 'POST' ? identity : null), this.userMutation({ key: r.key, version: r.version, value: target }, { ...target, generation: next(target.generation) }), this.audit(records, user.id, c.request.method === 'POST' ? 'identity.bind' : 'identity.unbind', await time())], result: json({ ok: true }) };
                });
            }),
            route('/login-connections', ['GET', 'POST', 'PUT', 'DELETE'], 'loginConnections', async (c) => {
                await this.requireCapability(c, 'config.write', c.request.method !== 'GET');
                if (c.request.method === 'GET')
                    return this.retry(async (time) => { const { records } = await this.guard(c, time); return { mutations: [], result: json({ publicOrigin: this.host.managementOrigin ? this.publicOrigin() : null, connections: connectionSlots(records).flatMap(slot => slot.value && !slot.value.deleting ? [{ ...this.connectionDto(slot.value), version: slot.version }] : []) }) }; });
                const b = await body(c.request);
                if (c.request.method === 'DELETE') {
                    exact(b, ['id', 'version']);
                    const id = this.text(b.id, 64);
                    if (!Number.isSafeInteger(b.version) || (b.version as number) < 1) fail('invalid_input');
                    return this.retry(async (time) => {
                        const { records, user } = await this.guard(c, time);
                        const slot = connectionSlots(records).find(s => s.value?.id === id && !s.value.deleting);
                        if (!slot || slot.version !== b.version) fail('version_conflict', 409);
                        const affectedIds = new Set(identities(records).filter(i => i.connectionId === id).map(i => i.userId));
                        const affected = users(records).filter(u => affectedIds.has(u.id));
                        const issued = this.subjects.get(c.subject!)!, session = await this.findSession(issued.digest);
                        return {
                            mutations: [
                                mutation(slot, 'connection', { ...slot.value!, enabled: false, deleting: { secretRefs: [...new Set([slot.value!.secretRef, ...this.flows(records).filter(f => f.value?.connectionId === id).map(f => f.value!.verifierRef)])].filter(Boolean) } }),
                                ...affected.map(u => {
                                    const r = records.find(r => r.key === 'user:' + u.id)!;
                                    return this.userMutation({ key: r.key, version: r.version, value: u }, { ...u, generation: next(u.generation) });
                                }),
                                this.audit(records, user.id, 'login.delete', await time()),
                            ],
                            result: json({ ok: true, sessionRevoked: affectedIds.has(user.id) || session?.value?.connectionId === id }),
                        };
                    });
                }
                exact(b, ['id', 'version', 'label', 'enabled', 'provider', 'configuration', 'clientId', 'clientSecret', 'scopes']);
                const id = this.text(b.id, 36), label = this.text(b.label, 128), clientId = this.text(b.clientId, 512);
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || (b.enabled !== undefined && typeof b.enabled !== 'boolean') || (c.request.method === 'POST' && b.version !== undefined) || (c.request.method === 'PUT' && (!Number.isSafeInteger(b.version) || (b.version as number) < 1))) fail('invalid_input');
                const parsed = parseProvider(b.provider, b.configuration, b.scopes);
                const previous = c.request.method === 'PUT' ? await this.retry(async time => {
                    const {records} = await this.guard(c, time);
                    const slot = connectionSlots(records).find(slot => slot.value?.id === id && !slot.value.deleting);
                    if (!slot?.value || slot.version !== b.version) fail('version_conflict', 409);
                    if (slot.value.provider !== parsed.provider) fail('invalid_input');
                    return {mutations: [], result: slot.value};
                }) : undefined;
                // Revocation must remain available while the identity provider is down.
                const disableOnly = previous && b.enabled === false && b.clientSecret === undefined
                    && previous.clientId === clientId && previous.issuer === parsed.issuer
                    && isDeepStrictEqual(previous.configuration, parsed.configuration)
                    && isDeepStrictEqual(previous.scopes, parsed.scopes);
                if (!disableOnly) await this.loginProviders().validate({...parsed, clientId});
                const secretRef = b.clientSecret === undefined ? undefined : await this.storeSecret(this.text(b.clientSecret, 8192));
                let replacedRef: string | undefined;
                try {
                    return await this.retry(async (time) => {
                        const { records, user } = await this.guard(c, time), slots = connectionSlots(records), record = c.request.method === 'POST' ? slots.find(s => s.value?.id === id) ?? slots.find(s => s.key === 'connection:' + id) ?? slots.find(s => s.value === null) : slots.find(s => s.value?.id === id && !s.value.deleting), old = record?.value;
                        if (c.request.method === 'PUT' && (!old || record?.version !== b.version))
                            fail('version_conflict', 409);
                        if (old && old.provider !== parsed.provider) fail('invalid_input');
                        if (c.request.method === 'POST' && old) fail('version_conflict', 409);
                        if (c.request.method === 'POST' && slots.filter(s => s.value !== null).length >= MAX_CONNECTIONS)
                            fail('connection_limit', 409);
                        replacedRef = old?.secretRef;
                        const connection: Connection = { id, label, enabled: b.enabled as boolean ?? false, ...parsed, clientId, secretRef: secretRef ?? old?.secretRef ?? '', generation: next(old?.generation ?? 0) };
                        if (connection.enabled && !connection.secretRef)
                            fail('oidc_secret_required');
                        return { mutations: [{ key: record?.key ?? 'connection:' + id, expectedVersion: record?.version ?? 0, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, connection }) }, this.audit(records, user.id, 'login.configure', await time())], result: json({ connection: { ...this.connectionDto(connection), version: (record?.version ?? 0) + 1 } }, c.request.method === 'POST' ? 201 : 200) };
                    });
                }
                finally {
                    if (secretRef)
                        await this.discardUnpublishedSecret(secretRef);
                    if (replacedRef)
                        await this.discardUnpublishedSecret(replacedRef);
                }
            }),
            route('/login-connections/discover', ['POST'], 'discoverLoginConnection', async c => {
                await this.requireCapability(c, 'config.write', true);
                const b = await body(c.request); exact(b, ['mode', 'url']);
                const metadata = await this.loginProviders().discover(b.mode, b.url);
                return this.retry(async time => { await this.guard(c, time); return {mutations: [], result: json(metadata)}; });
            }),
            route('/login-settings', ['GET', 'PUT'], 'loginSettings', async (c) => {
                await this.requireCapability(c, 'config.write', c.request.method === 'PUT');
                const b = c.request.method === 'PUT' ? await body(c.request) : {};
                exact(b, ['version', 'autoCreateUsers']);
                return this.retry(async (time) => {
                    const { records, user } = await this.guard(c, time), s = settings(records);
                    if (c.request.method === 'GET')
                        return { mutations: [], result: json({ version: s.version, autoCreateUsers: s.value!.autoCreateUsers }) };
                    if (typeof b.autoCreateUsers !== 'boolean')
                        fail('invalid_input');
                    if (b.version !== s.version)
                        fail('version_conflict', 409);
                    return { mutations: [mutation(s, 'settings', { ...s.value!, autoCreateUsers: b.autoCreateUsers }), this.audit(records, user.id, 'login.configure', await time())], result: json({ version: s.version + 1, autoCreateUsers: b.autoCreateUsers }) };
                });
            }),
            route('/turnstile', ['GET', 'PUT'], 'turnstile', async (c) => {
                await this.requireCapability(c, 'config.write', c.request.method === 'PUT');
                if (c.request.method === 'GET')
                    return this.retry(async (time) => { const { records } = await this.guard(c, time), s = turnstile(records); return { mutations: [], result: json(this.turnstileDto(s)) }; });
                const b = await body(c.request);
                exact(b, ['version', 'enabled', 'siteKey', 'secret', 'hostnames']);
                if (typeof b.enabled !== 'boolean' || typeof b.siteKey !== 'string' || b.siteKey.length > 256 || !Array.isArray(b.hostnames) || b.hostnames.length > 32 || b.hostnames.some(h => typeof h !== 'string' || !h || h.length > 253 || !/^([a-z0-9-]+\.)*[a-z0-9-]+$/i.test(h)))
                    fail('invalid_input');
                const ref = b.secret === undefined ? undefined : await this.storeSecret(this.text(b.secret, 8192));
                let replacedRef: string | undefined;
                try {
                    return await this.retry(async (time) => {
                        const { records, user } = await this.guard(c, time), s = turnstile(records);
                        replacedRef = s.value!.secretRef;
                        if (s.version !== b.version)
                            fail('version_conflict', 409);
                        const v: Turnstile = { enabled: b.enabled as boolean, siteKey: b.siteKey as string, secretRef: ref ?? s.value!.secretRef, hostnames: b.hostnames as string[] };
                        if (v.enabled && (!v.siteKey || !v.secretRef || !v.hostnames.length))
                            fail('turnstile_incomplete');
                        return { mutations: [mutation(s, 'turnstile', v), this.audit(records, user.id, 'turnstile.configure', await time())], result: json(this.turnstileDto({ key: s.key, version: s.version + 1, value: v })) };
                    });
                }
                finally {
                    if (ref)
                        await this.discardUnpublishedSecret(ref);
                    if (replacedRef)
                        await this.discardUnpublishedSecret(replacedRef);
                }
            }),
            route('/identities/link/start', ['POST'], 'beginIdentityLink', async (c) => { await this.requireCapability(c, 'config.write', true); const b = await body(c.request); exact(b, ['connectionId']); return this.startFlow(c.request, this.text(b.connectionId, 64), '/#/extensions/user-auth/profile', c); }),
            route('/identities/link/finish', ['POST'], 'finishIdentityLink', async (c) => { await this.requireCapability(c, 'config.write', true); const b = await body(c.request); exact(b, ['flowId']); return this.finishLink(c, this.text(b.flowId, 64)); }),
        ];
    }
    private displayName(v: unknown): string { if (typeof v !== 'string' || [...v].length > 128)
        fail('invalid_input'); return v; }
    private text(v: unknown, max: number): string { if (typeof v !== 'string' || !v || v.length > max)
        fail('invalid_input'); return v; }
    private confirmPassword(b: Record<string, unknown>): string { const p = password(b.password); if (p !== b.passwordConfirmation)
        fail('password_confirmation'); return p; }
    private connectionDto(v: Connection) { return { id: v.id, label: v.label, enabled: v.enabled, provider: v.provider, configuration: v.configuration, issuer: v.issuer, clientId: v.clientId, scopes: v.scopes, hasSecret: !!v.secretRef }; }
    private turnstileDto(s: Slot<Turnstile>) { return { version: s.version, enabled: s.value!.enabled, siteKey: s.value!.siteKey, hostnames: s.value!.hostnames, hasSecret: !!s.value!.secretRef }; }
    private async storeSecret(secret: string): Promise<string> {
        const encoded = JSON.stringify({owner: randomUUID(), value: secret});
        for (let index = 0; index < MAX_SECRETS; index++) {
            const key = 'auth-secret:' + index;
            if (await this.host.secretStore.get(key)) continue;
            try {
                const version = await this.host.secretStore.compareAndSet(key, null, encoded);
                return key + ':' + version;
            }
            catch (error) {
                const saved = await this.host.secretStore.get(key);
                if (saved && constant(saved.value, encoded)) return key + ':' + saved.version;
                if (error && typeof error === 'object' && 'code' in error && error.code === 'version_conflict') continue;
                throw error;
            }
        }
        return fail('secret_limit', 503);
    }
    private async readSecret(ref: string) {
        const match = /^auth-secret:(\d+):([1-9]\d*)$/.exec(ref);
        if (!match || Number(match[1]) >= MAX_SECRETS) return null;
        const key = 'auth-secret:' + match[1], saved = await this.host.secretStore.get(key);
        if (saved?.version !== Number(match[2])) return null;
        try {
            const value = JSON.parse(saved.value) as {owner?: unknown; value?: unknown};
            return typeof value?.owner === 'string' && typeof value.value === 'string' ? {version:saved.version, value:value.value, key} : null;
        } catch { return null; }
    }
    private async deleteSecret(ref: string) {
        const saved = await this.readSecret(ref);
        if (saved) await this.host.secretStore.delete(saved.key, saved.version);
    }
    private async discardUnpublishedSecret(ref: string) {
        try {
            const records = await this.records();
            if (records.some(r => JSON.stringify(r.value).includes(ref)))
                return;
            await this.deleteSecret(ref);
        }
        catch { /* Unknown publication must retain the reference until a later bounded-slot cleanup. */ }
    }
    private async verifyTurnstile(token: unknown, config: Turnstile, request: Request) {
        if (!config.enabled)
            return;
        if (typeof token !== 'string' || !token || token.length > 2048)
            fail('turnstile_required', 401);
        await this.retry(async (time) => {
            const records = await this.records(), s = settings(records).value!, all = slots(records, 'failure', MAX_FAILURES, validateFailure), key = 'challenge:' + digest(token), now = await time();
            if (all.some(f => f.value?.key === key && f.value.until > now))
                fail('turnstile_failed', 401);
            const slot = all.find(f => !f.value || f.value.until <= now);
            if (!slot)
                fail('login_limited', 429);
            return { mutations: [mutation(slot, 'failure', { key, count: 1, until: now + 5 * 60000, epoch: s.failureEpoch })], result: undefined };
        });
        const secret = await this.readSecret(config.secretRef);
        if (!secret)
            fail('turnstile_failed', 401);
        try {
            const response = await (this.dependencies.fetch ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: secret.value, response: token }), signal: AbortSignal.any([request.signal, this.host.signal, AbortSignal.timeout(5000)]), redirect: 'error' });
            const result = await response.json() as {
                success?: unknown;
                hostname?: unknown;
                action?: unknown;
            };
            if (!response.ok || result.success !== true || typeof result.hostname !== 'string' || !config.hostnames.includes(result.hostname) || result.action !== 'local-login')
                fail('turnstile_failed', 401);
        }
        catch (e) {
            if (e instanceof AccountError)
                throw e;
            fail('turnstile_failed', 401);
        }
    }
    private publicOrigin(): string {
        const configured = this.host.managementOrigin;
        if (!configured) fail('management_origin_required', 503);
        let url: URL;
        try { url = new URL(configured); }
        catch { fail('management_origin_required', 503); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== configured)
            fail('management_origin_required', 503);
        return url.origin;
    }
    private returnPath(value: unknown): string { if (value === undefined)
        return '/#/'; if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\x00-\x20]/.test(value) || value.length > 2048)
        fail('invalid_return_to'); const u = new URL(value, this.publicOrigin()); if (u.origin !== this.publicOrigin())
        fail('invalid_return_to'); return u.pathname + u.search + u.hash; }
    private flowCookie(token: string, maxAge = 600) { return `${FLOW_COOKIE}=${token}; Path=/api/auth/login/callback/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.publicOrigin().startsWith('https:') ? '; Secure' : ''}`; }
    private flows(records: readonly DurableRecord[]): Slot<AuthFlow>[] {
        return slots(records, 'flow', MAX_FLOWS, validateFlow);
    }
    private loginProviders() { return new LoginProviders(this.dependencies.fetch ?? fetch, this.host.signal); }
    private async oidcConfig(connection: Connection): Promise<oidc.Configuration> {
        const secret = await this.readSecret(connection.secretRef);
        if (!secret) fail('oidc_unavailable', 503);
        return this.loginProviders().configuration(connection, secret.value);
    }
    async loginOptions(_request: Request): Promise<Response> { try {
        this.alive();
        const records = await this.records(), t = turnstile(records).value!;
        return json({ local: { enabled: true, turnstile: { enabled: t.enabled, ...(t.enabled ? { siteKey: t.siteKey } : {}) } }, methods: connections(records).filter(c => c.enabled).map(c => ({ id: c.id, label: c.label, provider: c.provider })) });
    }
    catch (e) {
        return safe(e);
    } }
    async beginLogin(request: Request): Promise<Response> { try {
        this.alive();
        origin(request, this.host.managementOrigin);
        const b = await body(request);
        exact(b, ['methodId', 'returnTo']);
        return await this.startFlow(request, this.text(b.methodId, 64), this.returnPath(b.returnTo));
    }
    catch (e) {
        return safe(e);
    } }
    private async startFlow(request: Request, methodId: string, returnTo: string, c?: ControlApiHandlerContext): Promise<Response> {
        const publicOrigin = this.publicOrigin();
        await this.reserve(['source:' + digest(this.source(request))]);
        const connection = connections(await this.records()).find(c => c.id === methodId && c.enabled);
        if (!connection)
            fail('oidc_unavailable', 401);
        const config = await this.oidcConfig(connection), state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier(), challenge = await oidc.calculatePKCECodeChallenge(verifier), verifierRef = await this.storeSecret(verifier), id = randomUUID();
        let replacedRef: string | undefined;
        try {
            await this.retry(async (time) => {
                const guarded = c ? await this.guard(c, time) : undefined, records = guarded?.records ?? await this.records(), current = connections(records).find(x => x.id === methodId), now = await time();
                if (!current?.enabled || current.generation !== connection.generation)
                    fail('version_conflict', 409);
                const slot = this.flows(records).find(s => !s.value || s.value.expiresAt <= now || s.value.status === 'consumed');
                if (!slot)
                    fail('flow_limit', 429);
                replacedRef = slot.value?.verifierRef;
                const flow: AuthFlow = { id, state, nonce, verifierRef, connectionId: methodId, generation: current.generation, created: now, expiresAt: now + 10 * 60000, epoch: settings(records).value!.sessionEpoch, returnTo, status: 'pending', ...(guarded ? { initiator: { userId: guarded.user.id, generation: guarded.user.generation, sessionDigest: this.subjects.get(c!.subject!)!.digest } } : {}) };
                return { mutations: [mutation(slot, 'flow', flow)], result: undefined };
            });
            const authorizationUrl = oidc.buildAuthorizationUrl(config, { redirect_uri: publicOrigin + '/api/auth/login/callback/' + methodId, scope: connection.scopes.join(' '), response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, ...(connection.provider === 'github' ? {} : { nonce }) }).href;
            return json({ authorizationUrl, flowId: id }, 200, { 'set-cookie': this.flowCookie(state) });
        }
        finally {
            await this.discardUnpublishedSecret(verifierRef);
            if (replacedRef)
                await this.discardUnpublishedSecret(replacedRef);
        }
    }
    async completeLogin(request: Request): Promise<Response> {
        let verifierRef: string | undefined;
        try {
            this.alive();
            const publicOrigin = this.publicOrigin(), incoming = new URL(request.url), methodId = incoming.pathname.split('/').at(-1)!, state = incoming.searchParams.get('state');
            const cookies = (request.headers.get('cookie') ?? '').split(';').map(c => c.trim()).filter(c => c.startsWith(FLOW_COOKIE + '='));
            if (!state || cookies.length !== 1 || !constant(cookies[0]!.slice(FLOW_COOKIE.length + 1), state))
                fail('invalid_oidc_state', 401);
            const flow = await this.retry(async (time) => {
                const records = await this.records(), slot = this.flows(records).find(s => s.value?.state === state), connection = connections(records).find(c => c.id === methodId), now = await time(), f = slot?.value;
                if (!slot || !f || f.connectionId !== methodId || f.status !== 'pending' || f.epoch !== settings(records).value!.sessionEpoch || f.expiresAt <= now || !connection?.enabled || connection.generation !== f.generation)
                    fail('invalid_oidc_flow', 401);
                return { mutations: [mutation(slot, 'flow', { ...f, status: 'exchanging' })], result: { flow: f, connection } };
            });
            verifierRef = flow.flow.verifierRef;
            const verifier = await this.readSecret(verifierRef);
            if (!verifier)
                fail('invalid_oidc_flow', 401);
            const config = await this.oidcConfig(flow.connection);
            const canonical = new URL(publicOrigin + '/api/auth/login/callback/' + methodId);
            canonical.search = incoming.search;
            const identityResult = await this.loginProviders().exchange(flow.connection, config, canonical, {pkceCodeVerifier: verifier.value, expectedState: state, expectedNonce: flow.flow.nonce});
            const token = randomBytes(32).toString('base64url');
            const result = await this.retry<{
                link: boolean;
                returnTo: string;
                policy?: SessionPolicy;
            }>(async (time) => {
                const records = await this.records(), slot = this.flows(records).find(s => s.value?.id === flow.flow.id), f = slot?.value, current = connections(records).find(c => c.id === methodId), policy = (await this.readSessionPolicy()).policy, initiatingSession = f?.initiator ? await this.findSession(f.initiator.sessionDigest) : undefined, now = await time();
                if (!slot || !f || f.status !== 'exchanging' || f.epoch !== settings(records).value!.sessionEpoch || f.expiresAt <= now || !current?.enabled || current.generation !== f.generation)
                    fail('invalid_oidc_flow', 401);
                if (f.initiator) {
                    const u = users(records).find(u => u.id === f.initiator!.userId), session = initiatingSession;
                    if (!u || u.generation !== f.initiator.generation || !session?.value || !this.live(u, session.value, now, records))
                        fail('forbidden', 403);
                    return { mutations: [mutation(slot, 'flow', { ...f, status: 'verified', subject: identityResult.subject, issuer: identityResult.issuer, protocol: identityResult.protocol })], result: { link: true, returnTo: '/#/extensions/user-auth/profile?oidcLink=' + f.id } };
                }
                const id = digest(identityResult.issuer + '\0' + identityResult.subject), binding = identities(records).find(i => i.id === id), all = users(records);
                let u = binding && all.find(u => u.id === binding.userId);
                const changes: DurableMutation[] = [];
                if (binding && !u)
                    fail('corrupt_state', 503);
                if (binding && (binding.connectionId !== current.id || binding.protocol !== identityResult.protocol))
                    fail('identity_connection_mismatch', 401);
                if (!u) {
                    if (!settings(records).value!.autoCreateUsers)
                        fail('unknown_identity', 401);
                    if (all.length >= MAX_USERS || identities(records).length >= MAX_IDENTITIES)
                        fail('user_limit', 409);
                    const userId = randomUUID();
                    u = { id: userId, username: 'sso-' + userId, displayName: identityResult.displayName, disabled: false, generation: 1, passwordHash: '', temporary: false };
                    changes.push(this.userMutation({ key: 'user:' + userId, version: 0, value: null }, u));
                    const identity: Identity = { id, userId, connectionId: current.id, issuer: identityResult.issuer, subject: identityResult.subject, protocol: identityResult.protocol };
                    changes.push(mutation(entry(records, 'identity:' + id, 'identity', null), 'identity', identity));
                }
                if (u.disabled)
                    fail('disabled_user', 401);
                const sessions = slots(records, 'session', MAX_SESSIONS, validateSession), session = sessions.find(s => !s.value || !this.live(all.find(u => u.id === s.value!.administratorId) ?? null, s.value, now, records));
                if (!session)
                    fail('session_limit', 429);
                changes.push(mutation(session, 'session', { digest: digest(token), administratorId: u.id, generation: u.generation, created: now, touched: now, transport: 'cookie', policy, epoch: settings(records).value!.sessionEpoch, connectionId: current.id, connectionGeneration: current.generation }), mutation(slot, 'flow', { ...f, status: 'consumed' }), this.audit(records, u.id, 'oidc.login', now));
                return { mutations: changes, result: { link: false, returnTo: f.returnTo, policy } };
            });
            const headers = new Headers({ 'location': new URL(result.returnTo, publicOrigin).href, 'cache-control': 'no-store' });
            headers.append('set-cookie', this.flowCookie('', 0));
            if (!result.link && result.policy)
                headers.append('set-cookie', cookie(request, token, this.cookieAge(result.policy), publicOrigin));
            return new Response(null, { status: 302, headers });
        }
        catch (error) {
            const code=error instanceof AccountError?error.code:'oidc_failed';
            await this.recordFailure('oidc.login',error);
            try {
                return new Response(null, { status: 302, headers: { location: this.publicOrigin() + '/#/login?oidcError=' + encodeURIComponent(code), 'cache-control': 'no-store', 'set-cookie': this.flowCookie('', 0) } });
            }
            catch {
                return safe(error);
            }
        }
        finally {
            if (verifierRef) {
                try {
                    await this.deleteSecret(verifierRef);
                }
                catch { }
            }
        }
    }
    private async finishLink(c: ControlApiHandlerContext, id: string): Promise<Response> {
        return this.retry(async (time) => {
            const { records, user } = await this.guard(c, time), slot = this.flows(records).find(s => s.value?.id === id), f = slot?.value, now = await time(), connection = f && connections(records).find(x => x.id === f.connectionId), issued = this.subjects.get(c.subject!)!;
            if (!slot || !f || f.status !== 'verified' || f.epoch !== settings(records).value!.sessionEpoch || f.expiresAt <= now || !f.subject || !f.issuer || !f.protocol || !f.initiator || f.initiator.userId !== user.id || f.initiator.generation !== user.generation || f.initiator.sessionDigest !== issued.digest || !connection?.enabled || connection.generation !== f.generation)
                fail('invalid_oidc_flow', 401);
            const identity: Identity = { id: digest(f.issuer + '\0' + f.subject), userId: user.id, connectionId: connection.id, issuer: f.issuer, subject: f.subject, protocol: f.protocol };
            if (identities(records).some(i => i.id === identity.id))
                fail('identity_exists', 409);
            if (identities(records).length >= MAX_IDENTITIES)
                fail('identity_limit', 409);
            const u = records.find(r => r.key === 'user:' + user.id)!;
            return { mutations: [mutation(entry(records, 'identity:' + identity.id, 'identity', null), 'identity', identity), this.userMutation({ key: u.key, version: u.version, value: user }, { ...user, generation: next(user.generation) }), mutation(slot, 'flow', { ...f, status: 'consumed' }), this.audit(records, user.id, 'identity.link', now)], result: json({ ok: true }) };
        });
    }
}
export function createControl(host: ControlHostContext, dependencies: Dependencies = {}): UserAuthControl { return new UserAuthControl(host, dependencies); }
export const api = [
    { path: '/password', methods: ['POST'], handler: 'changePassword' },
    { path: '/logout', methods: ['POST'], handler: 'logout' },
    { path: '/self', methods: ['GET'], handler: 'self' },
    { path: '/session-policy', methods: ['GET', 'PUT'], handler: 'sessionPolicy' },
    ...[['/users', ['GET', 'POST'], 'users'], ['/users/update', ['PUT'], 'updateUser'], ['/users/password', ['POST'], 'resetUserPassword'], ['/identities', ['GET', 'POST', 'DELETE'], 'identities'], ['/login-connections', ['GET', 'POST', 'PUT', 'DELETE'], 'loginConnections'], ['/login-connections/discover', ['POST'], 'discoverLoginConnection'], ['/login-settings', ['GET', 'PUT'], 'loginSettings'], ['/turnstile', ['GET', 'PUT'], 'turnstile'], ['/identities/link/start', ['POST'], 'beginIdentityLink'], ['/identities/link/finish', ['POST'], 'finishIdentityLink']].map(([path, methods, handler]) => ({ path, methods, handler })),
] as const;
export const rpc = [], controlApi = api, controlRpc = rpc;
export async function readManagementSetup(state: StateReader): Promise<{
    initialized: boolean;
}> {
    const records = withoutSetupCode(await state.list());
    if (!records.length) return { initialized: false };
    const setup = validateState(records);
    return { initialized: setup.value.phase === 'ready' };
}
function validateState(records: readonly DurableRecord[]) {
    const setup = setupRecord(records);
    slots(records, 'session', MAX_SESSIONS, validateSession);
    slots(records, 'failure', MAX_FAILURES, validateFailure);
    slots(records, 'flow', MAX_FLOWS, validateFlow);
    const policy = records.find(r => r.key === 'session-policy');
    if (policy) validateSessionPolicy(envelope(policy.value, 'policy'), 'corrupt_state', 503);
    const all = users(records);
    for (const record of records.filter(r => r.key.startsWith('credential:'))) {
        localValue(record);
        if (!all.some(u => record.key === 'credential:' + u.id)) fail('corrupt_state', 503);
    }
    return setup;
}
/** Recognize only the retired schema-3 pending-code shape, without mutating reads. */
function withoutSetupCode(records: readonly DurableRecord[]): readonly DurableRecord[] {
    const record = records.find(r => r.key === 'setup');
    if (!record) return records;
    const value = envelope(record.value, 'setup') as Record<string, unknown>;
    if (!value || !Object.hasOwn(value, 'code')) return records;
    const code = value.code as {digest?: unknown; expiresAt?: unknown};
    if (value.phase !== 'uninitialized' || Object.keys(value).some(k => !['phase', 'code'].includes(k))
        || !code || typeof code.digest !== 'string' || !/^[a-f0-9]{64}$/.test(code.digest)
        || !Number.isSafeInteger(code.expiresAt) || (code.expiresAt as number) < 0
        || Object.keys(code).some(k => !['digest', 'expiresAt'].includes(k))) fail('corrupt_state', 503);
    return records.map(r => r === record ? {...r, value: {schema: ACCOUNT_RECORD_SCHEMA, setup: {phase: 'uninitialized'}}} : r);
}
async function clearSetupCode(state: PluginDurableState): Promise<void> {
    for (let i = 0; i < 64; i++) {
        const records = await state.list(), normalized = withoutSetupCode(records);
        if (normalized === records) return;
        const before = records.find(r => r.key === 'setup')!, after = normalized.find(r => r.key === 'setup')!;
        const clock = records.find(r => r.key === 'clock');
        try {
            await state.transact([{key: 'setup', expectedVersion: before.version, value: after.value}, clockMutation({version: clock?.version ?? 0, value: clockValue(clock)})]);
            return;
        } catch (error) { if (!isDurableStateConflictError(error)) throw error; }
    }
    fail('version_conflict', 409);
}
async function ensureSetup(state: PluginDurableState, now: () => number): Promise<void> {
    for (let i = 0; i < 64; i++) {
        if ((await state.list()).length) return;
        try {
            await state.transact([{key: 'setup', expectedVersion: 0, value: {schema: ACCOUNT_RECORD_SCHEMA, setup: {phase: 'uninitialized'}}}, clockMutation({version: 0, value: wallTime(now)})]);
            return;
        } catch (error) { if (!isDurableStateConflictError(error)) throw error; }
    }
    fail('version_conflict', 409);
}
function initialUserMutations(records: readonly DurableRecord[], user: User, hash: string): DurableMutation[] {
    return [
        {key: 'setup', expectedVersion: records.find(r => r.key === 'setup')?.version ?? 0, value: {schema: ACCOUNT_RECORD_SCHEMA, setup: {phase: 'ready'}}},
        mutation(settings(records), 'settings', EMPTY_SETTINGS), mutation(turnstile(records), 'turnstile', EMPTY_TURNSTILE),
        {key: 'user:' + user.id, expectedVersion: 0, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, user})},
        {key: 'credential:' + user.id, expectedVersion: 0, value: {schema: ACCOUNT_RECORD_SCHEMA, credential: {passwordHash: hash, temporary: false}}},
        {key: 'recovery-anchor', expectedVersion: 0, value: {schema: ACCOUNT_RECORD_SCHEMA, userId: user.id}},
    ];
}
function offlinePasswordInput(input: unknown, operation: string) {
    const b = object(input);
    exact(b, ['operation', 'username', 'password', 'passwordConfirmation']);
    if (b.operation !== operation) fail('invalid_input');
    const name = username(b.username), p = password(b.password);
    if (b.passwordConfirmation !== p) fail('password_confirmation');
    return {name, p};
}
export async function addUserOffline(input: unknown, context: RecoveryContext) {
    const {name, p} = offlinePasswordInput(input, 'add-user');
    const state = context.durableState, now = context.now ?? Date.now;
    await clearSetupCode(state);
    const hash = await Bun.password.hash(p, {algorithm: 'argon2id', memoryCost: 65536, timeCost: 3});
    for (let i = 0; i < 64; i++) {
        const records = await state.list();
        if (records.length) validateState(records);
        const all = users(records);
        if (all.some(u => u.username === name)) fail('username_exists', 409);
        if (all.length >= MAX_USERS) fail('user_limit', 409);
        const user: User = {id: randomUUID(), username: name, displayName: name, disabled: false, generation: 1};
        const pending = !records.length || setupRecord(records).value.phase === 'uninitialized';
        const changes = pending ? initialUserMutations(records, user, hash) : [
            {key: 'user:' + user.id, expectedVersion: 0, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, user})},
            {key: 'credential:' + user.id, expectedVersion: 0, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, credential: {passwordHash: hash, temporary: false}})},
        ];
        const clock = records.find(r => r.key === 'clock');
        changes.push(clockMutation({version: clock?.version ?? 0, value: Math.max(clock ? clockValue(clock) : 0, wallTime(now))}));
        try {
            await state.transact(changes);
            return dto({...user, passwordHash: hash, temporary: false});
        } catch (error) { if (!isDurableStateConflictError(error)) throw error; }
    }
    return fail('version_conflict', 409);
}
export async function resetUserPasswordOffline(input: unknown, context: RecoveryContext) {
    const {name, p} = offlinePasswordInput(input, 'reset-password');
    const state = context.durableState, now = context.now ?? Date.now;
    await clearSetupCode(state);
    // Resolve the target before hashing or observing time; missing users never write state.
    const initial = await state.list();
    if (initial.length) validateState(initial);
    if (!users(initial).some(u => u.username === name)) fail('not_found', 404);
    const hash = await Bun.password.hash(p, {algorithm: 'argon2id', memoryCost: 65536, timeCost: 3});
    for (let i = 0; i < 64; i++) {
        const records = await state.list();
        validateState(records);
        const target = users(records).find(u => u.username === name);
        if (!target) fail('not_found', 404);
        const record = records.find(r => r.key === 'user:' + target.id)!, credential = records.find(r => r.key === 'credential:' + target.id);
        const {passwordHash: _, temporary: __, ...prior} = target, user = {...prior, generation: next(prior.generation)};
        const s = settings(records), failures = slots(records, 'failure', MAX_FAILURES, validateFailure), clock = records.find(r => r.key === 'clock')!;
        try {
            await state.transact([
                {key: record.key, expectedVersion: record.version, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, user})},
                {key: 'credential:' + user.id, expectedVersion: credential?.version ?? 0, value: {schema: ACCOUNT_RECORD_SCHEMA, credential: {passwordHash: hash, temporary: false}}},
                mutation(s, 'settings', {...s.value!, failureEpoch: next(Math.max(s.value!.failureEpoch, ...failures.map(f => f.value?.epoch ?? 0)))}),
                clockMutation({version: clock.version, value: Math.max(clockValue(clock), wallTime(now))}),
            ]);
            return dto({...user, passwordHash: hash, temporary: false});
        } catch (error) { if (!isDurableStateConflictError(error)) throw error; }
    }
    return fail('version_conflict', 409);
}
/** An explicit offline reset restores only the stable recovery anchor. */
export async function recoverIdentity(input: unknown, context: RecoveryContext) {
    const b = object(input);
    exact(b, ['operation', 'username', 'password', 'passwordConfirmation', 'reason', 'disableTurnstile']);
    if (b.operation !== 'reset' || (b.disableTurnstile !== undefined && !['', 'yes', 'no'].includes(b.disableTurnstile as string)))
        fail('invalid_input');
    const name = username(b.username), p = password(b.password);
    if (b.passwordConfirmation !== p)
        fail('password_confirmation');
    if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 512)
        fail('invalid_reason');
    const state = context.durableState, now = context.now ?? Date.now;
    await clearSetupCode(state);
    const hash = await Bun.password.hash(p, { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 });
    for (let i = 0; i < 64; i++) {
        const records = await state.list();
        validateKeys(records);
        const anchor = records.find(r => r.key === 'recovery-anchor');
        let anchorId: string | undefined;
        if (anchor) {
            const id = envelope(anchor.value, 'userId');
            if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
                fail('corrupt_state', 503);
            anchorId = id;
        }
        // Recovery deliberately does not accept a previous record schema or infer an anchor from a username.
        for (const r of records) {
            const anchorTombstone = anchorId && ['user:' + anchorId, 'credential:' + anchorId].includes(r.key) && r.value === null;
            if (!anchorTombstone && (r.value as {schema?: unknown})?.schema !== ACCOUNT_RECORD_SCHEMA)
                fail('corrupt_state', 503);
        }
        const id = anchorId ?? randomUUID(), record = records.find(r => r.key === 'user:' + id);
        let prior: User | undefined;
        if (record) {
            try {
                prior = validateUser(envelope(record.value, 'user'));
            }
            catch (error) {
                if (!(error instanceof AccountError))
                    throw error;
            }
        }
        const other = records.filter(r => r.key.startsWith('user:') && r.key !== 'user:' + id).map(r => validateUser(envelope(r.value, 'user')));
        if (other.some(u => u.username === name))
            fail('username_exists', 409);
        const user: User = { id, username: name, displayName: prior?.displayName ?? name, disabled: false, generation: next(prior?.generation ?? 0) };
        const credential = records.find(r => r.key === 'credential:' + id);
        if (records.length) {
            if (!anchorId && setupRecord(records).value.phase === 'ready') fail('corrupt_state', 503);
            // Only the anchor user and its local credential may be rebuilt. Keep every
            // unrelated record under the same strict validation as normal startup.
            const repaired = records.filter(r => !['user:' + id, 'credential:' + id].includes(r.key));
            const setup = records.find(r => r.key === 'setup');
            if (!setup) fail('corrupt_state', 503);
            const phase = (envelope(setup.value, 'setup') as Setup).phase;
            if (phase === 'ready') {
                validateState([...repaired,
                    {key: 'user:' + id, version: record?.version ?? 0, value: asJson({schema: ACCOUNT_RECORD_SCHEMA, user})},
                    {key: 'credential:' + id, version: credential?.version ?? 0, value: {schema: ACCOUNT_RECORD_SCHEMA, credential: {passwordHash: hash, temporary: false}}},
                ]);
            } else validateState(records);
        }
        const s = settings(records), turn = turnstile(records), clockRecord = records.find(r => r.key === 'clock');
        const at = Math.max(clockRecord ? clockValue(clockRecord) : 0, wallTime(now));
        const failures = slots(records, 'failure', MAX_FAILURES, validateFailure);
        slots(records, 'session', MAX_SESSIONS, validateSession);
        connections(records);
        identities(records);
        const changes: DurableMutation[] = [
            { key: 'user:' + id, expectedVersion: record?.version ?? 0, value: asJson({ schema: ACCOUNT_RECORD_SCHEMA, user }) },
            { key: 'credential:' + id, expectedVersion: credential?.version ?? 0, value: { schema: ACCOUNT_RECORD_SCHEMA, credential: { passwordHash: hash, temporary: false } } },
            { key: 'recovery-anchor', expectedVersion: anchor?.version ?? 0, value: { schema: ACCOUNT_RECORD_SCHEMA, userId: id } },
            { key: 'setup', expectedVersion: records.find(r => r.key === 'setup')?.version ?? 0, value: { schema: ACCOUNT_RECORD_SCHEMA, setup: { phase: 'ready' } } },
            { key: 'clock', expectedVersion: clockRecord?.version ?? 0, value: { schema: ACCOUNT_RECORD_SCHEMA, observedThrough: at } },
            mutation(s, 'settings', { ...s.value!, sessionEpoch: next(s.value!.sessionEpoch), failureEpoch: next(Math.max(s.value!.failureEpoch, ...failures.map(f => f.value?.epoch ?? 0))) }),
            { key: 'recovery-summary', expectedVersion: records.find(r => r.key === 'recovery-summary')?.version ?? 0, value: { schema: ACCOUNT_RECORD_SCHEMA, userId: id, reason: b.reason, at } },
            mutation(turn, 'turnstile', { ...turn.value!, ...(b.disableTurnstile === 'yes' ? {enabled: false} : {}) }),
        ];
        try {
            await state.transact(changes);
            return dto({ ...user, passwordHash: hash, temporary: false });
        }
        catch (e) {
            if (!isDurableStateConflictError(e))
                throw e;
        }
    }
    return fail('version_conflict', 409);
}
const passwordPrompts = [
    {name: 'username', label: 'Username', secret: false},
    {name: 'password', label: 'New password', secret: true},
    {name: 'passwordConfirmation', label: 'Confirm password', secret: true},
] as const;
export default { createControl, readManagementSetup, offlineRecovery: { kind: 'identity', actions: {
    'add-user': {prompts: passwordPrompts, run: (input, context) => addUserOffline({...input, operation: 'add-user'}, context)},
    'reset-password': {prompts: passwordPrompts, run: (input, context) => resetUserPasswordOffline({...input, operation: 'reset-password'}, context)},
    reset: {prompts: [{name: 'username', label: 'Recovery username', secret: false}, ...passwordPrompts.slice(1), {name: 'reason', label: 'Recovery reason', secret: false}, {name: 'disableTurnstile', label: 'Disable Turnstile? Type yes to disable; default no', secret: false}], run: (input, context) => recoverIdentity({...input, operation: 'reset'}, context)},
} } } satisfies ControlPlugin;
