import type { Page, Request, Route } from 'playwright';

/** Expected failures belong to the exact fixture request that produced them. */
export function collectApiEvidence(page: Page) {
  const errors: string[] = [];
  const expected: Array<{ url: string; method: string; status: number; observed: boolean; consoleObserved: boolean }> = [];
  const cancellations = new Map<Request,{errorText:string;observed:boolean;consoleObserved:boolean}>();
  const consoleErrors: Array<{ text: string; url: string }> = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  page.on('response', response => {
    if (response.status() < 400) return;
    const match = expected.find(item => !item.observed && item.url === response.url()
      && item.method === response.request().method() && item.status === response.status());
    if (match) match.observed = true;
    else errors.push(`Unexpected HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on('requestfailed', request => {
    const expectedFailure=cancellations.get(request);
    if (expectedFailure && !expectedFailure.observed && request.failure()?.errorText === expectedFailure.errorText) { expectedFailure.observed=true;return; }
    errors.push(`Request failed: ${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  return {
    errors,
    expectFailure(request: Request, errorText: string) { cancellations.set(request,{errorText,observed:false,consoleObserved:false}); },
    expectStatus(route: Route, status: number) {
      expected.push({ url: route.request().url(), method: route.request().method(), status, observed: false, consoleObserved: false });
    },
    verify() {
      for (const message of consoleErrors) {
        const match = expected.find(item => !item.consoleObserved && item.observed && item.url === message.url
          && message.text.startsWith(`Failed to load resource: the server responded with a status of ${item.status} `));
        if (match) match.consoleObserved = true;
        else {
          const failure=[...cancellations].find(([request,item])=>item.observed && !item.consoleObserved && request.url()===message.url && message.text===`Failed to load resource: ${item.errorText}`);
          if(failure)failure[1].consoleObserved=true;
          else errors.push(`Console: ${message.url}: ${message.text}`);
        }
      }
      for (const [request,item] of cancellations) if(!item.observed) errors.push(`Expected failure ${item.errorText} ${request.method()} ${request.url()} was not observed`);
      for (const item of expected) if (!item.observed) errors.push(`Expected HTTP ${item.status} ${item.method} ${item.url} was not observed`);
      if (errors.length) throw new AggregateError(errors.map(message => new Error(message)), 'Browser API evidence failed');
    },
  };
}
