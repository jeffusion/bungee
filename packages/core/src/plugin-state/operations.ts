/** Shared IPC intent; resource creation and cleanup are never durable writes. */
export type StateMethodClass = 'read' | 'write' | 'resource' | 'cleanup' | 'close';
const reads = new Set(['get','readStrict','keys','list','receipt','status','inspect','query','current','version','read','oldestSequence','latestSequence','prunedThrough','checkpoint','maintenanceStatus','pendingRecoveryRequests','recoveryScanComplete','journalNamespaces','atomicView','executorProofPage','executorHasPending','probe']);
const creators = new Set(['durable','storage','secret','communication','event','snapshot','journal']);
export function stateMethodClass(target:string|Promise<string>,method:string,args:readonly unknown[]):StateMethodClass {
  if(method==='close')return 'close';
  if(method==='releaseCapability'||method==='secretRevoke'||(target==='source'&&method==='release')||(target==='host'&&method==='release'))return 'cleanup';
  if(target==='host'&&(method==='open'||creators.has(method)))return 'resource';
  if(target==='host'&&method==='storageOperation')return ['get','readStrict','keys'].includes(args[1] as string)?'read':'write';
  return reads.has(method)?'read':'write';
}
export function stateCreatedResource(target:string|Promise<string>,method:string):'capability'|'source'|null {
  if(target==='host'&&creators.has(method))return 'capability';
  if(method==='current'||method==='version')return 'source';
  return null;
}
