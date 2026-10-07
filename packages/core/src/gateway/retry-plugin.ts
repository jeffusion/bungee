import { createBodySource } from './body-factory';
import type { Plugin, PluginHooks, GatewayRetryInput } from '@jeffusion/bungee-core/plugin';
import { ensureSnapshotCloned } from '../worker/request/snapshot';
import type { ProxyRequestResult } from './forward-plugin';
export class RetryPlugin implements Plugin {
  bodyRequirements() { return {request:'none' as const}; }
  register(hooks: PluginHooks): void {
    hooks.onGatewayRetry.tapPromise('builtin.retry', async (input: GatewayRetryInput) => {
      let repairUsed=false;
      const repair=async(original:ProxyRequestResult):Promise<ProxyRequestResult>=>{
        if(!original.repairRetry || repairUsed || (input.claimRepair && !input.claimRepair()))return original;
        repairUsed=true;
        const override=original.repairRetry.request;
        const fallbackSource=createBodySource(original.response.body,input.snapshot.bodySource?.maxBytes ?? 50*1024*1024,
          original.response.headers.get('content-encoding')??'',input.signal,{requestId:'',attemptId:'',direction:'response',stage:'client-response',version:0,
            contentType:original.response.headers.get('content-type')??'',contentEncoding:original.response.headers.get('content-encoding')??''});
        let keepFallback=false;
        try{
          const bytes=await fallbackSource.buffer('repair-fallback');
          original.response=new Response(bytes as BodyInit,{status:original.response.status,statusText:original.response.statusText,headers:original.response.headers});
          await original.observationCompletion;await input.finish(original);await input.recordAttempt?.(original);
          await input.cleanup(original,input.signal);
          const cleanup=original.cleanup;
          const fallback=():ProxyRequestResult=>({...original,repairFallback:true,
            cleanup:async()=>{try{await cleanup?.();}finally{fallbackSource.dispose();}}});
          if(input.signal.aborted)throw input.signal.reason??new DOMException('Aborted','AbortError');
          let repaired:ProxyRequestResult;
          try{repaired=await input.runAttempt(override);}catch(error){
            if(input.signal.aborted)throw error;
            keepFallback=true;return fallback();
          }
          if(repaired.response.ok){fallbackSource.dispose();return repaired;}
          try{
            if(repaired.drainRetryObservation)await repaired.drainRetryObservation();
            else if(repaired.response.body){const discarded=createBodySource(repaired.response.body,input.snapshot.bodySource?.maxBytes ?? 50*1024*1024,'',input.signal,
              {requestId:'',attemptId:'',direction:'response',stage:'client-response',version:0,contentType:repaired.response.headers.get('content-type')??'',contentEncoding:''});
              try{await discarded.buffer('repair-error-observation');}finally{discarded.dispose();}}
          }catch(error){if(input.signal.aborted)throw error;}
          await input.cleanup(repaired,input.signal);await repaired.observationCompletion;await input.finish(repaired);await input.recordAttempt?.(repaired);
          keepFallback=true;return fallback();
        }finally{if(!keepFallback)fallbackSource.dispose();}
      };
      let result = await repair(await input.runAttempt());
      const retryConfig = input.route.retry;
      const retryOn = retryConfig?.retry_on ?? [];

      if (repairUsed || !input.snapshot.bodySource?.replayable || !retryConfig?.enabled || result.response.ok || !retryOn.includes(result.response.status)) {
        return result;
      }

      for (let i = 0; i < (retryConfig.max_retries ?? 1); i++) {
        const previousAttempt = result;
        try {
          if (input.signal.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
          ensureSnapshotCloned(input.snapshot);
          if (previousAttempt.drainRetryObservation) {
            await previousAttempt.drainRetryObservation();
            await previousAttempt.observationCompletion;
          }
          await input.cleanup(previousAttempt, input.signal);
          await previousAttempt.observationCompletion;
          await input.finish(previousAttempt);
          const retryResponse = await repair(await input.runAttempt());
          result = retryResponse;
          if (repairUsed || !retryOn.includes(retryResponse.response.status)) {
            return retryResponse;
          }
        } finally {
          // A retry abort or cleanup failure must not leave its selected attempt open.
          await input.end(previousAttempt,input.signal.aborted);
        }
      }

      return result;
    });
  }
}
