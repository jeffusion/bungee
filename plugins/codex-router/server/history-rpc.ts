import {defineRpcService} from '@jeffusion/bungee-core/plugin';
const key={type:'string',minLength:1,maxLength:512} as const;
/** Each canonical RPC frame is <=64 KiB; long histories use bounded ordered chunks. */
export const historyRpc=defineRpcService({id:'codex-router.history.v1',version:1,methods:{
  get:{kind:'query',input:{type:'object',properties:{scope:key,id:key,index:{type:'number',integer:true,minimum:0,maximum:1023}}},output:{type:'json',maxBytes:65536},purposes:['background','request','attempt']},
  put:{kind:'command',input:{type:'object',properties:{scope:key,id:key,index:{type:'number',integer:true,minimum:0,maximum:1023},total:{type:'number',integer:true,minimum:1,maximum:1024},data:{type:'string',maxLength:8192}}},output:{type:'null'},purposes:['background','request','attempt'],command:{deduplication:'none',resultRetentionMs:1,quotaBytes:1024,maxResultBytes:1024}},
}});
export interface HistoryClient {
  get(input:{scope:string;id:string},options?:{signal?:AbortSignal}):Promise<any>;
  put(input:{scope:string;id:string;value:any},options:{signal?:AbortSignal;operationId:string}):Promise<unknown>;
}
export function historyClient(rpc:any):HistoryClient {
  return {
    async get({scope,id},options){let text='';for(let index=0;index<1024;index++){
      options?.signal?.throwIfAborted();const part=await rpc.get({scope,id,index},options);if(part===null)return null;
      text+=part.data;if(Buffer.byteLength(text)>8*1024*1024)throw new Error('codex_router_history_limit');
      if(part.done)return JSON.parse(text);
    }throw new Error('codex_router_history_limit');},
    async put({scope,id,value},options){const text=JSON.stringify(value),total=Math.ceil(text.length/8192);
      if(total>1024||Buffer.byteLength(text)>8*1024*1024)throw new Error('codex_router_history_limit');
      for(let index=0;index<total;index++){options.signal?.throwIfAborted();await rpc.put({scope,id,index,total,data:text.slice(index*8192,(index+1)*8192)},{...options,operationId:`${options.operationId}-${index}`});}
    },
  };
}
