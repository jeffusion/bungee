import {definePlugin,type Plugin,type PluginHooks,type PluginConfigField} from '@jeffusion/bungee-core/plugin';
export default definePlugin(class implements Plugin {
  static name='dispatch-fixture'; static version='1';
  static configSchema=[{name:'target',type:'gateway_target',label:'target'}] as PluginConfigField[];
  constructor(private options:any) {}
  bodyRequirements(){return {request:'json-write' as const};}
  register(hooks:PluginHooks){
    if(this.options.target) hooks.onDispatchRequest.tap('fixture.dispatch',({context})=>{context.body.model='actual';if(this.options.key)context.annotations={trace:{stages:['dispatch'],detail:{value:'baseline'}}};return {target:this.options.target};});
    hooks.onBeforeRequest.tap('fixture.marker',context=>{
      context.headers[`x-${this.options.mark}`]='yes';
      if(!this.options.key)return context;
      const state=(globalThis as any)[this.options.key];
      state.before.push({mark:this.options.mark,upstreamId:context.upstreamId,annotations:structuredClone(context.annotations)});
      const annotations={...context.annotations!};
      (annotations.trace as any).stages.push(`${this.options.mark}:before`);
      return {...context,annotations};
    });
    if(this.options.key){
      hooks.onInterceptRequest.tap('fixture.annotations',context=>{
        const trace=context.annotations!.trace as any;
        trace.stages.push(`${this.options.mark}:intercept`);
        if(this.options.mark==='upstream'){
          (globalThis as any)[this.options.key].attempts.push({upstreamId:context.upstreamId,value:trace.detail.value});
          context.annotations={...context.annotations,trace:{...trace,detail:{value:context.upstreamId}}};
        }
      });
      if(this.options.mark==='upstream')hooks.onValidateOutbound.tap('fixture.validation',context=>{
        const trace=context.annotations!.trace as any;
        const state=(globalThis as any)[this.options.key];
        state.validations.push(context);
        state.frozen.push([Object.isFrozen(context),Object.isFrozen(context.annotations),Object.isFrozen(trace),Object.isFrozen(trace.stages),Object.isFrozen(trace.detail)]);
        state.mutations.push(Reflect.set(trace.detail,'value','invalid'));
        return context;
      });
    }
  }
});
