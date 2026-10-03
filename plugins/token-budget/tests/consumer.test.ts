import {expect,test} from 'bun:test';
import {createBudgetConsumer} from '../server/index';
import type {TokenMeteringSubscription} from '../../../packages/core/src/plugin-services';
const target={requestId:'r',attemptId:'a',principal:{domain:'data' as const,keyId:'k',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:'m',now:0};
const snapshot={keyId:'k',requestId:'r',month:'2026-01',policy:{mode:'monthly' as const,limit:100},version:1};
test('budget consumer prepares durable before send, settles provider results and excludes no policy',async()=>{
 let subscription:TokenMeteringSubscription|undefined;let subscriptions=0;const calls:any[]=[];
 const consumer=createBudgetConsumer({async drainRequest(){},subscribe(s){subscription=s;subscriptions++;return ()=>{};},prepareRequest(){return true;},prepareAttempt(){return {supported:true};}});
 expect(await consumer.prepareAdmissionAttempt({target,snapshot:null,body:{},stateRpc:async()=>{throw new Error('unused')}})).toEqual({});expect(subscriptions).toBe(0);
 const handler=await consumer.prepareAdmissionAttempt({target,snapshot,body:{model:'m'},stateRpc:async(method,payload)=>{calls.push({method,payload});}});
 expect(calls[0].method).toBe('prepare');expect(subscription?.required).toBe(true);
 const result:any={requestId:'r',attemptId:'a',inputTokens:1,outputTokens:2};await subscription!.onResult(result);expect(calls[1]).toEqual({method:'settle',payload:{result,costNanoUsd:null}});
 await handler.onResult!({sent:true,outcome:'completed'});expect(calls.length).toBe(2);
});
test('unmeterable budget rejects before durable prepare, unsent attempt explicitly cancels',async()=>{
 const calls:string[]=[];let supported=false;
 const consumer=createBudgetConsumer({async drainRequest(){},subscribe(){return ()=>{};},prepareRequest(){return true;},prepareAttempt(){return {supported};}});
 const input={target,snapshot,body:{},stateRpc:async(method:string)=>{calls.push(method);}};
 expect((await consumer.prepareAdmissionAttempt(input)).denial?.status).toBe(422);expect(calls).toEqual([]);
 supported=true;const prepared=await consumer.prepareAdmissionAttempt(input);await prepared.onResult!({sent:false,outcome:'cancelled'});expect(calls).toEqual(['prepare','cancel']);
});
test('sent completion waits for required metering drain and missing result becomes unknown',async()=>{
 const calls:string[]=[];let release!:()=>void;const draining=new Promise<void>(resolve=>{release=resolve;});
 const consumer=createBudgetConsumer({subscribe(){return ()=>{};},prepareRequest(){return true;},prepareAttempt(){return {supported:true};},async drainRequest(requestId){expect(requestId).toBe('r');calls.push('drain');await draining;}});
 const prepared=await consumer.prepareAdmissionAttempt({target,snapshot,body:{},stateRpc:async(method,payload:any)=>{calls.push(method);if(method==='settle')expect(payload.result).toMatchObject({inputSource:'none',outputSource:'none',observationIncomplete:true});}});
 let finished=false;const completion=prepared.onResult!({sent:true,outcome:'completed'}).then(()=>{finished=true;});
 await Promise.resolve();expect(finished).toBe(false);expect(calls).toEqual(['prepare','drain']);
 release();await completion;expect(calls).toEqual(['prepare','drain','settle']);expect(finished).toBe(true);
});
test('USD verifies actual prepared model/provider before durable prepare and sends exact price while Token tolerates unavailable price',async()=>{
 const calls:any[]=[];let subscription:TokenMeteringSubscription|undefined,canPrice=false;
 const metering={async drainRequest(){calls.push('drain');},subscribe(s:TokenMeteringSubscription){subscription=s;return ()=>{};},prepareRequest(){return true;},prepareAttempt(){return {supported:true,model:'actual-model',pricingProvider:'actual-provider',provider:'wire-provider'};}};
 const pricing={async canPrice(input:any){calls.push(input);return canPrice;},async price(){return {costUsd:0.123456789,costNanoUsd:123456789};}};
 const consumer=createBudgetConsumer(metering,pricing),usdSnapshot={...snapshot,policy:{mode:'monthly' as const,unit:'usd' as const,limit:1}};
 const input={target,snapshot:usdSnapshot,body:{model:'wrong-client-model'},stateRpc:async(method:string,payload:any)=>{calls.push({method,payload});}};
 expect((await consumer.prepareAdmissionAttempt(input)).denial?.status).toBe(422);expect(calls).toEqual([{model:'actual-model',pricingProvider:'actual-provider'}]);
 canPrice=true;await consumer.prepareAdmissionAttempt(input);const result:any={requestId:'r',attemptId:'a'};await subscription!.onResult(result);expect(calls.at(-1)).toEqual({method:'settle',payload:{result,costNanoUsd:123456789}});
 const failed=createBudgetConsumer(metering,{async canPrice(){throw new Error('not ready')},async price(){throw new Error('gone')}});
 expect((await failed.prepareAdmissionAttempt(input)).denial?.status).toBe(503);
 await failed.prepareAdmissionAttempt({...input,snapshot});await subscription!.onResult(result);expect(calls.at(-1)).toEqual({method:'settle',payload:{result,costNanoUsd:null}});
});
test('required pricing and durable settlement finish while service leases are retained, before disposal',async()=>{
 const {PluginServiceHost}=await import('../../../packages/core/src/plugin-services');
 const host=new PluginServiceHost(),meteringContext=host.createContext('token-metering'),pricingContext=host.createContext('token-stats');
 let subscription:TokenMeteringSubscription|undefined,releasePrice!:()=>void,settlement:Promise<void>|undefined;
 const priceReady=new Promise<void>(resolve=>{releasePrice=resolve;});
 meteringContext.publish('metering',1,{prepareRequest(){return true;},prepareAttempt(){return {supported:true,model:'m'};},subscribe(s:TokenMeteringSubscription){subscription=s;return ()=>{};},async drainRequest(){await settlement;}});
 pricingContext.publish('pricing',1,{async canPrice(){return true;},async price(){await priceReady;return {costNanoUsd:1000,costUsd:0.000001};}});
 host.markReady('token-metering');host.markReady('token-stats');
 const context=host.createContext('budget','global',{'token-metering':'*','token-stats':'*'});host.markReady('budget');const release=host.acquireLease('budget');
 const consumer=createBudgetConsumer(context.consume('token-metering','metering',1),context.consume('token-stats','pricing',1));
 let settled=false,disposed=false;
 const prepared=await consumer.prepareAdmissionAttempt({target,snapshot,body:{},stateRpc:async(method)=>{if(method==='settle')settled=true;}});
 settlement=Promise.resolve(subscription!.onResult({requestId:'r',attemptId:'a'} as any));
 const disposal=host.dispose('budget').then(()=>{disposed=true;});const completion=prepared.onResult!({sent:true,outcome:'completed'});
 await Promise.resolve();expect(disposed).toBe(false);expect(settled).toBe(false);releasePrice();await completion;expect(settled).toBe(true);expect(disposed).toBe(false);
 release();await disposal;expect(disposed).toBe(true);await host.dispose('token-metering');await host.dispose('token-stats');
});
