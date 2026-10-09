import {randomUUID} from 'node:crypto';
import type {GatewayWebSocketInput,WebSocketMessageView} from './websocket-contracts';
import type {ManagedWebSocketSession} from '../websocket';
import type {PluginHooks} from '../hooks';
import {deriveWorkerRequestIdentity,getTrustedDataIdentity} from '../config-worker/private-transport';
import {runGatewayRequest,runWithGatewayHooks} from './runtime';
import {createBodySource} from './body-factory';
import {BodyBufferLease,bodySourceFor} from './body-service';
import {controlledBodyHandle} from './controlled-views';
import type {BodyHandle} from './body-contracts';
import {DataAdmissionError, type DataAdmissionErrorDetails} from '../data-admission/errors';

interface History {model:string;items:unknown[];bytes:number;expires:number}
const TERMINALS = new Set(['response.completed','response.incomplete','response.failed']);
/** One connection owns one active logical generation; the transport owns all queues. */
export class ResponsesWebSocketSession {
  private active:AbortController|undefined;
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
  private error(session:ManagedWebSocketSession,code:string,status=422,details?:DataAdmissionErrorDetails):Promise<void> {
    const safe=new DataAdmissionError(status,code,undefined,details).details;
    return session.send(JSON.stringify({type:'error',status,error:{type:'invalid_request_error',code,message:safe?.message ?? code,...(safe?.param ? {param:safe.param}:{})}}));
  }
  onMessage(session:ManagedWebSocketSession,message:WebSocketMessageView):void|Promise<void> {
    const value=message.json() as Record<string,any>|undefined;
    if(message.kind!=='text' || !value || typeof value!=='object' || Array.isArray(value))return this.error(session,'codex_router_invalid_websocket_event');
    if(value.type==='response.cancel'){
      if(!this.active)return this.error(session,'codex_router_no_active_response');
      this.active.abort(new Error('response.cancel'));return;
    }
    if(value.type!=='response.create')return this.error(session,'codex_router_unsupported_websocket_event');
    if(this.active)return this.error(session,'codex_router_response_busy',409);
    const controller=new AbortController();this.active=controller;
    // Reserve the generation synchronously before starting any asynchronous work.
    return this.generate(session,value,AbortSignal.any([session.signal,controller.signal])).finally(()=>{if(this.active===controller)this.active=undefined;});
  }
  private async generate(session:ManagedWebSocketSession,value:Record<string,any>,signal:AbortSignal):Promise<void> {
    let source:ReturnType<typeof createBodySource>|undefined;
    try {
      const body=structuredClone(value);delete body.type;delete body.generate;delete body.client_metadata;
      if(typeof body.model!=='string' || !body.model)throw new DataAdmissionError(422,'codex_router_model_required');
      let logicalInput=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input;
      if(!Array.isArray(logicalInput))throw new DataAdmissionError(422,'codex_router_invalid_history');
      let completeHistory=true;
      if(body.previous_response_id){
        const previous=this.history.get(body.previous_response_id);
        if(previous && previous.expires>Date.now()){
          if(previous.items.some((item:any)=>item?.encrypted_content || item?.type==='compaction')){
            const identity=getTrustedDataIdentity(this.input.request);
            if(previous.model!==body.model || !identity || identity.principal.domain==='anonymous')throw new DataAdmissionError(422,'codex_router_unrestorable_history_start_new_conversation');
            // Retain the reference so the plugin verifies cached provider/endpoint origin.
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
        await session.send(JSON.stringify({type:'response.created',sequence_number:0,response:{...response,status:'in_progress'}}));
        await session.send(JSON.stringify({type:'response.completed',sequence_number:1,response}));return;
      }
      body.stream=true;
      const headers=new Headers(this.input.request.headers);
      for(const name of ['connection','upgrade','content-length','content-encoding','transfer-encoding','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'])headers.delete(name);
      headers.set('content-type','application/json');headers.set('accept','text/event-stream');
      const id=randomUUID();
      const request=new Request(this.input.request.url,{method:'POST',headers,body:JSON.stringify(body),signal});
      deriveWorkerRequestIdentity(this.input.request,request,id);
      const response=await runWithGatewayHooks(this.hooks,()=>runGatewayRequest(request,this.input.config,{servingRevision:this.input.servingRevision,transport:'websocket',websocketBridge:this.input.bridge,skipEntryRate:true,logging:this.input.logging,onCanonicalInput(input){logicalInput=[...input];}}));
      source=createBodySource(response.body,this.input.bridge.limits.maxMessageBytes,response.headers.get('content-encoding')??'',signal,{requestId:id,attemptId:id,direction:'response',stage:'client-response',version:1,contentType:response.headers.get('content-type')??'',contentEncoding:response.headers.get('content-encoding')??''});
      const wire=response.body && bodySourceFor(response.body)===source ? response.body : source.take() as ReadableStream<Uint8Array>|null;
      const handle:BodyHandle=controlledBodyHandle(source,wire,source.handle(),signal);
      if(!response.ok){
        let code='codex_router_generation_rejected';
        let details:DataAdmissionErrorDetails|undefined;
        try{const payload:any=await handle.json({id:'websocket.error',mandatory:true,signal});if(typeof payload?.error==='string'){code=payload.error;details={message:payload.message,param:payload.param};}}catch{}
        await this.error(session,code,response.status,details);return;
      }
      let terminal=false;
      const deliver=async(event:any)=>{
        if(!event || typeof event.type!=='string')throw new Error('Invalid Responses event');
        if(terminal)throw new Error('Responses event after terminal');
        if(TERMINALS.has(event.type)){
          terminal=true;
          if(completeHistory && event.type==='response.completed' && typeof event.response?.id==='string' && Array.isArray(event.response.output))this.remember(event.response.id,body.model,[...logicalInput,...event.response.output]);
        }
        await session.send(JSON.stringify(event));
      };
      if(response.headers.get('content-type')?.includes('text/event-stream')){
        for await(const event of handle.events({id:'websocket.responses',mandatory:true,signal,backlogEvents:16,backlogBytes:this.input.bridge.limits.maxBufferedBytes})){
          if(event.data==='[DONE]' || !event.hasData)continue;
          await deliver(event.json);
        }
      }else {
        const result:any=await handle.json({id:'websocket.responses',mandatory:true,signal});
        if(result?.object!=='response')throw new Error('Invalid Responses JSON');
        await deliver({type:'response.created',response:{...result,status:'in_progress',output:[]}});
        await deliver({type:result.status==='incomplete'?'response.incomplete':result.status==='failed'?'response.failed':'response.completed',response:result});
      }
      if(!terminal)throw new Error('Responses stream ended without terminal');
    }catch(error){
      if(!session.signal.aborted)await this.error(session,signal.aborted?'codex_router_generation_cancelled':error instanceof DataAdmissionError?error.code:'codex_router_generation_failed',error instanceof DataAdmissionError?error.status:signal.aborted?499:502,error instanceof DataAdmissionError?error.details:undefined);
    }finally {source?.dispose();}
  }
}
