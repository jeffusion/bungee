import { randomUUID } from 'node:crypto';
import { ANONYMOUS_PRINCIPAL } from '../plugin-extensions';
import type { ForwardPublicRequestOptions } from './forwarding';
import { privateRequestHeaders } from './headers';
import { validateWebSocketRequest, type WebSocketBridge } from '../websocket';

/** Pin the admitted worker for this connection; publication never migrates an open socket. */
export async function forwardPublicWebSocket(request: Request, server: Bun.Server<any>, bridge: WebSocketBridge,
  options: ForwardPublicRequestOptions, peer?: string): Promise<Response|undefined> {
  const invalid=validateWebSocketRequest(request);
  if (invalid) return invalid;
  const principal=options.authenticate?.(request) ?? ANONYMOUS_PRINCIPAL;
  const identity={requestId:randomUUID(),principal};
  const lease=options.admission.acquire();
  try {
    if (!lease.worker) return Response.json({error:'service_unavailable'},{status:503,headers:{'retry-after':'1'}});
    const original=new URL(request.url);
    return await bridge.upgrade(request,server,{
      url:`ws://127.0.0.1:${lease.worker.private_port}${original.pathname}${original.search}`,
      headers:privateRequestHeaders(request,options.transportSecret,peer,identity),signal:request.signal,
    });
  } finally {lease.release();}
}
