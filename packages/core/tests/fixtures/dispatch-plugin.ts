import {definePlugin,type Plugin,type PluginHooks,type PluginConfigField} from '@jeffusion/bungee-core/plugin';
export default definePlugin(class implements Plugin {
  static name='dispatch-fixture'; static version='1';
  static configSchema=[{name:'target',type:'gateway_target',label:'target'}] as PluginConfigField[];
  constructor(private options:any) {}
  bodyRequirements(){return {request:'json-write' as const};}
  register(hooks:PluginHooks){
    if(this.options.target) hooks.onDispatchRequest.tap('fixture.dispatch',({context})=>{context.body.model='actual';return {target:this.options.target};});
    hooks.onBeforeRequest.tap('fixture.marker',context=>{context.headers[`x-${this.options.mark}`]='yes';return context;});
  }
});
