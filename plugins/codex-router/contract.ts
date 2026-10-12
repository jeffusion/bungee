import { defineRpcService, type PluginServices } from '@jeffusion/bungee-core/plugin';

const key = {type: 'string', minLength: 64, maxLength: 64} as const;
const etag = {type: 'string', minLength: 66, maxLength: 66} as const;

/** Only directory validators cross workers; no catalog bodies or credentials. */
export const catalogValidatorsRpc = defineRpcService({
  id: 'codex-router.catalog-validators.v1', version: 1, methods: {
    get: {kind: 'query', input: {type: 'object', properties: {key}},
      output: {type: 'union', variants: [etag, {type: 'null'}]}, purposes: ['request', 'attempt']},
    put: {kind: 'command', input: {type: 'object', properties: {key, etag}},
      output: {type: 'null'}, purposes: ['request', 'attempt'],
      command: {deduplication: 'none', resultRetentionMs: 1, quotaBytes: 1024, maxResultBytes: 1024}},
  },
});

export function catalogValidatorsClient(services: PluginServices) {
  return services.rpc!.consume('codex-router', catalogValidatorsRpc);
}
