import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { constantTimeCompare, extractToken } from '../auth';

export const NEXT_AUTHORIZATION_HEADER = 'x-bungee-next-authorization';

function parseAuthorization(value: string | null): string | null {
  if (value === null) return null;
  const parts = value.trim().split(' ').filter((part) => part.length > 0);
  if (parts.length === 2 && parts[0] === 'Bearer') return parts[1] ?? null;
  return parts.length === 1 ? parts[0] ?? null : null;
}

function matchesToken(
  supplied: string | null,
  aggregate: ConfigurationAggregateV2,
  resolve: (token: string) => unknown,
): boolean {
  const auth = aggregate.logical_configuration.auth;
  if (auth?.enabled !== true || supplied === null) return false;
  return auth.tokens.some((expression) => {
    try {
      const token = resolve(expression);
      return typeof token === 'string' && token.length > 0 && constantTimeCompare(supplied, token);
    } catch {
      return false;
    }
  });
}

export function matchesActiveAuth(
  request: Request,
  aggregate: ConfigurationAggregateV2,
  resolve: (token: string) => unknown,
): boolean {
  if (aggregate.logical_configuration.auth?.enabled !== true) return true;
  return matchesToken(extractToken(request), aggregate, resolve);
}

export function provesNextAuth(
  request: Request,
  aggregate: ConfigurationAggregateV2,
  resolve: (token: string) => unknown,
): boolean {
  if (aggregate.logical_configuration.auth?.enabled !== true) return true;
  return matchesToken(parseAuthorization(request.headers.get(NEXT_AUTHORIZATION_HEADER)), aggregate, resolve);
}

export function authChanged(active: ConfigurationAggregateV2, next: ConfigurationAggregateV2): boolean {
  const current = active.logical_configuration.auth;
  const candidate = next.logical_configuration.auth;
  if (current?.enabled !== candidate?.enabled) return true;
  const currentTokens = current?.tokens ?? [];
  const candidateTokens = candidate?.tokens ?? [];
  return currentTokens.length !== candidateTokens.length
    || currentTokens.some((token, index) => token !== candidateTokens[index]);
}
