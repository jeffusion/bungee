import type { RequestLogObserver, RequestLogRecords, WebSocketMessageView } from '@jeffusion/bungee-core/plugin';
import { object, type JsonObject, type LogProtocol, type Result } from './contracts';

function candidates(body: JsonObject): JsonObject[] {
  if (!Array.isArray(body.candidates)) return [];
  return body.candidates.map(object).filter((candidate): candidate is JsonObject => candidate !== undefined);
}

function finishReason(value: unknown): Result | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z_]{1,63}$/.test(value) || value === 'FINISH_REASON_UNSPECIFIED') return;
  if (value === 'STOP') return { outcome: 'completed' };
  return { outcome: value === 'MAX_TOKENS' ? 'incomplete' : 'failed', code: value };
}

function live(): RequestLogObserver {
  const operation = { protocol: 'gemini', operation: 'bidiGenerateContent' };
  let setup = false;
  let confirmed = false;
  type Turn = { startedAt: number; id?: string; started: boolean; interrupted: boolean };
  let current: Turn | undefined;
  const beginTurn = (turn: Turn) => {
    if (turn.started) return;
    turn.started = true;
    return async (records: RequestLogRecords) => {
      turn.id = await records.start({ ...operation, startedAt: turn.startedAt });
    };
  };
  return {
    observe() {},
    prepareWebSocket(event) {
      const message: WebSocketMessageView = event.message;
      if (event.settled || event.oversized || (!setup && event.direction !== 'client')) return;
      if (event.direction === 'client') {
        if ((setup ? message.mayContainJsonString?.('clientContent', 'realtimeInput') : message.mayContainJsonString?.('setup')) === false) return;
        const body = object(message.json());
        if (!setup) {
          const model = object(body?.setup)?.model;
          setup = typeof model === 'string' && model.startsWith('models/') && model.length > 7;
        } else if (confirmed) {
          const content = object(body?.clientContent);
          if (content || object(body?.realtimeInput)) {
            current ??= { startedAt: event.timestamp, started: false, interrupted: false };
            if (content?.turnComplete === true) return beginTurn(current);
          }
        }
        return;
      }
      if (message.mayContainJsonString?.(confirmed ? 'serverContent' : 'setupComplete') === false) return;
      const body = object(message.json({ binary: true }));
      if (!confirmed) {
        confirmed = object(body?.setupComplete) !== undefined;
        return;
      }
      const content = object(body?.serverContent);
      const turn = current;
      if (!content || !turn) return;
      turn.interrupted ||= content.interrupted === true;
      const complete = content.turnComplete === true;
      const started = !!object(content.modelTurn) || content.generationComplete === true || turn.interrupted;
      const begin = started || complete ? beginTurn(turn) : undefined;
      if (!complete) return begin;
      current = undefined;
      return async records => {
        await begin?.(records);
        if (turn.id) records.finish(turn.id, { outcome: turn.interrupted ? 'cancelled' : 'completed' });
      };
    },
  };
}

export const gemini: LogProtocol = {
  name: 'gemini',
  http(context, streaming) {
    const endpoint = /:(?:streamGenerateContent|generateContent)\/?$/.test(context.path);
    const outcomes = new Map<number, Result | undefined>();
    return {
      operation: streaming ? 'streamGenerateContent' : 'generateContent',
      matches(body, _event, confirmed) {
        const metadata = typeof body.modelVersion === 'string' || typeof body.responseId === 'string';
        const feedback = object(body.promptFeedback);
        const error = object(body.error);
        return ((endpoint || metadata || confirmed) && (
          candidates(body).some(candidate => object(candidate.content)?.role === 'model' || finishReason(candidate.finishReason))
          || typeof feedback?.blockReason === 'string'
        )) || ((endpoint || confirmed) && typeof error?.status === 'string' && typeof error.code === 'number');
      },
      observe(body) {
        if (object(body.error)) return { outcome: 'failed', code: 'upstream_protocol_error' };
        const block = object(body.promptFeedback)?.blockReason;
        if (typeof block === 'string' && block !== 'BLOCK_REASON_UNSPECIFIED') return { outcome: 'failed', code: block };
        for (const [position, candidate] of candidates(body).entries()) {
          const index = candidate.index ?? position;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= 64) continue;
          const result = finishReason(candidate.finishReason);
          if (result || !outcomes.has(index)) outcomes.set(index, result);
        }
      },
      end() {
        const results = [...outcomes.values()];
        return results.find(result => result?.outcome === 'failed')
          ?? (results.some(result => !result) ? undefined : results.find(result => result?.outcome === 'incomplete') ?? results[0]);
      },
    };
  },
  websocket(context) { if (!context.webSocketMode) return live(); },
};
