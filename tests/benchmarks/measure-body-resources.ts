/** Repeatable synthetic measurements. Outputs metadata only, never request contents. */
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { BodySource, BodyBufferLease } from '../../packages/core/src/gateway/body-service';
import { bodyResources, snapshotBodyResources, bodyMetrics } from '../../packages/core/src/gateway/body-resources';
import { captureBody } from '../../packages/core/src/logger/body-capture';
import { createAttemptResponseObserver } from '../../packages/core/src/worker/response/attempt-observation';
const encoder=new TextEncoder();const limit=50*1024*1024;
const context={requestId:'synthetic',attemptId:'a',routeId:'r',upstreamId:'u',status:200};
async function sample(size:number,coding:string,concurrency=1,mixed=false){
  Bun.gc(true);bodyMetrics.peakBytes=bodyMetrics.retainedBytes;
  const before=snapshotBodyResources();const rssBefore=process.memoryUsage().rss;const started=performance.now();let observed=0;let saved=0;const codes:string[]=[];const incomplete:string[]=[];
  let input='x'.repeat(size-12);
  if(mixed){let state=1729;const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-';
    input=Array.from({length:size-12},()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return alphabet[(state>>>0)%alphabet.length];}).join('');}
  const text=JSON.stringify({input});const raw=encoder.encode(text);const wire=new Uint8Array(coding==='gzip'?gzipSync(raw):coding==='zstd'?zstdCompressSync(raw):raw);
  await Promise.all(Array.from({length:concurrency},async()=>{
    const capture=captureBody(new Response(wire).body!,1024*1024,coding,async()=>{saved++;},reason=>incomplete.push(reason),undefined,'application/json');
    const source=new BodySource(capture.body,limit,coding);
    try{
      await source.handle().json({id:'mandatory',mandatory:true});
      const observer=createAttemptResponseObserver('json',context,async e=>{if(e.phase==='response')observed++;if(e.phase==='incomplete')incomplete.push(e.reason);},undefined,coding,'response','',undefined,{maxBytes:limit,bodyHandle:source.handle()});
      await new Response(new Response(source.take()).body!.pipeThrough(observer)).arrayBuffer();await observer.completion;
    }catch(error){codes.push((error as {code?:string}).code??'unknown');capture.stop();}
    finally{await capture.completion;source.dispose();}
  }));
  const after=snapshotBodyResources();
  if(after.retainedBytes!==before.retainedBytes || after.activeDecoders!==before.activeDecoders || after.optionalBytes!==before.optionalBytes || after.loggerBytes!==before.loggerBytes)throw Error('resource leak');
  return {bytes:size,wireBytes:wire.byteLength,coding:coding||'identity',concurrency,pattern:mixed?'mixed':'repeated',ms:+(performance.now()-started).toFixed(2),rssDelta:process.memoryUsage().rss-rssBefore,peakRetained:after.peakBytes,decompressions:after.decompressions-before.decompressions,jsonParses:after.jsonParses-before.jsonParses,observed,saved,codes,incomplete:[...new Set(incomplete)],remaining:after.retainedBytes};
}
console.log(JSON.stringify({runtime:Bun.version,configuration:bodyResources}));
for(const size of [800*1024,2*1024*1024,limit,limit+1])for(const coding of ['', 'gzip', 'zstd'])console.log(JSON.stringify(await sample(size,coding)));
for(const coding of ['', 'gzip', 'zstd'])for(const concurrency of [2,8])console.log(JSON.stringify(await sample(800*1024,coding,concurrency)));
for(const coding of ['', 'gzip', 'zstd'])console.log(JSON.stringify(await sample(800*1024,coding,8,true)));
for(const coding of ['', 'gzip', 'zstd'])console.log(JSON.stringify(await sample(2*1024*1024,coding,8)));
const before=snapshotBodyResources();const pressure=new BodyBufferLease();pressure.add(bodyResources.workerMemoryBytes-32);
const owner=new BodySource(new Response('x'.repeat(64)).body!,1024);
try{await owner.buffer('pressure');throw Error('pressure was not enforced');}catch(error){if((error as {code:string}).code!=='body_buffer_capacity')throw error;}finally{owner.dispose();pressure.dispose();}
if(snapshotBodyResources().retainedBytes!==before.retainedBytes)throw Error('pressure leak');
console.log(JSON.stringify({pressure:'body_buffer_capacity',released:true}));
// All samples and log consumers have settled; imported host timers do not own this CLI.
process.exit(0);
