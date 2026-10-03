import { randomUUID } from 'node:crypto';
import type { ControlHostContext, PluginControl } from '../../../packages/core/src/plugin-control/contracts';
import { validatePolicy } from './policy';
import { publication, readKey, readUsage, setPolicy, stateRpc, recoverPending, recoverUsage } from './ledger';

export interface PolicyControlHost extends ControlHostContext {
  validateKeyPolicyReferences?: (keyId:string,policy:unknown)=>boolean|Promise<boolean>;
}
function json(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
export function createControl(host:PolicyControlHost):PluginControl {
  if(!host.durableState) throw new Error('token-budget.durable_state_required');
  const state=host.durableState;let ready=false;
  const policy=()=>{return publication(state);};
  return {policy,rpc:[],stateRpc: async(method,payload,ctx)=>{const before=policy().version;const result=stateRpc(method,payload,ctx);const next=policy();if(next.version!==before || method==='settle')await host.publishPolicy?.(next);return result},
    api:[{path:'/keys/:keyId',methods:['GET','PUT'],handler:'keyPolicy',async invoke(ctx){
      const keyId=decodeURIComponent(new URL(ctx.request.url).pathname.split('/').pop()??'');
      if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId))return json({error:'invalid_key_id'},400);
      if(ctx.request.method==='GET')return json({keyId,version:policy().version,value:readKey(state,keyId),usage:readUsage(state,keyId),active:ready});
      if(!ready || host.signal.aborted)return json({error:'token-budget.inactive'},503);
      if(!ctx.subject)return json({error:'management_subject_required'},403);
      try {
        if(!host.validateKeyPolicyReferences)return json({error:'reference_validator_unavailable'},503);
        const value=validatePolicy(await ctx.request.json());
        if(!await host.validateKeyPolicyReferences(keyId,value))return json({error:'invalid_references'},422);
        setPolicy(state,keyId,value);
        const next=policy();await host.publishPolicy?.(next);return json({keyId,version:next.version,value:readKey(state,keyId)});
      }catch{return json({error:'token-budget.policy_write_failed'},422);}
    }}],
    async start(){if(host.signal.aborted)throw new Error('inactive');recoverPending(state);await host.publishPolicy?.(policy());ready=true;},
    dispose(){ready=false;},
  };
}
export function readResource(resource:string,keyId:string,state:Pick<NonNullable<ControlHostContext['durableState']>,'get'|'list'>) {
  if(resource!=='api-key')throw new Error('resource_not_supported');
  const ledger=readKey(state,keyId);
  return {value:ledger.policy,usage:readUsage(state,keyId)};
}
export { recoverUsage } from './ledger';
export default {createControl,readResource,offlineRecovery:{kind:'plugin-state' as const,recover:recoverUsage}};
