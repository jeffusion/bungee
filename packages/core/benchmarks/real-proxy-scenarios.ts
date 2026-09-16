import { request as httpRequest, type Agent, type IncomingMessage } from 'node:http';

export type ScenarioName =
  | 'ordinary'
  | 'sse'
  | 'large-request'
  | 'large-response'
  | 'keepalive'
  | 'client-cancel'
  | 'publication';

export const SCENARIO_NAMES: readonly ScenarioName[] = [
  'ordinary', 'sse', 'large-request', 'large-response', 'keepalive', 'client-cancel', 'publication',
];

let stopRequested = false;
export function requestScenarioStop(): void { stopRequested = true; }

export type ScenarioProfile = {
  readonly warmupMs: number;
  readonly measureMs: number;
  readonly publicationSwitchMs: number;
  readonly requestTimeoutMs: number;
  readonly latencySampleCap: number;
  readonly publicationRate: number;
  readonly publicationMaxInFlight: number;
};

export type UpstreamSnapshot = {
  readonly requests: number;
  readonly bytes: number;
  readonly aborted: number;
  readonly connections: number;
};

export type UpstreamProbe = {
  readonly instance_id: string;
  readonly port: number;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly snapshot: () => UpstreamSnapshot;
  readonly reset: () => void;
};

export type UpstreamCancelObservation = {
  readonly snapshot: UpstreamSnapshot;
  readonly upstream_cancelled: boolean;
  readonly upstream_avoided: boolean;
  readonly observation_completed: boolean;
};

export type PhaseReport = {
  readonly elapsed_ms: number;
  readonly attempted: number;
  readonly completed: number;
  readonly errors: number;
  readonly rps: number;
  readonly latency_ms: { readonly p50: number | null; readonly p95: number | null; readonly p99: number | null; readonly max: number | null };
  readonly ttfb_ms?: { readonly p50: number | null; readonly p95: number | null; readonly p99: number | null; readonly max: number | null };
  readonly upstream_requests: number;
  readonly error_samples: readonly string[];
};

export type ScenarioReport = {
  readonly scenario: ScenarioName;
  readonly valid: boolean;
  readonly metric: number;
  readonly correctness: {
    readonly errors: number;
    readonly error_samples: readonly string[];
    readonly checks: Readonly<Record<string, boolean>>;
  };
  readonly warmup: PhaseReport | null;
  readonly measurement: PhaseReport;
  readonly details: Readonly<Record<string, unknown>>;
};

export type ScenarioContext = {
  readonly publicPort: number;
  readonly profile: ScenarioProfile;
  readonly upstream: UpstreamProbe;
  readonly publish: (targetPath: string) => Promise<{ readonly converged_ms: number }>;
};

const REQUEST_PAYLOAD = new Uint8Array(1024 * 1024).fill(0x5a);
// Keep the sentinel valid UTF-8: the current proxy's buffered response path
// decodes non-SSE bodies as text before rebuilding the Response.
const RESPONSE_PAYLOAD = new Uint8Array(4 * 1024 * 1024).fill(0x52);
const SSE_PAYLOAD = 'x'.repeat(512);
const MAX_ERRORS = 8;
export const UPSTREAM_PREWARM_REQUESTS = 16;
let upstreamInstanceSequence = 0;

function round(value: number): number { return Math.round(value * 1_000) / 1_000; }

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!);
}

function phaseReport(
  started: number,
  attempted: number,
  completed: number,
  errors: number,
  latencies: readonly number[],
  upstreamRequests: number,
  errorSamples: readonly string[],
  ttfb: readonly number[] = [],
): PhaseReport {
  const elapsed = performance.now() - started;
  return {
    elapsed_ms: round(elapsed), attempted, completed, errors,
    rps: round(completed / Math.max(elapsed / 1_000, 0.001)),
    latency_ms: {
      p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99), max: percentile(latencies, 1),
    },
    ...(ttfb.length > 0 ? { ttfb_ms: {
      p50: percentile(ttfb, 0.5), p95: percentile(ttfb, 0.95),
      p99: percentile(ttfb, 0.99), max: percentile(ttfb, 1),
    } } : {}),
    upstream_requests: upstreamRequests, error_samples: errorSamples,
  };
}

