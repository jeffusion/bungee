import { definePlugin,RequestRetryAction,type PluginHooks } from '@jeffusion/bungee-core/plugin';
export default definePlugin(class {
  static readonly name='repair-attempt-fixture';
  static readonly version='1.0.0';
  constructor(private readonly options:{key:string;mode:'convert'|'admission'}){}
  private get state():any {return (globalThis as any)[this.options.key];}
  bodyRequirements(){return this.options.mode==='admission'?{request:'none' as const}:{request:'json-write' as const,response:['json' as const],replay:true,observe:{request:true,response:true}};}
  async prepareAdmissionAttempt(input:any){this.state.admissions.push({attemptId:input.target.attemptId,upstreamId:input.target.upstreamId,body:input.body});
    return {onResult:async(result:any)=>{this.state.admissionResults.push(result);}};}
  register(hooks:PluginHooks){
    if(this.options.mode==='admission')return;
    hooks.onBeforeRequest.tap('convert',context=>{
      this.state.conversions++;context.body={...context.body,conversions:this.state.conversions};context.url.pathname='/converted';
      this.state.finalBody=structuredClone(context.body);return context;
    });
    hooks.onAttemptObservation.tapPromise('observe',async event=>{this.state.events.push(event);});
    hooks.onResponse.tapPromise('repair',async(response,context)=>{
      if(response.ok)return response;
      const body=await context.bodyHandle!.json({id:'repair-fixture'});
      if((body as any).error?.code==='signature'){
        this.state.repairs++;throw new RequestRetryAction({...this.state.finalBody,repaired:true},'signature-repair');
      }
      return response;
    });
  }
});
