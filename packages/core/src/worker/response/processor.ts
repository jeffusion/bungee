import type { RequestLogger } from '../../logger/request-logger';
import type { AppConfig, ModificationRules, ResponseModificationRules } from '@jeffusion/bungee-types';
import { processDynamicValue, type ExpressionContext } from '../../expression-engine';
import { analyzeExpressionDependencies, hasBodyModification } from '../../utils/expression-dependencies';
import type { PluginHooks, RequestContext } from '../../hooks';
import type { InboundChain } from '../../scoped-plugin-registry';
import type { SSEEnvelope } from '../../plugin.types';
import { applyBodyRules } from '../rules/modifier';
import { BodySource, BodyBufferLease, BodyProcessingError, decodeStream, isJsonMediaType, isObjectBody, readBodyChunk, reconcileEntityHeaders } from '../request/body-source';
import { parseBodyParserLimit } from '../../config-storage/global-scalars';
import type { RawResponseCompletion } from '../../plugin-control/contracts';
import { logger } from '../../logger';

export interface StreamCompletionState {
  interrupted: boolean;
  cancelled: boolean;
  clientCancelled?: boolean;
  completion?: Promise<RawResponseCompletion>;
  complete?: (completion: RawResponseCompletion) => void;
  teardown?: Promise<void>;
  teardownNow?: (reason?: unknown) => Promise<void>;
  finalCompletion?: Promise<RawResponseCompletion>;
}
function headerRecord(headers: Headers): Record<string,string> { const result: Record<string,string> = {}; headers.forEach((value,key)=>{result[key]=value;}); return result; }
export interface PrepareResponseResult { headers: Headers; body: BodyInit | null }

export function applyHeaderRules(headers: Headers, rules: ModificationRules['headers'], context: ExpressionContext): void {
  if (!rules) return;
  const set = (key: string, value: unknown, action: string) => {
    try { const result = processDynamicValue(value, context); if (result !== undefined) headers.set(key, String(result)); }
    catch { logger.warn({ field: key, action, code: 'header_expression_failed' }, 'Header modification was skipped'); }
  };
  for (const [key, value] of Object.entries(rules.add ?? {})) set(key, value, 'add');
  for (const [key, value] of Object.entries(rules.replace ?? {})) if (headers.has(key)) set(key, value, 'replace');
  for (const [key, value] of Object.entries((rules as typeof rules & {default?:Record<string,string>}).default ?? {})) if (!headers.has(key)) set(key, value, 'default');
  for (const key of rules.remove ?? []) if (!(key in (rules.add ?? {})) && !(key in (rules.replace ?? {}))) headers.delete(key);
}
/** Completion follows the consumer, including ordinary binary responses. */
export function completionStream(source: ReadableStream<Uint8Array>, state?: StreamCompletionState, signal?: AbortSignal): ReadableStream<Uint8Array> {
  const reader = source.getReader(); let closed = false;
  let teardownResolve!: () => void;
  const teardown = new Promise<void>(resolve => { teardownResolve = resolve; });
  if (state) state.teardown = teardown;
  const settle = (outcome: RawResponseCompletion) => { if (closed) return; closed = true; state?.complete?.(outcome); teardownResolve(); };
  const cancel = async (reason?: unknown) => { settle({status: 'cancelled'}); await reader.cancel(reason).catch(() => undefined); };
  if (state) state.teardownNow = cancel;
  return new ReadableStream({
    async pull(controller) {
      try { const part = await readBodyChunk(reader, signal);
        if (part.done) { settle({status:'completed'}); controller.close(); return; } controller.enqueue(part.value);
      } catch (error) { if (state) state.interrupted = !signal?.aborted; settle(signal?.aborted ? {status:'cancelled'} : {status:'failed',code:'stream_read_failed'});
        void reader.cancel(error).catch(() => undefined); controller.error(error); }
    },
    async cancel(reason) { if (state) { state.cancelled = true; state.clientCancelled = true; } await cancel(reason); },
  }, {highWaterMark:0});
}