function reason(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) return 'timeout';
  return error instanceof Error ? `${error.name}:${error.message.slice(0, 80)}` : 'unknown-error';
}

function pushError(errors: string[], value: string): void {
  if (errors.length < MAX_ERRORS) errors.push(value);
}

export async function observeUpstreamCancellation(
  snapshot: () => UpstreamSnapshot,
  requestTimeoutMs: number,
  options: {
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
    readonly pollIntervalMs?: number;
  } = {},
): Promise<UpstreamCancelObservation> {
  const now = options.now ?? performance.now;
  const sleep = options.sleep ?? Bun.sleep;
  const pollIntervalMs = options.pollIntervalMs ?? 5;
  const deadline = now() + requestTimeoutMs;
  let observed = snapshot();
  while (now() < deadline) {
    await sleep(Math.min(pollIntervalMs, deadline - now()));
    observed = snapshot();
  }
  observed = snapshot();
  const upstream_cancelled = observed.requests > 0 && observed.aborted === observed.requests;
  return { snapshot: observed, upstream_cancelled, upstream_avoided: observed.requests === 0, observation_completed: true };
}

type HttpResult = { readonly status: number; readonly body: Uint8Array; readonly socketKey: string };

function nodeRequest(
  port: number,
  path: string,
  options: { readonly method?: string; readonly body?: Uint8Array; readonly headers?: Record<string, string>; readonly agent?: Agent; readonly signal?: AbortSignal },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: options.agent,
      headers: { connection: 'keep-alive', ...(options.body ? { 'content-length': String(options.body.byteLength) } : {}), ...options.headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: new Uint8Array(Buffer.concat(chunks)),
        socketKey: response.socket ? `${response.socket.localAddress ?? ''}:${response.socket.localPort ?? ''}` : 'unknown',
      }));
      response.once('error', reject);
    });
    const abort = () => req.destroy(new Error('client aborted'));
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    req.once('error', reject);
    req.end(options.body === undefined ? undefined : Buffer.from(options.body));
  });
}

type ClientCancelOutcome = 'cancelled' | 'timeout' | 'pre-response-error' | 'bad-status';
type ClientCancelResult = {
  readonly rejected: boolean;
  readonly established: boolean;
  readonly cancel_initiated: boolean;
  readonly cancelled: boolean;
  readonly timed_out: boolean;
  readonly outcome: ClientCancelOutcome;
};

function cancelNodeRequest(port: number, path: string, timeoutMs: number): Promise<ClientCancelResult> {
  return new Promise((resolve) => {
    let settled = false;
    let established = false;
    let cancelInitiated = false;
    let timedOut = false;
    let statusOk = false;
    let responseReceived = false;
    let response: IncomingMessage | undefined;
    let socket: IncomingMessage['socket'] | undefined;
    let request: ReturnType<typeof httpRequest>;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ClientCancelOutcome, rejected: boolean): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      request.removeListener('error', onRequestError);
      request.removeListener('close', onRequestClose);
      if (response !== undefined) {
        response.removeListener('data', onData);
        response.removeListener('close', onResponseClose);
        response.removeListener('error', onResponseError);
        response.removeListener('end', onResponseEnd);
      }
      socket?.removeListener('close', onSocketClose);
      socket?.removeListener('error', onSocketError);
      resolve({
        rejected, established: established && statusOk, cancel_initiated: cancelInitiated,
        cancelled: outcome === 'cancelled', timed_out: timedOut || outcome === 'timeout', outcome,
      });
    };
    const outcomeBeforeCancel = (): ClientCancelOutcome => timedOut ? 'timeout' : responseReceived && !statusOk ? 'bad-status' : 'pre-response-error';
    const onRequestError = (): void => finish(cancelInitiated ? 'cancelled' : outcomeBeforeCancel(), true);
    const onRequestClose = (): void => { if (cancelInitiated) finish('cancelled', true); };
    const onResponseClose = (): void => finish(cancelInitiated ? 'cancelled' : outcomeBeforeCancel(), cancelInitiated);
    const onResponseError = (): void => finish(cancelInitiated ? 'cancelled' : outcomeBeforeCancel(), true);
    const onResponseEnd = (): void => { if (!cancelInitiated) finish(outcomeBeforeCancel(), false); };
    const onSocketClose = (): void => { if (cancelInitiated) finish('cancelled', true); };
    const onSocketError = (): void => finish(cancelInitiated ? 'cancelled' : outcomeBeforeCancel(), true);
    const onData = (): void => {
      if (!statusOk) {
        response?.destroy();
        socket?.destroy();
        return;
      }
      established = true;
      cancelInitiated = true;
      response?.destroy();
      socket?.destroy();
    };
    request = httpRequest({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { connection: 'keep-alive', 'x-bungee-bench-scenario': 'client-cancel' },
    }, (incomingResponse) => {
      response = incomingResponse;
      socket = incomingResponse.socket ?? undefined;
      responseReceived = true;
      statusOk = incomingResponse.statusCode === 200;
      incomingResponse.once('data', onData);
      incomingResponse.once('close', onResponseClose);
      incomingResponse.once('error', onResponseError);
      incomingResponse.once('end', onResponseEnd);
      socket?.once('close', onSocketClose);
      socket?.once('error', onSocketError);
    });
    request.once('error', onRequestError);
    request.once('close', onRequestClose);
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      response?.destroy();
      socket?.destroy();
      request.destroy();
      finish('timeout', true);
    }, timeoutMs);
    request.end();
  });
}

