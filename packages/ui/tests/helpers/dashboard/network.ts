import assert from 'node:assert/strict';
import type { Page, Request } from 'playwright';

/** Failures own an exact request/reason budget; unrelated network and console errors stay visible. */
export function observeNetwork(page: Page, errors: string[]) {
  type Fault = { request: Request; reason?: string; status?: number; observed: boolean; consoleConsumed: boolean };
  const faults: Fault[] = [];
  const expected = new Map<Request, { reason: string; settle: (error?: Error) => void; fault: Fault }>();
  page.on('console', message => {
    if (message.type() !== 'error') return;
    // Chromium's resource console event has a URL, but no Request identity. Match
    // only one resource message to a registered, independently observed request fault.
    const fault = faults.find(fault => !fault.consoleConsumed && fault.request.url() === message.location().url &&
      (fault.reason ? message.text() === `Failed to load resource: ${fault.reason}` :
        message.text().startsWith(`Failed to load resource: the server responded with a status of ${fault.status} (`)));
    if (fault) { fault.consoleConsumed = true; return; }
    errors.push(message.text());
  });
  page.on('response', response => {
    const fault = faults.find(fault => fault.request === response.request() && fault.status === response.status());
    if (fault) fault.observed = true;
  });
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText ?? 'unknown';
    const entry = expected.get(request);
    if (entry) {
      expected.delete(request);
      if (reason === entry.reason) { entry.fault.observed = true; entry.settle(); return; }
      entry.settle(new Error(`Expected ${entry.reason}, observed ${reason}: ${request.method()} ${request.url()}`));
    }
    errors.push(`Network request failed: ${request.method()} ${request.url()} (${reason})`);
  });
  async function expectFailures(requests: readonly Request[], reason: string, action: () => Promise<unknown>) {
    assert(requests.length > 0, 'An intentional cancellation must identify an in-flight request');
    assert.equal(new Set(requests).size, requests.length, 'Each request has one cancellation budget');
    const observations = requests.map(request => new Promise<void>((resolve, reject) => {
      assert(!expected.has(request), 'A request cannot own two cancellation budgets');
      const fault: Fault = { request, reason, observed: false, consoleConsumed: false };
      faults.push(fault);
      expected.set(request, { reason, fault, settle: error => error ? reject(error) : resolve() });
    }));
    const observed = Promise.all(observations);
    try { await Promise.all([action(), observed]); }
    finally { for (const request of requests) expected.delete(request); }
  }
  return {
    expectAborts: (requests: readonly Request[], action: () => Promise<unknown>) => expectFailures(requests, 'net::ERR_ABORTED', action),
    expectFailure: (request: Request, reason: string, action: () => Promise<unknown>) => expectFailures([request], reason, action),
    expectHttpError(request: Request, status: number) {
      assert(status >= 400 && status <= 599, 'Only explicit HTTP faults can consume resource console messages');
      assert(!faults.some(fault => fault.request === request), 'Each request has one fault budget');
      faults.push({ request, status, observed: false, consoleConsumed: false });
    },
    assertSettled() {
      assert.equal(expected.size, 0, 'Every expected cancellation must be observed');
      assert(faults.every(fault => fault.observed), 'Every expected fault must be independently observed on its exact request');
    },
  };
}
