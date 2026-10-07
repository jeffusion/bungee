import { defineRpcService } from '@jeffusion/bungee-core/plugin';

const command = { deduplication: 'none', resultRetentionMs: null, quotaBytes: 65536, maxResultBytes: 65536 } as const;
export const businessRpc = defineRpcService({id: 'chatgpt-oauth.credentials.v1', version: 1, methods: {
  getCredential: {kind: 'command', input: {type: 'object', properties: {}}, output: {type: 'object', properties: {version: {type: 'number', integer: true, minimum: 1}, expiresAt: {type: 'number'}, headers: {type: 'record', values: {type: 'string'}, maxEntries: 16}}}, purposes: ['attempt'], command, timeoutMs: 15000},
  rejectAccess: {kind: 'command', input: {type: 'object', properties: {version: {type: 'number', integer: true, minimum: 1}}}, output: {type: 'object', properties: {rejected: {type: 'boolean'}}}, purposes: ['attempt'], command, timeoutMs: 15000},
}});
