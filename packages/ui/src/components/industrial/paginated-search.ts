export interface ModelPage<T> {
  models: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ModelSearchState<T> extends ModelPage<T> {
  loading: boolean;
  error: boolean;
}

/** Cancels on every query change, even during debounce, and ignores late responses. */
export function createModelSearch<T, Query>(
  load: (path: string, signal: AbortSignal) => Promise<ModelPage<T>>,
  publish: (state: ModelSearchState<T>) => void,
  pathFor: (query: Query, page: number) => string,
  delayMs = 250,
) {
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  function cancel() { generation++; clearTimeout(timer); controller?.abort(); }
  function search(query: Query, page = 1, debounce = true) {
    if (destroyed) return;
    cancel();
    const version = generation;
    publish({ models: [], total: 0, page, pageSize: 50, loading: true, error: false });
    async function run() {
      const request = new AbortController();
      controller = request;
      try {
        const result = await load(pathFor(query, page), request.signal);
        if (!destroyed && version === generation) publish({ ...result, loading: false, error: false });
      } catch {
        if (!destroyed && version === generation && !request.signal.aborted) {
          publish({ models: [], total: 0, page, pageSize: 50, loading: false, error: true });
        }
      }
    }
    if (debounce) timer = setTimeout(() => void run(), delayMs);
    else void run();
  }
  return { search, cancel, destroy() { destroyed = true; cancel(); } };
}
