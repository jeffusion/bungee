import { expect, test } from 'bun:test';
import { defaultLogFilters, countLogFilters, type LogFilters } from '../../../src/components/domain/log/filter-state';

test('reset provides exactly the filter, sorting and page defaults', () => {
  expect(defaultLogFilters()).toEqual({ searchTerm: '', method: '', statusFilter: '', transportFilter: undefined,
    requestTypeFilter: '', hasRetryFilter: undefined, timeRangeType: 'recent', recentHours: 1,
    customStartTime: '', customEndTime: '', sortBy: 'timestamp', sortOrder: 'desc', page: 1 });
  expect(defaultLogFilters()).not.toBe(defaultLogFilters());
  expect(countLogFilters(defaultLogFilters())).toBe(0);
});

test('active count preserves false, whitespace and all-time semantics', () => {
  const changes: Partial<LogFilters>[] = [{ searchTerm: 'test' }, { method: 'POST' }, { statusFilter: '503' },
    { transportFilter: 'cancelled' }, { requestTypeFilter: 'retry' }, { hasRetryFilter: false },
    { timeRangeType: 'custom' }, { recentHours: 2 }, { sortOrder: 'asc' }];
  for (const patch of changes) expect(countLogFilters({ ...defaultLogFilters(), ...patch })).toBe(1);
  expect(countLogFilters({ ...defaultLogFilters(), searchTerm: '  ' })).toBe(0);
  expect(countLogFilters({ ...defaultLogFilters(), timeRangeType: 'all' })).toBe(0);
  expect(countLogFilters({ ...defaultLogFilters(), searchTerm: 'test', method: 'POST', statusFilter: '503',
    transportFilter: 'cancelled', requestTypeFilter: 'retry', hasRetryFilter: true, timeRangeType: 'custom',
    sortBy: 'duration' })).toBe(8);
});
