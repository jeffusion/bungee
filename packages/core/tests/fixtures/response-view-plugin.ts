import { definePlugin, type PluginHooks } from '@jeffusion/bungee-core/plugin';
export default definePlugin(class {
  static readonly name='response-view-fixture';
  static readonly version='1.0.0';
  constructor(private readonly options:{key:string;mode:'all'|'first'|'second'|'read'|'filter';raw?:boolean}){}
  bodyRequirements(){return {request:'none' as const,response:[this.options.mode==='filter'?'sse-json' as const:'json' as const]};}
  register(hooks:PluginHooks){
    if(this.options.mode==='filter'){
      hooks.onStreamChunk.tap('filter',envelope=>(envelope.json as any)?.value===1?[]:[envelope]);return;
    }
    const check=async(response:Response,context:any,expected:number)=>{
      const body=await context.bodyHandle.json({id:'response-view-fixture'});
      (globalThis as any)[this.options.key].push({value:body.value,version:context.bodyHandle.identity.version,
        type:context.bodyHandle.identity.contentType,coding:context.bodyHandle.identity.contentEncoding,metadata:context.response===response});
      if(body.value!==expected)throw new Error(`stale response view: ${body.value} expected ${expected}`);
    };
    const tap=(mode:'first'|'second'|'read',stage:number)=>{
      const callback=async(response:Response,context:any)=>{
        await check(response,context,mode==='first'?1:mode==='second'?2:3);
        if(mode==='read')return response;
        const headers=new Headers(response.headers);headers.set('content-type',mode==='first'?'application/vendor+json':'application/json');
        return new Response(JSON.stringify({value:mode==='first'?2:3}),{status:response.status,headers});
      };
      if(this.options.raw)hooks.onRawResponse.tapPromise({name:`views-${mode}`,stage},async(result,context)=>({...result,response:await callback(result.response,context)}));
      else hooks.onResponse.tapPromise({name:`views-${mode}`,stage},callback);
    };
    if(this.options.mode==='all'){tap('first',0);tap('second',1);tap('read',2);}else tap(this.options.mode,0);
  }
});
