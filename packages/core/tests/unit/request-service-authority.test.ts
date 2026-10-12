import {expect,test} from 'bun:test';
import {requestServiceDeclared, RequestRouteProtections} from '../../src/plugin-control/request-service-authority';
const manifest:any={name:'caller',dependencies:{provider:'^1.0.0'},services:{consumes:[{plugin:'provider',id:'public.v1',version:1,process:'worker',kind:'rpc'}]}};
test('projected request allows declared cross-plugin RPC without allowing arbitrary services',()=>{
 expect(requestServiceDeclared(manifest,{provider:'provider',service:'public.v1',major:1})).toBe(true);
 for(const target of [{provider:'other',service:'public.v1',major:1},{provider:'provider',service:'private.v1',major:1},{provider:'provider',service:'public.v1',major:2}])expect(requestServiceDeclared(manifest,target)).toBe(false);
 expect(requestServiceDeclared({...manifest,dependencies:{}},{provider:'provider',service:'public.v1',major:1})).toBe(false);
 expect(requestServiceDeclared({...manifest,services:{consumes:[{...manifest.services.consumes[0],process:'control'}]}},{provider:'provider',service:'public.v1',major:1})).toBe(false);
});

const anonymousTarget = {principal: {domain: 'anonymous', keyId: '', credentialVersion: 0}, routeId: 'public'};
test('anonymous request RPC requires confirmed public entry and associated route protections', () => {
 const protections = new RequestRouteProtections();
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
 protections.confirmPublication(protections.beginPublication(), [{routeIds: ['protected']}]);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(true);
 expect(protections.allowsAnonymous({...anonymousTarget, routeId: 'protected'})).toBe(false);
 expect(protections.allowsAnonymous({...anonymousTarget, entryRouteId: 'protected'})).toBe(false);
 for (const principal of [
  {domain: 'anonymous', keyId: 'forged', credentialVersion: 0},
  {domain: 'anonymous', keyId: '', credentialVersion: 1},
  {domain: 'data', keyId: 'key', credentialVersion: 1},
 ]) expect(protections.allowsAnonymous({...anonymousTarget, principal})).toBe(false);
});

test('pending, failed and superseded publications cannot retain anonymous RPC authority', () => {
 const protections = new RequestRouteProtections();
 protections.confirmPublication(protections.beginPublication(), []);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(true);
 const first = protections.beginPublication();
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
 const queued = protections.beginPublication();
 protections.confirmPublication(first, []);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
 // The latest publication fails without a confirmed ACK. An older ACK cannot restore it.
 protections.confirmPublication(first, []);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
 protections.confirmPublication(queued, [{routeIds: ['public']}]);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
 const recovery = protections.beginPublication();
 protections.confirmPublication(recovery, []);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(true);
 const beforeBootChange = protections.beginPublication();
 protections.beginPublication();
 protections.confirmPublication(beforeBootChange, []);
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
});

test('confirmed protections are detached from the mutable protection registry', () => {
 const protections = new RequestRouteProtections();
 const requirements = [{routeIds: ['public']}];
 protections.confirmPublication(protections.beginPublication(), requirements);
 requirements[0]!.routeIds.length = 0;
 expect(protections.allowsAnonymous(anonymousTarget)).toBe(false);
});
