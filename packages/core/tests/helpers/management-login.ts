import type { ConfigurationAggregate } from '@jeffusion/bungee-types';
import type { ManagementProtection, RepositorySnapshot } from '../../src/config-storage';
import type { PluginControlHost } from '../../src/plugin-control';
import type { ManagementProvider } from '../../src/plugin-extensions';
import { createConfigControlApi } from '../../src/master-runtime/control-api';
import { ManagementAuthentication } from '../../src/master-runtime/management-auth';

/** Host-only fixture: no plugin business rules, storage, server, or active session. */
export function managementLoginFixture(publicOrigin = 'https://dashboard.example') {
  let guard: ManagementProtection = {required:true,selectedProvider:'test-auth',generation:1};
  let aggregate: ConfigurationAggregate = {
    logical_configuration:{services:[],routes:[],plugins:[]},plugin_activations:[{plugin_name:'test-auth'}],
  };
  const calls: {interaction:string;request:Request}[] = [];
  const provider: ManagementProvider = {
    setupStatus:async () => 'ready', initialize:async () => Response.json({initialized:true}),
    authenticate:async () => null, authorize:async () => false,
    login:async () => Response.json({success:false},{status:401}),
    logout:async () => Response.json({success:true}), bootstrap:async () => {},
    hasIdentity:async () => true, revokeSessions:async () => {},
    async loginOptions(request) {
      calls.push({interaction:'options',request});
      return Response.json({methods:[{id:'example',type:'redirect'}]});
    },
    async beginLogin(request) {
      calls.push({interaction:'start',request});
      return Response.json({received:await request.text()});
    },
    async completeLogin(request) {
      calls.push({interaction:'callback',request});
      if (new URL(request.url).pathname !== '/api/auth/login/callback/example') {
        return Response.json({error:'unknown_login_method'},{status:404});
      }
      const headers = new Headers({location:'/#/','cache-control':'public, max-age=3600'});
      headers.append('set-cookie','session=issued; Path=/; HttpOnly; SameSite=Lax');
      headers.append('set-cookie','flow=; Path=/api/auth/login; Max-Age=0; HttpOnly');
      return new Response(null,{status:303,headers});
    },
  };
  let activeProvider = provider, ready = true, repositoryReady = true;
  const host = {get:() => ready ? {status:'ready',admission:true,control:{management:activeProvider}} : undefined} as unknown as PluginControlHost;
  const auth = new ManagementAuthentication(host,() => aggregate,new Set(['test-auth','other-auth']),publicOrigin,() => guard);
  const api = createConfigControlApi({
    repository:{
      getSnapshot:() => {
        if (!repositoryReady) throw new Error('secret database location');
        return {aggregate,revision:1,content_hash:'sha256:'+'0'.repeat(64)} as RepositorySnapshot;
      },
      getActivePublication:async () => null,getOperationState:async () => null,
      commit:async () => {throw new Error('unexpected commit');},
    },
    admission:{snapshot:() => []},workerCount:1,clock:{now:Date.now},resolveAuthToken:() => null,
    parseAggregate:value => ({ok:true,value:value as ConfigurationAggregate}),publicationTasks:{enqueue() {}},
    isMutationReady:() => true,managementAuth:auth,
  });
  return {api,auth,provider,calls,
    invalidate:() => {guard = {...guard,generation:guard.generation+1};},
    replaceProvider:() => {activeProvider = {...provider};},
    setReady:(value:boolean) => {ready = value;},
    setRepositoryReady:(value:boolean) => {repositoryReady = value;},
    select:(name:string|null) => {
      guard = {required:name !== null,selectedProvider:name,generation:guard.generation+1};
      aggregate = {...aggregate,plugin_activations:name ? [{plugin_name:name}] : []};
    },
  };
}

export function loginInteractionRequest(path:string, method = 'GET', headers:HeadersInit = {}, body?:string) {
  return new Request('http://localhost'+path,{method,headers,...(body === undefined ? {} : {body})});
}
