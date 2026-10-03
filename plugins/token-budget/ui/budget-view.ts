export type BudgetMode = 'daily'|'weekly'|'monthly'|'cumulative';
export type BudgetUnit = 'tokens'|'usd';
export interface BudgetPolicy {mode:BudgetMode;unit?:BudgetUnit;limit:number}
export interface BudgetUsage {
  cumulative:number;monthly:Record<string,number>;daily?:Record<string,number>;weekly?:Record<string,number>;unresolved:Record<string,string>;
  money?:{cumulativeNanoUsd:number;monthlyNanoUsd:Record<string,number>;dailyNanoUsd:Record<string,number>;weeklyNanoUsd:Record<string,number>;unresolved:Record<string,string>};
  collection?:{dailyWeeklyStartedAtMs:number|null;moneyStartedAtMs:number|null;legacyTokensExcluded:boolean};
}
export function periods(now:number) {
  const date = new Date(now),day=date.toISOString().slice(0,10);
  const monday = new Date(day+'T00:00:00Z');monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);
  return {daily:day,weekly:monday.toISOString().slice(0,10),monthly:day.slice(0,7)};
}
export function budgetUsed(usage:BudgetUsage|undefined,mode:string,unit:string,now:number):number {
  if (!usage) return 0;
  if (unit==='usd') {
    const money=usage.money;if(!money)return 0;
    return (mode==='cumulative' ? money.cumulativeNanoUsd : money[(mode+'NanoUsd') as 'monthlyNanoUsd']?.[periods(now)[mode as 'monthly']] ?? 0)/1e9;
  }
  return mode==='cumulative' ? usage.cumulative : usage[mode as 'monthly']?.[periods(now)[mode as 'monthly']] ?? 0;
}
export function formatBudget(value:number,unit:string,locale?:string) {return value.toLocaleString(locale,{maximumFractionDigits:unit==='usd'?9:0});}
export function formatBudgetPeriod(mode:Exclude<BudgetMode,'cumulative'>,now:number,locale?:string):string {
  const date = new Date(periods(now)[mode]+(mode==='monthly'?'-01':'')+'T00:00:00Z');
  return date.toLocaleDateString(locale,{timeZone:'UTC',year:'numeric',month:mode==='monthly'?'long':'2-digit',...(mode==='monthly'?{}:{day:'2-digit' as const})})+' UTC';
}
export function formatBudgetDate(value:number,locale?:string):string {
  return new Date(value).toLocaleString(locale,{timeZone:'UTC',timeZoneName:'short'});
}
export const periodLabels:Record<string,string>={daily:'period.daily',weekly:'period.weekly',monthly:'period.monthly',cumulative:'period.cumulative'};
export function statisticsLink(keyId:string) {return '/#/plugins/token-stats/statistics?keyId='+encodeURIComponent(keyId);}
