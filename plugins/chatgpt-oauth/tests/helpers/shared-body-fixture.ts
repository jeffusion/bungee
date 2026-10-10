import type { BodyEvent, RawResponseContext, RawResponseResult } from '@jeffusion/bungee-core/plugin';
import { BodySource } from '../../../../packages/core/src/gateway/body-service';
import { controlledBodyHandle } from '../../../../packages/core/src/gateway/controlled-views';
import { ChatgptOauthAdapter as ProductionAdapter } from '../../server/adapter';

/** Test host: use the real central owner and its controlled view, including cancellation. */
export function responseBodyFixture(response: Response, context: Pick<RawResponseContext, 'requestId' | 'attemptId' | 'signal'>, maxBytes = 50 * 1024 * 1024) {
  const source = new BodySource(response.body, maxBytes, response.headers.get('content-encoding') ?? '', context.signal, {
    requestId: context.requestId, attemptId: context.attemptId, direction: 'response', stage: 'upstream-response', version: 0,
    contentType: response.headers.get('content-type') ?? '', contentEncoding: response.headers.get('content-encoding') ?? '',
  });
  const transport = source.take() as ReadableStream<Uint8Array> | null;
  const handle = controlledBodyHandle(source, transport, source.handle(), context.signal);
  return { source, handle };
}

export class ChatgptOauthAdapter extends ProductionAdapter {
  override async rawResponse(result: RawResponseResult, context: RawResponseContext): Promise<RawResponseResult> {
    if (context.bodyHandle) return super.rawResponse(result, context);
    const fixture = responseBodyFixture(result.response, context);
    const output = await super.rawResponse(result, { ...context, bodyHandle: fixture.handle });
    void output.completion.finally(() => fixture.source.dispose()).catch(() => undefined);
    return output;
  }
}

export type FixtureSource = string | AsyncIterable<Uint8Array | string> | ReadableStream<Uint8Array>;
export function sharedEvents(input: FixtureSource, options: { signal?: AbortSignal; maxBytes?: number } = {}): AsyncIterable<BodyEvent> {
  const signal = options.signal ?? new AbortController().signal;
  let stream: ReadableStream<Uint8Array>;
  if (typeof input === 'string') stream = new Response(input).body!;
  else if ('getReader' in input) stream = input as ReadableStream<Uint8Array>;
  else {
    const iterator = input[Symbol.asyncIterator]();
    stream = new ReadableStream<Uint8Array>({
      async pull(controller) { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(typeof next.value === 'string' ? new TextEncoder().encode(next.value) : next.value); },
      cancel() { void Promise.resolve(iterator.return?.()).catch(() => undefined); },
    }, { highWaterMark: 0 });
  }
  const fixture = responseBodyFixture(new Response(stream), { requestId: 'protocol-test', attemptId: 'protocol-attempt', signal }, options.maxBytes ?? 50 * 1024 * 1024);
  return { async *[Symbol.asyncIterator]() {
    try { yield* fixture.handle.events({ id: 'protocol-fixture', mandatory: true, signal }); }
    finally { fixture.source.dispose(); }
  } };
}
