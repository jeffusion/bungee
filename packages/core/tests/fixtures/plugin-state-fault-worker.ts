export {};
/** Fault wrapper around the actual production storage entry, never a fake database. */
const scope = globalThis as any;
const post = scope.postMessage.bind(scope);
const responseIds = new Set<number>();
let crashId = -1;
scope.postMessage = (message:any) => {
  if(message.type==='response' && responseIds.has(message.id))return;
  if(message.type==='response' && message.id===crashId && !message.error){scope.close();return;}
  post(message);
};
await import('../../src/plugin-state/worker');
const receive = scope.onmessage;
scope.onmessage = (event:any) => {
  const request=event.data;
  if(request.type==='request') {
    if(request.method==='open') {
      const path=request.args[0] as string;
      scope.faultMode=path.includes('lost-ack')?'lost-ack':path.includes('silent-close')?'silent-close':path.includes('silent-cap')?'silent-cap':path.includes('silent-release')?'silent-release':'silent';
    }
    if(scope.faultMode==='lost-ack'&&request.method==='execute')crashId=request.id;
    if((scope.faultMode==='silent-cap'&&['durable','journal'].includes(request.method))||(scope.faultMode==='silent-release'&&request.method==='releaseCapability')){responseIds.add(request.id);return;}
    if((scope.faultMode==='silent'&&request.method==='get')||(scope.faultMode==='silent-close'&&request.method==='close')) {responseIds.add(request.id);return;}
  }
  receive(event);
};
