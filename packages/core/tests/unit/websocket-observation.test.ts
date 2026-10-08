import { expect, test } from 'bun:test';
import { createPluginHooks } from '../../src/hooks';
import { WebSocketObservers } from '../../src/websocket/observation';
import { createWebSocketMessageView } from '../../src/websocket';
import type { WebSocketObservationEvent } from '../../src/gateway/websocket-contracts';
const context={connectionId:'conn',routeId:'/v1/responses',upstreamId:'up',upstreamUrl:'ws://localhost/v1/responses'};
const close={phase:'close' as const,code:1000,reason:'',metrics:{durationMs:1,clientMessages:1,upstreamMessages:0,clientBytes:2,upstreamBytes:0}};
test('slow observer expires independently and close survives timeout with queued terminal',async()=>{
  const slow=createPluginHooks(),fast=createPluginHooks();
  const slowEvents:WebSocketObservationEvent[]=[];const fastEvents:WebSocketObservationEvent[]=[];
  slow.onWebSocketObservation.tapPromise('slow',async event=>{slowEvents.push(event);if(event.phase==='message')await new Promise(()=>{});});
  fast.onWebSocketObservation.tap('fast',event=>{fastEvents.push(event);});
  const observers=new WebSocketObservers(context,[{pluginName:'slow',hooks:slow.onWebSocketObservation},{pluginName:'fast',hooks:fast.onWebSocketObservation}]);
  observers.emit({phase:'open'});observers.emit({phase:'message',direction:'client',message:createWebSocketMessageView('{}')});
  await observers.close(close);
  expect(fastEvents.map(e=>e.phase)).toEqual(['open','message','close']);
  expect(slowEvents.map(e=>e.phase)).toEqual(['open','message','incomplete','close']);
  expect(slowEvents[1]!.isActive()).toBe(false);
});
test('bounded observer overflow emits incomplete once and preserves cleanup',async()=>{
  const hooks=createPluginHooks();const phases:string[]=[];
  hooks.onWebSocketObservation.tap('observe',event=>{phases.push(event.phase);});
  const observers=new WebSocketObservers(context,[{pluginName:'observe',hooks:hooks.onWebSocketObservation}]);
  observers.emit({phase:'open'});
  const message=createWebSocketMessageView('x'.repeat(2*1024*1024));
  for(let i=0;i<10;i++)observers.emit({phase:'message',direction:'upstream',message});
  await observers.close(close);
  expect(phases).toEqual(['open','incomplete','close']);
});
