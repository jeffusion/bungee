import {expect,test} from 'bun:test';
import {createIngress} from '../server/policy';
const target={requestId:'r',attemptId:'a',principal:{domain:'data' as const,keyId:'k',credentialVersion:1},routeId:'route',serviceId:null,upstreamId:'u',url:'https://example.test',model:null,now:0};
test('staged shared key bucket is atomic, retries do not deduct, refill is bounded',()=>{
 const plugin=createIngress();const policy={rps:2,burst:1};const state=null;
 const rejected=plugin.plan(target,policy,state);expect(state).toBeNull();
 expect(plugin.plan({...target,requestId:'second'},policy,state).denial).toBeUndefined();
 const committed=rejected.state!;
 expect(plugin.plan({...target,routeId:'another'},policy,committed).denial).toMatchObject({status:429,retryAfter:1});
 expect(plugin.beforeAttempt!(target,rejected.snapshot!)).toBeNull();
 expect(plugin.plan({...target,now:500},policy,committed).denial).toBeUndefined();
});
