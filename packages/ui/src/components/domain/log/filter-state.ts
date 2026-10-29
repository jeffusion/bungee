import type { TransportOutcome, TransportType } from '../../../api/logs';

export interface LogFilters {
  searchTerm: string;
  method: string;
  statusFilter: string;
  transportFilter?: TransportOutcome;
  transportTypeFilter?: TransportType;
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
  return { searchTerm: '', method: '', statusFilter: '', transportFilter: undefined, transportTypeFilter: undefined,
    requestTypeFilter: '', hasRetryFilter: undefined, timeRangeType: 'recent', recentHours: 1,
    customStartTime: '', customEndTime: '', sortBy: 'timestamp', sortOrder: 'desc', page: 1 };
}

export function countLogFilters(filters: LogFilters): number {
  const { searchTerm, method, statusFilter, transportFilter, transportTypeFilter, requestTypeFilter,
    hasRetryFilter, timeRangeType, recentHours, sortBy, sortOrder } = filters;
  return [searchTerm.trim(), method, statusFilter, transportFilter !== undefined, transportTypeFilter !== undefined,
    requestTypeFilter, hasRetryFilter !== undefined,
    timeRangeType !== 'all' && timeRangeType !== 'recent' || recentHours !== 1,
    sortBy !== 'timestamp' || sortOrder !== 'desc'].filter(Boolean).length;
}