/** Parse only demanded SSE. Metadata stays separate from the JSON object. */
export function createSSEEnvelopeTransform(
  rules: ModificationRules['body'], requestContext: ExpressionContext, maxBytes: number,
  chain?: InboundChain, hookContext?: RequestContext, bodyOwners?: Array<{dispose():void}>,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder('utf-8', {fatal:true}); const encoder = new TextEncoder();
  const lease=new BodyBufferLease();bodyOwners?.push(lease);
  let pending = ''; let chunkIndex = 0; const streamState = new Map<string, any>();
  const serialize = (envelope: SSEEnvelope): string => {
    if (envelope.raw !== undefined && envelope.json === undefined) return envelope.raw;
    const fields: string[] = (envelope.comments ?? []).map(comment => `:${comment}`);
    for (const key of ['event','id','retry'] as const) if (envelope[key] !== undefined) fields.push(`${key}: ${envelope[key]}`);
    const data = envelope.json === undefined ? envelope.data : JSON.stringify(envelope.json);
    for (const line of data.split('\n')) fields.push(`data: ${line}`);
    return `${fields.join('\n')}\n\n`;
  };
  const context = () => ({...hookContext, chunkIndex, isFirstChunk:chunkIndex===0, isLastChunk:false, streamState, request:hookContext, strict:true});
  const frame = async (raw: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    const lines = raw.replace(/(?:\r\n|\r|\n){2}$/, '').split(/\r\n|\r|\n/);
    const envelope: SSEEnvelope = {data:'',comments:[],raw}; const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) { envelope.comments!.push(line.slice(1)); continue; }
      const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0,colon); let value = colon < 0 ? '' : line.slice(colon+1); if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event' || field === 'id' || field === 'retry') envelope[field] = value;
    }
    envelope.data = data.join('\n');
    if (!data.length || envelope.data.trim() === '[DONE]') { controller.enqueue(encoder.encode(raw)); return; }
    try { const json: unknown = JSON.parse(envelope.data); if (isObjectBody(json)) envelope.json = json; } catch { /* Non-JSON is a legal SSE event. */ }
    if (envelope.json === undefined) { controller.enqueue(encoder.encode(raw)); return; }
    const outputs = chain ? await chain.onStreamChunk(envelope, context()) : [envelope]; chunkIndex++;
    for (const output of outputs) {
      if (!output || typeof output.data !== 'string') throw new BodyProcessingError(502,'invalid_sse_plugin_envelope');
      let final = output;
      if (hasBodyModification(rules) && isObjectBody(output.json)) {
        const bodyContext = {...requestContext, headers:requestContext.response?.headers ?? {}, body:output.json, response:{headers:requestContext.response?.headers ?? {},body:output.json}};
        final = {...output, json:await applyBodyRules(output.json, rules, bodyContext, {})};
      }
      controller.enqueue(encoder.encode(serialize(final)));
    }
  };
  const consume = async (controller: TransformStreamDefaultController<Uint8Array>) => {
    // A blank line can use any permitted SSE line ending, including CR split across chunks.
    let match: RegExpExecArray | null;
    while ((match = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/.exec(pending))) {
      if (match.index + match[0].length === pending.length && pending.endsWith('\r')) break;
      const end = match.index + match[0].length; const raw = pending.slice(0,end); pending = pending.slice(end);
      if (encoder.encode(raw).byteLength > maxBytes) throw new BodyProcessingError(502,'sse_event_too_large'); await frame(raw,controller);lease.release(encoder.encode(raw).byteLength);
    }
    if (encoder.encode(pending).byteLength > maxBytes) throw new BodyProcessingError(502,'sse_event_too_large');
  };
  return new TransformStream({
    async transform(bytes, controller) { try { lease.add(bytes.byteLength);pending += decoder.decode(bytes,{stream:true});await consume(controller); } catch(error) {lease.dispose();throw error instanceof BodyProcessingError ? error : new BodyProcessingError(502,'invalid_response_utf8');} },
    async flush(controller) {
      try { pending += decoder.decode(); } catch { throw new BodyProcessingError(502,'invalid_response_utf8'); }
      await consume(controller); if (pending) controller.enqueue(encoder.encode(pending));
      if (chain) for (const output of await chain.onFlushStream([], {...context(),isLastChunk:true})) controller.enqueue(encoder.encode(serialize(output)));
      streamState.clear();lease.dispose();
    },
  });
}

