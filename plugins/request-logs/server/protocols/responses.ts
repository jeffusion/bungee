import type {
  RequestLogObserver, RequestLogRecords, RequestLogWebSocketBody, WebSocketMessageView,
} from '@jeffusion/bungee-core/plugin';
import { object, type JsonObject, type LogProtocol, type Result } from './contracts';

const operation = { protocol: 'responses', operation: 'response.create' };
type StreamId = string | undefined;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function streamId(body: JsonObject, response?: JsonObject): StreamId | null {
  const outer = body.stream_id;
  const inner = response?.stream_id;
  if (outer !== undefined && inner !== undefined && outer !== inner) return null;
  const value = outer === undefined ? inner : outer;
  return value === undefined ? undefined : identifier(value) ?? null;
}

function responseResult(status: unknown): Result | undefined {
  switch (status) {
    case 'completed': return { outcome: 'completed' };
    case 'failed': return { outcome: 'failed', code: 'upstream_protocol_error' };
    case 'incomplete': return { outcome: 'incomplete', code: 'incomplete' };
    case 'cancelled': return { outcome: 'cancelled' };
  }
}

function eventResult(type: unknown, response?: JsonObject): Result | undefined {
  if (type === 'error') return responseResult('failed');
  if (typeof type !== 'string' || !type.startsWith('response.') || !response) return;
  const result = responseResult(type.slice('response.'.length));
  if (response.status === undefined || response.status === result?.outcome) {
    return result;
  }
}

function isOpeningType(type: unknown): boolean {
  return type === 'response.created' || type === 'response.in_progress';
}

const MAX_OPERATIONS = 64;
const MAX_RECENT_RESPONSE_IDS = 256;
const LIFECYCLE_TYPES = [
  'response.created', 'response.in_progress', 'response.completed', 'response.incomplete',
  'response.failed', 'response.cancelled', 'error',
];

interface PendingResponse {
  stream: StreamId;
  startedAt: number;
  capture?: RequestLogWebSocketBody;
}

interface ActiveResponse extends PendingResponse {
  id?: string;
  result?: Result;
}

