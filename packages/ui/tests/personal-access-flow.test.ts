import {afterEach,expect,test} from 'bun:test';
import {ApiError} from '../src/api/client';
import {createdCredential,publicationMessage} from '../../../plugins/key-access/ui/key-flow';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const source = await Bun.file(new URL('../../../plugins/key-access/ui/KeyPolicy.svelte',import.meta.url)).text();
const handler = source.match(/  async function create\([\s\S]*?\n  }/)![0];
function creationHarness(create:()=>Promise<unknown>, savePolicy:()=>Promise<void>) {
  return new Function('keysApi','savePolicy','createdCredential',new Bun.Transpiler({loader:'ts'}).transformSync(`
    let ready=true,busy=false,error='',secretStatus='',allRoutes=false,allowed=['public'],expires='',name='test',secret='',copied=false,secretOpen=false,createOpen=true,keys=[],status='';
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

test('creating a Key for a public route saves immediately without a protection confirmation',async()=>{
  let writes=0;
  const view=creationHarness(async()=>({key:{id:'k'},token:'token',ready:true,published:true}),async()=>{writes++});
  await view.create({preventDefault(){}});
  expect(writes).toBe(1);expect(view.secretOpen).toBe(true);expect(view.notice.key).toBe('ui.createdPublic');
});

test.each([false,true])('saving Key permissions preserves public access (edit=%s)',async(includeDetails)=>{
  const save=source.match(/  async function savePolicy\([\s\S]*?\n  }/)![0];
  const writes:{path:string;method:string;body?:unknown}[]=[];
  const control=async(path:string,method:string,body?:unknown)=>{
    writes.push({path,method,body});
    return method==='GET' ? {protectedRouteIds:[],routeKeyBindings:{public:[{id:'k',name:'test'}]}} : {ready:true,published:true};
  };
  const keysApi={update:async(id:string,body:unknown)=>{writes.push({path:'/credentials/'+id,method:'PUT',body});return {key:{id},ready:true,published:true};}};
  const run=new Function('control','keysApi','modelPatterns',new Bun.Transpiler({loader:'ts'}).transformSync(`
    let routes=[{id:'public'}],allRoutes=false,allowed=['public'],models='',name='test',keys=[{id:'k'}],target=null,protectedIds=[],routeKeyBindings={},unrestrictedKeyIds=[];
    const expiration=()=>null;
    ${save}
    return {savePolicy,get protectedIds(){return protectedIds}};
  `))(control,keysApi,()=>null);
  await run.savePolicy('k',includeDetails);
  expect(writes).toEqual([{path:includeDetails?'/credentials/k':'/keys/k',method:'PUT',body:{...(includeDetails?{name:'test',expiresAt:null}:{}),routes:['public'],models:null}},{path:'/routes',method:'GET',body:undefined}]);
  expect(run.protectedIds).toEqual([]);
});

test('quick Key binding and public switch perform independent writes even when the route has Key grants',async()=>{
  const apply=source.match(/  async function applyRouteKey\([\s\S]*?\n  }/)![0];
  const protect=source.match(/  async function protect\([\s\S]*?\n  }/)![0];
  const writes:unknown[]=[];
  const control=async(path:string,method:string,body:unknown)=>{
    writes.push({path,method,body});return {protectedRouteIds:[],routeKeyBindings:{public:[{id:'k',name:'test'}]},ready:true,published:true};
  };
  const run=new Function('control','publicationMessage',new Bun.Transpiler({loader:'ts'}).transformSync(`
    let busy=false,error=null,status=null,ready=true,selectedRoute={id:'public'},protectedIds=[],routeKeyBindings={public:[{id:'k',name:'test'}]},unrestrictedKeyIds=[],routeConfigOpen=true;
    const message=key=>({key});
    const failure=e=>{throw e};
    ${apply}
    ${protect}
    return {applyRouteKey,protect};
  `))(control,publicationMessage);
  await run.applyRouteKey({id:'k'});
  await run.protect('public',false);
  expect(writes).toEqual([{path:'/route-key',method:'PUT',body:{routeId:'public',keyId:'k'}},{path:'/routes',method:'PUT',body:{protectedRouteIds:[]}}]);
});


test('unrestricted Key grants display as applied even for a public route without explicit bindings',()=>{
  const helper=source.match(/  const isKeyApplied = .*;/)![0];
  const applied=new Function(new Bun.Transpiler({loader:'ts'}).transformSync(`
    let unrestrictedKeyIds=['any'],routeKeyBindings={public:[{id:'explicit'}]};
    ${helper}
    return isKeyApplied;
  `))();
  expect(applied('unlisted-public','any')).toBe(true);
  expect(applied('public','explicit')).toBe(true);
  expect(applied('unlisted-public','explicit')).toBe(false);
});
