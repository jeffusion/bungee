import { businessRpc } from './rpc';
import type { ControlHostContext, PluginControl } from '@jeffusion/bungee-core/plugin';
import { validatePolicy } from './policy';
import { publication, readKey, readUsage, setPolicy, stateRpc, recoverPending, recoverUsage } from './ledger';

export interface PolicyControlHost extends ControlHostContext {
  validateKeyPolicyReferences?: (keyId:string,policy:unknown)=>boolean|Promise<boolean>;
}
function json(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
export function createControl(host:PolicyControlHost):PluginControl {
  if(!host.durableState) throw new Error('token-budget.durable_state_required');
  const state=host.durableState;let ready=false;
  let cached={version:0,value:{version:0,byKey:{}} as import('@jeffusion/bungee-core/plugin').DurableJson};
  const policy=()=>cached;
  const refresh=async()=>{cached=await publication(state);};
  let writes:Promise<unknown>=Promise.resolve();
  const serialize=<T>(operation:()=>Promise<T>):Promise<T>=>{const next=writes.catch(()=>undefined).then(operation);writes=next;return next;};
  if (host.services?.rpc) {
    const handlers = Object.fromEntries(Object.keys(businessRpc.methods).map(method => [method, (payload: unknown, context: any) => {
      if (!host.runAdmissionOperation) throw new Error('token-budget.host_admission_required');
      return host.runAdmissionOperation(method, payload, host.resolveRpcCallee?.(context.callee), async target => serialize(async () => {
        const before = policy().version;
        const result = await stateRpc(method, payload, {state, requestId: target.requestId, attemptId: target.attemptId, principal: target.principal});
        await refresh();
        const next = policy();
        if (next.version !== before || method === 'settle') await host.publishPolicy?.(next);
        return result;
      }));
    }]));
    host.services.rpc.publish(businessRpc, handlers as any);
  }
  return {policy,rpc:[],
    api:[{path:'/keys/:keyId',methods:['GET','PUT'],handler:'keyPolicy',async invoke(ctx){
      const keyId=decodeURIComponent(new URL(ctx.request.url).pathname.split('/').pop()??'');
      if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId))return json({error:'invalid_key_id'},400);
      if(ctx.request.method==='GET')return json({keyId,version:policy().version,value:await readKey(state,keyId),usage:await readUsage(state,keyId),active:ready});
      if(!ready || host.signal.aborted)return json({error:'token-budget.inactive'},503);
      if(!ctx.subject)return json({error:'management_subject_required'},403);
      try {
        if(!host.validateKeyPolicyReferences)return json({error:'reference_validator_unavailable'},503);
        const value=validatePolicy(await ctx.request.json());
        if(!await host.validateKeyPolicyReferences(keyId,value))return json({error:'invalid_references'},422);
        return serialize(async()=>{
          await setPolicy(state,keyId,value);await refresh();
          const next=policy();await host.publishPolicy?.(next);return json({keyId,version:next.version,value:await readKey(state,keyId)});
        });
      }catch{return json({error:'token-budget.policy_write_failed'},422);}
    }}],
    async start(){if(host.signal.aborted)throw new Error('inactive');await recoverPending(state);await refresh();await host.publishPolicy?.(policy());ready=true;},
    dispose(){ready=false;},
  };
}
export async function readResource(resource:string,keyId:string,state:Pick<NonNullable<ControlHostContext['durableState']>,'get'|'list'>) {
  if(resource!=='api-key')throw new Error('resource_not_supported');
  const ledger=await readKey(state,keyId);
  return {value:ledger.policy,usage:await readUsage(state,keyId)};
}
export { recoverUsage } from './ledger';
export default {createControl,readResource,offlineRecovery:{kind:'plugin-state' as const,recover:recoverUsage}};
