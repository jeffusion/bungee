import { createHash, timingSafeEqual } from 'node:crypto';
import { ANONYMOUS_PRINCIPAL, type DataPrincipal, type AdmissionTarget, type AdmissionDenial, type IngressPlugin } from '@jeffusion/bungee-core/plugin';
import { DataAdmissionError } from '@jeffusion/bungee-core/plugin';

export interface AccessPolicy { routes: string[] | null; models: string[] | null }
export interface AccessCredential {
  id: string; domain: 'data'; name: string; prefix: string; digest: string;
  createdAt: number; expiresAt: number | null; revokedAt: number | null; credentialVersion: number;
}
export interface AccessPublication {
  protectedRouteIds: string[];
  byKey: Record<string, AccessPolicy | null>;
  credentials: AccessCredential[];
}
export function stringIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || value.some(x => typeof x !== 'string' || !x.length || x.length > 256)
    || new Set(value).size !== value.length) throw new Error('invalid_policy');
  return [...value];
}
export function validatePolicy(value: unknown): AccessPolicy | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['routes', 'models'].includes(k))) throw new Error('invalid_policy');
  const p = value as AccessPolicy;
  return {routes: p.routes === null ? null : stringIds(p.routes), models: p.models === null ? null : stringIds(p.models)};
}
export function validatePublication(value: unknown): AccessPublication {
  const p = value as AccessPublication;
  if (!p || typeof p !== 'object' || !p.byKey || typeof p.byKey !== 'object' || Array.isArray(p.byKey)
    || !Array.isArray(p.credentials)) throw new Error('invalid_policy');
  const protectedRouteIds = stringIds(p.protectedRouteIds);
  for (const key of p.credentials) {
    if (!key || key.domain !== 'data' || typeof key.id !== 'string' || !key.id || !/^[a-f0-9]{64}$/.test(key.digest)
      || !Number.isSafeInteger(key.credentialVersion) || key.credentialVersion < 1
      || (key.expiresAt !== null && !Number.isSafeInteger(key.expiresAt))
      || (key.revokedAt !== null && !Number.isSafeInteger(key.revokedAt))) throw new Error('invalid_credentials');
  }
  return {...p, protectedRouteIds};
}
export function validPrincipal(principal: DataPrincipal, value: AccessPublication, now: number): boolean {
  const key = value.credentials.find(key => key.id === principal.keyId);
  return principal.domain === 'data' && !!key && key.credentialVersion === principal.credentialVersion
    && key.revokedAt === null && (key.expiresAt === null || key.expiresAt > now);
}
/** Only * is special; every other character is literal. Match the entire model. */
function matchesModel(pattern: string, model: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === model;
  const first = parts[0]!, last = parts[parts.length - 1]!;
  if (!model.startsWith(first) || !model.endsWith(last)) return false;
  let cursor = first.length;
  const end = model.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const index = model.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }
  return cursor <= end;
}
function protectedScopes(target: AdmissionTarget, publication: AccessPublication): string[] {
  return [...new Set([target.entryRouteId,target.routeId].filter((id): id is string => !!id && publication.protectedRouteIds.includes(id)))];
}
function check(target: AdmissionTarget, policy: AccessPolicy | null, scopes: string[] = [target.routeId]): AdmissionDenial | null {
  if (target.principal.domain === 'anonymous') return null;
  if (policy && ((policy.routes !== null && !scopes.every(id => policy.routes!.includes(id)))
    || (policy.models !== null && (!target.model || !policy.models.some(pattern => matchesModel(pattern, target.model!)))))) return {error: 'key-access.scope_denied', status: 403};
  return null;
}
export function createIngress(): IngressPlugin { return {
  bodyRequirements(target, value) {
    const publication = validatePublication(value);
    if (protectedScopes(target,publication).length === 0 || target.principal.domain !== 'data') return { request: 'none' };
    const policy = validatePolicy(publication.byKey[target.principal.keyId] ?? null);
    const urlModel = /\/models\/([^/:]+):(?:streamGenerateContent|generateContent)$/.test(new URL(target.url).pathname);
    return { request: policy?.models !== null && policy?.models !== undefined && policy.models.length > 0 && !urlModel ? 'json-read' : 'none' };
  },
  authenticate(request, value, now) {
    const p = validatePublication(value);
    const match = /^Bearer (bng_data_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get('authorization') ?? '');
    if (!match) return null;
    const digest = createHash('sha256').update(match[1]!).digest('hex');
    const key = p.credentials.find(key => timingSafeEqual(Buffer.from(key.digest, 'hex'), Buffer.from(digest, 'hex')));
    if (!key) return null;
    const principal = {domain: 'data', keyId: key.id, credentialVersion: key.credentialVersion};
    return validPrincipal(principal, p, now) ? principal : null;
  },
  resolveIdentity(target, value) {
    const p = validatePublication(value);
    if (protectedScopes(target,p).length === 0) return ANONYMOUS_PRINCIPAL;
    if (!validPrincipal(target.principal, p, target.now)) throw new DataAdmissionError(401, 'unauthorized');
    return target.principal;
  },
  plan(target, value) {
    try {
      const p = validatePublication(value);
      if (protectedScopes(target,p).length === 0) return {snapshot: null};
      if (target.principal.domain === 'anonymous') return {denial: {error: 'unauthorized', status: 401}};
      const policy = validatePolicy(p.byKey[target.principal.keyId] ?? null);
      const scopes = protectedScopes(target,p);
      const denial = check(target, policy,scopes);
      return denial ? {denial} : {snapshot: {routeId: target.routeId, entryRouteId:target.entryRouteId ?? null, scopes, policy: policy as any}};
    } catch { return {denial: {error: 'key-access.policy_unavailable', status: 503}}; }
  },
  beforeAttempt(target, snapshot) {
    if (snapshot === null) return target.principal.domain === 'anonymous' ? null : {error: 'key-access.invalid_grant', status: 503};
    try {
      const s = snapshot as {routeId: string; entryRouteId?: string | null; scopes?: string[]; policy: AccessPolicy | null};
      if (!s || s.routeId !== target.routeId || (s.entryRouteId ?? null) !== (target.entryRouteId ?? null)) return {error: 'key-access.scope_denied', status: 403};
      return check(target, validatePolicy(s.policy),s.scopes ?? [target.routeId]);
    } catch { return {error: 'key-access.policy_unavailable', status: 503}; }
  },
}; }
