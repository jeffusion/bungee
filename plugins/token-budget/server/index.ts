import { businessRpc } from './rpc';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type { PluginInitContext } from '@jeffusion/bungee-core/plugin';
import type { AdmissionTarget, AdmissionDenial } from '@jeffusion/bungee-core/plugin';
import { TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION, TOKEN_PRICING_SERVICE_ID, TOKEN_PRICING_CONTRACT_VERSION, type TokenPricingService, type TokenMeteringService } from '@jeffusion/bungee-core/plugin';
import type { BudgetSnapshot } from './policy';
export { createIngress } from './policy';
export interface BudgetAttemptInput {
  target: AdmissionTarget; snapshot: BudgetSnapshot | null; body: unknown;
  callBudget: (method:string,payload:unknown)=>Promise<unknown>;
}
type BudgetMeteringService = TokenMeteringService & { drainRequest(requestId:string):Promise<void> };
export function createBudgetConsumer(service:Readonly<BudgetMeteringService>,pricing?:Readonly<TokenPricingService>) {
  return {
    async prepareAdmissionAttempt(input:BudgetAttemptInput) {
      const {target,snapshot,callBudget}=input;
      if(!snapshot) return {};
      if(snapshot.keyId!==target.principal.keyId || snapshot.requestId!==target.requestId) return {denial:{error:'token-budget.invalid_grant',status:503} as AdmissionDenial};
      let settled=false;
      const unsubscribe=service.subscribe({requestId:target.requestId,required:true,onResult:async result=>{
        if(result.attemptId!==target.attemptId)return;
        let costNanoUsd:number|null=null;
        try { const price=await pricing?.price(result); if(price && Number.isSafeInteger(price.costNanoUsd) && price.costNanoUsd!>=0)costNanoUsd=price.costNanoUsd; } catch { /* A failed price remains explicitly unknown. */ }
        await callBudget('settle',{result: JSON.parse(JSON.stringify(result)),costNanoUsd});settled=true;unsubscribe();
      }});
      try {
        service.prepareRequest(target.requestId);
        const support=service.prepareAttempt({requestId:target.requestId,attemptId:target.attemptId,routeId:target.routeId,upstreamId:target.upstreamId,url:target.url,body:input.body});
        if(!support.supported){unsubscribe();return {denial:{error:'token-budget.unmeterable',status:422} as AdmissionDenial};}
        if(snapshot.policy.unit==='usd') {
          if(!pricing || !await pricing.canPrice({model:support.model,pricingProvider:support.pricingProvider})) {unsubscribe();return {denial:{error:'token-budget.unpriceable',status:422} as AdmissionDenial};}
        }
        await callBudget('prepare',{snapshot});
      } catch {unsubscribe();return {denial:{error:'token-budget.prepare_failed',status:503} as AdmissionDenial};}
      const cancel=async()=>{await callBudget('cancel',{sent:false});unsubscribe();};
      return {cancel,async onResult(result:{sent:boolean;outcome:string;observationLost?:boolean}) {
        if(!result.sent){await cancel();return;}
        // Keep the request lease until required metering callbacks durably settle.
        await service.drainRequest(target.requestId);
        if(!settled) {
          await callBudget('settle',{result:{requestId:target.requestId,attemptId:target.attemptId,routeId:target.routeId,upstreamId:target.upstreamId,provider:'unknown',inputSource:'none',outputSource:'none',inputAuthority:'none',outputAuthority:'none',complete:false,observationIncomplete:true,outcome:'failed',finishedAtMs:Date.now(),settlementVersion:1},costNanoUsd:null});
          unsubscribe();
        }
      }};
    },
  };
}
export default definePlugin(class {
  static readonly admissionRpcContract = businessRpc;
    static readonly name='token-budget';static readonly version='1.0.0';
  private consumer?:ReturnType<typeof createBudgetConsumer>;
  async init(ctx:PluginInitContext) {
    if(ctx.scope && ctx.scope.type!=='global')throw new Error('token-budget requires global scope');
    if(!ctx.services)throw new Error('token-budget requires token-metering');
    this.consumer=createBudgetConsumer(
      ctx.services.consume<BudgetMeteringService>('token-metering',TOKEN_METERING_SERVICE_ID,TOKEN_METERING_CONTRACT_VERSION),
      ctx.services.consume<TokenPricingService>('token-stats',TOKEN_PRICING_SERVICE_ID,TOKEN_PRICING_CONTRACT_VERSION),
    );
  }
  bodyRequirements(): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements { return { request: 'none' }; }
  register(){}
  prepareAdmissionAttempt(input:Omit<BudgetAttemptInput,'snapshot'> & {snapshot:unknown}){if(!this.consumer)throw new Error('token-budget not ready');return this.consumer.prepareAdmissionAttempt({...input,snapshot:input.snapshot as BudgetSnapshot|null});}
});
