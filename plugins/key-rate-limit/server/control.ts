import { randomUUID } from 'node:crypto';
import type { ControlHostContext, PluginControl } from '../../../packages/core/src/plugin-control/contracts';
import { validatePolicy } from './policy';

export interface PolicyControlHost extends ControlHostContext {
  validateKeyPolicyReferences?: (keyId:string,policy:unknown)=>boolean|Promise<boolean>;
}
function json(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
export function createControl(host:PolicyControlHost):PluginControl {
  if(!host.durableState) throw new Error('key-rate-limit.durable_state_required');
  const state=host.durableState;let ready=false;
  const policy=()=>{const r=state.get('policies');return {version:r?.version??0,value:r?.value??{byKey:{}}};};
  return {policy,rpc:[],
    api:[{path:'/keys/:keyId',methods:['GET','PUT'],handler:'keyPolicy',async invoke(ctx){
      const keyId=decodeURIComponent(new URL(ctx.request.url).pathname.split('/').pop()??'');
      if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId))return json({error:'invalid_key_id'},400);
      if(ctx.request.method==='GET')return json({keyId,version:policy().version,value:(policy().value as any).byKey[keyId]??null,active:ready});
      if(!ready || host.signal.aborted)return json({error:'key-rate-limit.inactive'},503);
      if(!ctx.subject)return json({error:'management_subject_required'},403);
      try {
        if(!host.validateKeyPolicyReferences)return json({error:'reference_validator_unavailable'},503);
        const value=validatePolicy(await ctx.request.json());
        if(!await host.validateKeyPolicyReferences(keyId,value))return json({error:'invalid_references'},422);
        const old=state.get('policies');const byKey={...((old?.value as any)?.byKey??{}),[keyId]:value};state.execute({commandId:randomUUID(),mutations:[{key:'policies',expectedVersion:old?.version??0,value:{byKey}}]});
        const next=policy();await host.publishPolicy?.(next);return json({keyId,version:next.version,value:(policy().value as any).byKey[keyId]??null});
      }catch{return json({error:'key-rate-limit.policy_write_failed'},422);}
    }}],
    async start(){if(host.signal.aborted)throw new Error('inactive');await host.publishPolicy?.(policy());ready=true;},
    dispose(){ready=false;},
  };
}
export function readResource(resource:string,keyId:string,state:Pick<NonNullable<ControlHostContext['durableState']>,'get'|'list'>) {
  if(resource!=='api-key')throw new Error('resource_not_supported');
  return {value:(state.get('policies')?.value as any)?.byKey?.[keyId]??null};
}
export default {createControl,readResource};
