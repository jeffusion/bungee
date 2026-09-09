import type {
  CredentialLease,
  CredentialOutboundHeaderProfile,
  CredentialPolicy,
  CredentialRequestPolicy,
} from '../../plugin-control/contracts';

const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

const INBOUND_SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'x-api-key', 'api-key',
  'cookie', 'set-cookie',
]);
const HTTP_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'PUT']);
const HEADER_TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const MAX_OUTBOUND_HEADER_NAMES = 32;
const MAX_FIXED_HEADER_BYTES = 8192;
const MAX_FIXED_HEADERS_BYTES = 32768;
const POLICY_FORBIDDEN_HEADERS = new Set([
  ...HOP_HEADERS, 'cookie', 'set-cookie', 'content-length', 'accept-encoding',
]);
const OUTBOUND_FORBIDDEN_HEADERS = new Set([
  ...POLICY_FORBIDDEN_HEADERS, 'accept-encoding', 'authorization', 'proxy-authorization',
  'x-api-key', 'api-key',
]);

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

function validHeaderName(value: unknown, forbidden: ReadonlySet<string>): value is string {
  return typeof value === 'string' && HEADER_TOKEN.test(value)
    && !forbidden.has(value.toLowerCase())
    && !value.toLowerCase().startsWith('x-forwarded-')
    && !value.toLowerCase().startsWith('sec-');
}

function validateHeaderNames(value: unknown, forbidden: ReadonlySet<string>): string[] {
  if (!Array.isArray(value) || value.length > MAX_OUTBOUND_HEADER_NAMES) invalidPolicy();
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!validHeaderName(item, forbidden)) invalidPolicy();
    const normalized = item.toLowerCase();
    if (seen.has(normalized)) invalidPolicy();
    seen.add(normalized);
    names.push(item);
  }
  return names;
}

function validateOutboundHeaders(value: unknown, allowedHeaderNames: ReadonlySet<string>): CredentialOutboundHeaderProfile {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'passthrough' && key !== 'set')) invalidPolicy();
  const passthrough = validateHeaderNames(value.passthrough, OUTBOUND_FORBIDDEN_HEADERS);
  if (!isRecord(value.set) || Object.keys(value.set).length > MAX_OUTBOUND_HEADER_NAMES) invalidPolicy();
  const set: Record<string, string> = Object.create(null);
  const setNames = new Set<string>();
  let totalBytes = 0;
  for (const [name, headerValue] of Object.entries(value.set)) {
    if (!validHeaderName(name, OUTBOUND_FORBIDDEN_HEADERS)) invalidPolicy();
    const normalized = name.toLowerCase();
    if (setNames.has(normalized) || allowedHeaderNames.has(normalized)) invalidPolicy();
    if (typeof headerValue !== 'string' || headerValue.length === 0 || headerValue !== headerValue.trim()
      || /[\u0000\r\n]/.test(headerValue)) invalidPolicy();
    const bytes = new TextEncoder().encode(headerValue).byteLength;
    if (bytes > MAX_FIXED_HEADER_BYTES) invalidPolicy();
    totalBytes += bytes;
    if (totalBytes > MAX_FIXED_HEADERS_BYTES) invalidPolicy();
    setNames.add(normalized);
    set[name] = headerValue;
  }
  for (const name of passthrough) {
    const normalized = name.toLowerCase();
    if (allowedHeaderNames.has(normalized) || setNames.has(normalized)) invalidPolicy();
    setNames.add(normalized);
  }
  return { passthrough, set };
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
    || !Array.isArray(requests)
    || !Array.isArray(headers)) {
    invalidPolicy();
  }
  const allowedHeaderNames = validateHeaderNames(headers, POLICY_FORBIDDEN_HEADERS);
  const allowedHeaderNameSet = new Set(allowedHeaderNames.map((name) => name.toLowerCase()));
  const requestKeys = new Set<string>();
  const allowedRequests: CredentialRequestPolicy[] = [];
  for (const item of requests) {
    if (!isRecord(item) || typeof item.pathname !== 'string'
      || !item.pathname.startsWith('/') || item.pathname.includes('?')
      || item.pathname.includes('#') || item.pathname.includes('//')
      || !Array.isArray(item.methods) || item.methods.length === 0) invalidPolicy();
    const methods: string[] = [];
    const methodSet = new Set<string>();
    for (const method of item.methods) {
      if (typeof method !== 'string' || !HTTP_METHODS.has(method) || methodSet.has(method)) invalidPolicy();
      methodSet.add(method);
      methods.push(method);
      const key = `${item.pathname}\u0000${method}`;
      if (requestKeys.has(key)) invalidPolicy();
      requestKeys.add(key);
    }
    const outboundHeaders = item.outboundHeaders === undefined ? undefined
      : validateOutboundHeaders(item.outboundHeaders, allowedHeaderNameSet);
    allowedRequests.push({
      pathname: item.pathname,
      methods,
      ...(outboundHeaders === undefined ? {} : { outboundHeaders }),
    });
  }

  return {
    allowedOrigins: origins,
    allowedRequests,
    allowedHeaderNames,
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
): CredentialRequestPolicy {
  if (source.protocol !== 'https:' || source.username || source.password
    || target.protocol !== 'https:' || target.username || target.password
    || target.origin !== source.origin || target.port !== source.port
    || !policy.allowedOrigins.includes(target.origin)) {
    throw new Error('managed upstream target is outside credential policy');
  }
  if (expectedPath !== undefined && target.pathname !== expectedPath) {
    throw new Error('managed upstream target changed while acquiring credentials');
  }
  const requests = policy.allowedRequests.filter((item) => item.pathname === target.pathname
    && item.methods.some((value) => value.toUpperCase() === method.toUpperCase()));
  if (requests.length !== 1) {
    throw new Error('managed upstream request is outside credential policy');
  }
  return requests[0]!;
}

export function applyOutboundHeaderProfile(
  source: Headers,
  profile: CredentialOutboundHeaderProfile,
): Headers {
  const headers = new Headers();
  for (const name of profile.passthrough) {
    const value = source.get(name);
    if (value !== null && value.trim() !== '') headers.set(name, value.trim());
  }
  for (const [name, value] of Object.entries(profile.set)) headers.set(name, value);
  return headers;
}

export function validateCredentialLease(value: unknown, now = Date.now()): CredentialLease {
  if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= now || !isRecord(value.headers)) {
    throw new Error('invalid or expired credential lease');
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (!validHeaderName(name, POLICY_FORBIDDEN_HEADERS)
      || typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new Error('invalid credential header');
    }
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
