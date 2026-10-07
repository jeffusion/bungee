import type { IngressPlugin } from '@jeffusion/bungee-core/plugin';
import type { DurableJson } from '@jeffusion/bungee-core/plugin';
export interface RatePolicy { rps: number; burst: number; unit?: 'second'|'minute' }
interface Bucket { tokens: number; at: number; rps: number; burst: number }
export function validatePolicy(value: unknown): RatePolicy | null {
  if (value === null) return null;
  const p = value as RatePolicy;
  if (!p || !Number.isFinite(p.rps) || p.rps <= 0 || !Number.isSafeInteger(p.burst) || p.burst < 1
    || !Number.isFinite(p.burst / p.rps * 1000)
    || (p.unit !== undefined && p.unit !== 'second' && p.unit !== 'minute')
    || (p.unit === 'minute' && !Number.isFinite(p.rps * 60))) throw new Error('invalid_policy');
  return {rps:p.rps,burst:p.burst,...(p.unit ? {unit:p.unit} : {})};
}
function refill(state: DurableJson, now: number): Bucket {
  const prior = state as unknown as Bucket;
  if (!prior || !Number.isFinite(prior.at) || !Number.isFinite(prior.tokens) || prior.tokens < 0
    || prior.tokens > prior.burst || !validatePolicy({rps:prior.rps,burst:prior.burst})) throw new Error('invalid_state');
  const at = Math.max(now,prior.at);
  return {...prior,at,tokens:Math.min(prior.burst,prior.tokens+(at-prior.at)/1000*prior.rps)};
}
export function createIngress(): IngressPlugin { return {
  bodyRequirements() { return { request: 'none' }; },
  keyedState: {
    capacity: 10000,
    policyForKey(value,key) { return (value as any)?.byKey?.[key] ?? null; },
    expiresAt(state) {
      const b = state as unknown as Bucket;
      // Round upwards: deleting even slightly early must not create free capacity.
      return Math.ceil(b.at+(b.burst-b.tokens)/b.rps*1000);
    },
    reconcile(state,value,now) {
      const b = refill(state,now), p = validatePolicy(value);
      // Removed/disabled rules expire naturally at their previous refill rate.
      // Rate changes accrue old-rate credit first, then apply the new rate.
      return (p ? {...b,rps:p.rps,burst:p.burst,tokens:Math.min(b.tokens,p.burst)} : b) as unknown as DurableJson;
    },
  },
  plan(target,value,state) {
    if (target.principal.domain === 'anonymous') return {snapshot:null};
    try {
      const p = validatePolicy(value);
      if (!p) return {snapshot:null};
      if (!Number.isFinite(target.now)) throw new Error('invalid_time');
      const bucket = state === null ? {tokens:p.burst,at:target.now,rps:p.rps,burst:p.burst} : refill(state,target.now);
      if (bucket.tokens < 1) return {denial:{error:'key-rate-limit.exhausted',status:429,retryAfter:Math.max(1,Math.ceil((1-bucket.tokens)/p.rps))}};
      return {state:{...bucket,tokens:bucket.tokens-1},snapshot:p as unknown as DurableJson};
    } catch { return {denial:{error:'key-rate-limit.unavailable',status:503}}; }
  },
  beforeAttempt() { return null; },
}; }
