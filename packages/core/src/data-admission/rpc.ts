import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRateLimitCredential, deriveRateLimitDomainKey, signRateLimitDebitRequest, verifyRateLimitDebitRequest,
  type RateLimitWorkerIdentity, type RateLimitIngressIdentity } from '../rate-limit';
import type { AdmissionTarget } from '../plugin-extensions';
import { DataAdmissionError, type AdmissionGrant, type DataAdmissionHost } from './host';

export const DATA_ADMISSION_RPC_PATH = '/__bungee/internal/data-admission/v1';
export const WORKER_STATE_RPC_PATH = '/__bungee/internal/plugin-state/v1';
const MAX_BYTES = 262_144;
const digest = (value: unknown) => `rlb-v1:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
function mac(key: Uint8Array, value: unknown): string { return createHmac('sha256', key).update('bungee-data-rpc/v1\0').update(JSON.stringify(value)).digest('hex'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid RPC object');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).sort().join() !== keys.sort().join()) throw new Error('invalid RPC fields');
}
export function parseAdmissionTarget(value: unknown): AdmissionTarget {
  const target = object(value);
  exact(target, ['requestId','attemptId','principal','routeId','serviceId','upstreamId','url','model','now']);
  for (const name of ['requestId','attemptId','routeId','upstreamId','url']) if (typeof target[name] !== 'string' || !(target[name] as string).length || (target[name] as string).length > (name === 'url' ? 65536 : 256)) throw new Error('invalid RPC target');
  if (!Number.isSafeInteger(target.now) || (target.serviceId !== null && typeof target.serviceId !== 'string') || (target.model !== null && typeof target.model !== 'string')) throw new Error('invalid RPC target');
  const principal = object(target.principal);
  exact(principal,['domain','keyId','credentialVersion']);
  if (typeof principal.domain !== 'string' || !principal.domain || principal.domain.length > 128 || typeof principal.keyId !== 'string' || principal.keyId.length > 128 || !Number.isSafeInteger(principal.credentialVersion) || (principal.domain === 'anonymous' ? principal.keyId !== '' || principal.credentialVersion !== 0 : !principal.keyId || (principal.credentialVersion as number) < 1)) throw new Error('invalid RPC principal');
  return target as unknown as AdmissionTarget;
}
async function read(request: Request): Promise<unknown> {
  if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json') throw new Error('invalid RPC request');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('missing RPC body');
  let total = 0; const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => { void reader.cancel('RPC body deadline'); }, 1000);
  try {
    while (true) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
      if (total > MAX_BYTES) { void reader.cancel(); throw new Error('RPC body too large'); } chunks.push(part.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
export interface WorkerStateRpcCall { readonly plugin: string; readonly method: string; readonly payload: unknown; readonly target: AdmissionTarget }
export function createSignedWorkerRpcServer(options: {
  transportSecret: string;
  identity: RateLimitIngressIdentity;
  authorizeWorker(worker: RateLimitWorkerIdentity): string;
  handle(operation: string, payload: unknown, worker: RateLimitWorkerIdentity): Promise<unknown> | unknown;
}) {
  const credential = createRateLimitCredential(options.transportSecret, options.identity);
  const key = deriveRateLimitDomainKey(options.transportSecret);
  const decisions = new Map<string,{ fingerprint: string; pending: Promise<unknown>; expires: number }>();
  let bodyReads = 0;
  let pendingOperations = 0;
  return async (request: Request): Promise<Response> => {
    try {
      if (bodyReads >= 64) throw new DataAdmissionError(503,'rpc_busy');
      bodyReads++;
      let wire: unknown;
      try { wire = await read(request); } finally { bodyReads--; }
      const envelope = object(wire); exact(envelope,['proof','payload']);
      const proof = verifyRateLimitDebitRequest(envelope.proof, credential);
      if (proof.deadline_at < Date.now() || proof.deadline_at > Date.now() + 15000) throw new Error('RPC deadline invalid');
      if (!['active','retired'].includes(options.authorizeWorker(proof.worker))) throw new DataAdmissionError(403,'worker_not_admitted');
      if (proof.body.bucket_id !== digest(envelope.payload)) throw new Error('RPC payload signature mismatch');
      const fingerprint = JSON.stringify([proof.worker,proof.body.policy_id,envelope.payload]);
      for (const [id, decision] of decisions) if (decision.expires <= Date.now()) decisions.delete(id);
      const previous = decisions.get(proof.debit_id);
      if (previous && previous.fingerprint !== fingerprint) throw new Error('RPC replay conflict');
      if (!previous && decisions.size >= 100000) throw new DataAdmissionError(503,'rpc_capacity');
      if (!previous && pendingOperations >= 64) throw new DataAdmissionError(503,'rpc_busy');
      if (!previous) pendingOperations++;
      const pending = previous?.pending ?? Promise.resolve().then(() => options.handle(proof.body.policy_id, envelope.payload, proof.worker)).finally(() => { pendingOperations--; });
      if (!previous) decisions.set(proof.debit_id,{fingerprint,pending,expires:proof.deadline_at});
      const result = await pending;
      const body = { requestId: proof.request_id, worker: proof.worker, server: options.identity, result };
      return Response.json({body,mac:mac(key,body)});
    } catch (error) {
      return Response.json({ error: error instanceof DataAdmissionError ? error.code : 'invalid_worker_rpc' }, {status: error instanceof DataAdmissionError ? error.status : 400,
        headers: error instanceof DataAdmissionError && error.retryAfter !== undefined ? {'retry-after':String(error.retryAfter)} : {}});
    }
  };
}
export function createDataAdmissionRpcServer(options: { host: DataAdmissionHost; transportSecret: string; identity: RateLimitIngressIdentity; authorizeWorker(worker: RateLimitWorkerIdentity): string }) {
  return createSignedWorkerRpcServer({...options, handle(operation,payload,worker) {
    if (operation === 'release') { const input=object(payload); exact(input,['requestId']); if(typeof input.requestId!=='string') throw new Error('invalid release'); options.host.release(input.requestId,worker); return null; }
    if (operation === 'admit') { const input=object(payload); exact(input,['target','version']);
      if (!Number.isSafeInteger(input.version)) throw new Error('invalid admission version');
      return options.host.admit(parseAdmissionTarget(input.target),worker,false,input.version as number); }
    const target = parseAdmissionTarget(payload);
    if (operation === 'preview') return options.host.admit(target,worker,true);
    if (operation === 'attempt') return options.host.beforeAttempt(target,worker);
    throw new Error('unknown admission operation');
  }});
}
export function createSignedWorkerRpcClient(options: {
  transportSecret: string; worker: RateLimitWorkerIdentity; expectedServer: RateLimitIngressIdentity; url: string;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) {
  const credential = createRateLimitCredential(options.transportSecret, options.worker);
  const key=deriveRateLimitDomainKey(options.transportSecret);
  return async (operation: string,payload: unknown,signal?: AbortSignal): Promise<unknown> => {
    const requestId=randomUUID(); const debitId=randomUUID();
    const proof=signRateLimitDebitRequest({request_id:requestId,debit_id:debitId,deadline_at:Date.now()+2000,
      body:{bucket_id:digest(payload),policy_id:operation,revision:1,rps:1,burst:1}},credential);
    const wire=JSON.stringify({proof,payload}); if(Buffer.byteLength(wire)>MAX_BYTES) throw new Error('RPC payload too large');
    // Retry the exact operation identity after an uncertain ACK; server returns its original decision.
    for(let attempt=0;attempt<2;attempt++) {
      try {
        const response=await (options.fetch ?? fetch)(options.url,{method:'POST',headers:{'content-type':'application/json'},body:wire,
          signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000)});
        const text=await response.text(); if(Buffer.byteLength(text)>MAX_BYTES) throw new Error('RPC response too large');
        const envelope=object(JSON.parse(text));
        if(!response.ok) throw new DataAdmissionError(response.status,String(envelope.error));
        exact(envelope,['body','mac']); const body=object(envelope.body); exact(body,['requestId','worker','server','result']);
        const expected=Buffer.from(mac(key,body),'hex'); const actual=typeof envelope.mac==='string' ? Buffer.from(envelope.mac,'hex') : Buffer.alloc(0);
        if(expected.length!==actual.length || !timingSafeEqual(expected,actual) || body.requestId!==requestId
          || Object.entries(options.worker).some(([name,value]) => object(body.worker)[name] !== value)
          || Object.entries(options.expectedServer).some(([name,value]) => object(body.server)[name] !== value)) throw new Error('RPC response identity mismatch');
        return body.result;
      } catch(error) { if(error instanceof DataAdmissionError || signal?.aborted || attempt===1) throw error; }
    }
  };
}
export type DataAdmissionRpc = (operation: 'admit'|'attempt'|'release',payload: AdmissionTarget|{requestId:string},signal?:AbortSignal)=>Promise<AdmissionGrant|unknown>;

/** Master adapter: process proof is checked before dispatching any plugin-owned schema. */
export function createWorkerStateRpcServer(options: {
  transportSecret: string; identity: RateLimitIngressIdentity;
  authorizeWorker(worker: RateLimitWorkerIdentity): string;
  handle(call: WorkerStateRpcCall, worker: RateLimitWorkerIdentity): Promise<unknown>;
}) {
  return createSignedWorkerRpcServer({ ...options, handle(operation,payload,worker) {
    if(operation !== 'plugin-state') throw new Error('unknown worker state operation');
    const input=object(payload); exact(input,['plugin','method','payload','target']);
    if(typeof input.plugin !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.plugin)
      || typeof input.method !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.method)) throw new Error('invalid plugin state RPC');
    return options.handle({plugin:input.plugin,method:input.method,payload:input.payload,target:parseAdmissionTarget(input.target)},worker);
  }});
}
