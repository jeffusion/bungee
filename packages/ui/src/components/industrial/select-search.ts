export type SelectSearchOption = { value: string; label: string; disabled?: boolean };
export interface SelectRemoteSearch {
  result: { total: number; page: number; pageSize: number; loading: boolean; error: boolean };
  resetKey?: string;
  search: (keyword: string, page: number, debounce: boolean) => void;
  cancel: () => void;
}
export interface SelectSearchLabels {
  search: string; loading: string; error: string; empty: string; retry: string;
  custom: string; loaded: string; complete: string; loadMore: string; clear: string;
}
