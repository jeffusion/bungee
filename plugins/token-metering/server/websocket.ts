import { randomUUID, createHash } from 'node:crypto';
import type { AttemptObservationEvent, WebSocketObservationEvent } from '@jeffusion/bungee-core/plugin';

type JsonRecord = Record<string, unknown>;
type LogicalResponse = { requestId: string; attemptId: string; stream?: string; model?:string; bound?:boolean };
type Connection = {
  metadata: string;
  pending: LogicalResponse[];
  active: Map<string, LogicalResponse>;
  finished: Set<string>;
  disabled: boolean;
};
export interface ResponsesWebSocketMeteringCallbacks {
  emit(event: AttemptObservationEvent): Promise<void>;
  prepareRequest(requestId: string): void;
  discardRequest(requestId: string, attemptId: string): void;
  hasDemand(): boolean;
}
const MAX_CONNECTIONS = 128;
const MAX_RESPONSES = 1024;
const MAX_CONNECTION_RESPONSES = 64;
const MAX_TOMBSTONES = 256;
const record = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function metadata(event: WebSocketObservationEvent): string {
  return JSON.stringify([event.keyId ?? null, event.routeId, event.upstreamId, event.upstreamUrl, event.servingRevision]);
}
function responsesUrl(value: string): boolean {
  try { return /\/(?:v1\/responses|backend-api\/codex\/responses)\/?$/.test(new URL(value).pathname); } catch { return false; }
}
function stream(body: JsonRecord): string | undefined {
  return identifier(body.stream_id) ?? (record(body.response) ? identifier(body.response.stream_id) : undefined);
}

/** Converts Responses events into the existing per-attempt service, without retaining request input. */
export class ResponsesWebSocketMetering {
  private connections = new Map<string, Connection>();
  private responseCount = 0;
  private closed = false;
  constructor(private readonly callbacks: ResponsesWebSocketMeteringCallbacks) {}

  async observe(event: WebSocketObservationEvent): Promise<void> {
    try { await this.observeActive(event); }
    finally {
      if (!event.isActive()) {
        const connection = this.connections.get(event.connectionId);
        if (connection) { connection.disabled = true; this.discard(connection); }
      }
    }
  }

  private async observeActive(event: WebSocketObservationEvent): Promise<void> {
    if (this.closed || !event.isActive()) return;
    if (event.phase === 'open') {
      if (!responsesUrl(event.upstreamUrl) || !this.callbacks.hasDemand() || this.connections.has(event.connectionId) || this.connections.size >= MAX_CONNECTIONS) return;
      this.connections.set(event.connectionId, { metadata: metadata(event), pending: [], active: new Map(), finished: new Set(), disabled: false });
      return;
    }
    const connection = this.connections.get(event.connectionId);
    if (!connection) return;
    if (connection.metadata !== metadata(event)) {
      this.discard(connection);
      this.connections.delete(event.connectionId);
      return;
    }
    if (event.phase === 'close' || event.phase === 'incomplete') {
      await this.interrupt(connection, event, event.phase === 'close' ? 'cancelled' : 'failed');
      if (event.phase === 'close') this.connections.delete(event.connectionId);
      return;
    }
    if (connection.disabled || event.phase !== 'message' || event.message.kind !== 'text') return;
    const body = event.message.json();
    if (!record(body)) return;
    if (event.direction === 'client') {
      if (body.type !== 'response.create' || !(typeof body.input === 'string' || Array.isArray(body.input) || identifier(body.previous_response_id) || identifier(body.model))) return;
      if (!this.hasCapacity(connection)) { await this.interrupt(connection, event, 'failed'); return; }
      const response = await this.start(event, identifier(body.model), stream(body));
      if (response && event.isActive()) connection.pending.push(response);
      return;
    }
    const type = identifier(body.type);
    if (!type?.startsWith('response.')) return;
    const envelope = record(body.response) ? body.response : undefined;
    const terminal = ['response.completed', 'response.failed', 'response.incomplete'].includes(type);
    if (terminal && (!envelope || envelope.object !== 'response' || !Array.isArray(envelope.output))) return;
    const responseId = identifier(envelope?.id) ?? identifier(body.response_id);
    if (!responseId || connection.finished.has(responseId)) return;
    // A bare arbitrary { type, id } is not a generation envelope. Deltas must reference an admitted response.
    let response = connection.active.get(responseId);
    if (!response) {
      if (!envelope || envelope.object !== 'response' || !Array.isArray(envelope.output)
        || !['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete'].includes(type)) return;
      const key = stream(body);
      let pendingIndex = connection.pending.findIndex(item => item.stream === key);
      if (pendingIndex < 0 && key !== undefined) pendingIndex = connection.pending.findIndex(item => item.stream === undefined);
      // A terminal alone cannot prove it belongs to a pending create: it may be an old replay.
      if (pendingIndex >= 0 && !terminal) response = connection.pending.splice(pendingIndex, 1)[0];
      else {
        if (!this.hasCapacity(connection)) { await this.interrupt(connection, event, 'failed'); return; }
        response = await this.start(event, identifier(envelope.model), key);
      }
      if (!response || !event.isActive()) return;
      connection.active.set(responseId, response);
    }
    const usage = record(envelope?.usage) ? envelope.usage : undefined;
    if (!response.bound && !await this.bind(response,event,responseId)) return;
    if (!await this.emit(response, event, { phase: 'response', status: 200, protocol: 'sse', body })) return;
    if (!terminal) return;
    connection.active.delete(responseId);
    connection.finished.add(responseId);
    // Earlier usage may be intermediate. Only a terminal envelope proves both final totals.
    const usageComplete = count(usage?.input_tokens) && count(usage?.output_tokens);
    await this.finish(response, event, type === 'response.completed' && usageComplete ? 'completed' : 'failed', !usageComplete);
    if (connection.finished.size > MAX_TOMBSTONES) connection.finished.delete(connection.finished.values().next().value!);
  }

