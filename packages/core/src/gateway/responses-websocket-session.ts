import {randomUUID} from 'node:crypto';
import type {GatewayWebSocketInput,WebSocketMessageView} from './websocket-contracts';
import type {ManagedWebSocketSession} from '../websocket';
import type {PluginHooks} from '../hooks';
import {deriveWorkerRequestIdentity,getTrustedDataIdentity} from '../config-worker/private-transport';
import {runGatewayRequest,runWithGatewayHooks} from './runtime';
import {createBodySource} from './body-factory';
import {BodyBufferLease,BodyProcessingError,bodySourceFor,getBodyProcessingDiagnosticCause} from './body-service';
import {controlledBodyHandle} from './controlled-views';
import type {BodyHandle} from './body-contracts';
import {DataAdmissionError, type DataAdmissionErrorDetails} from '../data-admission/errors';
import type {DispatchRequestPreparationInput} from './contracts';

interface History {model:string;items:unknown[];bytes:number;expires:number}
type HostedErrorOutcome = 'failed' | 'cancelled';
type ObserveResponse = (message: string, failure?: HostedErrorOutcome) => void;
type SendResponse = (message: unknown, failure?: HostedErrorOutcome) => Promise<void>;
const TERMINALS = new Set(['response.completed','response.incomplete','response.failed','response.cancelled']);
const RESPONSE_CANCELLED = new Error('response.cancel');

const DIAGNOSTIC_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AggregateError',
  'AbortError', 'TimeoutError', 'BodyProcessingError', 'DataAdmissionError', 'ResponsesCodecError', 'UpstreamNetworkError', 'UpstreamTimeoutError']);
const DIAGNOSTIC_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ConnectionClosed',
  'upstream_network_error', 'upstream_timeout',
  'body_buffer_capacity', 'body_decoder_capacity', 'body_disposed', 'body_not_replayable',
  'body_observer_backlog', 'body_processing_timeout', 'body_sse_frame_too_large', 'body_sse_frame_truncated',
  'body_stream_cancelled', 'decoded_body_too_large', 'request_body_too_large', 'invalid_compressed_body',
  'invalid_json_body', 'invalid_response_body', 'invalid_sse_plugin_envelope', 'unsupported_content_encoding',
  'llm_adapter_invalid_payload', 'llm_adapter_invalid_stream', 'llm_adapter_invalid_usage',
  'llm_adapter_missing_terminal', 'llm_adapter_resource_limit', 'llm_adapter_session_disposed',
  'llm_adapter_unknown_terminal', 'llm_adapter_unsupported_content', 'llm_adapter_unsupported_response',
]);
const DIAGNOSTIC_MESSAGES = new Set([
  'Invalid Responses event', 'Invalid Responses JSON', 'Responses event after terminal',
  'Responses stream ended without terminal', 'WebSocket Responses upstream error event',
  'WebSocket Responses stream truncated before terminal event', 'Invalid JSON WebSocket Responses event',
  'Binary WebSocket Responses message', 'WebSocket Responses message too large',
  'WebSocket Responses upstream failed', 'WebSocket Responses request send failed',
  'WebSocket session closed', 'WebSocket message too large', 'WebSocket send budget exceeded',
  'WebSocket downstream send failed',
]);
const RECEIVE_BUDGET_MESSAGES = [
  'WebSocket Responses session receive budget exceeded',
  'WebSocket Responses process receive budget exceeded',
];

function recordGenerationFailure(requestId: string, stage: string, error: unknown): void {
  try {
    const exceptions: { name: string; code?: string; message: string }[] = [];
    // Exception text can contain raw prompts, credentials or tool output.
    for (let depth = 0; depth < 4; depth++) {
      if (!(error instanceof Error)) {
        exceptions.push({ name: 'NonError', message: '[REDACTED]' });
        break;
      }
      const { name, message, code } = error as Error & { code?: string };
      const cause = error instanceof BodyProcessingError ? getBodyProcessingDiagnosticCause(error) : error.cause;
      const safeMessage = DIAGNOSTIC_MESSAGES.has(message) || DIAGNOSTIC_CODES.has(message) ? message
        : typeof message === 'string' ? RECEIVE_BUDGET_MESSAGES.find(prefix => message.startsWith(`${prefix} (`)) : undefined;
      exceptions.push({
        name: DIAGNOSTIC_NAMES.has(name) ? name : 'Error',
        code: code && DIAGNOSTIC_CODES.has(code) ? code : undefined,
        message: safeMessage ?? '[REDACTED]',
      });
      if (cause === undefined) break;
      error = cause;
    }
    // Production workers inherit stderr and have no application logger transport.
    console.error(JSON.stringify({ event: 'codex_router_generation_failed', requestId, stage, exceptions }));
  } catch { /* Diagnostics must not replace the original failure. */ }
}

