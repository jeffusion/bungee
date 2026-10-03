import { createHash, randomUUID } from 'node:crypto';
import type { PluginDurableState, DurableMutation } from '../../../packages/core/src/plugin-durable-state';
import type { PluginStateRpcContext } from '../../../packages/core/src/plugin-extensions';
import type { TokenMeteringResult } from '../../../packages/core/src/plugin-services';
import { validatePolicy, usdToNanoUsd, utcWeek, type BudgetPolicy, type BudgetSnapshot } from './policy';
type Unresolved = Record<string,'pending'|'unknown'>;
type Totals = Record<string,number>;
export interface KeyLedger {
  policy: BudgetPolicy | null; cumulative: number; monthly: Totals; daily: Totals; weekly: Totals; unresolved: Unresolved;
  money: { cumulativeNanoUsd:number; monthlyNanoUsd:Totals; dailyNanoUsd:Totals; weeklyNanoUsd:Totals; unresolved:Unresolved };
  collection: { dailyWeeklyStartedAtMs:number|null; moneyStartedAtMs:number|null; legacyTokensExcluded:boolean };
}
interface Attempt { keyId:string; requestId:string; attemptId:string; snapshot:BudgetSnapshot; status:'pending'|'settled'|'cancelled'|'unknown'; input:number; output:number; inputSource:string; outputSource:string; settlementVersion:number; resultFingerprint:string|null; partial:boolean; costNanoUsd?:number|null; accountedNanoUsd?:number; costStatus?:'pending'|'known'|'unknown'|'untracked' }
export function keyRecord(keyId:string) { return 'key:'+createHash('sha256').update(keyId).digest('hex'); }
function id(kind:string,requestId:string,attemptId='') { return kind+':'+createHash('sha256').update(JSON.stringify([requestId,attemptId])).digest('hex'); }
function amount(value:unknown): value is number { return Number.isSafeInteger(value) && (value as number)>=0; }
function totals(value:any) { return value && typeof value==='object' && !Array.isArray(value) && Object.values(value).every(amount); }
function unresolved(value:any) { return value && typeof value==='object' && !Array.isArray(value) && Object.values(value).every(v=>v==='pending'||v==='unknown'); }
function emptyMoney():KeyLedger['money'] { return {cumulativeNanoUsd:0,monthlyNanoUsd:{},dailyNanoUsd:{},weeklyNanoUsd:{},unresolved:{}}; }
export function readKey(state:Pick<PluginDurableState,'get'>,keyId:string):KeyLedger {
  const record=state.get(keyRecord(keyId));
  if (!record) return {policy:null,cumulative:0,monthly:{},daily:{},weekly:{},unresolved:{},money:emptyMoney(),collection:{dailyWeeklyStartedAtMs:null,moneyStartedAtMs:null,legacyTokensExcluded:false}};
  const v=structuredClone((record.value as any).ledger);
  if (!v || !amount(v.cumulative) || !totals(v.monthly) || !unresolved(v.unresolved)) throw new Error('token-budget.corrupt_state');
  const legacy=v.daily===undefined || v.weekly===undefined;
  v.daily??={};v.weekly??={};v.money??=emptyMoney();
  v.collection??={dailyWeeklyStartedAtMs:null,moneyStartedAtMs:null,legacyTokensExcluded:legacy};
  if (!totals(v.daily)||!totals(v.weekly)||!amount(v.money.cumulativeNanoUsd)||!totals(v.money.monthlyNanoUsd)||!totals(v.money.dailyNanoUsd)||!totals(v.money.weeklyNanoUsd)||!unresolved(v.money.unresolved)) throw new Error('token-budget.corrupt_state');
  if (!v.collection || ![v.collection.dailyWeeklyStartedAtMs,v.collection.moneyStartedAtMs].every(n=>n===null||amount(n)) || typeof v.collection.legacyTokensExcluded!=='boolean') throw new Error('token-budget.corrupt_state');
  validatePolicy(v.policy); return v;
}
/** Dates and money absent from legacy history are never inferred from month totals. */
export function readUsage(state:Pick<PluginDurableState,'get'|'list'>,keyId:string) {
  const ledger=readKey(state,keyId);
  const attempts=state.list().filter(record=>record.key.startsWith('attempt:'))
    .map(record=>record.value as unknown as Attempt).filter(attempt=>attempt.keyId===keyId)
    .sort((a,b)=>Number(b.status==='unknown'||b.status==='pending'||b.costStatus==='unknown')-Number(a.status==='unknown'||a.status==='pending'||a.costStatus==='unknown'));
  return {...ledger,attemptCount:attempts.length,attempts:attempts.slice(0,50).map(attempt=>({
    requestId:attempt.requestId,attemptId:attempt.attemptId,month:attempt.snapshot.month,day:attempt.snapshot.day??null,week:attempt.snapshot.week??null,status:attempt.status,
    inputTokens:attempt.inputSource==='none'?null:attempt.input,outputTokens:attempt.outputSource==='none'?null:attempt.output,
    inputSource:attempt.inputSource,outputSource:attempt.outputSource,partial:attempt.partial,
    costNanoUsd:attempt.costNanoUsd??null,costStatus:attempt.costStatus??'untracked',
  }))};
}
export function setPolicy(state:PluginDurableState,keyId:string,policy:unknown) {
  const key=keyRecord(keyId);const old=state.get(key); const ledger=readKey(state,keyId); ledger.policy=validatePolicy(policy);
  commit(state,[{key,expectedVersion:old?.version??0,value:{keyId,ledger:ledger as any}}],true);
}
export function publication(state:PluginDurableState) {
  const byKey:Record<string,any>={}; const version=admissionVersion(state);
  for(const r of state.list()) { if(r.key.startsWith('key:')) { const v=r.value as any; byKey[v.keyId]=readKey(state,v.keyId); } }
  return {version,value:{version,byKey}};
}
export function admissionVersion(state:PluginDurableState):number {
  const version=state.get('admission-version')?.value??0;
  if(typeof version!=='number' || !Number.isSafeInteger(version) || version<0) throw new Error('token-budget.corrupt_version');
  return version;
}
function commit(state:PluginDurableState,mutations:DurableMutation[],admissionChanged=false) {
  if(admissionChanged) {
    const record=state.get('admission-version');const next=admissionVersion(state)+1;
    if(!Number.isSafeInteger(next))throw new Error('token-budget.version_overflow');
    mutations.push({key:'admission-version',expectedVersion:record?.version??0,value:next});
  }
  state.execute({commandId:randomUUID(),mutations});
}
function validSnapshot(snapshot:BudgetSnapshot) {
  if(!snapshot || !/^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot.month) || !validatePolicy(snapshot.policy) || !amount(snapshot.version))return false;
  if(snapshot.day===undefined && snapshot.week===undefined) return !['daily','weekly'].includes(snapshot.policy.mode);
  if(typeof snapshot.day!=='string'||typeof snapshot.week!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(snapshot.day)||snapshot.month!==snapshot.day.slice(0,7))return false;
  const time=Date.parse(snapshot.day+'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===snapshot.day && utcWeek(time)===snapshot.week;
}
function add(map:Totals,key:string,delta:number) { const next=(map[key]??0)+delta;if(!amount(next))throw new Error('token-budget.overflow');map[key]=next; }
function applyDelta(ledger:KeyLedger,attempt:Attempt,previous:Attempt) {
  const total=attempt.input+attempt.output,previousTotal=previous.input+previous.output;
  if(!amount(total)||!amount(previousTotal))throw new Error('token-budget.overflow');
  const delta=total-previousTotal;
  const cumulative=ledger.cumulative+delta;if(!amount(cumulative))throw new Error('token-budget.overflow');ledger.cumulative=cumulative;
  add(ledger.monthly,attempt.snapshot.month,delta);
  if(attempt.snapshot.day&&attempt.snapshot.week){add(ledger.daily,attempt.snapshot.day,delta);add(ledger.weekly,attempt.snapshot.week,delta);}
  const moneyDelta=(attempt.accountedNanoUsd??0)-(previous.accountedNanoUsd??previous.costNanoUsd??0);
  const money=ledger.money.cumulativeNanoUsd+moneyDelta;if(!amount(money))throw new Error('token-budget.overflow');ledger.money.cumulativeNanoUsd=money;
  // Zero unknown prices do not become monetary observations or fabricated period history.
  if(attempt.accountedNanoUsd!==undefined && attempt.costStatus!=='pending') {
    add(ledger.money.monthlyNanoUsd,attempt.snapshot.month,moneyDelta);
    if(attempt.snapshot.day&&attempt.snapshot.week){add(ledger.money.dailyNanoUsd,attempt.snapshot.day,moneyDelta);add(ledger.money.weeklyNanoUsd,attempt.snapshot.week,moneyDelta);}
  }
}
function mark(ledger:KeyLedger,key:string,attempt:Attempt) {
  if(attempt.status==='unknown')ledger.unresolved[key]='unknown';else delete ledger.unresolved[key];
  if(attempt.costStatus==='unknown')ledger.money.unresolved[key]='unknown';else delete ledger.money.unresolved[key];
}
export function stateRpc(method:string,payload:unknown,ctx:PluginStateRpcContext):unknown {
  if(ctx.principal.domain!=='data') throw new Error('token-budget.invalid_principal');
  const state=ctx.state,keyId=ctx.principal.keyId,p=payload as any;
  const attemptKey=id('attempt',ctx.requestId,ctx.attemptId),requestKey=id('request',ctx.requestId);
  const record=state.get(attemptKey);const attempt=record ? structuredClone(record.value) as unknown as Attempt : undefined;
  if(attempt && (attempt.keyId!==keyId || attempt.requestId!==ctx.requestId || attempt.attemptId!==ctx.attemptId)) throw new Error('token-budget.id_conflict');
  if(method==='status') return attempt??null;
  if(method==='prepare') {
    const snapshot=p?.snapshot as BudgetSnapshot;
    if(!validSnapshot(snapshot)||snapshot.keyId!==keyId||snapshot.requestId!==ctx.requestId)throw new Error('token-budget.invalid_grant');
    const request=state.get(requestKey);
    if(request && JSON.stringify(request.value)!==JSON.stringify(snapshot)) throw new Error('token-budget.id_conflict');
    if(attempt) { if(JSON.stringify(attempt.snapshot)!==JSON.stringify(snapshot)) throw new Error('token-budget.id_conflict'); return attempt; }
    const ledger=readKey(state,keyId),ledgerKey=keyRecord(keyId),prior=state.get(ledgerKey);
    ledger.unresolved[attemptKey]='pending';ledger.money.unresolved[attemptKey]='pending';
    if(snapshot.day)ledger.collection.dailyWeeklyStartedAtMs??=Date.now();
    ledger.collection.moneyStartedAtMs??=Date.now();
    const next:Attempt={keyId,requestId:ctx.requestId,attemptId:ctx.attemptId,snapshot,status:'pending',input:0,output:0,inputSource:'none',outputSource:'none',settlementVersion:0,resultFingerprint:null,partial:false,costNanoUsd:null,costStatus:'pending'};
    const mutations:DurableMutation[]=[{key:attemptKey,expectedVersion:0,value:next as any},{key:ledgerKey,expectedVersion:prior?.version??0,value:{keyId,ledger:ledger as any}}];
    if(!request) mutations.push({key:requestKey,expectedVersion:0,value:snapshot as any});
    commit(state,mutations);return next;
  }
  if(!attempt) throw new Error('token-budget.attempt_not_prepared');
  if(method==='cancel') {
    if(p?.sent!==false) throw new Error('token-budget.cancel_requires_unsent');
    if(attempt.status==='cancelled') return attempt;
    if(attempt.status!=='pending') throw new Error('token-budget.attempt_already_sent');
    attempt.status='cancelled';attempt.costStatus='known';attempt.costNanoUsd=0;
  } else if(method==='settle') {
    if(state.get(id('recovery',ctx.requestId,ctx.attemptId))||state.get(id('recovery-cost',ctx.requestId,ctx.attemptId))) throw new Error('token-budget.recovered_attempt');
    if(attempt.status==='cancelled') throw new Error('token-budget.cancelled_attempt');
    const result=p?.result as TokenMeteringResult | undefined;
    if(!result || result.requestId!==ctx.requestId || result.attemptId!==ctx.attemptId || !Number.isSafeInteger(result.settlementVersion) || result.settlementVersion<1) throw new Error('token-budget.invalid_settlement');
    const cost=p.costNanoUsd??null;if(cost!==null&&!amount(cost))throw new Error('token-budget.invalid_cost');
    // Legacy payloads keep their historical fingerprint for replay after upgrade.
    const fingerprint=createHash('sha256').update(JSON.stringify(Object.hasOwn(p,'costNanoUsd')?{result,costNanoUsd:cost}:result)).digest('hex');
    if(result.settlementVersion<attempt.settlementVersion) return attempt;
    if(result.settlementVersion===attempt.settlementVersion) {if(fingerprint!==attempt.resultFingerprint) throw new Error('token-budget.id_conflict');return attempt;}
    for(const field of ['input','output'] as const) {
      const count=result[`${field}Tokens`],source=result[`${field}Source`];
      if(count!==undefined && !amount(count)) throw new Error('token-budget.invalid_tokens');
      if(!['official','estimated','partial','none'].includes(source)) throw new Error('token-budget.invalid_source');
      if(source!=='none' && count!==undefined && (attempt[`${field}Source`]!=='official' || source==='official')) {attempt[field]=count;attempt[`${field}Source`]=source;}
    }
    const known=attempt.inputSource!=='none' && attempt.outputSource!=='none',official=attempt.inputSource==='official' && attempt.outputSource==='official';
    attempt.status=known && (!result.observationIncomplete || official)?'settled':'unknown';
    attempt.costNanoUsd=cost;attempt.costStatus=cost===null?'unknown':'known';
    if(cost!==null)attempt.accountedNanoUsd=cost;
    attempt.partial=!result.complete;attempt.settlementVersion=result.settlementVersion;attempt.resultFingerprint=fingerprint;
  } else throw new Error('token-budget.unknown_method');
  const ledgerKey=keyRecord(keyId),prior=state.get(ledgerKey),ledger=readKey(state,keyId);
  const previouslyUnknown=ledger.unresolved[attemptKey]==='unknown'||ledger.money.unresolved[attemptKey]==='unknown';
  applyDelta(ledger,attempt,record!.value as unknown as Attempt);mark(ledger,attemptKey,attempt);
  if(method==='settle')ledger.collection.moneyStartedAtMs??=Date.now();
  commit(state,[{key:attemptKey,expectedVersion:record!.version,value:attempt as any},{key:ledgerKey,expectedVersion:prior?.version??0,value:{keyId,ledger:ledger as any}}],method==='settle' || previouslyUnknown);return attempt;
}
export function recoverPending(state:PluginDurableState) {
  for(const record of state.list()) {
    if(!record.key.startsWith('key:')) continue;
    const v=record.value as any,ledger=readKey(state,v.keyId);let changed=false;
    const mutations:DurableMutation[]=[];
    const keys=new Set([...Object.keys(ledger.unresolved),...Object.keys(ledger.money.unresolved)]);
    for(const key of keys) {
      const attemptRecord=state.get(key),attempt=attemptRecord?structuredClone(attemptRecord.value) as unknown as Attempt:null;let attemptChanged=false;
      if(ledger.unresolved[key]==='pending'){ledger.unresolved[key]='unknown';changed=true;if(attempt){attempt.status='unknown';attemptChanged=true;}}
      if(ledger.money.unresolved[key]==='pending'||attempt && attempt.costStatus===undefined && ledger.unresolved[key]) {ledger.money.unresolved[key]='unknown';changed=true;ledger.collection.moneyStartedAtMs??=Date.now();if(attempt){attempt.costStatus='unknown';attemptChanged=true;}}
      if(ledger.unresolved[key]==='unknown'&&attempt?.status==='pending'){attempt.status='unknown';attemptChanged=true;changed=true;}
      if(attemptChanged && attemptRecord && attempt)mutations.push({key,expectedVersion:attemptRecord.version,value:attempt as any});
    }
    if(changed) commit(state,[...mutations,{key:record.key,expectedVersion:record.version,value:{keyId:v.keyId,ledger:ledger as any}}],true);
  }
}

