import {test,expect} from 'bun:test';
import {periods,budgetUsed,formatBudget,statisticsLink} from '../../../ui/budget-view';
test('budget UI uses UTC Monday periods and distinct monetary totals',()=>{
 const now=Date.parse('2026-10-04T23:59:59Z');
 expect(periods(now)).toEqual({daily:'2026-10-04',weekly:'2026-09-28',monthly:'2026-10'});
 expect(periods(now+1000).weekly).toBe('2026-10-05');
 const usage={cumulative:100,monthly:{'2026-10':80},weekly:{'2026-09-28':60},daily:{'2026-10-04':20},unresolved:{},money:{cumulativeNanoUsd:1000000,monthlyNanoUsd:{'2026-10':800000},weeklyNanoUsd:{'2026-09-28':600000},dailyNanoUsd:{'2026-10-04':200000},unresolved:{}}};
 expect(budgetUsed(usage,'weekly','tokens',now)).toBe(60);
 expect(budgetUsed(usage,'daily','usd',now)).toBe(0.0002);
 expect(budgetUsed(usage,'cumulative','usd',now)).toBe(0.001);
 expect(formatBudget(0.000000001,'usd')).toBe('0.000000001');
 expect(statisticsLink('a:b')).toBe('/#/plugins/token-stats/statistics?keyId=a%3Ab');
});
