/**
 * Control entry of the channel-probe cross fixture.
 *
 * It consumes a channel in BOTH directions from the SAME control process:
 *
 *  - `channel-probe-provider`'s snapshot, which is provided by this very process
 *    (the same-process in-process route), and
 *  - `channel-probe-consumer`'s snapshot, which is provided by a supervised
 *    worker (the real cross-process peer route, control -> worker).
 *
 * Both go through the identical host lane engine and limits; only the route
 * differs, which is exactly what this fixture proves.
 */

const CROSS_CONTENT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' }, bytes: { type: 'number', integer: true, minimum: 0 },
    filler: { type: 'string' },
  },
} as const;
export const CROSS_SNAPSHOT_CONTRACT = { id: 'channel-probe.snapshot.v1', version: 1, content: CROSS_CONTENT_SCHEMA } as const;
export const CROSS_WORKER_SNAPSHOT_CONTRACT = { id: 'channel-probe.worker-snapshot.v1', version: 1, content: CROSS_CONTENT_SCHEMA } as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (typeof timer?.unref === 'function') timer.unref(); });
}

/**
 * Module-scope pump: the module is imported WITHOUT any invocation frame, so the
 * probes run as real background work instead of inheriting a closed bootstrap
 * closure (which the host correctly refuses to reuse).
 */
let pendingTasks: Array<() => Promise<void>> = [];
let pumpStopped = false;
(() => {
  const timer = setInterval(() => {
    if (pumpStopped) { clearInterval(timer); return; }
    const task = pendingTasks.shift();
    if (task === undefined) return;
    void task().catch(() => undefined);
  }, 25);
  if (typeof timer?.unref === 'function') timer.unref();
})();

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createControl(context: any) {
  const state: { stopped: boolean; sameProcess: any; crossProcess: any } = { stopped: false, sameProcess: null, crossProcess: null };

  const probe = async (name: string, provider: string, contract: unknown): Promise<void> => {
    const key = name === 'sameProcess' ? 'sameProcess' : 'crossProcess';
    let lastError = 'unavailable';
    for (let attempt = 0; attempt < 240 && !state.stopped; attempt += 1) {
      try {
        const view = context.services.snapshot.consume(provider, contract as never);
        const outcome = await view.sync({ timeoutMs: 10_000 });
        const error = view.status().error;
        if (outcome === 'failed') {
          lastError = error ?? 'failed';
          // Two supervised workers both HONOUR their declared publication, so the
          // global target is genuinely multi-instance: the host must refuse to
          // guess. `ambiguous` is that explicit, deterministic refusal.
          if (name === 'crossProcess' && error === 'ambiguous') {
            state.crossProcess = { outcome: 'failed', error };
            return;
          }
          await sleep(250);
          continue;
        }
        const applied = view.current();
        // During startup only one worker may have published its directory yet.
        // A successful read then is valid; keep probing until BOTH publications
        // are visible before asserting the multi-instance ambiguity.
        if (name === 'crossProcess') { await sleep(250); continue; }
        state[key] = applied === null
          ? { outcome, empty: true }
          : { outcome, version: applied.descriptor.version, size: applied.bytes.byteLength, digest: applied.descriptor.digest, status: view.status().status };
        return;
      } catch (thrown) {
        lastError = typeof (thrown as { code?: unknown })?.code === 'string'
          ? String((thrown as { code: string }).code)
          : thrown instanceof Error ? thrown.message.slice(0, 200) : 'thrown';
        await sleep(250);
      }
    }
    if (!state.stopped) state[key] = { outcome: 'failed', error: lastError };
  };

  return {
    api: [{
      path: '/state',
      methods: ['GET'],
      handler: 'state',
      invoke: () => Response.json({
        sameProcess: state.sameProcess,
        crossProcess: state.crossProcess,
        registryDegraded: false,
      }),
    }],
    rpc: [],
    start: () => {
      pendingTasks.push(() => probe('sameProcess', 'channel-probe-provider', CROSS_SNAPSHOT_CONTRACT));
      pendingTasks.push(() => probe('crossProcess', 'channel-probe-consumer', CROSS_WORKER_SNAPSHOT_CONTRACT));
    },
    dispose: () => { state.stopped = true; },
  };
}

export default { createControl };
