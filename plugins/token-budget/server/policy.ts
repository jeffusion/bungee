import type { IngressPlugin } from '@jeffusion/bungee-core/plugin';
export interface BudgetPolicy { mode: 'daily' | 'weekly' | 'monthly' | 'cumulative'; unit?: 'tokens' | 'usd'; limit: number }
export interface BudgetSnapshot { keyId: string; requestId: string; month: string; day?: string; week?: string; policy: BudgetPolicy; version: number }
export function usdToNanoUsd(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Number(value.toFixed(6)) !== value) throw new Error('invalid_usd');
  const [whole, fraction] = value.toFixed(6).split('.');
  const nano = Number(BigInt(whole!) * 1_000_000_000n + BigInt(fraction!) * 1_000n);
  if (!Number.isSafeInteger(nano)) throw new Error('invalid_usd');
  return nano;
}
export function validatePolicy(value: unknown): BudgetPolicy | null {
  if (value === null) return null;
  const p = value as BudgetPolicy;
  if (!p || !['daily','weekly','monthly','cumulative'].includes(p.mode) || (p.unit !== undefined && !['tokens','usd'].includes(p.unit))) throw new Error('invalid_policy');
  if (p.unit === 'usd') { if (usdToNanoUsd(p.limit) < 1) throw new Error('invalid_policy'); }
  else if (!Number.isSafeInteger(p.limit) || p.limit < 1) throw new Error('invalid_policy');
  return {mode:p.mode,...(p.unit !== undefined ? {unit:p.unit}:{}),limit:p.limit};
}
export function utcDay(now: number): string { if (!Number.isFinite(now)) throw new Error('invalid_time'); return new Date(now).toISOString().slice(0,10); }
export function utcMonth(now: number): string { return utcDay(now).slice(0,7); }
export function utcWeek(now: number): string { const date = new Date(utcDay(now)+'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - (date.getUTCDay()+6)%7); return utcDay(date.getTime()); }
export function createIngress(): IngressPlugin { return {
  bodyRequirements(target, value) {
    if (target.principal.domain !== 'data') return { request: 'none' };
    const policy = validatePolicy((value as any)?.byKey?.[target.principal.keyId]?.policy ?? null);
    return { request: policy ? 'json-read' : 'none' };
  },
  plan(target,value) {
    if (target.principal.domain === 'anonymous') return {snapshot: null};
    try {
      const publication = value as any; const key = publication?.byKey?.[target.principal.keyId];
      const p = validatePolicy(key?.policy ?? null); if (!p) return {snapshot:null};
      if (target.principal.domain !== 'data') return {denial:{error:'token-budget.invalid_principal',status:403}};
      const month=utcMonth(target.now),day=utcDay(target.now),week=utcWeek(target.now);
      const usd=p.unit==='usd';
      const unresolved=usd ? key.money?.unresolved : key.unresolved;
      if (!unresolved || Object.values(unresolved).some(v => v === 'unknown')) return {denial:{error:usd?'token-budget.cost_unknown':'token-budget.accounting_unknown',status:503}};
      const period=p.mode==='monthly'?month:p.mode==='weekly'?week:day;
      const used=usd ? (p.mode==='cumulative'?key.money.cumulativeNanoUsd:key.money[p.mode+'NanoUsd']?.[period]??0) : (p.mode==='cumulative'?key.cumulative:key[p.mode]?.[period]??0);
      if (!Number.isSafeInteger(used) || used < 0) throw new Error('invalid_accounting');
      if (used >= (usd?usdToNanoUsd(p.limit):p.limit)) return {denial:{error:'token-budget.exhausted',status:429}};
      return {snapshot:{keyId:target.principal.keyId,requestId:target.requestId,month,day,week,policy:p as any,version:publication.version ?? 0}};
    } catch { return {denial:{error:'token-budget.unavailable',status:503}}; }
  },
  beforeAttempt(target,snapshot) {
    if (snapshot === null) return null;
    const s = snapshot as any;
    return s?.keyId === target.principal.keyId && s?.requestId === target.requestId ? null : {error:'token-budget.invalid_grant',status:503};
  },
}; }