export async function prepareResponse(
  res: Response, rules: ResponseModificationRules, requestContext: ExpressionContext, requestLog: any,
  reqLogger?: RequestLogger, config?: AppConfig, _pluginHooks?: PluginHooks, streamRequestContext?: RequestContext,
  state?: StreamCompletionState, inboundChain?: InboundChain, hasInboundStreamCallbacks = false,
  _strictRawResponse = false, signal?: AbortSignal, bodyOwners?: Array<{dispose():void}>, cachedSource?: BodySource,
  representationModified = false,
): Promise<PrepareResponseResult> {
  const headers = new Headers(res.headers);
  reqLogger?.setResponseHeaders(headerRecord(headers));
  const media = headers.get('content-type') ?? ''; const max = parseBodyParserLimit(config?.body_parser_limit);
  const formats = rules.body_formats ?? ['json','sse-json'];
  const bodyRules = hasBodyModification(rules.body);
  const dependencies = analyzeExpressionDependencies(rules.headers,'response');
  const json = isJsonMediaType(media); const sse = /^text\/event-stream(?:\s*;|$)/i.test(media);
  const responseContext: ExpressionContext = {...requestContext, headers:headerRecord(headers),body:undefined,
    request:{headers:requestContext.headers,body:requestContext.body},response:{headers:headerRecord(headers),body:undefined}};
  let body: BodyInit | null = res.body; let modified = representationModified;
  if (!json && dependencies.responseBody && !sse) throw new BodyProcessingError(502,'response_format_unavailable');
  if (sse && dependencies.responseBody) throw new BodyProcessingError(502,'sse_headers_require_response_body');
  if (json && ((bodyRules && formats.includes('json')) || dependencies.responseBody)) {
    const source = cachedSource ?? new BodySource(res.body,max,headers.get('content-encoding') ?? '',signal);
    if (!bodyOwners?.includes(source)) bodyOwners?.push(source);
    try {
      let value = await source.json('response-json'); responseContext.body = value; responseContext.response!.body = value;
      if (bodyRules && formats.includes('json')) {
        if (!isObjectBody(value)) throw new BodyProcessingError(502,'response_body_must_be_object');
        value = await applyBodyRules(value,rules.body,responseContext,requestLog); modified = true;
        responseContext.body = value; responseContext.response!.body = value;
      }
      body = modified ? JSON.stringify(value) : source.take();
      if(modified && bodyOwners){const lease=new BodyBufferLease();lease.add(Buffer.byteLength(body as string));bodyOwners.push(lease);}
      if (config?.logging?.body?.enabled) reqLogger?.setResponseBody(value);
    } catch (error) { if (error instanceof BodyProcessingError && error.status === 503) throw error; throw new BodyProcessingError(502,'invalid_response_body'); }
    finally { if (!bodyOwners) source.dispose(); }
  } else if (sse && res.body && ((bodyRules && formats.includes('sse-json')) || hasInboundStreamCallbacks)) {
    try { body = decodeStream(res.body,headers.get('content-encoding') ?? '',max,signal)
      .pipeThrough(createSSEEnvelopeTransform(bodyRules && formats.includes('sse-json') ? rules.body : undefined,responseContext,max,
        hasInboundStreamCallbacks ? inboundChain : undefined,streamRequestContext,bodyOwners)); modified = true;
    } catch (error) { if (error instanceof BodyProcessingError && error.status === 503) throw error; throw new BodyProcessingError(502,'invalid_response_body'); }
  } else if (bodyRules) {
    reqLogger?.addStep('response_body_rules_skipped',{reason:'media_type_not_selected',content_type:media});
  }
  if(config?.logging?.body?.enabled && body instanceof ReadableStream && !modified) reqLogger?.addStep('body_logging_incomplete',{direction:'response',reason:'opaque_body_not_observed',observer_incomplete:true});
  reqLogger?.addStep('response_body_plan',{mode:modified ? (sse ? 'sse-json-write' : 'json-write') : dependencies.responseBody ? 'json-read' : 'opaque-stream',reasons:[...(bodyRules ? ['response-body-rules'] : []),...(dependencies.responseBody ? ['response-header-expression'] : []),...(hasInboundStreamCallbacks ? ['plugin-sse'] : [])],source:'wire'});
  applyHeaderRules(headers,rules.headers,responseContext);
  reconcileEntityHeaders(headers,body,modified);
  if (body instanceof ReadableStream) body = completionStream(body,state,signal);
  else state?.complete?.({status:'completed'});
  return {headers,body};
}
