import {CodexRouterPlugin} from '../../../../plugins/codex-router/server/index';
import {conversionService} from '../../../../plugins/llm-protocol-adapter/server/service';
export default class extends CodexRouterPlugin {
  constructor(private readonly fixtureOptions?:any){super(fixtureOptions);}
  async init(context:any){
    const catalog={status:()=>({version:1}),model:(input:any)=>this.fixtureOptions?.unavailable==='missing'?null:({provider:input.provider,model:input.model,name:input.model,catalogVersion:1,reasoningOptionsStatus:input.provider==='zai'?'known':'unknown',reasoningOptions:input.provider==='zai'?[{type:'effort',values:['low','high','max']}]:null,contextWindow:this.fixtureOptions?.unavailable==='context'?null:32000,outputLimit:4096,toolCall:true,reasoning:input.provider==='zai',inputModalities:this.fixtureOptions?.unavailable==='text'?['audio']:['text']})};
    await super.init({...context,services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(catalog as any,true):catalog,rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}});
  }
  register(hooks:any){
    super.register(hooks);
    if(this.fixtureOptions?.outboundMutation)hooks.onBeforeRequest.tap('fixture.outbound-mutation',(ctx:any)=>{
      const mutation=this.fixtureOptions.outboundMutation;
      if(mutation.model!==undefined)ctx.body.model=mutation.model;
      if(mutation.effort!==undefined)ctx.body.reasoning_effort=mutation.effort;
      if(mutation.path!==undefined)ctx.url.pathname=mutation.path;
      return ctx;
    });
  }
}
