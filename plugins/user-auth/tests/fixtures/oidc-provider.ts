import { createHash, generateKeyPairSync, sign } from 'node:crypto';

/** A real local authorization server: codes, PKCE and signed ID tokens cross HTTP. */
export function startIdentityProvider(authMethod: 'client_secret_post' | 'client_secret_basic' = 'client_secret_post', advertiseMethod = true) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-signing-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { nonce: string; challenge: string; clientId: string; redirectUri: string }>();
  const mutation: { nonce?: string; issuer?: string; audience?: string; subject: string; expired: boolean; invalidSignature: boolean; beforeToken?: () => Promise<void> } = { subject: 'subject-one', expired: false, invalidSignature: false };
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req): Promise<Response> {
    const url = new URL(req.url), issuer = server.url.origin;
    if (url.pathname === '/.well-known/openid-configuration') return Response.json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], ...(advertiseMethod ? {token_endpoint_auth_methods_supported: [authMethod]} : {}), code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/jwks') return Response.json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const code = crypto.randomUUID();
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, clientId: url.searchParams.get('client_id')!, redirectUri: url.searchParams.get('redirect_uri')! });
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', issuer);
      return Response.redirect(callback.href, 302);
    }
    if (url.pathname === '/token') {
      requests++;
      await mutation.beforeToken?.();
      const fields = new URLSearchParams(await req.text()), code = fields.get('code')!, record = codes.get(code);
      codes.delete(code);
      const basic = /^Basic (.+)$/i.exec(req.headers.get('authorization') ?? '');
      const credentials = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':').map(value => new URLSearchParams('v='+value).get('v')) : [];
      const validClient = authMethod === 'client_secret_post'
        ? fields.get('client_id') === record?.clientId && fields.get('client_secret') === 'fixture-client-secret'
        : credentials.length === 2 && credentials[0] === record?.clientId && credentials[1] === 'fixture-client-secret' && !fields.has('client_secret');
      if (!record || !validClient || fields.get('redirect_uri') !== record.redirectUri || createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url') !== record.challenge) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iss: mutation.issuer ?? issuer, aud: mutation.audience ?? record.clientId, sub: mutation.subject, nonce: mutation.nonce ?? record.nonce, iat: now, exp: mutation.expired ? now - 3600 : now + 300, name: 'Fixture User', email: 'same@example.com' })).toString('base64url');
      const input = header + '.' + payload;
      const signature = mutation.invalidSignature ? Buffer.alloc(256).toString('base64url') : sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url');
      return Response.json({ access_token: 'not-persisted-access-token', refresh_token: 'not-persisted-refresh-token', token_type: 'Bearer', id_token: input + '.' + signature, expires_in: 300 });
    }
    return new Response('Not found', { status: 404 });
  } });
  return { issuer: server.url.origin, mutation, tokenRequests: () => requests, stop: () => server.stop(true) };
}
