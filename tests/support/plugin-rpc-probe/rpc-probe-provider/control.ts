/**
 * Control entry of the rpc-probe provider fixture.
 *
 * It publishes a REAL control-process RPC service through the public plugin SDK surface
 * (`context.services.rpc.publish`) and exposes one read-only control API (`/state`) that
 * the acceptance test polls. Two call kinds are covered:
 *
 *  - `query` methods (`echo`, `pulse`, `slow`, `report`) used for startup/background
 *    evidence and for the caller-cancel proof;
 *  - one `command` method (`allocate`) declared as `local-transaction` with a
 *    host atomic planner, so the host journal owns exactly-once semantics.
 *
 * The file is deliberately import-free and therefore relocation-safe: the production
 * control artifact loader compiles it from the copied plugin directory.
 */

/** Service contract id; must match the consumer's identical literal. */
export const RPC_PROBE_SERVICE_ID = 'rpc-probe.control.v1';
/** Stable operation id the consumer repeats to prove idempotency across workers/restart. */
export const RPC_PROBE_OPERATION_ID = 'rpc-probe.allocate.v1';

/**
 * Contract literal kept byte-for-byte equivalent to the consumer's copy. Every method uses
 * the `json` schema so the fixture does not depend on a generated SDK type.
 */
const CONTRACT = {
  id: RPC_PROBE_SERVICE_ID,
  version: 1,
  methods: {
    echo: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    pulse: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    slow: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    admin: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['management'] },
    report: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['bootstrap', 'background'] },
    crashStatus: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['background'] },
    crashHold: { kind: 'query', input: { type: 'json' }, output: { type: 'json' }, purposes: ['background'] },
    crashCommand: { kind: 'command', input: { type: 'json' }, output: { type: 'json' }, purposes: ['background'],
      command: { deduplication: 'external-contract', resultRetentionMs: null, quotaBytes: 65536, maxResultBytes: 8192 } },
    allocate: {
      kind: 'command',
      input: { type: 'json' },
      output: { type: 'json' },
      purposes: ['bootstrap', 'background'],
      command: {
        deduplication: 'local-transaction',
        resultRetentionMs: null,
        quotaBytes: 65536,
        maxResultBytes: 8192,
      },
    },
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function createControl(context: any) {
  const state = {
    /** Planner invocations in THIS control instance; proves the side effect is not redone. */
    crashArmed: false,
    shutdownGate: false,
    shutdownActivePids: new Set<number>(),
    crashTarget: 0,
    crashEntered: [] as Array<{pid: number; kind: string}>,
    plannerRuns: 0,
    /** Monotonic value produced by the first accepted command execution. */
    counter: 0,
    calls: [] as Array<{ method: string; purpose: string | null; pid: number | null }>,
    reports: [] as Array<{ purpose: string | null; payload: any }>,
    slow: { entered: false, aborted: false },
  };
  const record = (method: string, input: any, purpose: any): void => {
    state.calls.push({ method, purpose: purpose ?? null, pid: typeof input?.pid === 'number' ? input.pid : null });
    if (state.calls.length > 128) state.calls.splice(0, state.calls.length - 128);
  };
  const reply = (method: string, input: any, ctx: any) => {
    record(method, input, ctx?.purpose);
    return { ok: true, method, purpose: ctx?.purpose ?? null, pid: typeof input?.pid === 'number' ? input.pid : null };
  };

  return {
    api: [{ path: '/crash', methods: ['POST'], handler: 'crash', invoke: async (ctx: any) => {
      const body = await ctx.request.json();
      if (body.shutdownGate) state.shutdownGate = true;
      else { state.crashTarget = body.pid; state.crashArmed = true; }
      return Response.json({armed: true});
    } }, {
      path: '/state',
      methods: ['GET'],
      handler: 'state',
      invoke: () => Response.json({
        crashEntered: state.crashEntered,
        shutdownActivePids: [...state.shutdownActivePids],
        plannerRuns: state.plannerRuns,
        calls: state.calls,
        reports: state.reports,
        slow: state.slow,
      }),
    }],
    rpc: [],
    start: () => {
      context.services.rpc.publish(CONTRACT, {
        crashStatus: async (input: any) => {
          if (state.shutdownGate) {
            state.shutdownActivePids.add(input.pid);
            try { await new Promise(resolve => setTimeout(resolve, 1_000)); }
            finally { state.shutdownActivePids.delete(input.pid); }
          }
          return { armed: state.crashArmed, pid: state.crashTarget };
        },
        crashHold: (input: any) => { state.crashEntered.push({pid: input.pid, kind: 'query'}); return new Promise(() => {}); },
        crashCommand: (input: any) => { state.crashEntered.push({pid: input.pid, kind: 'command'}); return new Promise(() => {}); },
        echo: (input: any, ctx: any) => reply('echo', input, ctx),
        pulse: (input: any, ctx: any) => reply('pulse', input, ctx),
        admin: (input: any, ctx: any) => reply('admin', input, ctx),
        // Gated query: the handler only settles when its invocation is cancelled. A caller
        // that aborts therefore never receives a business result.
        slow: (input: any, ctx: any) => new Promise((resolve) => {
          state.slow.entered = true;
          const finish = (aborted: boolean): void => {
            state.slow.aborted ||= aborted;
            record('slow', input, ctx?.purpose);
            resolve({ ok: true, aborted });
          };
          const signal = ctx?.signal;
          if (signal?.aborted === true) { finish(true); return; }
          if (typeof signal?.addEventListener === 'function') signal.addEventListener('abort', () => finish(true), { once: true });
          // Bounded fallback so a caller that never cancels (or a cancellation the transport
          // does not propagate) still settles the handler instead of leaking a pending task.
          const timer = setTimeout(() => finish(false), 2_000);
          if (typeof timer?.unref === 'function') timer.unref();
        }),
        report: (input: any, ctx: any) => {
          record('report', input, ctx?.purpose);
          state.reports.push({ purpose: ctx?.purpose ?? null, payload: input });
          return { ok: true, stored: state.reports.length };
        },
        // A local-transaction command never executes its ordinary handler; the host atomic
        // planner owns the side effect. This throw is unreachable by contract.
        allocate: () => { throw new Error('local-transaction command must not execute the ordinary handler'); },
      }, {
        crashCommand: { external: { reconcile: () => ({ status: 'unknown' }) } },
        allocate: {
          atomicReadSet: () => ({keys: ['rpc-probe-allocate']}),
          atomic: (_reader: any, execution: any) => {
            state.plannerRuns += 1;
            const value = ++state.counter;
            return {
              mutations: [{ key: 'rpc-probe-allocate', expectedVersion: 0, value: { value } }],
              result: { value, plannerRuns: state.plannerRuns },
              // `execution.input` is intentionally not used: the consumer sends a constant
              // command payload so the journal fingerprint is identical across workers and
              // restarts (a per-worker payload would be rejected as a conflict).
            };
          },
        },
      });
    },
    dispose: () => {},
  };
}

export default { createControl };
