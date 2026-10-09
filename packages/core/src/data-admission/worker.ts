import type { AdmissionTarget, AdmissionDenial } from '../plugin-extensions';
import type { DurableJson } from '../plugin-durable-state';
import type { AttemptObservationEvent, AttemptObservationOutcome } from '../hooks/plugin-hooks';
import type { AdmissionGrant } from './host';
import { DataAdmissionError } from './host';
export interface PreparedAdmissionAttempt {
  readonly denial?: AdmissionDenial;
  observeResponse?(event: AttemptObservationEvent): Promise<void>;
  onResult?(result: { sent: boolean; outcome: AttemptObservationOutcome }): Promise<void>;
  cancel?(): Promise<void>;
}
export interface WorkerAdmissionPlugin {
  readonly pluginName: string;
  resolveAdmissionModel?(input: {url: string;body: unknown}): string | null;
  prepareAdmissionAttempt?(input: {
    target: AdmissionTarget; snapshot: DurableJson; body: unknown;
    callBudget(method: string, payload: unknown): Promise<unknown>;
  }): Promise<PreparedAdmissionAttempt>;
}
type Rpc = (operation: string,payload: unknown,signal?:AbortSignal)=>Promise<unknown>;
export interface WorkerAdmissionSession { admission: Rpc }
let session: WorkerAdmissionSession | null = null;
export function setWorkerAdmissionSession(value: WorkerAdmissionSession | null): void { session=value; }
export function hasWorkerAdmissionSession(): boolean { return session!==null; }
export class WorkerRequestAdmission {
  private grant: AdmissionGrant | null = null;
  private admittedBody: unknown;
  constructor(private readonly plugins: readonly WorkerAdmissionPlugin[], private readonly targetBase: Omit<AdmissionTarget,'attemptId'|'upstreamId'|'url'|'model'|'now'>, private readonly invokeBudget: (plugin: string, method: string, payload: unknown, target: AdmissionTarget) => Promise<unknown>) {}
  async prepare(input: { attemptId: string; upstreamId: string; url: string; model: string | null; body: unknown; transport?: 'websocket' },signal: AbortSignal, loadBody?: () => Promise<unknown>): Promise<PreparedAdmissionAttempt[]> {
    if (!session) throw new DataAdmissionError(503,'admission_unavailable');
    const {body: _body,transport,...targetInput}=input;
    let body = input.body === undefined && this.grant ? this.admittedBody : input.body;
    for(let revisionAttempt=0;revisionAttempt<3;revisionAttempt++) {
      let target = Object.freeze({...this.targetBase,...targetInput,now:Date.now()});
      // Retry/drain attempts remain bound to the original grant's policy and
      // identity. Only a new request inspects the current publication.
      const inspected = this.grant ? {policyVersion:this.grant.version, requirements:{}}
        : await session.admission('inspect',target,signal) as {policyVersion:number;requirements:Record<string,{request:'none'|'json-read'}>};
      if (!inspected || !Number.isSafeInteger(inspected.policyVersion) || !inspected.requirements) throw new DataAdmissionError(503,'admission_inspect_failed');
      const needsBody = Object.values(inspected.requirements).some(requirement=>requirement.request === 'json-read');
      if (needsBody && transport === 'websocket') throw new DataAdmissionError(422,'websocket_budget_unsupported');
      if (needsBody && body === undefined) {
        if (!loadBody) throw new DataAdmissionError(503,'admission_body_unavailable'); body = await loadBody();
      }
      for (const plugin of this.plugins) if (plugin.resolveAdmissionModel) targetInput.model = plugin.resolveAdmissionModel({...input,body});
      target = Object.freeze({...this.targetBase,...targetInput,now:Date.now()});
      const snapshot=(this.grant ? await session.admission('attempt',target,signal) : await session.admission('preview',target,signal)) as AdmissionGrant;
      if (!this.grant && snapshot.version !== inspected.policyVersion) continue;
      const prepared: PreparedAdmissionAttempt[]=[];
      try {
        const effectiveTarget = Object.freeze({...target, principal: snapshot.principal});
        for(const plugin of this.plugins) {
          if(!plugin.prepareAdmissionAttempt || !(plugin.pluginName in snapshot.snapshots)) continue;
          const result=await plugin.prepareAdmissionAttempt({target: effectiveTarget,snapshot:snapshot.snapshots[plugin.pluginName]!,body,
            callBudget: (method,payload) => {
              return this.invokeBudget(plugin.pluginName, method, payload, effectiveTarget);
            }});
          prepared.push(result);
          if(result.denial) throw new DataAdmissionError(result.denial.status,result.denial.error,result.denial.retryAfter);
        }
        if(signal.aborted) throw signal.reason;
        if(!this.grant) {
          this.grant=await session.admission('admit',{target,version:snapshot.version},signal) as AdmissionGrant;
          this.admittedBody = body;
        }
        return prepared;
      } catch(error) {
        await Promise.allSettled(prepared.map(p=>p.cancel?.()));
        if(error instanceof DataAdmissionError && error.status===409 && !this.grant) continue;
        if (error instanceof DataAdmissionError || signal.aborted) throw error;
        throw new DataAdmissionError(503, 'admission_prepare_failed');
      }
    }
    throw new DataAdmissionError(503,'admission_publication_busy');
  }
  async release(): Promise<void> {
    if(this.grant && session) await session.admission('release',{requestId:this.targetBase.requestId}).catch(()=>undefined);
  }
}
