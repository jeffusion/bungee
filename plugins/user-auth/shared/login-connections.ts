export type LoginProvider = 'google' | 'microsoft' | 'github' | 'oidc';
export type MicrosoftConfiguration = { accountType: 'tenant' | 'organizations' | 'consumers' | 'common'; tenantId?: string };
export type OidcConfiguration = {
    mode: 'issuer' | 'discovery' | 'manual';
    issuer: string;
    discoveryUrl?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    jwksUri?: string;
    tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post';
    idTokenSigningAlg?: 'RS256' | 'PS256' | 'ES256';
};
export type LoginConfiguration = Record<string, never> | MicrosoftConfiguration | OidcConfiguration;
export interface VerifiedIdentity { protocol: 'oidc' | 'oauth2'; issuer: string; subject: string; displayName: string }
