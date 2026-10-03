import {afterEach,expect,test} from 'bun:test';
import {ApiError} from '../src/api/client';
import {createdCredential,publicationMessage} from '../../../plugins/key-access/ui/key-flow';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const source = await Bun.file(new URL('../../../plugins/key-access/ui/KeyPolicy.svelte',import.meta.url)).text();
const handler = source.match(/  async function create\([\s\S]*?\n  }/)![0];
function creationHarness(create:()=>Promise<unknown>, savePolicy:()=>Promise<void>) {
  return new Function('keysApi','savePolicy','createdCredential',new Bun.Transpiler({loader:'ts'}).transformSync(`
    let ready=true,busy=false,error='',secretStatus='',allRoutes=true,allowed=[],expires='',name='test',secret='',copied=false,secretOpen=false,createOpen=true,keys=[],protectSelected=false,status='',selectedPublic=[];
    const message=(key,values)=>({key,values});
    function failure(e) {error=e.message;}
    ${handler}
    return {create,get secret(){return secret},get secretOpen(){return secretOpen},get notice(){return secretStatus},get busy(){return busy}};
  `))({create},savePolicy,createdCredential);
}
test('creation followed by policy failure still exposes one-time token and recovery steps',async()=>{
  const view=creationHarness(async()=>({key:{id:'k'},token:'one-time-token',ready:true,published:true}),async()=>{throw new Error('policy_unavailable')});
  await view.create({preventDefault(){}});
  expect(view.secret).toBe('one-time-token');expect(view.secretOpen).toBe(true);expect(view.busy).toBe(false);
  expect(view.notice).toEqual({key:'ui.createdIncomplete',values:{stage:{key:'ui.stageSavePolicy',values:undefined},reason:'policy_unavailable'}});
});
test('persisted creation with publication failure exposes token once and never runs remaining writes',async()=>{
  let writes=0;
  const view=creationHarness(async()=>{throw new ApiError(503,{key:{id:'k'},token:'saved-token',persisted:true,ready:false,published:false},'publication_pending')},async()=>{writes++});
  await view.create({preventDefault(){}});
  expect(view.secret).toBe('saved-token');expect(view.secretOpen).toBe(true);expect(writes).toBe(0);expect(view.notice.key).toBe('ui.createdPending');
});
test('pending publication cannot be presented as published and unrelated failures never manufacture a token',()=>{
  expect(publicationMessage({ready:false,published:false})).toBe('ui.publicationPending');
  expect(createdCredential(new ApiError(503,{error:'unavailable'},'unavailable'))).toBeNull();
});
