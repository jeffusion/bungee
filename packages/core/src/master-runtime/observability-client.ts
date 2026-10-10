import type { MasterStatsApi, MasterLoggingConfig } from './master-stats';

function headerEntries(headers:Headers):[string,string][] {const values:[string,string][]=[];headers.forEach((value,key)=>values.push([key,value]));return values;}
export function resolveObservabilityWorkerUrl(moduleUrl: string | URL): URL {
  const url = new URL(moduleUrl);
  return new URL(url.pathname.endsWith('.ts') && !url.pathname.includes('/$bunfs/')
    ? (url.pathname.includes('/master-runtime/') ? './observability-worker.ts' : './master-runtime/observability-worker.ts')
    : './observability-worker.js',url);
}
class ObservationTransport {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly rejectReady: (error: Error) => void;
  private sequence = 0;
  private failed: Error | null = null;
  private closing: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(url: string | URL, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('invalid_observability_timeout');
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.rejectReady = rejectReady;
    void this.ready.catch(() => undefined);
    this.worker = new Worker(url, { type: 'module', name: 'bungee-observability' });
    this.worker.onmessage = event => {
      if (event.data?.type === 'ready') { resolveReady(); return; }
      const response = event.data, request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id); clearTimeout(request.timer);
      if (response.error) request.reject(Object.assign(new Error(response.error.message), {
        code: response.error.code, resourceUnreleased: response.error.resourceUnreleased,
      }));
      else request.resolve(response.value);
    };
    this.worker.onerror = event => { event.preventDefault(); this.fail('observability_worker_failed'); };
    this.worker.addEventListener('close', () => this.fail('observability_worker_closed'));
  }
  private fail(message: string): void {
    if (this.failed) return;
    const error = Object.assign(new Error(message), { resourceUnreleased: true });
    this.failed = error; this.rejectReady(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.worker.terminate();
  }
  call<T = any>(method: string, args: readonly unknown[] = []): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closing && method !== 'close') return Promise.reject(new Error('observability_client_closing'));
    if (this.pending.size >= 128) return Promise.reject(new Error('observability_queue_full'));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('observability_result_unknown'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.ready.then(() => {
        if (!this.pending.has(id)) return;
        try { this.worker.postMessage({ id, method, args }); }
        catch { this.fail('observability_message_failed'); }
      }, () => { /* fail settles all queued requests. */ });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.call('close').then(() => {
      this.failed = new Error('observability_client_closed'); this.worker.terminate();
    });
    return this.closing;
  }
  terminate(): void { this.worker.terminate(); }
  healthy(): boolean { return this.failed === null; }
}
function matches(path:string):boolean {
  if (path === '/api/stats/upstreams/last-used')return false;
  return ['/api/stats','/api/stats/history','/api/stats/history/v2','/api/stats/dashboard','/api/stats/upstream-stats',
    '/api/stats/upstream-distribution','/api/stats/upstream-failures','/api/stats/upstream-status-codes'].includes(path)
    || path === '/api/logs' || path.startsWith('/api/logs/');
}
/** Supervision thread only serializes control messages; SQL and scans run in the leaf. */
export async function createAsyncMasterStats(path:string,options:{workerUrl?:string|URL;requestTimeoutMs?:number}={}):Promise<MasterStatsApi> {
  const transport=new ObservationTransport(options.workerUrl ?? resolveObservabilityWorkerUrl(import.meta.url),options.requestTimeoutMs);
  try {await transport.call('open',[path]);}catch(error){transport.terminate();throw error;}
  const adapters=new Map<string,Readonly<Record<string,(...args:any[])=>Promise<any>>>>();
  const background=new Set<Promise<unknown>>();let backgroundError:unknown;
  const enqueue=(method:string,args:readonly unknown[])=>{const task=transport.call(method,args);background.add(task);
    void task.catch(error=>{backgroundError=error;}).finally(()=>background.delete(task));};
  let closed=false;
  return Object.freeze({matches,
    healthy:()=>!closed && transport.healthy(),
    async registerObservationAdapter(namespace:string,modulePath:string) {
      const methods=await transport.call<readonly string[]>('register',[namespace,modulePath]);
      if(methods.length)adapters.set(namespace,Object.freeze(Object.fromEntries(methods.map(method=>[method,(...args:unknown[])=>transport.call('observe',[namespace,method,args])]))));
    },
    observationAdapter:namespace=>adapters.get(namespace),
    observe:(namespace,operation,args)=>transport.call('observe',[namespace,operation,args]),
    configureLogging:(logging?:MasterLoggingConfig)=>enqueue('configure',[logging]),
    startCleanup:()=>enqueue('cleanup',[]),
    async handle(request:Request) {
      if(closed)return Response.json({error:'observability_unavailable'},{status:503});
      const requestBody=request.body ? new Uint8Array(await request.arrayBuffer()) : null;
      if(requestBody && requestBody.byteLength>1024*1024)throw new Error('observability_request_too_large');
      const response=await transport.call('request',[{url:request.url,method:request.method,headers:headerEntries(request.headers),body:requestBody}]);
      const id=response.bodyId as number|null;
      const cancel=()=>{if(id!==null)void transport.call('cancel',[id]).catch(()=>undefined);};
      request.signal.addEventListener('abort',cancel,{once:true});
      if(request.signal.aborted){cancel();throw new Error('observability_request_cancelled');}
      const body=id===null ? null : new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {const part=await transport.call('pull',[id]);if(part.done){request.signal.removeEventListener('abort',cancel);controller.close();}else controller.enqueue(part.value);}
          catch(error){request.signal.removeEventListener('abort',cancel);controller.error(error);cancel();}
        },
        async cancel(){request.signal.removeEventListener('abort',cancel);await transport.call('cancel',[id]);},
      });
      if(id===null)request.signal.removeEventListener('abort',cancel);
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    },
    async close(){closed=true;await Promise.allSettled([...background]);await transport.close();if(backgroundError)throw backgroundError;},
  } satisfies MasterStatsApi);
}
/** Selection and migrations run in a short-lived leaf before any observation connection. */
export async function migrateAccessDatabaseAsync(path:string,workerUrl=resolveObservabilityWorkerUrl(import.meta.url)):Promise<void> {
  const transport=new ObservationTransport(workerUrl);
  try {await transport.call('migrate',[path]);}finally{transport.terminate();}
}
