import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Page, Request, Route } from 'playwright';
import { collectApiEvidence } from '../../helpers/editors/api-evidence';
import { observeNetwork } from '../../helpers/dashboard/network';

// Drive Playwright's event contract without starting a browser or service.
function fixture() {
  const events = new EventEmitter();
  const request = {
    url: () => 'http://fixture.test/api/config', method: () => 'PUT',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
  } as Request;
  const message = (text = 'Failed to load resource: net::ERR_CONNECTION_RESET') => ({
    type: () => 'error', text: () => text, location: () => ({ url: request.url() }),
  });
  return { events, request, message, page: events as unknown as Page };
}

describe('browser error evidence', () => {
  test('an expected network error requires the exact Request and consumes its console once', () => {
    const f = fixture(), evidence = collectApiEvidence(f.page);
    evidence.expectFailure(f.request, 'net::ERR_CONNECTION_RESET');
    f.events.emit('requestfailed', f.request);
    f.events.emit('console', f.message());
    expect(() => evidence.verify()).not.toThrow();
    f.events.emit('console', f.message());
    expect(() => evidence.verify()).toThrow('Browser API evidence failed');
  });

  for (const kind of ['unobserved', 'console-only', 'different-request', 'different-reason'] as const) {
    test(`a ${kind} failure cannot satisfy a network fault budget`, () => {
      const f = fixture(), evidence = collectApiEvidence(f.page);
      evidence.expectFailure(f.request, 'net::ERR_CONNECTION_RESET');
      if (kind === 'console-only') f.events.emit('console', f.message());
      if (kind === 'different-request') f.events.emit('requestfailed', { ...f.request });
      if (kind === 'different-reason') f.events.emit('requestfailed', Object.assign(f.request, { failure: () => ({ errorText: 'net::ERR_ABORTED' }) }));
      expect(() => evidence.verify()).toThrow('Browser API evidence failed');
    });
  }

  test('an expected HTTP error requires its response and never hides another status', () => {
    const f = fixture(), evidence = collectApiEvidence(f.page);
    evidence.expectStatus({ request: () => f.request } as Route, 409);
    expect(() => evidence.verify()).toThrow('Browser API evidence failed');
    // Use a fresh collector: a failed verification must not be reused as passing evidence.
    const next = fixture(), current = collectApiEvidence(next.page);
    current.expectStatus({ request: () => next.request } as Route, 409);
    next.events.emit('response', { status: () => 409, request: () => next.request, url: next.request.url });
    next.events.emit('console', next.message('Failed to load resource: the server responded with a status of 409 (Conflict)'));
    expect(() => current.verify()).not.toThrow();
    next.events.emit('response', { status: () => 500, request: () => next.request, url: next.request.url });
    expect(() => current.verify()).toThrow('Browser API evidence failed');
  });

  test('Dashboard cancellation observes its exact request before completing the action', async () => {
    const f = fixture(), errors: string[] = [], network = observeNetwork(f.page, errors);
    await network.expectFailure(f.request, 'net::ERR_CONNECTION_RESET', async () => {
      expect(() => network.assertSettled()).toThrow();
      f.events.emit('requestfailed', f.request);
      f.events.emit('console', f.message());
    });
    network.assertSettled(); expect(errors).toEqual([]);
    f.events.emit('requestfailed', { ...f.request });
    expect(errors).toHaveLength(1);
  });

  test('Dashboard console alone cannot prove a registered HTTP failure occurred', () => {
    const f = fixture(), errors: string[] = [], network = observeNetwork(f.page, errors);
    network.expectHttpError(f.request, 503);
    f.events.emit('console', f.message('Failed to load resource: the server responded with a status of 503 (Service Unavailable)'));
    expect(() => network.assertSettled()).toThrow();
    f.events.emit('response', { status: () => 503, request: () => f.request });
    network.assertSettled(); expect(errors).toEqual([]);
    f.events.emit('console', f.message('Failed to load resource: the server responded with a status of 503 (Service Unavailable)'));
    expect(errors).toHaveLength(1);
  });
});
