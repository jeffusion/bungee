import {expect,test} from 'bun:test';
import {requestServiceDeclared} from '../../src/plugin-control/request-service-authority';
const manifest:any={name:'caller',dependencies:{provider:'^1.0.0'},services:{consumes:[{plugin:'provider',id:'public.v1',version:1,process:'worker',kind:'rpc'}]}};
test('projected request allows declared cross-plugin RPC without allowing arbitrary services',()=>{
 expect(requestServiceDeclared(manifest,{provider:'provider',service:'public.v1',major:1})).toBe(true);
 for(const target of [{provider:'other',service:'public.v1',major:1},{provider:'provider',service:'private.v1',major:1},{provider:'provider',service:'public.v1',major:2}])expect(requestServiceDeclared(manifest,target)).toBe(false);
 expect(requestServiceDeclared({...manifest,dependencies:{}},{provider:'provider',service:'public.v1',major:1})).toBe(false);
 expect(requestServiceDeclared({...manifest,services:{consumes:[{...manifest.services.consumes[0],process:'control'}]}},{provider:'provider',service:'public.v1',major:1})).toBe(false);
});
