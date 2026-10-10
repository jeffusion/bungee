import type { TransportOutcome } from '../../../api/logs';

export interface LogFilters {
  searchTerm: string;
  method: string;
  statusFilter: string;
  transportFilter?: TransportOutcome;
  requestTypeFilter: string;
  hasRetryFilter?: boolean;
  timeRangeType: 'all' | 'recent' | 'custom';
  recentHours: number;
  customStartTime: string;
  customEndTime: string;
  sortBy: 'timestamp' | 'duration' | 'status';
  sortOrder: 'asc' | 'desc';
  page: number;
}

export function defaultLogFilters(): LogFilters {
  return { searchTerm: '', method: '', statusFilter: '', transportFilter: undefined,
    requestTypeFilter: '', hasRetryFilter: undefined, timeRangeType: 'recent', recentHours: 1,
    customStartTime: '', customEndTime: '', sortBy: 'timestamp', sortOrder: 'desc', page: 1 };
}

export function countLogFilters(filters: LogFilters): number {
  const { searchTerm, method, statusFilter, transportFilter, requestTypeFilter,
    hasRetryFilter, timeRangeType, recentHours, sortBy, sortOrder } = filters;
  return [searchTerm.trim(), method, statusFilter, transportFilter !== undefined,
    requestTypeFilter, hasRetryFilter !== undefined,
    timeRangeType !== 'all' && timeRangeType !== 'recent' || recentHours !== 1,
    sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length;
}