function observeWebSocket(hosted: boolean): RequestLogObserver {
  const operations = new Map<string, ActiveResponse>();
  const pending: PendingResponse[] = [];
  const seen = new Set<string>();
  const uncertain = new Set<StreamId>();
  const unconfirmed = new Map<string, StreamId>();
  let overflow = false;

  const start = (key: string, current: ActiveResponse) => {
    operations.set(key, current);
    return async (records: RequestLogRecords) => {
      current.id = await records.start({ ...operation, body: current.capture, startedAt: current.startedAt });
      if (current.id) return;
      current.capture?.discard();
      if (operations.get(key) === current) operations.delete(key);
    };
  };
  const finish = (key: string, current: ActiveResponse, result?: Result) => {
    operations.delete(key);
    return (records: RequestLogRecords) => {
      if (current.id) records.finish(current.id, result);
    };
  };

  return {
    observe() {},
    prepareWebSocket(event, bodies) {
      const { relatedOperationId } = event;
      const message: WebSocketMessageView = event.message;
      const hostedOperation = hosted && relatedOperationId ? operations.get(relatedOperationId) : undefined;
      if (event.settled) {
        if (!hostedOperation || !relatedOperationId) return;
        return finish(relatedOperationId, hostedOperation, hostedOperation.result);
      }
      if (message.kind !== 'text') return;
      if (event.direction === 'client' && message.mayContainJsonString?.('response.create') === false) return;
      if (event.direction === 'upstream' && hosted && !hostedOperation) return;
      if (event.oversized) {
        if (hosted) {
          hostedOperation?.capture?.discardResponse('size_limit');
        } else if (event.direction === 'client') {
          // An uninspected create could belong to any lane. Keep known response IDs usable.
          overflow = true;
          for (const candidate of pending) candidate.capture?.discard();
          pending.length = 0;
        } else {
          for (const current of operations.values()) current.capture?.discardResponse('size_limit');
          if (message.mayContainJsonString?.(...LIFECYCLE_TYPES) !== false) {
            // Without the response ID, a later opening could replay this frame's operation.
            overflow = true;
            for (const candidate of pending) candidate.capture?.discard();
            pending.length = 0;
          }
        }
        return;
      }
      if (event.direction === 'upstream' && (!bodies || !operations.size)
        && message.mayContainJsonString?.(...LIFECYCLE_TYPES) === false) return;
      const body = object(message.json());
      if (!body) {
        if (event.direction === 'upstream') {
          for (const current of operations.values()) current.capture?.discardResponse();
        }
        return;
      }

      if (event.direction === 'client') {
        if (body.type !== 'response.create') return;
        if (hosted) {
          if (relatedOperationId) return start(relatedOperationId, { stream: undefined, startedAt: event.timestamp, capture: bodies?.start(message) });
          return;
        }
        const stream = streamId(body);
        if (overflow || stream === null || uncertain.has(stream)) return;
        const existing = pending.findIndex(candidate => candidate.stream === stream);
        if (existing !== -1) {
          // The response ID identifies the output, while both creates could own it.
          // Leave other lanes usable and quarantine this lane against late openings.
          pending.splice(existing, 1)[0]!.capture?.discard();
          uncertain.add(stream);
          return;
        }
        if (pending.length + uncertain.size >= MAX_OPERATIONS) {
          overflow = true;
          for (const candidate of pending) candidate.capture?.discard();
          pending.length = 0;
          return;
        }
        pending.push({ stream, startedAt: event.timestamp, capture: bodies?.start(message) });
        return;
      }

      const response = object(body.response);
      const result = eventResult(body.type, response);
      if (hosted) {
        if (!hostedOperation) return;
        hostedOperation.capture?.append(message);
        // Forwarded errors may be intermediate. The host can reject a generation
        // after sending a protocol terminal, so keep observing until it settles.
        if (event.hostedErrorOutcome) {
          hostedOperation.result = { outcome: event.hostedErrorOutcome,
            code: event.hostedErrorOutcome === 'failed' ? 'upstream_protocol_error' : undefined };
        } else if (result && body.type !== 'error') {
          hostedOperation.result = result;
        }
        return;
      }

      const opening = response?.object === 'response' && isOpeningType(body.type)
        && identifier(response.id) !== undefined
        && (response.status === undefined || response.status === 'queued' || response.status === 'in_progress');
      const declaredResponseId = response?.id ?? body.response_id;
      const responseId = identifier(declaredResponseId);
      const stream = streamId(body, response);
      if (stream === null || (declaredResponseId !== undefined && !responseId)
        || (response?.id !== undefined && body.response_id !== undefined && response.id !== body.response_id)) {
        if (typeof body.type === 'string' && (body.type.startsWith('response.') || body.type === 'error')) {
          for (const current of operations.values()) current.capture?.discardResponse();
        }
        return;
      }

      // An error without a response ID can be stale, even when it names a stream.
      if (body.type === 'error' && !responseId) {
        for (const current of operations.values()) {
          if (stream === undefined || current.stream === stream) current.capture?.discardResponse();
        }
        for (let i = pending.length - 1; i >= 0; i--) {
          const candidate = pending[i]!;
          if (stream !== undefined && candidate.stream !== stream) continue;
          uncertain.add(candidate.stream);
          candidate.capture?.discard();
          pending.splice(i, 1);
        }
        return;
      }

      if (!responseId) {
        if (typeof body.type !== 'string' || !body.type.startsWith('response.')) return;
        const possible = [...operations.values()].filter(current => stream === undefined || current.stream === stream);
        const hasPending = pending.some(candidate => stream === undefined || candidate.stream === stream);
        const hasUnconfirmed = stream === undefined ? unconfirmed.size > 0 : [...unconfirmed.values()].includes(stream);
        const ambiguous = overflow || hasUnconfirmed || hasPending
          || (stream === undefined ? uncertain.size > 0 : uncertain.has(stream)) || possible.length !== 1;
        for (const current of possible) {
          if (ambiguous || result || isOpeningType(body.type)) current.capture?.discardResponse();
          else current.capture?.append(message);
        }
        return;
      }

      const established = operations.get(responseId);
      if (established) {
        if (stream === undefined || stream === established.stream) {
          if (typeof body.type === 'string' && (body.type.startsWith('response.') || body.type === 'error')) {
            established.capture?.append(message);
          }
          if (result) return finish(responseId, established, result);
        } else {
          established.capture?.discardResponse();
        }
        return;
      }

      if (result) unconfirmed.delete(responseId);
      const replay = seen.has(responseId);
      // Non-lifecycle frames cannot establish an operation or consume a replay slot.
      if (!opening && !result) return;
      seen.add(responseId);
      // shortcut: Recent IDs cover normal replays; a transport replaying older opens needs host correlation.
      if (seen.size > MAX_RECENT_RESPONSE_IDS) seen.delete(seen.values().next().value!);
      if (!opening) return;
      const index = pending.findIndex(candidate => candidate.stream === stream);
      if (replay || index === -1 || overflow || uncertain.has(stream) || operations.size >= MAX_OPERATIONS) {
        if (unconfirmed.size < MAX_OPERATIONS) unconfirmed.set(responseId, stream);
        else overflow = true;
        return;
      }
      // An opening response and a matching client create jointly identify native Responses.
      const current = pending.splice(index, 1)[0]!;
      current.capture?.append(message);
      return start(responseId, current);
    },
  };
}

export const responses: LogProtocol = {
  name: operation.protocol,
  http(context, streaming) {
    const endpoint = /\/responses\/?$/.test(context.path);
    let responseId: string | undefined;
    return {
      operation: operation.operation,
      matches(body, event, confirmed) {
        const error = object(body.error);
        const errorEnvelope = typeof error?.message === 'string' && (typeof error.type === 'string' || typeof error.code === 'string');
        if (!streaming) return (body.object === 'response' && identifier(body.id) !== undefined) || (endpoint && errorEnvelope);
        const type = body.type ?? event;
        if (type === 'error') {
          const errorResponseId = identifier(body.response_id);
          if (responseId && errorResponseId && errorResponseId !== responseId) return false;
          const openAIError = body.type === 'error' && typeof body.message === 'string' && Number.isInteger(body.sequence_number)
            && (body.code === null || typeof body.code === 'string') && (body.param === null || typeof body.param === 'string');
          return openAIError || (confirmed && errorEnvelope);
        }
        if (typeof type !== 'string' || !type.startsWith('response.')) return false;
        const response = object(body.response);
        const id = identifier(response?.id ?? body.response_id);
        if (responseId && id && id !== responseId) return false;
        const opening = isOpeningType(type);
        const terminal = responseResult(type.slice('response.'.length)) !== undefined;
        if (opening || terminal) {
          if (!id || response?.object !== 'response' || (terminal && !eventResult(type, response))) return false;
          responseId ??= id;
          return true;
        }
        return confirmed;
      },
      observe(body, event) {
        if (!streaming) return responseResult(body.object === 'response' ? body.status : 'failed');
        const result = eventResult(body.type ?? event, object(body.response));
        return result?.outcome === 'completed' ? { ...result, acceptClientDisconnect: true } : result;
      },
    };
  },
  websocket(context) { return observeWebSocket(context.webSocketMode === 'responses'); },
};
