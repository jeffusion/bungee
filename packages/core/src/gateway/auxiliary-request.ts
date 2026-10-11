import {parseBodyParserLimit} from '../config-storage/global-scalars';
import {createHash,randomUUID} from 'node:crypto';
import type {AppConfig,RouteConfig} from '@jeffusion/bungee-types';
import type {GatewayAuxiliaryIdentity,GatewayAuxiliaryRequest,GatewayAuxiliaryResult} from './contracts';
import type {HandleRequestRuntimeContext} from './request-plugin';
import {runGatewayRequest} from './runtime';
import {deriveWorkerRequestIdentity} from '../config-worker/private-transport';
import {DataAdmissionError} from '../data-admission/errors';
import {createBodySource} from './body-factory';
import {controlledBodyHandle} from './controlled-views';
import type {RawResponseCompletion} from '../plugin-control/contracts';

/** Partition by actual outbound credentials and account selectors; request-body account claims never establish identity. */
export function auxiliaryCredentialIdentity(headers:Headers,model:string,upstreamId:string,managedCredentials?:readonly string[]):GatewayAuxiliaryIdentity {
  const credentials=managedCredentials?.length ? [...managedCredentials] : ['authorization','x-api-key','api-key'].flatMap(name=>headers.has(name)?[`${name}:${headers.get(name)}`]:[]);
  const accountSelectors=['chatgpt-account-id','openai-organization','openai-project'].flatMap(name=>headers.has(name)?[`${name}:${headers.get(name)}`]:[]);
  return Object.freeze({model,upstreamId,scope:credentials.length ? createHash('sha256').update(JSON.stringify(['gateway-credential-scope',upstreamId,credentials.sort(),accountSelectors])).digest('base64url'):null});
}

/** Bound by the host to a single parent and frozen serving configuration. */
export async function executeAuxiliaryRequest(parent:Request,config:AppConfig,entry:RouteConfig,runtime:HandleRequestRuntimeContext|undefined,input:GatewayAuxiliaryRequest,signal:AbortSignal,targets:readonly import('./contracts').GatewayDispatchTarget[]):Promise<GatewayAuxiliaryResult> {
  if(runtime?.auxiliary)throw new DataAdmissionError(422,'auxiliary_recursion_forbidden');
  if(!targets.some(target=>target.type===input.target.type && target.id===input.target.id))throw new DataAdmissionError(403,'dispatch_target_not_declared');
  if(input.protocol!=='responses' || typeof input.model!=='string' || !input.model)throw new DataAdmissionError(422,'auxiliary_request_invalid');
  if(!input.body || typeof input.body!=='object' || Array.isArray(input.body))throw new DataAdmissionError(422,'auxiliary_request_invalid');
  const requestId=randomUUID();const controller=new AbortController();
  const requestSignal=AbortSignal.any([input.signal??signal,controller.signal]);
  requestSignal.throwIfAborted();
  const headers=new Headers(parent.headers);
  for(const name of ['connection','upgrade','content-length','content-encoding','transfer-encoding','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'])headers.delete(name);
  headers.set('content-type','application/json');headers.set('accept',(input.body as Record<string,unknown>).stream===true?'text/event-stream':'application/json');
  const request=new Request(new URL(`${entry.path.replace(/\/$/,'')}/responses`,parent.url),{method:'POST',headers,body:JSON.stringify({...input.body,model:input.model}),signal:requestSignal});
  deriveWorkerRequestIdentity(parent,request,requestId);
  let identity:GatewayAuxiliaryIdentity|undefined;
  let reused:unknown;
  let completion:Promise<RawResponseCompletion>|undefined;
  const response=await runGatewayRequest(request,config,{servingRevision:runtime?.servingRevision,logging:{...runtime?.logging,captureBody:false},
    auxiliary:{target:input.target,parentRequestId:runtime?.parentRequestId,onIdentity:async actual=>{identity=actual;reused=await input.reuse?.(actual);return reused!==undefined;}},
    onCompletion:value=>{completion=value;}});
  if(!identity){await response.body?.cancel();throw new DataAdmissionError(response.status>=400?response.status:503,'auxiliary_request_rejected');}
  if(reused!==undefined){await response.body?.cancel();return {kind:'reused',value:reused,identity};}
  const source=createBodySource(response.body,parseBodyParserLimit(config.body_parser_limit),response.headers.get('content-encoding')??'',requestSignal,
    {requestId,attemptId:requestId,direction:'response',stage:'client-response',version:0,contentType:response.headers.get('content-type')??'',contentEncoding:response.headers.get('content-encoding')??''});
  const wire=source.take() as ReadableStream<Uint8Array>|null;
  const bodyHandle=controlledBodyHandle(source,wire,source.handle(),requestSignal);
  let disposed=false;
  const dispose=()=>{if(disposed)return;disposed=true;controller.abort('auxiliary disposed');void source.cancelReading('auxiliary disposed').catch(()=>undefined).finally(()=>source.dispose());};
  const abort=()=>{void source.cancelReading(requestSignal.reason).catch(()=>undefined);};
  requestSignal.addEventListener('abort',abort,{once:true});if(requestSignal.aborted)abort();
  const outcome=completion ?? source.completion.then(()=>({status:'completed' as const}),()=>({status:requestSignal.aborted?'cancelled' as const:'failed' as const,code:'auxiliary_body_failed'}));
  void outcome.then(()=>{requestSignal.removeEventListener('abort',abort);source.dispose();},()=>{requestSignal.removeEventListener('abort',abort);source.dispose();});
  return {kind:'response',status:response.status,bodyHandle,completion:outcome,identity,requestId,dispose};
}
