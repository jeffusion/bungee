import {definePlugin,type PluginHooks} from '@jeffusion/bungee-core/plugin';
export default definePlugin(class {
  static readonly name='service-frame-fixture';
  static readonly version='1.0.0';
  private active=new Set<string>();
  constructor(private options:{key:string;label:string;write?:boolean;reject?:boolean;model?:string;respond?:boolean;handshakeError?:'admission'|'plugin'}){}
  bodyRequirements(){return {request:this.options.write||this.options.model?'json-write' as const:'none' as const,response:['json' as const,'sse-json' as const]};}
  register(hooks:PluginHooks){
    const record=(event:string)=>((globalThis as any)[this.options.key] as string[]).push(`${this.options.label}:${event}`);
    record('register');
    hooks.onBeforeRequest.tap('frame.before',context=>{
      if(this.active.has(context.requestId))throw Error('frame reentered before finally');
      this.active.add(context.requestId);record('request');
      context.headers['x-frame-chain']=[context.headers['x-frame-chain'],this.options.label].filter(Boolean).join(',');
      if(this.options.write){context.body={...context.body,[this.options.label]:true};context.annotations={...context.annotations,[this.options.label]:true};}
      if(this.options.model){context.body={...context.body,model:this.options.model};context.url.pathname='/service-local';}
      if(this.options.reject)throw Error('controlled service rejection');
      return context;
    });
    if(this.options.respond)hooks.onInterceptRequest.tap('frame.respond',context=>({action:'respond',response:Response.json({model:context.body?.model})}));
    hooks.onWebSocketHandshake.tap('frame.handshake',context=>{
      if(this.active.has(context.connectionId))throw Error('frame reentered before finally');
      this.active.add(context.connectionId);record('handshake');
      if(this.options.handshakeError){
        const error=new Error('controlled handshake rejection');
        if(this.options.handshakeError==='admission')Object.assign(error,{name:'DataAdmissionError',status:403,code:'fixture.scope_denied'});
        throw error;
      }
      context.headers.set('x-frame-chain',[context.headers.get('x-frame-chain'),this.options.label].filter(Boolean).join(','));return context;
    });
    hooks.onResponse.tap('frame.response',response=>{record('response');return response;});
    hooks.onStreamChunk.tap('frame.chunk',chunk=>{record('chunk');return [chunk];});
    hooks.onError.tap('frame.error',()=>{record('error');});
    hooks.onFinally.tap('frame.finally',context=>{this.active.delete(context.requestId);record('finally');});
  }
});
