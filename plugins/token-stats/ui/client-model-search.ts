import { createModelSearch, type ModelPage, type ModelSearchState } from './model-search';

export type ClientModelPage = ModelPage<string>;
export type ClientModelSearchState = ModelSearchState<string>;

/** Cancels on every query change, even during debounce, and ignores late responses. */
export function createClientModelSearch(
  load: (path: string, signal: AbortSignal) => Promise<ClientModelPage>,
  publish: (state: ClientModelSearchState) => void,
  delayMs = 250,
) {
  return createModelSearch(load, publish, (keyword: string, page) => {
    const params = new URLSearchParams({ search: keyword, page: String(page), pageSize: '50' });
    return `/models?${params}`;
  }, delayMs);
}
