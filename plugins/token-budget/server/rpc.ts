import { defineRpcService } from '../../../packages/core/src/plugin-services';

const command = { deduplication: 'none', resultRetentionMs: null, quotaBytes: 65536, maxResultBytes: 65536 } as const;
export const businessRpc = defineRpcService({id: 'token-budget.admission.v1', version: 1, methods: {
  prepare: {kind: 'command', input: {type: 'object', properties: {snapshot: {type: 'json'}}}, output: {type: 'json'}, purposes: ['attempt'], command, timeoutMs: 15000},
  status: {kind: 'query', input: {type: 'null'}, output: {type: 'json'}, purposes: ['attempt'], timeoutMs: 15000},
  cancel: {kind: 'command', input: {type: 'object', properties: {sent: {type: 'literal', value: false}}}, output: {type: 'json'}, purposes: ['attempt'], command, timeoutMs: 15000},
  settle: {kind: 'command', input: {type: 'object', properties: {result: {type: 'json'}, costNanoUsd: {type: 'union', variants: [{type: 'null'}, {type: 'number', integer: true, minimum: 0}]}}, optional: ['costNanoUsd']}, output: {type: 'json'}, purposes: ['attempt'], command, timeoutMs: 15000},
}});
