import { createBodySource } from '../../gateway/body-factory';
import type { BodyViewIdentity } from '../../gateway/body-contracts';
import type { RequestSnapshot } from '../types';
import { parseBodyParserLimit } from '../../config-storage/global-scalars';
import { BodyProcessingError } from './body-source';
export class RequestBodyTooLargeError extends BodyProcessingError {
  constructor(readonly maxBytes: number, readonly receivedBytes: number) { super(413, 'request_body_too_large'); }
}
/** Metadata capture never reads, clones, or parses a payload. */
export async function createRequestSnapshot(req: Request, bodyParserLimit?: string, signal = req.signal,
  body: ReadableStream<Uint8Array> | null = req.body, identity?:BodyViewIdentity): Promise<RequestSnapshot> {
  const maxBytes = parseBodyParserLimit(bodyParserLimit);
  const contentLength = req.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) throw new RequestBodyTooLargeError(maxBytes, Number(contentLength));
  const headers: Record<string,string> = {}; req.headers.forEach((value,key)=>{headers[key]=value;});
  return { method: req.method, url: req.url, headers, body: undefined,
    content_type: headers['content-type'] ?? '', is_json_body: false,
    bodySource: createBodySource(body, maxBytes, headers['content-encoding'], signal, identity ?? {requestId:'',attemptId:'',direction:'request',stage:'original-request',version:0,contentType:headers['content-type'] ?? '',contentEncoding:headers['content-encoding'] ?? ''}) };
}
export async function readSnapshotJson(snapshot: RequestSnapshot, reason: string, emptyObject = false): Promise<any> {
  snapshot.body = await snapshot.bodySource!.json(reason, emptyObject); snapshot.is_json_body = true; return snapshot.body;
}
export function ensureSnapshotCloned(snapshot: RequestSnapshot): RequestSnapshot { return snapshot; }
export const ensureSnapshotBodyCloned = ensureSnapshotCloned;

/** A branch shares the controlled owner until its parent produced a new JSON representation. */
export function deriveRequestSnapshot(snapshot:RequestSnapshot, context:import('./context').MutableRequestContext,
  identity:BodyViewIdentity):{snapshot:RequestSnapshot;dispose:()=>void} {
  const branch:RequestSnapshot={...snapshot,headers:{...context.headers},
    body:context.body===undefined?snapshot.body:structuredClone(context.body),
    is_json_body:context.body!==undefined || snapshot.is_json_body};
  if(!context.bodyWrite || context.body===undefined)return {snapshot:branch,dispose:()=>{}};
  const bytes=new TextEncoder().encode(JSON.stringify(context.body));
  const headers={...branch.headers};delete headers['content-encoding'];headers['content-type']='application/json';headers['content-length']=String(bytes.byteLength);
  const owner=createBodySource(new Response(bytes).body,snapshot.bodySource?.maxBytes ?? 50*1024*1024,'',snapshot.bodySource?.signal,
    {...identity,contentType:'application/json',contentEncoding:''});
  branch.headers=headers;branch.content_type='application/json';branch.bodySource=owner;
  return {snapshot:branch,dispose:()=>owner.dispose()};
}
