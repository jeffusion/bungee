import { definePlugin, type PluginHooks } from '@jeffusion/bungee-core/plugin';
export default definePlugin(class {
  static name='websocket-lease-fixture';static version='1.0.0';
  constructor(private options:{key:string;tag:string}){}
  bodyRequirements(){return {request:'none' as const};}
  register(hooks:PluginHooks){
    hooks.onWebSocketHandshake.tapPromise('lease',async context=>{
      const state=(globalThis as any)[this.options.key];
      state.tags.push(this.options.tag);
      if(this.options.tag==='route')await state.gate;
      return context;
    });
    hooks.onWebSocketObservation.tap('observe',()=>undefined);
  }
});
