export type User = {id: string; username: string; displayName: string; disabled: boolean; hasLocalPassword: boolean; requiresPasswordChange: boolean};
import type { LoginProvider, MicrosoftConfiguration, OidcConfiguration } from '../shared/login-connections';
export type { LoginProvider, MicrosoftConfiguration, OidcConfiguration } from '../shared/login-connections';
export type Connection = {id: string; label: string; enabled: boolean; provider: LoginProvider; issuer: string; clientId: string; scopes: string[]; hasSecret: boolean; version: number; configuration: Record<string, never> | MicrosoftConfiguration | OidcConfiguration};
export type ConnectionInput = {id: string; label: string; enabled: boolean; provider: LoginProvider; clientId: string; clientSecret?: string; configuration: Connection['configuration']; scopes?: string[]; version?: number};
export type DiscoveryMetadata = {issuer: string; discoveryUrl: string; authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string; tokenEndpointAuthMethods: string[]; idTokenSigningAlgs: string[]};
export type Identity = {id: string; userId: string; connectionId: string; issuer: string; subject: string};
export function validPassword(password: string, confirmation: string) {
  if (password !== confirmation) throw new Error('password_confirmation');
  if ([...password].length < 5 || [...password].length > 32) throw new Error('invalid_password');
}
export function authorizationUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('oidc_failed');
  return url.href;
}