function generationError(payload: unknown): {code: string; type: string; details?: DataAdmissionErrorDetails} {
  const fallback = {code: 'codex_router_generation_rejected', type: 'invalid_request_error'};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  const body = payload as Record<string, unknown>;
  const error = typeof body.error === 'string' ? {...body, code: body.error}
    : body.error && typeof body.error === 'object' && !Array.isArray(body.error) ? body.error as Record<string, unknown> : undefined;
  if (!error) return fallback;
  const identifier = (value: unknown, otherwise: string) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value) ? value : otherwise;
  // Upstream diagnostics are untrusted: redact before bounding the client-visible message.
  const message = typeof error.message === 'string' ? error.message.slice(0, 16_384)
    .replace(/\b(Bearer|Basic)\s+[^\s,;"'<>]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[REDACTED]')
    .replace(/((?:authorization|access_token|refresh_token|id_token|api[_-]?key|cookie)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,<>]+)/gi, '$1[REDACTED]')
    .replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 512) : undefined;
  return {code: identifier(error.code, fallback.code), type: identifier(error.type, fallback.type),
    details: {message: message || undefined, param: typeof error.param === 'string' ? error.param : undefined}};
}
/** One connection owns one active logical generation; the transport owns all queues. */
export class ResponsesWebSocketSession {
  private active:AbortController|undefined;
  private readonly connectionId=randomUUID();
  private readonly history=new Map<string,History>();
  private readonly historyLease=new BodyBufferLease();
  private historyBytes=0;
  constructor(private readonly input:GatewayWebSocketInput,private readonly hooks:PluginHooks){}
  dispose():void {this.active?.abort();this.history.clear();this.historyBytes=0;this.historyLease.dispose();}
  private remember(id:string,model:string,items:unknown[]):void {
    const bytes=Buffer.byteLength(JSON.stringify(items))*2;
    if(bytes>8*1024*1024)return;
    const previous=this.history.get(id);if(previous){this.historyBytes-=previous.bytes;this.historyLease.release(previous.bytes);this.history.delete(id);}
    while(this.history.size>=32 || this.historyBytes+bytes>8*1024*1024){const oldest=this.history.keys().next().value!;const item=this.history.get(oldest)!;this.history.delete(oldest);this.historyBytes-=item.bytes;this.historyLease.release(item.bytes);}
    this.historyLease.add(bytes);this.historyBytes+=bytes;this.history.set(id,{model,items:structuredClone(items),bytes,expires:Date.now()+600_000});
  }
  private error(send:SendResponse,code:string,status=422,details?:DataAdmissionErrorDetails,type='invalid_request_error',outcome:HostedErrorOutcome='failed'):Promise<void> {
    const safe=new DataAdmissionError(status,code,undefined,details).details;
    return send({type:'error',status,error:{type,code,message:safe?.message ?? code,...(safe?.param ? {param:safe.param}:{})}},outcome);
  }
  onMessage(session:ManagedWebSocketSession,message:WebSocketMessageView,requestId:string,observe?:ObserveResponse):void|Promise<void> {
    const send: SendResponse = (payload, failure) => {
      const wire = JSON.stringify(payload);
      return session.send(wire, observe && (() => observe(wire, failure)));
    };
    const value=message.json() as Record<string,any>|undefined;
    if(message.kind!=='text' || !value || typeof value!=='object' || Array.isArray(value))return this.error(send,'codex_router_invalid_websocket_event');
    if(value.type==='response.cancel'){
      if(!this.active)return this.error(send,'codex_router_no_active_response');
      this.active.abort(RESPONSE_CANCELLED);return;
    }
    if(value.type!=='response.create')return this.error(send,'codex_router_unsupported_websocket_event');
    if(this.active)return this.error(send,'codex_router_response_busy',409);
    const controller=new AbortController();this.active=controller;
    // Reserve the generation synchronously before starting any asynchronous work.
    return this.generate(session,send,value,requestId,AbortSignal.any([session.signal,controller.signal])).finally(()=>{if(this.active===controller)this.active=undefined;});
  }
  private async generate(session:ManagedWebSocketSession,send:SendResponse,value:Record<string,any>,requestId:string,signal:AbortSignal):Promise<void> {
    let source:ReturnType<typeof createBodySource>|undefined;
    let stage = 'request_setup';
    try {
      const body=structuredClone(value);delete body.type;delete body.generate;delete body.client_metadata;
      if(typeof body.model!=='string' || !body.model)throw new DataAdmissionError(422,'codex_router_model_required');
      let logicalInput=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input;
      if(!Array.isArray(logicalInput))throw new DataAdmissionError(422,'codex_router_invalid_history');
      let completeHistory=true;
      let crossModelHistory: DispatchRequestPreparationInput['crossModelHistory'];
      if(body.previous_response_id){
        const previous=this.history.get(body.previous_response_id);
        if(previous && previous.expires>Date.now()){
          if(previous.items.some((item:any)=>item?.encrypted_content || item?.type==='compaction')){
            const identity=getTrustedDataIdentity(this.input.request);
            if(!identity || identity.principal.domain==='anonymous')throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
            if(previous.model!==body.model)crossModelHistory={responseId:body.previous_response_id,items:previous.items};
            // Retain the reference for provider/endpoint verification or an opted-in Chat conversion.
            completeHistory=false;
          }else {logicalInput=[...previous.items,...logicalInput];body.input=logicalInput;delete body.previous_response_id;}
        }else {
          const identity=getTrustedDataIdentity(this.input.request);
          if(!identity || identity.principal.domain==='anonymous')throw new DataAdmissionError(422,'codex_router_history_missing_start_new_conversation');
          // A bound model resolves the reference through the shared history RPC.
          completeHistory=false;
        }
      }
      if(value.generate===false){
        if(!completeHistory)throw new DataAdmissionError(422,'codex_router_history_missing_start_new_conversation');
        const id=`resp_bungee_prewarm_${randomUUID()}`;
        const response={id,object:'response',model:body.model,status:'completed',output:[],usage:null};
        this.remember(id,body.model,logicalInput);
        stage = 'client_send';
        await send({type:'response.created',sequence_number:0,response:{...response,status:'in_progress'}});
        await send({type:'response.completed',sequence_number:1,response});return;
      }
      body.stream=true;
      const headers=new Headers(this.input.request.headers);
      for(const name of ['connection','upgrade','content-length','content-encoding','transfer-encoding','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'])headers.delete(name);
      headers.set('content-type','application/json');headers.set('accept','text/event-stream');
      const request=new Request(this.input.request.url,{method:'POST',headers,body:JSON.stringify(body),signal});
      deriveWorkerRequestIdentity(this.input.request,request,requestId);
      stage = 'gateway_request';
      const response=await runWithGatewayHooks(this.hooks,()=>runGatewayRequest(request,this.input.config,{servingRevision:this.input.servingRevision,webSocketConnection:{id:this.connectionId,signal:session.signal},transport:'websocket',webSocketRequestId:requestId,websocketBridge:this.input.bridge,skipEntryRate:true,crossModelHistory,onCanonicalInput(input){logicalInput=[...input];if(crossModelHistory)completeHistory=true;}}));
      stage = 'response_body';
      source=createBodySource(response.body,this.input.bridge.limits.maxMessageBytes,response.headers.get('content-encoding')??'',signal,{requestId,attemptId:requestId,direction:'response',stage:'client-response',version:1,contentType:response.headers.get('content-type')??'',contentEncoding:response.headers.get('content-encoding')??''});
      const wire=response.body && bodySourceFor(response.body)===source ? response.body : source.take() as ReadableStream<Uint8Array>|null;
      const handle:BodyHandle=controlledBodyHandle(source,wire,source.handle(),signal);
      if(!response.ok){
        let error=generationError(undefined);
        try{error=generationError(await handle.json({id:'websocket.error',mandatory:true,signal}));}catch{}
        signal.throwIfAborted();
        stage = 'client_send';
        await this.error(send,error.code,response.status,error.details,error.type);return;
      }
      let terminal=false;
      const deliver=async(event:any)=>{
        stage = 'response_event';
        if(!event || typeof event.type!=='string')throw new Error('Invalid Responses event');
        if(terminal)throw new Error('Responses event after terminal');
        if(TERMINALS.has(event.type)){
          terminal=true;
          if(completeHistory && event.type==='response.completed' && typeof event.response?.id==='string' && Array.isArray(event.response.output))this.remember(event.response.id,body.model,[...logicalInput,...event.response.output]);
        }
        stage = 'client_send';
        await send(event);
      };
      if(response.headers.get('content-type')?.includes('text/event-stream')){
        stage = 'response_sse';
        for await(const event of handle.events({id:'websocket.responses',mandatory:true,signal,backlogEvents:16,backlogBytes:this.input.bridge.limits.maxBufferedBytes})){
          if(event.data==='[DONE]' || !event.hasData)continue;
          await deliver(event.json);
          stage = 'response_sse';
        }
      }else {
        stage = 'response_json';
        const result:any=await handle.json({id:'websocket.responses',mandatory:true,signal});
        if(result?.object!=='response')throw new Error('Invalid Responses JSON');
        await deliver({type:'response.created',response:{...result,status:'in_progress',output:[]}});
        const eventType = typeof result.status === 'string' ? `response.${result.status}` : '';
        await deliver({type:TERMINALS.has(eventType) ? eventType : 'response.completed',response:result});
      }
      stage = 'response_terminal';
      if(!terminal)throw new Error('Responses stream ended without terminal');
    }catch(error){
      if (!signal.aborted && !(error instanceof DataAdmissionError)) recordGenerationFailure(requestId, stage, error);
      if(!session.signal.aborted)await this.error(send,signal.aborted?'codex_router_generation_cancelled':error instanceof DataAdmissionError?error.code:'codex_router_generation_failed',error instanceof DataAdmissionError?error.status:signal.aborted?499:502,error instanceof DataAdmissionError?error.details:undefined,undefined,signal.reason === RESPONSE_CANCELLED ? 'cancelled' : 'failed');
    }finally {source?.dispose();}
  }
}
