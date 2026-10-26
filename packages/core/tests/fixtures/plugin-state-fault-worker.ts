import { existsSync, writeFileSync } from 'node:fs';
/** Fault wrapper around the actual production storage entry, never a fake database. */
const scope = globalThis as any;
const post = scope.postMessage.bind(scope);
const responseIds = new Set<number>();
let crashId = -1;
const delayed=new Map<number,number>();
const dropAcks=new Set<number>();
let faultMode='silent';
let dropProbes=false;
let storagePath='';
let sourceSequence=0;
let callbackSequence=0;
const heldSources=new Map<number,number>();
scope.postMessage = (message:any) => {
  if(message.type==='response' && (responseIds.has(message.id)||dropAcks.has(message.id)))return;
  if(message.type==='response'&&heldSources.has(message.id)){
    const sequence=heldSources.get(message.id)!;heldSources.delete(message.id);
    const gate=`${storagePath}.source-${sequence}`;
    writeFileSync(`${gate}.ready`,'');
    const release=()=>{if(existsSync(`${gate}.release`))post(message);else setTimeout(release,5);};
    release();return;
  }
  if(message.type==='callback'&&faultMode==='held-callback'){
    // The real worker already owns this callback; close must decide before the host forwards it.
    const gate=`${storagePath}.callback-${++callbackSequence}`;
    writeFileSync(`${gate}.ready`,'');
    const release=()=>{if(existsSync(`${gate}.release`))post(message);else setTimeout(release,5);};
    release();return;
  }
  if(message.type==='response'&&delayed.has(message.id)){const delay=delayed.get(message.id)!;delayed.delete(message.id);setTimeout(()=>post(message),delay);return;}
  if(message.type==='callback'&&faultMode==='late-callback'){setTimeout(()=>post(message),180);return;}
  if(message.type==='response' && message.id===crashId && !message.error){scope.close();return;}
  post(message);
};
await import('../../src/plugin-state/worker');
const receive = scope.onmessage;
scope.onmessage = (event:any) => {
  const request=event.data;
  if(request.type==='request') {
    if(request.method==='open') {
      const path=request.args[0] as string;storagePath=path;
      scope.faultMode=path.includes('late-cap')?'late-cap':path.includes('late-source')?'late-source':path.includes('held-callback')?'held-callback':path.includes('late-callback')?'late-callback':path.includes('drop-write-ack')?'drop-write-ack':path.includes('drop-probe')?'drop-probe':path.includes('drop-release-ack')?'drop-release-ack':path.includes('lost-ack')?'lost-ack':path.includes('silent-close')?'silent-close':path.includes('silent-cap')?'silent-cap':path.includes('silent-release')?'silent-release':'silent';
    }
    faultMode=scope.faultMode;
    if(faultMode==='late-cap'&&['durable','journal'].includes(request.method))delayed.set(request.id,400);
    if(faultMode==='late-source'&&request.method==='current')heldSources.set(request.id,++sourceSequence);
    // Setup must stay healthy; arm probe loss only after the suspect read starts.
    if(faultMode==='drop-probe'&&request.method==='durable')delayed.set(request.id,120);
    if((faultMode==='drop-write-ack'&&request.method==='execute')||(faultMode==='drop-release-ack'&&['release','releaseCapability'].includes(request.method)))dropAcks.add(request.id);
    if(faultMode==='drop-probe'&&request.method==='get'){dropProbes=true;responseIds.add(request.id);return;}
    if(faultMode==='drop-probe'&&request.method==='probe'&&dropProbes){responseIds.add(request.id);return;}
    if(scope.faultMode==='lost-ack'&&request.method==='execute')crashId=request.id;
    if((scope.faultMode==='silent-cap'&&['durable','journal'].includes(request.method))||(scope.faultMode==='silent-release'&&request.method==='releaseCapability')){responseIds.add(request.id);return;}
    if((scope.faultMode==='silent'&&request.method==='get')||(scope.faultMode==='silent-close'&&request.method==='close')) {responseIds.add(request.id);return;}
  }
  receive(event);
};
