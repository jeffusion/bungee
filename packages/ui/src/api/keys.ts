import { api, requestPluginControl } from './client';
export interface ApiKey { id:string;name:string;prefix:string;createdAt:number;expiresAt:number|null;revokedAt:number|null }
export interface KeyExtension {plugin:string;component:string;path:string;active:boolean;ready:boolean;value:unknown;usage?:unknown;reason?:string}
export interface KeyPublication { ready?:boolean;published?:boolean;persisted?:boolean }
export interface CreatedKey extends KeyPublication {key:ApiKey;token:string}
export const keysApi = {
  extensions: (id:string) => api.get<{extensions:KeyExtension[]}>(`/resources/api-key/${encodeURIComponent(id)}/extensions`),
  list: () => api.get<{keys:ApiKey[]}>('/resources/api-key'),
  create: (input:{name:string;expiresAt?:number|null}) => requestPluginControl<CreatedKey>('key-access', '/credentials', 'POST', input),
  reveal: (id:string) => requestPluginControl<{token:string}>('key-access', `/credentials/${encodeURIComponent(id)}`, 'GET'),
  update: (id:string,input:{name:string;expiresAt:number|null;routes:string[]|null;models:string[]|null}) => requestPluginControl<KeyPublication & {key:ApiKey}>('key-access', `/credentials/${encodeURIComponent(id)}`, 'PUT', input),
  remove: (id:string) => requestPluginControl<KeyPublication>('key-access', `/credentials/${encodeURIComponent(id)}`, 'DELETE'),
};
