import type { Plugin } from '../../../packages/core/src/plugin.types';
import type { PluginHooks, RawResponseContext } from '../../../packages/core/src/hooks';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import { ChatgptOauthAdapter } from './adapter';

function validAccountRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value.trim() === value;
}

export const ChatgptOauthPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'chatgpt-oauth';
    static readonly version = '1.0.0';

    private readonly adapter: ChatgptOauthAdapter;

    constructor(config: Record<string, unknown> = {}) {
      if (config.accountRef !== undefined && !validAccountRef(config.accountRef)) {
        throw new Error('accountRef must be a trimmed non-empty string of at most 128 characters');
      }
      this.adapter = new ChatgptOauthAdapter();
    }

    register(hooks: PluginHooks): void {
      hooks.onBeforeRequest.tap(
        { name: 'chatgpt-oauth', stage: -10 },
        (context) => this.adapter.beforeRequest(context),
      );
      hooks.onRawResponse.tapPromise(
        { name: 'chatgpt-oauth', stage: -10 },
        (result, context: RawResponseContext) => this.adapter.rawResponse(result, context),
      );
    }
  },
);

export default ChatgptOauthPlugin;
