import '../../src/config-storage/storage-worker';
/** Real production Worker with acknowledgements deliberately lost. */
const scope=globalThis as any;
const post=scope.postMessage.bind(scope);
const silent=new Set<number>();
scope.postMessage=(message:any)=>{if(!silent.has(message.id))post(message);};
const receive=scope.onmessage;
scope.onmessage=(event:any)=>{
  if(event.data.method==='getOperation'||event.data.method==='close') {silent.add(event.data.id);return;}
  receive(event);
};
