import type { CredentialLease, CredentialPolicy } from '../../plugin-control/contracts';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

const INBOUND_SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key',
  'cookie', 'set-cookie',
]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'PUT']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPolicy(): never {
  throw new Error('managed upstream credential policy is missing or invalid');
}

function exactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function credentialPolicyFromManifest(manifest: unknown, contributionId: string): CredentialPolicy {
  const contributes = isRecord(manifest) && isRecord(manifest.contributes)
    ? manifest.contributes
    : undefined;
  const sources = contributes?.upstreamSources;
  if (!Array.isArray(sources)) invalidPolicy();
  const source = sources.find((item) => isRecord(item) && item.id === contributionId);
  if (!isRecord(source) || !isRecord(source.credentialPolicy)) invalidPolicy();

  const policy = source.credentialPolicy;
  const origins = policy.allowedOrigins;
  const requests = policy.allowedRequests;
  const headers = policy.allowedHeaderNames;
  if (!Array.isArray(origins) || !origins.every(exactHttpsOrigin)
    || !Array.isArray(requests) || !requests.every((item) => isRecord(item)
      && typeof item.pathname === 'string'
      && item.pathname.startsWith('/')
      && !item.pathname.includes('?') && !item.pathname.includes('#') && !item.pathname.includes('//')
      && Array.isArray(item.methods)
      && item.methods.length > 0
      && item.methods.every((method) => typeof method === 'string' && HTTP_METHODS.has(method)))
    || !Array.isArray(headers) || !headers.every((item) => typeof item === 'string'
      && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(item)
      && !HOP_HEADERS.has(item.toLowerCase())
      && !item.toLowerCase().startsWith('x-forwarded-')
      && !item.toLowerCase().startsWith('sec-'))) {
    invalidPolicy();
  }

  return {
    allowedOrigins: origins,
    allowedRequests: requests.map((item) => ({
      pathname: item.pathname as string,
      methods: (item.methods as unknown[]).map((method) => method as string),
    })),
    allowedHeaderNames: headers,
  };
}

export function stripCredentialHeaders(headers: Headers, policy: CredentialPolicy): void {
  const declared = new Set(policy.allowedHeaderNames.map((name) => name.toLowerCase()));
  const names: string[] = [];
  headers.forEach((_, name) => names.push(name));
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (HOP_HEADERS.has(normalized) || INBOUND_SENSITIVE_HEADERS.has(normalized) || declared.has(normalized)) {
      headers.delete(name);
    }
  }
}

export function assertCredentialTarget(
  target: URL,
  source: URL,
  policy: CredentialPolicy,
  method: string,
  expectedPath?: string,
): void {
  if (source.protocol !== 'https:' || source.username || source.password
    || target.protocol !== 'https:' || target.username || target.password
    || target.origin !== source.origin || target.port !== source.port
    || !policy.allowedOrigins.includes(target.origin)) {
    throw new Error('managed upstream target is outside credential policy');
  }
  if (expectedPath !== undefined && target.pathname !== expectedPath) {
    throw new Error('managed upstream target changed while acquiring credentials');
  }
  const request = policy.allowedRequests.find((item) => item.pathname === target.pathname);
  if (!request || !request.methods.some((value) => value.toUpperCase() === method.toUpperCase())) {
    throw new Error('managed upstream request is outside credential policy');
  }
}

export function validateCredentialLease(value: unknown, now = Date.now()): CredentialLease {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= now || !isRecord(value.headers)) {
    throw new Error('invalid or expired credential lease');
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) throw new Error('invalid credential header');
    headers[name] = headerValue;
  }
  return { version: value.version as number, expiresAt: value.expiresAt, headers };
}

export function sanitizeError(error: unknown, secrets: readonly string[] = []): Error {
  const message = error instanceof Error ? error.message : String(error);
  const needles = [...new Set(secrets.flatMap((secret) => [secret, ...secret.split(/\s+/)]))]
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  const sanitized = needles.reduce(
    (result, secret) => result.split(secret).join('[REDACTED]'),
    message,
  );
  const result = new Error(sanitized);
  if (error instanceof Error) {
    result.name = error.name;
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      (result as Error & { code: string }).code = code;
    }
  }
  return result;
}

export function sanitizeMessage(error: unknown, secrets: readonly string[] = []): string {
  return sanitizeError(error, secrets).message;
}

export { HOP_HEADERS };