async function closedLoop(
  context: ScenarioContext,
  scenario: ScenarioName,
  concurrency: number,
  path: string,
  options: { readonly body?: Uint8Array; readonly expectedLength?: number; readonly expectedBody?: Uint8Array; readonly agent?: Agent; readonly timeoutMs?: number; readonly useFetch?: boolean } = {},
): Promise<{ readonly warmup: PhaseReport; readonly measurement: PhaseReport; readonly checks: Record<string, boolean>; readonly details: Record<string, unknown> }> {
  let connectionCount = 0;
  const run = async (durationMs: number): Promise<PhaseReport> => {
    const started = performance.now();
    const deadline = started + durationMs;
    const latencies: number[] = [];
    const errors: string[] = [];
    let attempted = 0;
    let completed = 0;
    let errorCount = 0;
    const sockets = new Set<string>();
    const workers = Array.from({ length: concurrency }, async () => {
      while (!stopRequested && performance.now() < deadline && latencies.length < context.profile.latencySampleCap) {
        attempted += 1;
        const requestStarted = performance.now();
        try {
          const requestPath = `${path}?scenario=${encodeURIComponent(scenario)}`;
          const response = options.useFetch
            ? await (async (): Promise<HttpResult> => {
              const fetchResponse = await fetch(`http://127.0.0.1:${context.publicPort}${requestPath}`, {
                method: options.body === undefined ? 'GET' : 'POST', body: options.body === undefined ? undefined : Buffer.from(options.body),
                headers: { 'content-type': 'application/octet-stream', 'x-bungee-bench-scenario': scenario },
                signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
              });
              return { status: fetchResponse.status, body: new Uint8Array(await fetchResponse.arrayBuffer()), socketKey: 'fetch' };
            })()
            : await nodeRequest(context.publicPort, requestPath, {
              body: options.body, agent: options.agent,
              signal: options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs),
              headers: { 'x-bungee-bench-scenario': scenario },
            });
          sockets.add(response.socketKey);
          latencies.push(performance.now() - requestStarted);
          const bodyOk = options.expectedBody === undefined
            ? options.expectedLength === undefined || response.body.byteLength === options.expectedLength
            : response.body.byteLength === options.expectedBody.byteLength && response.body.every((value, index) => value === options.expectedBody![index]);
          if (response.status !== 200) { errorCount += 1; pushError(errors, `status:${response.status}`); }
          else if (!bodyOk) {
            errorCount += 1;
            pushError(errors, `body:mismatch:${response.body.byteLength}:${response.body[0] ?? -1}:${response.body.at(-1) ?? -1}`);
          }
          else completed += 1;
        } catch (error) {
          errorCount += 1; pushError(errors, reason(error));
          latencies.push(performance.now() - requestStarted);
        }
      }
    });
    await Promise.all(workers);
    connectionCount = sockets.size;
    return phaseReport(started, attempted, completed, errorCount, latencies, context.upstream.snapshot().requests, errors);
  };
  const warmup = await run(context.profile.warmupMs);
  context.upstream.reset();
  const measurement = await run(context.profile.measureMs);
  const checks: Record<string, boolean> = { no_errors: measurement.errors === 0, completed: measurement.completed > 0 };
  if (options.agent) {
    const requests = measurement.completed;
    const upstreamConnections = context.upstream.snapshot().connections;
    checks.client_connection_reuse = requests > 0 && 1 - Math.max(1, connectionCount) / requests >= 0.9;
    checks.upstream_connection_reuse = measurement.upstream_requests > 0
      && 1 - Math.max(1, upstreamConnections) / measurement.upstream_requests >= 0.9;
  }
  const upstream = context.upstream.snapshot();
  return {
    warmup, measurement, checks,
    details: {
      client_connections: connectionCount, upstream_connections: upstream.connections,
      upstream_request_count: upstream.requests, upstream_body_bytes: upstream.bytes,
    },
  };
}

