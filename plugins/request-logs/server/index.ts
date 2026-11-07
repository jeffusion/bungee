import { definePlugin, type Plugin, type PluginHooks } from '@jeffusion/bungee-core/plugin';

import { applicationObserver, mediaType, streamBodyParser } from './protocols';

import { json, text } from './body-parsers';

export default definePlugin(class implements Plugin {
  static readonly name = 'request-logs';
  static readonly version = '1.0.0';

  bodyRequirements() { return { request: 'none' as const }; }

  register(hooks: PluginHooks): void {
    hooks.onRequestLog.tap('request-logs', () => true as const);
    const fallback = { name: 'request-logs', stage: Number.MAX_SAFE_INTEGER };
    hooks.onRequestLogBody.tap(fallback, context => {
      if (context.transportType !== 'http') return;
      const type = mediaType(context.contentType);
      if (type === 'application/json' || type.endsWith('+json')) return json;
      if (type === 'text/plain') return text;
      return streamBodyParser(context);
    });
    hooks.onRequestLogApplication.tap(fallback, applicationObserver);
  }
});
