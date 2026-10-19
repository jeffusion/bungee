import { expect, test } from 'bun:test';
import { waitForAuthPublication } from '../helpers/auth-publication-readiness';

const runtime = (operation: string | null = 'converged', revision = 2) => ({
  revision, config: { privateFixtureValue: 'must-not-appear-in-diagnostics' },
  publication: { serving_complete: true, serving_revision: revision,
    operation: operation === null ? null : { state: operation }, recovery: null }, workers: [],
});
const options = { base: 'http://fixture.invalid', revision: 2, timeoutMs: 100, pollMs: 1,
  childExited: () => false, childDiagnostic: () => ({ exitCode: null, signal: null }) };

test('auth fixture preserves headers and waits for the target revision and converged operation', async () => {
  const bodies = [runtime('converged', 1), runtime('draining'), runtime('converged')];
  let requests = 0;
  const result = await waitForAuthPublication({ ...options, headers: { authorization: 'Bearer fixture-session' },
    fetch: Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-session');
      return Response.json(bodies[requests++]);
    }, { preconnect: () => {} }) });
  expect(requests).toBe(3); expect(result).toEqual(bodies[2]);
});

test('auth fixture accepts a null operation but never mismatched serving evidence', async () => {
  let requests = 0;
  const result = await waitForAuthPublication({ ...options, fetch: Object.assign(async () => {
    const body = runtime(null);
    if (requests++ === 0) body.publication.serving_revision = 1;
    return Response.json(body);
  }, { preconnect: () => {} }) });
  expect(requests).toBe(2); expect(result.publication.operation).toBeNull();
});

test.each(['failed', 'degraded'])('auth fixture fails immediately on %s publication with safe state evidence', async state => {
  let requests = 0;
  const error = await waitForAuthPublication({ ...options, fetch: Object.assign(async () => {
    requests++; return Response.json(runtime(state));
  }, { preconnect: () => {} }) }).catch(error => error);
  expect(requests).toBe(1); expect(error.message).toContain('publication stopped');
  expect(error.message).toContain(`"operation":"${state}"`);
  expect(error.message).not.toContain('must-not-appear-in-diagnostics');
});

test('auth fixture fails immediately when recovery has stopped', async () => {
  const body: any = runtime(); body.publication.recovery = { state: 'stopped' };
  const error = await waitForAuthPublication({ ...options, fetch: Object.assign(async () => Response.json(body), { preconnect: () => {} }) }).catch(error => error);
  expect(error.message).toContain('publication stopped'); expect(error.message).toContain('"recovery":"stopped"');
});

test('auth fixture consumes persistent 503 responses and reports HTTP status at its deadline', async () => {
  let cancelled = 0, requests = 0;
  const error = await waitForAuthPublication({ ...options, timeoutMs: 30,
    fetch: Object.assign(async () => { requests++; return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }); }, { preconnect: () => {} }),
  }).catch(error => error);
  expect(requests).toBeGreaterThan(0); expect(cancelled).toBe(requests);
  expect(error.message).toContain('publication deadline exceeded'); expect(error.message).toContain('"httpStatus":503');
});

test('auth fixture records transport failures rather than discarding every readiness observation', async () => {
  const error = await waitForAuthPublication({ ...options, timeoutMs: 30,
    fetch: Object.assign(async () => { throw new Error('fixture connection refused'); }, { preconnect: () => {} }),
  }).catch(error => error);
  expect(error.message).toContain('"requestError":"fixture connection refused"');
  expect(error.message).toContain('publication deadline exceeded');
});

test('auth fixture absolute deadline also aborts an in-flight request', async () => {
  const started = performance.now(); let aborted = false;
  const error = await waitForAuthPublication({ ...options, timeoutMs: 30,
    fetch: Object.assign(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const stop = () => { aborted = true; reject(new Error('fixture request aborted')); };
      if (init?.signal?.aborted) stop(); else init?.signal?.addEventListener('abort', stop, { once: true });
    }), { preconnect: () => {} }),
  }).catch(error => error);
  expect(aborted).toBe(true); expect(performance.now() - started).toBeLessThan(500);
  expect(error.message).toContain('publication deadline exceeded');
});

test('auth fixture detects signal exits with null exitCode before polling again', async () => {
  let exited = false, requests = 0;
  const error = await waitForAuthPublication({ ...options, childExited: () => exited,
    childDiagnostic: () => ({ exitCode: null, signal: 'SIGTERM' }),
    fetch: Object.assign(async () => { requests++; exited = true; return new Response(null, { status: 503 }); }, { preconnect: () => {} }),
  }).catch(error => error);
  expect(requests).toBe(1); expect(error.message).toContain('master exited before readiness');
  expect(error.message).toContain('"signal":"SIGTERM"');
});
