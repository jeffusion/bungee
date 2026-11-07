import RequestLogs from '../../../../plugins/request-logs/server';
import type { PluginHooks } from '../../src/hooks';
import type { RequestLogBodyParser } from '../../src/gateway/request-log-contracts';

export const parseLogText: RequestLogBodyParser = async (body, consumer) =>
  new TextDecoder().decode(await body.decoded(consumer));

export const parseLogSse: RequestLogBodyParser = async (body, consumer) => {
  const frames = [];
  for await (const frame of body.events(consumer)) {
    if (frame.hasData) frames.push({ event: frame.event || 'message', data: frame.json ?? frame.data });
  }
  return frames;
};

export function registerRequestLogs(hooks: PluginHooks, options?: { sse: true }): void {
  if (options?.sse) {
    hooks.onRequestLogBody.tap('test-sse-parser', ({ contentType }) =>
      contentType.startsWith('text/event-stream') ? parseLogSse : undefined);
  }
  new RequestLogs().register(hooks);
}
