import { businessRpc } from './rpc';
import type { Plugin } from '@jeffusion/bungee-core/plugin';
import type { PluginHooks, RawResponseContext } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import { ChatgptOauthAdapter } from './adapter';

function validAccountRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value;
}

export const ChatgptOauthPlugin = definePlugin(
  class implements Plugin {
    static readonly controlRpcContract = businessRpc;
    static readonly name = 'chatgpt-oauth';
    static readonly version = '1.0.0';

    private readonly adapter: ChatgptOauthAdapter;

    constructor(config: Record<string, unknown> = {}) {
      if (config.accountRef !== undefined && !validAccountRef(config.accountRef)) {
        throw new Error('accountRef must be a trimmed non-empty string of at most 128 characters');
      }
      this.adapter = new ChatgptOauthAdapter();
    }

    bodyRequirements(context: import('@jeffusion/bungee-core/plugin').PluginBodyRequirementContext): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements {
      const path = context.url.pathname;
      if (path === '/v1/models' && context.method.toUpperCase() === 'GET') return { request: 'none', response: ['json'] };
      return context.method.toUpperCase() === 'POST' && ['/v1/chat/completions', '/v1/responses', '/backend-api/codex/responses'].includes(path) ? { request: 'json-write', response: path === '/backend-api/codex/responses' ? [] : ['json', 'sse-json'] } : { request: 'none' };
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'chatgpt-oauth', stage: -10 },
        (context) => this.adapter.beforeRequest(context),
      );
      // Reconcile after the currently registered request-transform stages; higher stages/scopes may still run later.
      hooks.onBeforeRequest.tap(
        { name: 'chatgpt-oauth-outbound-reconciliation', stage: 1000 },
        (context) => this.adapter.reconcileOutboundRequest(context),
      );
      hooks.onRawResponse.tapPromise(
        { name: 'chatgpt-oauth', stage: -10 },
        (result, context: RawResponseContext) => this.adapter.rawResponse(result, context),
      );
    }
  },
);

export default ChatgptOauthPlugin;