  private hasCapacity(connection: Connection): boolean {
    return this.responseCount < MAX_RESPONSES && connection.pending.length + connection.active.size < MAX_CONNECTION_RESPONSES;
  }
  private async start(event: WebSocketObservationEvent, model?: string, streamId?: string): Promise<LogicalResponse | undefined> {
    const response: LogicalResponse = { requestId: randomUUID(), attemptId: randomUUID(), stream: streamId, model };
    this.responseCount++;
    this.callbacks.prepareRequest(response.requestId);
    try {
      if (await this.emit(response, event, { phase: 'selected' })
        && await this.emit(response, event, { phase: 'request', url: event.upstreamUrl, body: { model, stream: true } })) return response;
    } catch (error) {
      this.responseCount--;
      this.callbacks.discardRequest(response.requestId, response.attemptId);
      throw error;
    }
    this.responseCount--;
    return undefined;
  }
  private async bind(response:LogicalResponse,event:WebSocketObservationEvent,responseId:string):Promise<boolean> {
    // Stable identities let the durable stats table deduplicate old replays even after the recent-ID cache rotates.
    this.callbacks.discardRequest(response.requestId,response.attemptId);
    const uuid=(kind:string)=>{
      const hex=createHash('sha256').update(JSON.stringify(['bungee.ws.response.v1',event.connectionId,responseId,kind])).digest('hex');
      return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    };
    response.requestId=uuid('request');response.attemptId=uuid('attempt');response.bound=true;
    this.callbacks.prepareRequest(response.requestId);
    return await this.emit(response,event,{phase:'selected'})
      && await this.emit(response,event,{phase:'request',url:event.upstreamUrl,body:{model:response.model,stream:true}});
  }
  private async emit(response: LogicalResponse, event: WebSocketObservationEvent, phase: Record<string, unknown>): Promise<boolean> {
    if (this.closed || !event.isActive()) { this.callbacks.discardRequest(response.requestId, response.attemptId); return false; }
    await this.callbacks.emit({ requestId: response.requestId, attemptId: response.attemptId, keyId: event.keyId, routeId: event.routeId, upstreamId: event.upstreamId, isActive: event.isActive, ...phase } as AttemptObservationEvent);
    if (this.closed || !event.isActive()) { this.callbacks.discardRequest(response.requestId, response.attemptId); return false; }
    return true;
  }
  private async finish(response: LogicalResponse, event: WebSocketObservationEvent, outcome: 'completed' | 'failed' | 'cancelled', incomplete: boolean): Promise<void> {
    this.responseCount--;
    if (incomplete && !await this.emit(response, event, { phase: 'incomplete', reason: 'raw-response-incomplete' })) return;
    if (!await this.emit(response, event, { phase: 'end', sent: true, outcome })) return;
    await this.emit(response, event, { phase: 'request-end' });
  }
  private async interrupt(connection: Connection, event: WebSocketObservationEvent, outcome: 'failed' | 'cancelled'): Promise<void> {
    connection.disabled = true;
    const unfinished = [...connection.pending, ...connection.active.values()];
    connection.pending.length = 0;
    connection.active.clear();
    for (const response of unfinished) await this.finish(response, event, outcome, true);
  }
  private discard(connection: Connection): void {
    for (const response of [...connection.pending, ...connection.active.values()]) {
      this.responseCount--;
      this.callbacks.discardRequest(response.requestId, response.attemptId);
    }
    connection.pending.length = 0; connection.active.clear();
  }
  dispose(): void {
    this.closed = true;
    for (const connection of this.connections.values()) this.discard(connection);
    this.connections.clear();
  }
}
