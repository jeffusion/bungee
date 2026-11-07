import type {
  BodyHandle, RequestLogBodyContext, RequestLogBodyStreamParser, RequestLogContext, RequestLogEvent, RequestLogObserver, RequestLogRecords,
} from '@jeffusion/bungee-core/plugin';
import { object, type HttpProtocol } from './contracts';
import { gemini } from './gemini';
import { responses } from './responses';

const protocols = [responses, gemini];

export function mediaType(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

function isJson(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json');
}

function httpCandidates(context: RequestLogContext, streaming: boolean) {
  return protocols.map(protocol => ({ name: protocol.name, decoder: protocol.http(context, streaming) }));
}

export function streamBodyParser(context: RequestLogBodyContext): RequestLogBodyStreamParser | undefined {
  if (context.method !== 'POST' || context.stage !== 'client-response' || mediaType(context.contentType) !== 'text/event-stream') return;
  return {
    async *stream(body) {
      const candidates = httpCandidates(context, true);
      let decoder: HttpProtocol | undefined;
      let first = true;
      for await (const frame of body.events()) {
        if (frame.truncated || frame.hasData === false) continue;
        const value = object(frame.json);
        if (!value) continue;
        if (decoder) {
          if (!decoder.matches(value, frame.event, true)) continue;
        } else {
          decoder = candidates.find(candidate => candidate.decoder.matches(value, frame.event, false))?.decoder;
          if (!decoder) continue;
        }
        yield (first ? '[' : ',') + JSON.stringify({ event: frame.event || 'message', data: value });
        first = false;
      }
      if (!first) yield ']';
    },
  };
}

async function observeHttp(
  context: RequestLogContext, event: Extract<RequestLogEvent, { kind: 'http' }>, records: RequestLogRecords,
): Promise<void> {
  const type = mediaType(event.contentType);
  const streaming = type === 'text/event-stream';
  if (!streaming && !isJson(type)) return;
  const candidates = httpCandidates(context, streaming);
  const consumer = { id: 'request-log-protocol', mandatory: false, signal: event.signal };
  if (!streaming) {
    const bodyHandle: BodyHandle = event.body;
    const body = object(await bodyHandle.json(consumer));
    if (!body) return;
    const candidate = candidates.find(({ decoder }) => decoder.matches(body, undefined, false));
    if (!candidate) return;
    const id = await records.start({ protocol: candidate.name, operation: candidate.decoder.operation });
    const result = candidate.decoder.observe(body, undefined) ?? candidate.decoder.end?.();
    if (id && result) records.finish(id, result);
    return;
  }
  let decoder: HttpProtocol | undefined;
  let id: string | undefined;
  for await (const frame of event.body.events(consumer)) {
    if (frame.truncated) continue;
    const body = object(frame.json);
    if (!body) continue;
    if (!decoder) {
      const candidate = candidates.find(candidate => candidate.decoder.matches(body, frame.event, false));
      if (!candidate) continue;
      decoder = candidate.decoder;
      id = await records.start({ protocol: candidate.name, operation: decoder.operation });
      if (!id) return;
    } else if (!decoder.matches(body, frame.event, true)) continue;
    const result = decoder.observe(body, frame.event);
    if (result && id) {
      records.finish(id, result);
      return;
    }
  }
  const result = decoder?.end?.();
  if (id && result) records.finish(id, result);
}

export function applicationObserver(context: RequestLogContext): RequestLogObserver | undefined {
  if (context.transportType === 'http') {
    if (context.method === 'POST') return { observe: (event, records) => {
      if (event.kind === 'http') return observeHttp(context, event, records);
    } };
    return;
  }
  const observers = protocols.flatMap(protocol => protocol.websocket(context) ?? []);
  let selected: RequestLogObserver | undefined;
  const deliverLifecycle = (deliveries: Array<{
    observer: RequestLogObserver;
    deliver: (records: RequestLogRecords) => void | Promise<void>;
  }>) => async (records: RequestLogRecords) => {
    for (const { observer, deliver } of deliveries) {
      if (selected && selected !== observer) continue;
      await deliver({
        ...records,
        async start(fields) {
          const id = await records.start(fields);
          if (id) selected = observer;
          return id;
        },
      });
    }
  };
  return {
    observe() {},
    prepareWebSocket(event, bodies) {
      const deliveries = (selected ? [selected] : observers).flatMap(observer => {
        const deliver = observer.prepareWebSocket?.(event, bodies);
        return deliver ? [{ observer, deliver }] : [];
      });
      if (deliveries.length) return deliverLifecycle(deliveries);
    },
  };
}
