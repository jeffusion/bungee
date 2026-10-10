import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {gzipSync,zstdCompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createPublicRequestForwarder} from '../../packages/core/src/public-listener/forwarding';
const encoder=new TextEncoder();const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function worker(target:string){
  const root=await mkdtemp(join(tmpdir(),'bungee-opaque-process-'));
  const source=`import {handleRequest} from ${JSON.stringify(resolve(import.meta.dir,'../../packages/core/src/worker/request/handler.ts'))};
    const cfg={routes:[{path:'/test',endpoints:[{target:${JSON.stringify(target)}}]}]};
    const logging={accessLogWriter:{write(){},updateResponseBodyId(){},updateProtocolOutcome(){}},fileLogWriter:{write(){}}};
    const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return handleRequest(req,cfg,{logging});}});
    console.log('OPAQUE_READY:'+server.port);process.on('SIGTERM',()=>{server.stop(true);process.exit(0);});`;
  const child=spawn(process.execPath,['-e',source],{cwd:root,env:{...process.env,BUNGEE_ACCESS_DB_PATH:join(root,'access.db'),BUNGEE_HEADER_LOG_DIR:join(root,'headers')},stdio:['ignore','pipe','pipe']});
  let output='';let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});
  const port=await new Promise<number>((resolvePort,reject)=>{const timer=setTimeout(()=>reject(new Error('worker readiness timeout '+stderr)),5000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(!output.includes('OPAQUE_READY:'))reject(new Error('worker exited '+code+' '+stderr));});child.stdout!.on('data',chunk=>{output+=chunk;const match=/OPAQUE_READY:(\d+)/.exec(output);if(match){clearTimeout(timer);resolvePort(Number(match[1]));}});});
  return {port,async close(){child.kill('SIGTERM');await new Promise<void>(resolveExit=>{if(child.exitCode!==null)resolveExit();else child.once('exit',()=>resolveExit());});await rm(root,{recursive:true,force:true});}};
}
async function chain(upstreamFetch:(req:Request)=>Response|Promise<Response>){
  const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch:upstreamFetch});
  const processWorker=await worker(upstream.url.origin);
  let forward:ReturnType<typeof createPublicRequestForwarder>;
  try { forward=createPublicRequestForwarder({transportSecret:Buffer.alloc(32,1).toString('base64url'),admission:{acquire(){return {worker:{private_port:processWorker.port},release(){}};}}}); } catch(error){await processWorker.close();await upstream.stop(true);throw error;}
  const ingress=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){return forward(req,'127.0.0.1');}});
  return {url:ingress.url.origin,async close(){await ingress.stop(true);await processWorker.close();await upstream.stop(true);}};
}
test('real ingress → worker child → upstream preserves compressed/malformed/binary/SSE raw wire hashes',async()=>{
  const received:Array<{bytes:Uint8Array;coding:string|null}>=[];
  const pipeline=await chain(async(req)=>{const bytes=new Uint8Array(await req.arrayBuffer());received.push({bytes,coding:req.headers.get('content-encoding')});return new Response(bytes,{headers:{'content-type':req.headers.get('content-type')!,'content-encoding':req.headers.get('content-encoding') ?? 'identity'}});});
  try{
    const json=encoder.encode('{ "model": "codex" }');
    for(const [bytes,coding,type] of [[zstdCompressSync(json),'zstd','application/json'],[gzipSync(json),'gzip','application/json'],[encoder.encode('{invalid'),'identity','application/json'],[new Uint8Array([0,128,255]),'unknown','application/octet-stream'],[encoder.encode(': custom\nevent: arbitrary\ndata: {bad}\n\ndata: [DONE]\n\n'),'identity','text/event-stream']] as const){
      const res=await Bun.fetch(pipeline.url+'/test',{method:'POST',body:bytes,headers:{'content-type':type,'content-encoding':coding},decompress:false});const output=new Uint8Array(await res.arrayBuffer());expect(res.status).toBe(200);expect(hash(received.at(-1)!.bytes)).toBe(hash(bytes));expect(hash(output)).toBe(hash(bytes));expect(received.at(-1)!.coding).toBe(coding);expect(res.headers.get('content-encoding')).toBe(coding);
    }
  }finally{await pipeline.close();}
},15000);
test('real ingress streams request and response chunks before their respective EOF',async()=>{
  let firstUpload!:()=>void;const uploadObserved=new Promise<void>(resolve=>{firstUpload=resolve;});
  let responseFinish!:()=>void;const responseGate=new Promise<void>(resolve=>{responseFinish=resolve;});
  const pipeline=await chain(async(req)=>{const reader=req.body!.getReader();const first=await reader.read();expect(new TextDecoder().decode(first.value)).toBe('upload-first');firstUpload();while(!(await reader.read()).done){}
    return new Response(new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(encoder.encode('response-first'));await responseGate;controller.enqueue(encoder.encode('response-last'));controller.close();}}),{headers:{'content-type':'application/octet-stream'}});
  });
  let finishUpload!:()=>void;const uploadGate=new Promise<void>(resolve=>{finishUpload=resolve;});
  const bytes=new ReadableStream<Uint8Array>({async start(controller){controller.enqueue(encoder.encode('upload-first'));await uploadGate;controller.enqueue(encoder.encode('upload-last'));controller.close();}});
  try{
    const pending=Bun.fetch(pipeline.url+'/test',{method:'POST',body:bytes,decompress:false});await Promise.race([uploadObserved,Bun.sleep(2000).then(()=>{throw new Error('upload buffered until EOF');})]);finishUpload();
    const response=await pending;const reader=response.body!.getReader();expect(new TextDecoder().decode((await reader.read()).value)).toBe('response-first');responseFinish();expect(new TextDecoder().decode((await reader.read()).value)).toBe('response-last');expect((await reader.read()).done).toBe(true);
  }finally{finishUpload();responseFinish();await pipeline.close();}
},15000);
