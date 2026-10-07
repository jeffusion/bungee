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
