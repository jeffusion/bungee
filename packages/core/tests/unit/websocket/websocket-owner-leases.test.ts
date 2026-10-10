import { expect, test } from 'bun:test';
import { ScopedPluginRegistry } from '../../../src/scoped-plugin-registry';
import type { AppConfig } from '@jeffusion/bungee-types';
test('handshake retains route, service and upstream instances while global is overridden; observations use upstream',async()=>{
  const key=`ws-leases-${crypto.randomUUID()}`;
  let resume!:()=>void;
  const state={tags:[] as string[],gate:new Promise<void>(resolve=>{resume=resolve;})};
  (globalThis as any)[key]=state;
  const path=new URL('../../fixtures/websocket-lease-plugin.ts',import.meta.url).pathname;
  const plugin=(tag:string)=>({name:'websocket-lease-fixture',path,options:{key,tag}});
  const config:AppConfig={plugins:[plugin('global')],services:[{name:'svc',plugins:[plugin('service')],endpoints:[{id:'up',target:'http://localhost',plugins:[plugin('upstream')]}]}],
    routes:[{path:'/lease-test',service:'svc',plugins:[plugin('route')],websocket:{enabled:true}}]};
  const registry=new ScopedPluginRegistry(import.meta.dir);
  const releases:Array<()=>void>=[];
  try{
    expect((await registry.initializeFromConfig(config)).failed).toBe(0);
    const owners=registry.getWebSocketHandshakeOwners('/lease-test','up','svc');
    expect(owners.map(owner=>owner.scopeKey)).toEqual(['route:/lease-test','service:/lease-test:svc','upstream:/lease-test#up']);
    expect(registry.getWebSocketOwners('/lease-test','up','svc').map(owner=>owner.scopeKey)).toEqual(['upstream:/lease-test#up']);
    for(const owner of owners)releases.push(registry.serviceHost.acquireLease(owner.pluginName,owner.scopeKey));
    expect(registry.serviceHost.references('websocket-lease-fixture').filter(owner=>owner.scope!=='global').map(owner=>owner.leases)).toEqual([1,1,1]);
    const phases=registry.getPrecompiledHooks('/lease-test','up','svc');
    let context={connectionId:'conn',routeId:'/lease-test',upstreamId:'up',url:new URL('http://localhost/lease-test'),headers:new Headers(),signal:new AbortController().signal};
    const pending=(async()=>{for(const phase of [phases.routePhase,phases.servicePhase,phases.upstreamPhase])if(phase)context=await phase.hooks.onWebSocketHandshake.promise(context);})();
    await Promise.resolve();expect(state.tags).toEqual(['route']);
    registry.serviceHost.retireAll();
    let disposed=false;
    const disposing=registry.destroy().then(()=>{disposed=true;});
    await Bun.sleep(5);expect(disposed).toBe(false);
    resume();await pending;expect(state.tags).toEqual(['route','service','upstream']);
    for(const release of releases)release();await disposing;expect(disposed).toBe(true);
  }finally{resume();for(const release of releases)release();await registry.destroy();delete (globalThis as any)[key];}
});
