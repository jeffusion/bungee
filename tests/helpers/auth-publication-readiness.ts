import { setTimeout as sleep } from 'node:timers/promises';
import { FIXTURE_PUBLICATION_WAIT_MS, FIXTURE_REQUEST_TIMEOUT_MS } from './publication-fixture';

/** Auth transitions need both current serving evidence and a converged operation. */
export async function waitForAuthPublication(options: {
  base: string;
  headers?: HeadersInit;
  revision?: number;
  childExited: () => boolean;
  childDiagnostic: () => unknown;
  timeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}): Promise<any> {
  const timeoutMs = options.timeoutMs ?? FIXTURE_PUBLICATION_WAIT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let requestError: string | null = null;
  let publication: Record<string, unknown> | null = null;
  const failure = (reason: string) => new Error(`auth fixture ${reason} ${JSON.stringify({
    expectedRevision: options.revision, timeoutMs, elapsedMs: Math.round(performance.now() - startedAt),
    httpStatus, requestError, publication, child: options.childDiagnostic(),
  })}`);
  try {
    while (!deadline.signal.aborted) {
      if (options.childExited()) throw failure('master exited before readiness');
      let body: any = null;
      try {
        const response = await (options.fetch ?? fetch)(`${options.base}/api/config/runtime`, {
          headers: options.headers,
          signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(FIXTURE_REQUEST_TIMEOUT_MS)]),
        });
        httpStatus = response.status;
        if (response.ok) body = await response.json();
        else await response.body?.cancel();
        requestError = null;
      } catch (error) {
        requestError = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
      if (options.childExited()) throw failure('master exited before readiness');
      if (deadline.signal.aborted) break;
      if (body !== null) {
        const state = body.publication;
        const operation = state?.operation?.state ?? null;
        const recovery = state?.recovery?.state ?? null;
        publication = { revision: body.revision, servingRevision: state?.serving_revision,
          servingComplete: state?.serving_complete, operation, recovery };
        if (operation === 'failed' || operation === 'degraded' || recovery === 'stopped') {
          throw failure('publication stopped');
        }
        if (state?.serving_complete === true && state.serving_revision === body.revision
          && (options.revision === undefined || body.revision === options.revision)
          && (state.operation === null || operation === 'converged')) return body;
      }
      await sleep(options.pollMs ?? 100, undefined, { signal: deadline.signal }).catch(() => undefined);
    }
    throw failure('publication deadline exceeded');
  } finally { clearTimeout(timer); }
}
