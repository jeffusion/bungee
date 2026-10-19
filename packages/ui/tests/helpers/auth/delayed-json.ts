import {expect, type BrowserContext, type Page} from 'playwright/test';

/** Keep normal fetch/abort semantics; delay only JSON after the real body has arrived. */
export async function delayJsonDelivery(context: BrowserContext, pathname: string, urls: string[]) {
  await context.addInitScript(({pathname, urls}) => {
    const original = window.fetch;
    const deliveries: Record<string, {received: boolean; delivered: boolean; release: () => void}> = {};
    (window as any).jsonDeliveries = deliveries;
    window.fetch = Object.assign(async (...args: Parameters<typeof window.fetch>) => {
      const response = await original(...args);
      if (new URL(response.url).pathname !== pathname) return response;
      const request = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
      const body = await request.clone().json();
      if (!urls.includes(body.url)) return response;
      const data = await response.json();
      let release!: () => void;
      const pending = new Promise(resolve => { release = () => resolve(data); });
      const delivery: (typeof deliveries)[string] = {received:true,delivered:false,release};
      deliveries[body.url] = delivery;
      response.json = async () => {
        const value = await pending;
        // Queue the checkpoint after the caller's await continuation has run.
        queueMicrotask(() => queueMicrotask(() => { delivery.delivered = true; }));
        return value;
      };
      return response;
    }, original);
  }, {pathname, urls});
}

export async function releaseJsonDelivery(page: Page, url: string) {
  await page.evaluate(url => (window as any).jsonDeliveries[url].release(), url);
  await expect.poll(() => page.evaluate(url => (window as any).jsonDeliveries[url]?.delivered, url)).toBe(true);
}
