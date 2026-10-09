/** Escape UTF-16 code units so fixed RPC slices never contain lone surrogates. */
export function serializeHistory(value:unknown):string {return JSON.stringify(value).replace(/[\uD800-\uDFFF]/g,unit=>'\\u'+unit.charCodeAt(0).toString(16).padStart(4,'0'));}
/** Ephemeral control-process cache: no storage/database access, bounded across all workers. */
export class HistoryCache {
  private entries = new Map<string,{text:string;bytes:number;expires:number}>();
  private used=0;
  constructor(private limits={maxEntries:512,maxBytes:32*1024*1024,maxEntryBytes:8*1024*1024,ttlMs:600_000},private now=Date.now) {}
  sweep(){for(const [key,entry] of this.entries)if(entry.expires<=this.now()){this.used-=entry.bytes;this.entries.delete(key);}}
  get(scope:string,id:string){this.sweep();const entry=this.entries.get(JSON.stringify([scope,id]));return entry ? JSON.parse(entry.text) : null;}
  readText(scope:string,id:string){this.sweep();return this.entries.get(JSON.stringify([scope,id]))?.text ?? null;}
  put(scope:string,id:string,value:unknown){
    this.sweep();const text=serializeHistory(value);const bytes=Buffer.byteLength(text);if(bytes>this.limits.maxEntryBytes)throw new Error('codex_router_history_limit');
    const key=JSON.stringify([scope,id]),old=this.entries.get(key);if(old){this.used-=old.bytes;this.entries.delete(key);}
    while(this.entries.size>=this.limits.maxEntries||this.used+bytes>this.limits.maxBytes){const oldest=this.entries.keys().next().value;if(oldest===undefined)throw new Error('codex_router_history_limit');const item=this.entries.get(oldest)!;this.used-=item.bytes;this.entries.delete(oldest);}
    this.entries.set(key,{text,bytes,expires:this.now()+this.limits.ttlMs});this.used+=bytes;
  }
  clear(){this.entries.clear();this.used=0;}
  status(){this.sweep();return {entries:this.entries.size,bytes:this.used};}
}

export class HistoryTransport {
  private pending=new Map<string,{scope:string;id:string;total:number;parts:string[];bytes:number;expires:number}>();
  private retained=0;
  constructor(readonly cache=new HistoryCache()){}
  sweep(){const now=Date.now();for(const [key,entry] of this.pending)if(entry.expires<=now){this.retained-=entry.bytes;this.pending.delete(key);}this.cache.sweep();}
  get({scope,id,index}:{scope:string;id:string;index:number}){const text=this.cache.readText(scope,id);if(text===null)return null;if(index*8192>=text.length)return null;return {data:text.slice(index*8192,(index+1)*8192),done:(index+1)*8192>=text.length};}
  put({scope,id,index,total,data}:{scope:string;id:string;index:number;total:number;data:string}){
    this.sweep();const key=JSON.stringify([scope,id]);let entry=this.pending.get(key);
    if(index===0){if(entry){this.retained-=entry.bytes;this.pending.delete(key);}if(this.pending.size>=128)throw new Error('codex_router_history_busy');entry={scope,id,total,parts:[],bytes:0,expires:Date.now()+30_000};this.pending.set(key,entry);}
    if(!entry||entry.total!==total||entry.parts.length!==index)throw new Error('codex_router_history_chunks_invalid');
    const bytes=Buffer.byteLength(data);if(entry.bytes+bytes>8*1024*1024||this.retained+bytes>8*1024*1024)throw new Error('codex_router_history_limit');
    entry.parts.push(data);entry.bytes+=bytes;this.retained+=bytes;
    if(index+1===total){this.pending.delete(key);this.retained-=entry.bytes;this.cache.put(scope,id,JSON.parse(entry.parts.join('')));}return null;
  }
  clear(){this.pending.clear();this.retained=0;this.cache.clear();}
}
