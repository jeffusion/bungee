import type {Database} from 'bun:sqlite';
import {createHash} from 'node:crypto';
import {decodePluginExecutorProof,type PluginExecutorProof} from '../plugin-services/peer-executor-proof';
import type {PluginCommunicationStore} from '../plugin-services/persistence';

/** Replace the protected proof in one transaction, without an extra row or byte reservation. */
export function retireExecutorProof(db:Database,communication:PluginCommunicationStore,id:string,expected:PluginExecutorProof):void {
  const proof=decodePluginExecutorProof(expected);
  if(proof===null || createHash('sha256').update(JSON.stringify([proof.source.process,proof.source.instance,proof.source.catalog,proof.source.generation])).digest('hex')!==id) throw new Error('executor_proof_invalid');
  db.transaction(()=>{
    const store=communication.forNamespace('host:rpc:executors');
    const record=store.get(id);
    const current=record===null?null:decodePluginExecutorProof(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.payload)));
    if(current===null || JSON.stringify({...current,retired:false})!==JSON.stringify({...proof,retired:false})) throw new Error('executor_proof_changed');
    if(current.retired) return;
    store.ack(id);
    store.put(id,new TextEncoder().encode(JSON.stringify({...current,retired:true})),{required:true});
  }).immediate();
}

/** Explicit offline normalization preserves commands and makes absent exit facts unknown. */
export function prepareExecutorProofPage(db:Database,communication:PluginCommunicationStore,after:string) {
  if(typeof after!=='string'||after.length>128) throw new Error('runtime_upgrade_cursor_invalid');
  return db.transaction(()=>{
    const rows=db.query<{key:string},[string]>("SELECT key FROM plugin_communication_records WHERE namespace='host:rpc:executors' AND key>? ORDER BY key LIMIT 128").all(after);
    const store=communication.forNamespace('host:rpc:executors'); let converted=0;
    for(const row of rows) {
      const record=store.get(row.key);if(record===null) throw new Error('runtime_upgrade_record_missing');
      const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(record.payload));
      if(decodePluginExecutorProof(raw)!==null) continue;
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).sort().join()!=='boot,physical,source') throw new Error('runtime_upgrade_proof_invalid');
      const proof=decodePluginExecutorProof({...raw,guard:null,retired:false});
      if(proof===null) throw new Error('runtime_upgrade_proof_invalid');
      const key=createHash('sha256').update(JSON.stringify([proof.source.process,proof.source.instance,proof.source.catalog,proof.source.generation])).digest('hex');
      if(key!==row.key) throw new Error('runtime_upgrade_identity_mismatch');
      store.ack(row.key);store.put(row.key,new TextEncoder().encode(JSON.stringify(proof)),{required:true});converted++;
    }
    return {scanned:rows.length,converted,last_key:rows.at(-1)?.key??null};
  }).immediate();
}
