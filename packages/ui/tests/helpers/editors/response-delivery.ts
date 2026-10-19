import type { Page } from 'playwright';

type JsonResponseMatch = {
  method: string;
  path: string;
  query?: Record<string, string>;
  bodyIncludes?: string;
};
type JsonHold = { name: string; match: JsonResponseMatch; requestId?: number };

/** Read the native response completely, then optionally hold its JSON delivery to the caller. */
export async function recordResponseDelivery(page: Page, path: string, initialHolds: JsonHold[] = []) {
  await page.addInitScript(({ path, initialHolds }) => {
    const host = window as any;
    if (host.editorResponseDelivery) {
      host.editorResponseDelivery.paths.add(path);
      host.editorResponseDelivery.holds.push(...initialHolds);
      return;
    }
    const state = host.editorResponseDelivery = {
      paths: new Set([path]), holds: initialHolds, nextId: 1,
      requests: [] as Array<{ id: number; url: string; method: string; received: boolean; delivered: boolean; release?: () => void }>,
    };
    const originalFetch = window.fetch.bind(window);
    const trackedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const body = typeof init?.body === 'string' ? init.body : '';
      const hold = state.paths.has(url.pathname) ? state.holds.find((item: JsonHold) => item.requestId === undefined
        && item.match.method === method && item.match.path === url.pathname
        && Object.entries(item.match.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value)
        && (item.match.bodyIncludes === undefined || body.includes(item.match.bodyIncludes))) : undefined;
      const entry = state.paths.has(url.pathname)
        ? { id: state.nextId++, url: url.href, method, received: false, delivered: false, release: undefined as (() => void) | undefined }
        : undefined;
      if (entry) state.requests.push(entry);
      if (hold && entry) hold.requestId = entry.id;
      // Preserve the caller's Request, init and AbortSignal exactly.
      const response = await originalFetch(input, init);
      if (entry) {
        const json = response.json.bind(response);
        response.json = async () => {
          const value = await json();
          // Native JSON parsing has consumed the complete response body before the gate opens.
          if (hold) {
            const gate = new Promise<void>(resolve => { entry.release = resolve; });
            entry.received = true;
            await gate;
          } else entry.received = true;
          entry.delivered = true;
          return value;
        };
      }
      return response;
    };
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: trackedFetch });
  }, { path, initialHolds });
}

export async function holdResponseJson(page: Page, name: string, match: JsonResponseMatch) {
  await page.evaluate(({ name, match }) => {
    const state = (window as any).editorResponseDelivery;
    if (state.holds.some((hold: JsonHold) => hold.name === name)) throw new Error(`Duplicate JSON gate: ${name}`);
    state.holds.push({ name, match });
  }, { name, match });
}

export async function waitForResponseReceipt(page: Page, name: string): Promise<number> {
  await page.waitForFunction(name => {
    const state = (window as any).editorResponseDelivery;
    const hold = state.holds.find((item: JsonHold) => item.name === name);
    return state.requests.some((entry: { id: number; received: boolean }) => entry.id === hold?.requestId && entry.received);
  }, name);
  return page.evaluate(name => (window as any).editorResponseDelivery.holds.find((hold: JsonHold) => hold.name === name).requestId, name);
}

export async function releaseResponseJson(page: Page, requestId: number) {
  await page.evaluate(id => {
    const entry = (window as any).editorResponseDelivery.requests.find((entry: { id: number }) => entry.id === id);
    if (!entry?.received || !entry.release || entry.delivered) throw new Error(`JSON response ${id} is not held after receipt`);
    entry.release();
  }, requestId);
}

export async function waitForResponseDelivery(page: Page, requestId: number) {
  await page.waitForFunction(id => (window as any).editorResponseDelivery.requests
    .some((entry: { id: number; delivered: boolean }) => entry.id === id && entry.delivered), requestId);
  // This separate browser task runs after the JSON and API promises and their component continuations.
  await page.evaluate(async () => { await Promise.resolve(); await Promise.resolve(); });
}