/** Offline totals and optional exact USD amount; every correction retains immutable evidence. */
export function recoverUsage(input: unknown, context: { durableState: PluginDurableState }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('token-budget.invalid_recovery');
  const p=input as Record<string,unknown>,fields=['keyId','requestId','attemptId','inputTokens','outputTokens','costUsd','reason'];
  if(Object.keys(p).some(k=>!fields.includes(k)))throw new Error('token-budget.invalid_recovery');
  for(const field of ['keyId','requestId','attemptId'])if(typeof p[field]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p[field] as string))throw new Error('token-budget.invalid_recovery');
  const hasTokens=Object.hasOwn(p,'inputTokens')||Object.hasOwn(p,'outputTokens'),hasCost=Object.hasOwn(p,'costUsd');
  if(!hasTokens&&!hasCost)throw new Error('token-budget.invalid_recovery');
  if(hasTokens)for(const field of ['inputTokens','outputTokens'])if(!amount(p[field]))throw new Error('token-budget.invalid_tokens');
  const cost=hasCost?usdToNanoUsd(p.costUsd):undefined;
  if(typeof p.reason!=='string'||!p.reason.trim()||p.reason.length>512)throw new Error('token-budget.invalid_reason');
  const state=context.durableState,attemptKey=id('attempt',p.requestId as string,p.attemptId as string),auditKey=id(hasTokens?'recovery':'recovery-cost',p.requestId as string,p.attemptId as string);
  // Match the legacy token-only fingerprint field order.
  const fingerprint=createHash('sha256').update(JSON.stringify((hasCost?fields:['keyId','requestId','attemptId','inputTokens','outputTokens','reason']).map(k=>p[k]))).digest('hex');
  const audit=state.get(auditKey);
  if(audit){if((audit.value as any).fingerprint!==fingerprint)throw new Error('token-budget.recovery_conflict');return {recovered:true,alreadyApplied:true};}
  const record=state.get(attemptKey);if(!record)throw new Error('token-budget.attempt_not_prepared');
  const previous=record.value as unknown as Attempt;
  if(previous.keyId!==p.keyId||previous.requestId!==p.requestId||previous.attemptId!==p.attemptId)throw new Error('token-budget.id_conflict');
  const ledger=readKey(state,p.keyId as string);
  if(hasTokens && !ledger.unresolved[attemptKey] || hasCost && !ledger.money.unresolved[attemptKey])throw new Error('token-budget.recovery_requires_unresolved');
  if(!validSnapshot(previous.snapshot)||!amount(previous.input)||!amount(previous.output))throw new Error('token-budget.corrupt_state');
  const attempt={...previous};
  if(hasTokens && !hasCost && (attempt.costStatus===undefined||attempt.costStatus==='pending')) {attempt.costStatus='unknown';attempt.costNanoUsd=null;ledger.money.unresolved[attemptKey]='unknown';ledger.collection.moneyStartedAtMs??=Date.now();}
  if(hasTokens){attempt.input=p.inputTokens as number;attempt.output=p.outputTokens as number;attempt.inputSource='manual';attempt.outputSource='manual';attempt.status='settled';attempt.partial=false;}
  if(hasCost){attempt.costNanoUsd=cost!;attempt.accountedNanoUsd=cost!;attempt.costStatus='known';ledger.collection.moneyStartedAtMs??=Date.now();}
  // Token-only recovery never clears the independently unknown monetary cost.
  applyDelta(ledger,attempt,previous);
  if(hasTokens)delete ledger.unresolved[attemptKey];if(hasCost)delete ledger.money.unresolved[attemptKey];
  const delta=attempt.input+attempt.output-previous.input-previous.output,deltaNanoUsd=(attempt.accountedNanoUsd??0)-(previous.accountedNanoUsd??previous.costNanoUsd??0),ledgerKey=keyRecord(p.keyId as string);
  commit(state,[
    {key:attemptKey,expectedVersion:record.version,value:attempt as any},
    {key:ledgerKey,expectedVersion:state.get(ledgerKey)?.version??0,value:{keyId:p.keyId as string,ledger:ledger as any}},
    {key:auditKey,expectedVersion:0,value:{fingerprint,keyId:p.keyId as string,requestId:p.requestId as string,attemptId:p.attemptId as string,reason:p.reason,at:Date.now(),month:previous.snapshot.month,day:previous.snapshot.day??null,week:previous.snapshot.week??null,previous:previous as any,inputTokens:attempt.input,outputTokens:attempt.output,costNanoUsd:attempt.costNanoUsd??null,delta,deltaNanoUsd}},
  ],true);
  return {recovered:true,alreadyApplied:false};
}