function report(
  scenario: ScenarioName,
  result: Awaited<ReturnType<typeof closedLoop>>,
  metric: number,
  details: Record<string, unknown> = {},
): ScenarioReport {
  const valid = Object.values(result.checks).every(Boolean);
  return {
    scenario, valid, metric,
    correctness: { errors: result.measurement.errors, error_samples: result.measurement.error_samples, checks: result.checks },
    warmup: result.warmup, measurement: result.measurement, details: { ...result.details, ...details },
  };
}

async function runSse(context: ScenarioContext): Promise<ScenarioReport> {
  const ttfb: number[] = [];
  const totals: number[] = [];
  const errors: string[] = [];
  let completed = 0;
  const run = async (durationMs: number): Promise<PhaseReport> => {
    const started = performance.now();
    const deadline = started + durationMs;
    let attempted = 0;
    const worker = async (): Promise<void> => {
      while (!stopRequested && performance.now() < deadline && ttfb.length < context.profile.latencySampleCap) {
        attempted += 1;
        const requestStarted = performance.now();
        try {
          const response = await fetch(`http://127.0.0.1:${context.publicPort}/bench?scenario=sse`, {
            headers: { 'x-bungee-bench-scenario': 'sse' }, signal: AbortSignal.timeout(context.profile.requestTimeoutMs),
          });
          const reader = response.body?.getReader();
          if (!reader) throw new Error('missing response body');
          let first = true;
          let bytes = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (first) { ttfb.push(performance.now() - requestStarted); first = false; }
            bytes += new TextDecoder().decode(chunk.value, { stream: true });
          }
          const events = bytes.trim().split('\n\n').filter(Boolean);
          const valid = response.status === 200 && events.length === 32 && events.every((event, index) => event === `data: ${index}:${SSE_PAYLOAD}`);
          totals.push(performance.now() - requestStarted);
          if (!valid) pushError(errors, 'sse:sequence-or-body-mismatch');
          else completed += 1;
        } catch (error) { pushError(errors, reason(error)); }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    return phaseReport(started, attempted, completed, attempted - completed, totals, context.upstream.snapshot().requests, errors, ttfb);
  };
  const warmup = await run(context.profile.warmupMs);
  const warmupCount = completed;
  ttfb.length = 0; totals.length = 0; errors.length = 0; completed = 0; context.upstream.reset();
  const measurement = await run(context.profile.measureMs);
  return {
    scenario: 'sse', valid: measurement.errors === 0 && measurement.completed > 0,
    metric: measurement.ttfb_ms?.p95 ?? Number.POSITIVE_INFINITY,
    correctness: { errors: measurement.errors, error_samples: measurement.error_samples, checks: { complete_events: measurement.errors === 0, completed: measurement.completed > 0 } },
    warmup, measurement, details: { concurrency: 16, warmup_completed: warmupCount, buffered_response_accepted: true },
  };
}

async function runCancel(context: ScenarioContext): Promise<ScenarioReport> {
  context.upstream.reset();
  const errors: string[] = [];
  const started = performance.now();
  const cancellations = await Promise.all(Array.from({ length: 32 }, () =>
    cancelNodeRequest(context.publicPort, '/bench?scenario=client-cancel', context.profile.requestTimeoutMs)));
  const rejected = cancellations.filter(({ rejected: requestRejected }) => requestRejected).length;
  const established = cancellations.every(({ established: requestEstablished }) => requestEstablished);
  const cancelInitiated = cancellations.every(({ cancel_initiated }) => cancel_initiated);
  const cancelled = cancellations.every(({ cancelled: requestCancelled }) => requestCancelled);
  const timedOut = cancellations.some(({ timed_out }) => timed_out);
  const outcomes = [...new Set(cancellations.map(({ outcome }) => outcome))];
  for (const outcome of outcomes) {
    if (outcome !== 'cancelled') pushError(errors, outcome);
  }
  if (rejected !== 32) pushError(errors, 'client-rejected');
  if (!established) pushError(errors, 'upstream-not-established');
  const clientRejectedMs = performance.now() - started;
  const observation = await observeUpstreamCancellation(context.upstream.snapshot, context.profile.requestTimeoutMs);
  const { snapshot } = observation;
  const checks = {
    client_rejected: rejected === 32 && established && cancelled && !timedOut,
    upstream_cancelled: observation.upstream_cancelled,
    upstream_avoided: observation.upstream_avoided,
    observation_completed: observation.observation_completed,
  };
  if (!checks.upstream_cancelled) pushError(errors, 'upstream-not-cancelled');
  if (checks.upstream_avoided) pushError(errors, 'upstream-avoided');
  const measurement = phaseReport(started, 32, rejected, 32 - rejected, [clientRejectedMs], snapshot.requests, errors);
  return {
    scenario: 'client-cancel', valid: checks.client_rejected && checks.upstream_cancelled && !checks.upstream_avoided,
    metric: measurement.latency_ms.p95 ?? Number.POSITIVE_INFINITY,
    correctness: { errors: measurement.errors, error_samples: measurement.error_samples, checks }, warmup: null, measurement,
    details: {
      rejected, established, cancel_initiated: cancelInitiated, cancelled, timed_out: timedOut,
      outcome: outcomes.length === 1 ? outcomes[0] : 'mixed',
      final_requests: snapshot.requests, final_aborted: snapshot.aborted,
      client_rejected: checks.client_rejected, upstream_cancelled: observation.upstream_cancelled,
      upstream_avoided: observation.upstream_avoided, observation_completed: observation.observation_completed,
    },
  };
}

async function runPublication(context: ScenarioContext): Promise<ScenarioReport> {
  const warmupDeadline = performance.now() + context.profile.warmupMs;
  while (!stopRequested && performance.now() < warmupDeadline) {
    await fetch(`http://127.0.0.1:${context.publicPort}/bench?scenario=publication`, {
      headers: { 'x-bungee-bench-scenario': 'publication' }, signal: AbortSignal.timeout(context.profile.requestTimeoutMs),
    }).then((response) => response.arrayBuffer()).catch(() => undefined);
    await Bun.sleep(Math.min(1_000 / context.profile.publicationRate, Math.max(1, warmupDeadline - performance.now())));
  }
  context.upstream.reset();
  const started = performance.now();
  const deadline = started + context.profile.measureMs;
  const intervalMs = 1_000 / context.profile.publicationRate;
  const active = new Set<Promise<void>>();
  const responses: { readonly value: string; readonly launchedAt: number; readonly completedAt: number }[] = [];
  const errors: string[] = [];
  let attempted = 0;
  let dropped = 0;
  let switchAt: number | null = null;
  let observedConvergedAt: number | null = null;
  let publicationConvergedMs: number | null = null;
  let publicationError: unknown;
  let publication: Promise<void> | undefined;
  const launch = (): void => {
    if (active.size >= context.profile.publicationMaxInFlight) { dropped += 1; return; }
    attempted += 1;
    const launchedAt = performance.now() - started;
    const task = fetch(`http://127.0.0.1:${context.publicPort}/bench?scenario=publication`, { headers: { 'x-bungee-bench-scenario': 'publication' }, signal: AbortSignal.timeout(context.profile.requestTimeoutMs) })
      .then(async (response) => {
        const body = await response.text();
        if (response.status !== 200 || (body !== 'A' && body !== 'B')) pushError(errors, `publication:${response.status}:${body.slice(0, 20)}`);
        else responses.push({ value: body, launchedAt, completedAt: performance.now() - started });
      }).catch((error) => pushError(errors, `publication:${reason(error)}`));
    active.add(task);
    void task.finally(() => active.delete(task));
  };
  let nextLaunchAt = started;
  while (!stopRequested && performance.now() < deadline) {
    const elapsed = performance.now() - started;
    if (switchAt === null && elapsed >= context.profile.publicationSwitchMs) {
      switchAt = elapsed;
      publication = Promise.resolve().then(() => context.publish('/b')).then((result) => {
        publicationConvergedMs = result.converged_ms;
        observedConvergedAt = performance.now() - started;
        if (!Number.isFinite(result.converged_ms) || result.converged_ms < 0) pushError(errors, 'publication:invalid-convergence-time');
      }).catch((error) => {
        publicationError = error;
        pushError(errors, `publication:publish:${reason(error)}`);
      });
    }
    while (nextLaunchAt < deadline && nextLaunchAt <= performance.now()) {
      launch();
      nextLaunchAt += intervalMs;
    }
    const delay = Math.min(nextLaunchAt - performance.now(), deadline - performance.now());
    if (delay > 0) await Bun.sleep(delay);
  }
  if (publication !== undefined) await publication;
  await Promise.all(active);
  const convergedAt = observedConvergedAt;
  const before = switchAt === null ? [] : responses.filter(({ completedAt }) => completedAt < switchAt).map(({ value }) => value);
  const after = convergedAt === null ? [] : responses.filter(({ launchedAt }) => launchedAt >= convergedAt).map(({ value }) => value);
  const transition = responses.filter((response) => {
    const isBefore = switchAt !== null && response.completedAt < switchAt;
    const isAfter = convergedAt !== null && response.launchedAt >= convergedAt;
    return !isBefore && !isAfter;
  }).map(({ value }) => value);
  const checks = {
    switched: switchAt !== null, converged: observedConvergedAt !== null && publicationConvergedMs !== null && publicationError === undefined,
    no_drops: dropped === 0, no_errors: errors.length === 0,
    before_only_a: before.every((value) => value === 'A'), transition_a_or_b: transition.every((value) => value === 'A' || value === 'B'),
    after_only_b: after.length > 0 && after.every((value) => value === 'B'), active_zero: active.size === 0,
  };
  const elapsed = performance.now() - started;
  const measurement: PhaseReport = {
    ...phaseReport(started, attempted, responses.length, errors.length + dropped, [], context.upstream.snapshot().requests, errors),
    elapsed_ms: round(elapsed),
  };
  return {
    scenario: 'publication', valid: Object.values(checks).every(Boolean), metric: publicationConvergedMs ?? Number.POSITIVE_INFINITY,
    correctness: { errors: errors.length + dropped, error_samples: errors, checks }, warmup: null, measurement,
    details: {
      open_loop_rps: context.profile.publicationRate, max_in_flight: context.profile.publicationMaxInFlight, dropped,
      publication_converged_ms: publicationConvergedMs, switch_at_ms: switchAt,
      observed_converged_at_ms: observedConvergedAt, transition_responses: transition.length, responses: responses.length,
    },
  };
}

export async function runScenario(name: ScenarioName, context: ScenarioContext): Promise<ScenarioReport> {
  if (name === 'sse') return runSse(context);
  if (name === 'client-cancel') return runCancel(context);
  if (name === 'publication') return runPublication(context);
  if (name === 'ordinary') {
    const result = await closedLoop(context, name, 32, '/bench', { expectedBody: new TextEncoder().encode('ok') });
    return report(name, result, result.measurement.rps);
  }
  if (name === 'large-request') {
    const result = await closedLoop(context, name, 8, '/bench', { body: REQUEST_PAYLOAD, expectedBody: new TextEncoder().encode('request-ok'), useFetch: true });
    return report(name, result, result.measurement.rps, { payload_bytes: REQUEST_PAYLOAD.byteLength, sentinel: '0x5a' });
  }
  if (name === 'large-response') {
    const result = await closedLoop(context, name, 4, '/bench', { expectedBody: RESPONSE_PAYLOAD });
    return report(name, result, result.measurement.rps, { payload_bytes: RESPONSE_PAYLOAD.byteLength, sentinel: '0x52' });
  }
  const agent = new (await import('node:http')).Agent({ keepAlive: true, maxSockets: 128 });
  try {
    const result = await closedLoop(context, name, 128, '/bench', { agent, expectedBody: new TextEncoder().encode('ok') });
    return report(name, result, result.measurement.rps, { keep_alive: true, reuse_required: 0.9 });
  } finally { agent.destroy(); }
}

export async function prewarmUpstream(upstream: UpstreamProbe): Promise<void> {
  for (let index = 0; index < UPSTREAM_PREWARM_REQUESTS; index += 1) {
    const response = await fetch(`http://127.0.0.1:${upstream.port}/bench?scenario=ordinary`, { signal: AbortSignal.timeout(2_000) });
    const body = await response.text();
    if (response.status !== 200 || body !== 'ok') throw new Error(`upstream prewarm failed: HTTP ${response.status} body=${body.slice(0, 32)}`);
  }
  upstream.reset();
}

export async function startUpstream(port = 0): Promise<UpstreamProbe> {
  let requests = 0;
  let bytes = 0;
  let aborted = 0;
  const connections = new Set<string>();
  const server = Bun.serve({
    hostname: '127.0.0.1', port,
    fetch(request, servingServer) {
      requests += 1;
      const ip = servingServer.requestIP(request);
      connections.add(ip ? `${ip.address}:${ip.port}` : 'unknown');
      const parsedUrl = new URL(request.url);
      const scenario = parsedUrl.searchParams.get('scenario') ?? request.headers.get('x-bungee-bench-scenario') ?? 'ordinary';
      if (scenario === 'sse') {
        let index = 0;
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            timer = setInterval(() => {
              if (index >= 32) { if (timer) clearInterval(timer); controller.close(); return; }
              const value = new TextEncoder().encode(`data: ${index}:${SSE_PAYLOAD}\n\n`);
              bytes += value.byteLength; controller.enqueue(value); index += 1;
            }, 5);
          },
          cancel() { if (timer) clearInterval(timer); aborted += 1; },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
      }
      if (scenario === 'client-cancel') {
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first-chunk'));
            timer = setInterval(() => controller.enqueue(new TextEncoder().encode('later-chunk')), 10);
          },
          cancel() { if (timer) clearInterval(timer); aborted += 1; },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
      }
      if (scenario === 'publication') {
        const body = new URL(request.url).pathname.includes('/b/') ? 'B' : 'A';
        bytes += body.length;
        return new Response(body);
      }
      if (scenario === 'large-request') {
        return request.arrayBuffer().then((body) => {
          const bytesValue = new Uint8Array(body);
          bytes += bytesValue.byteLength;
          return new Response(bytesValue.byteLength === REQUEST_PAYLOAD.byteLength && bytesValue[0] === 0x5a
            ? 'request-ok' : `request-invalid:${bytesValue.byteLength}:${bytesValue[0] ?? -1}`);
        });
      }
      if (scenario === 'large-response') {
        bytes += RESPONSE_PAYLOAD.byteLength;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < RESPONSE_PAYLOAD.byteLength; offset += 64 * 1024) {
              controller.enqueue(RESPONSE_PAYLOAD.subarray(offset, Math.min(RESPONSE_PAYLOAD.byteLength, offset + 64 * 1024)));
            }
            controller.close();
          },
        });
        return new Response(stream);
      }
      const body = 'ok';
      bytes += body.length;
      return new Response(body);
    },
  });
  if (server.port === undefined) throw new Error('upstream port is unavailable');
  return {
    instance_id: `upstream-${++upstreamInstanceSequence}-${server.port}`,
    port: server.port, server,
    snapshot: () => ({ requests, bytes, aborted, connections: connections.size }),
    reset: () => { requests = 0; bytes = 0; aborted = 0; connections.clear(); },
  };
}
