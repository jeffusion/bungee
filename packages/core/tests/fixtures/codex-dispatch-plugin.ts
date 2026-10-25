import { MODEL_IDENTITY_ANNOTATION_KEY } from '../../../../plugins/models-dev/contract';
import {CodexRouterPlugin} from '../../../../plugins/codex-router/server/index';
import {conversionService} from '../../../../plugins/llm-protocol-adapter/server/service';
export default class extends CodexRouterPlugin {
  constructor(private readonly fixtureOptions?:any){super(fixtureOptions);}
  async init(context:any){
    const knownModels=new Set(['glm-5.3','glm-5.3-flash','GLM-5.3','GLM-5.3-Flash']);
    const catalog={status:()=>({version:1}),model:(input:any)=>this.fixtureOptions?.unavailable==='missing' || input.provider==='missing' || input.provider==='zai'&&!knownModels.has(input.model)?null:({provider:input.provider,model:input.model,name:input.model,catalogVersion:1,reasoningOptionsStatus:input.provider==='zai'?'known':'missing',reasoningOptions:input.provider==='zai'?[{type:'effort',values:['low','high','max']}]:null,contextWindow:this.fixtureOptions?.unavailable==='context'?null:32000,outputLimit:4096,toolCall:true,reasoning:input.provider==='zai',inputModalities:this.fixtureOptions?.unavailable==='text'?['audio']:['text']})};
    await super.init({...context,services:{consume:(provider:string)=>provider==='llm-protocol-adapter'?conversionService(catalog as any,true):catalog,rpc:{consume:()=>({get:async()=>null,put:async()=>null})}}});
  }
  register(hooks:any){
    super.register(hooks);
    if(this.fixtureOptions?.outboundMutation)hooks.onBeforeRequest.tap('fixture.outbound-mutation',(ctx:any)=>{
      const mutation=this.fixtureOptions.outboundMutation;
      if('identity' in mutation)ctx.annotations={...ctx.annotations,[MODEL_IDENTITY_ANNOTATION_KEY]:mutation.identity};
      if(mutation.model!==undefined)ctx.body.model=mutation.model;
      if(mutation.effort!==undefined)ctx.body.reasoning_effort=mutation.effort;
      if(mutation.path!==undefined)ctx.url.pathname=mutation.path;
      return ctx;
    });
  }
}
