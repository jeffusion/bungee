import { createBodySource } from './body-factory';
import { sharedSSEResponse } from './sse-response';
import { readControlledBody } from './controlled-views';
import { gatewayHooks, requireGatewayResult } from './runtime';
import type { RequestLogger } from '../logger/request-logger';
import type { AppConfig, ModificationRules, ResponseModificationRules } from '@jeffusion/bungee-types';
import { processDynamicValue, type ExpressionContext } from '../expression-engine';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import type { RequestContext } from '../hooks';
import type { InboundChain } from '../scoped-plugin-registry';
import type { SSEEnvelope } from '../plugin.types';
import { applyBodyRules } from '../worker/rules/modifier';
import { type BodySource, bodySourceFor, BodyBufferLease, BodyProcessingError, isJsonMediaType, isObjectBody, readBodyChunk, reconcileEntityHeaders } from '../worker/request/body-source';
import { parseBodyParserLimit } from '../config-storage/global-scalars';
import type { RawResponseCompletion } from '../plugin-control/contracts';
import { logger } from '../logger';

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

export async function executeResponseRules(
  res: Response, rules: ResponseModificationRules, requestContext: ExpressionContext, requestLog: any,
  reqLogger?: RequestLogger, config?: AppConfig, _pluginHooks?: PluginHooks, streamRequestContext?: RequestContext,
  state?: StreamCompletionState, inboundChain?: InboundChain, hasInboundStreamCallbacks = false,
  _strictRawResponse = false, signal?: AbortSignal, bodyOwners?: Array<{dispose():void}>, cachedSource?: BodySource,
  representationModified = false,
): Promise<PrepareResponseResult> {
  const headers = new Headers(res.headers);
  reqLogger?.setResponseHeaders(headerRecord(headers));
  const media = headers.get('content-type') ?? ''; const max = parseBodyParserLimit(config?.body_parser_limit);
  const bodyVersion=(streamRequestContext as (RequestContext & {bodyVersion?:number})|undefined)?.bodyVersion
    ?? cachedSource?.identity.version ?? (res.body ? bodySourceFor(res.body)?.identity.version:undefined) ?? 0;
  let stageRewritten=false;
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
    const source = cachedSource ?? createBodySource(res.body,max,headers.get('content-encoding') ?? '',signal,{requestId:streamRequestContext?.requestId ?? '',attemptId:(streamRequestContext as RequestContext & {attemptId?:string})?.attemptId ?? streamRequestContext?.requestId ?? '',direction:'response',stage:'upstream-response',version:bodyVersion,contentType:media,contentEncoding:headers.get('content-encoding') ?? ''});
    if (!bodyOwners?.includes(source)) bodyOwners?.push(source);
    try {
      let value = await readControlledBody(source,res.body,()=>source.json('response-json'),signal); responseContext.body = value; responseContext.response!.body = value;
      if (bodyRules && formats.includes('json')) {
        if (!isObjectBody(value)) throw new BodyProcessingError(502,'response_body_must_be_object');
        value = await applyBodyRules(value,rules.body,responseContext,requestLog); modified = true;stageRewritten=true;
        responseContext.body = value; responseContext.response!.body = value;
      }
      body = modified ? JSON.stringify(value) : source.take();
      if(modified && bodyOwners){const lease=new BodyBufferLease();lease.add(Buffer.byteLength(body as string));bodyOwners.push(lease);}
    } catch (error) { if (error instanceof BodyProcessingError && error.status === 503) throw error; throw new BodyProcessingError(502,'invalid_response_body'); }
    finally { if (!bodyOwners) source.dispose(); }
  } else if (sse && res.body && ((bodyRules && formats.includes('sse-json')) || hasInboundStreamCallbacks)) {
    try {
      const existing=bodySourceFor(res.body);
      const source=existing??createBodySource(res.body,max,headers.get('content-encoding') ?? '',signal,
        {requestId:streamRequestContext?.requestId ?? '',attemptId:(streamRequestContext as RequestContext & {attemptId?:string})?.attemptId ?? streamRequestContext?.requestId ?? '',direction:'response',stage:'upstream-response',version:bodyVersion,contentType:media,contentEncoding:headers.get('content-encoding') ?? ''});
      if(!bodyOwners?.includes(source))bodyOwners?.push(source);
      const wire=existing?res.body:source.take() as ReadableStream<Uint8Array>;
      body=sharedSSEResponse(wire,source.handle(),bodyRules && formats.includes('sse-json')?rules.body:undefined,responseContext,
        hasInboundStreamCallbacks?inboundChain:undefined,streamRequestContext,signal);
      modified=true;
      stageRewritten=true;
    } catch(error) {if(error instanceof BodyProcessingError && error.status===503)throw error;throw new BodyProcessingError(502,'invalid_response_body');}
  } else if (bodyRules) {
    reqLogger?.addStep('response_body_rules_skipped',{reason:'media_type_not_selected',content_type:media});
  }
  reqLogger?.addStep('response_body_plan',{mode:modified ? (sse ? 'sse-json-write' : 'json-write') : dependencies.responseBody ? 'json-read' : 'opaque-stream',reasons:[...(bodyRules ? ['response-body-rules'] : []),...(dependencies.responseBody ? ['response-header-expression'] : []),...(hasInboundStreamCallbacks ? ['plugin-sse'] : [])],source:'wire'});
  requireGatewayResult(await gatewayHooks().onGatewayHeaderRules.promise(headers,rules.headers,responseContext), 'onGatewayHeaderRules');
  reconcileEntityHeaders(headers,body,modified);
  reqLogger?.setResponseHeaders(headerRecord(headers));
  if (reqLogger) body = reqLogger.observeBody(body, 'response', headers, config?.logging?.body, signal, res.status, {
    bodyHandle: !modified ? (cachedSource ?? (res.body ? bodySourceFor(res.body) : undefined))?.handle() : undefined,
    identity: {requestId:streamRequestContext?.requestId ?? '',attemptId:(streamRequestContext as RequestContext & {attemptId?:string})?.attemptId ?? streamRequestContext?.requestId ?? '',
      direction:'response',stage:'client-response',version:bodyVersion+(stageRewritten?1:0),contentType:headers.get('content-type') ?? '',contentEncoding:headers.get('content-encoding') ?? ''},
    maxBodyBytes:max,
  });
  if (body instanceof ReadableStream) body = completionStream(body,state,signal);
  else state?.complete?.({status:'completed'});
  return {headers,body};
}

import type { Plugin, PluginHooks } from '@jeffusion/bungee-core/plugin';
export class ResponseRulesPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayHeaderRules.tap('builtin.response-rules', (...args) => {applyHeaderRules(...args);return true as const;});
    hooks.onGatewayResponseRules.tapPromise('builtin.onGatewayResponseRules', executeResponseRules);
  }
}
