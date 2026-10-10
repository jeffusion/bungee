/**
 * Worker plugin of the rpc-probe consumer fixture.
 *
 * It consumes the REAL control-provided RPC service during worker bootstrap (the plugin
 * runtime's bootstrap invocation frame), which is only possible when the authenticated
 * peer transport and the control publication directory are both already loaded. It then:
 *
 *  1. performs a bootstrap query (per-worker pid evidence),
 *  2. executes one idempotent `local-transaction` command with a constant operation id,
 *     repeats it, and reads it back through `queryResult`,
 *  3. proves a management-only method is refused from a bootstrap frame,
 *  4. schedules one genuine `background`-purpose round from a module-scope timer (created
 *     outside any invocation frame, so the purpose is NOT inherited from bootstrap),
 *  5. cancels a gated slow query and reports the terminal code.
 *
 * The plugin is intentionally import-free and relocation-safe: it is copied into the
 * fixture's PLUGINS_DIR and imported by the real worker plugin registry.
 */

/** Service contract id; must match the provider's identical literal. */
export const RPC_PROBE_SERVICE_ID = 'rpc-probe.control.v1';
/** Stable operation id repeated by every worker and across restart. */
export const RPC_PROBE_OPERATION_ID = 'rpc-probe.allocate.v1';

/** Contract literal kept byte-for-byte equivalent to the provider's copy. */
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

/** Constant command payload: the journal fingerprint must be identical across workers/restarts. */
const COMMAND_PAYLOAD = Object.freeze({ command: 'rpc-probe' });

let backgroundTask: (() => Promise<void>) | null = null;
let backgroundStopped = false;

// Module-scope pump: this callback is registered while the module is imported (no RPC
// invocation frame exists yet), so when it later drives the client the adapter selects the
// real `background` purpose instead of inheriting the bootstrap frame.
(() => {
  const timer = setInterval(() => {
    if (backgroundStopped) { clearInterval(timer); return; }
    const task = backgroundTask;
    if (task === null) return;
    backgroundTask = null;
    void task().catch(() => { /* reported through the background-error report */ });
  }, 30);
  timer.unref?.();
})();

let crashClient: any = null;
let crashStarted = false;
let crashPolling = false;
const crashTimer = setInterval(() => {
  if (crashStarted) { clearInterval(crashTimer); return; }
  if (!crashClient || crashPolling) return;
  crashPolling = true;
  void (async () => {
    const client = crashClient;
    const status = await client.crashStatus({pid: process.pid});
    if (!status.armed || crashStarted) return;
    crashStarted = true;
    const pid = process.pid;
    if (status.pid !== pid) return;
    await new Promise(resolve => setTimeout(resolve, 50));
    const command = client.crashCommand({pid}, {operationId: `rpc-probe.crash.${pid}`})
      .then(() => 'resolved', (error: any) => codeOf(error));
    // Default caller capacity is 64: leave all 64 real tasks outstanding.
    const holds = Array.from({length: 63}, () => client.crashHold({pid})
      .then(() => 'resolved', (error: any) => codeOf(error)));
    const outcomes = await Promise.all([command, ...holds]);
    // Once physically released, wait for the new control directory to be ready.
    let lastCode = 'none';
    for (let attempt = 0; attempt < 400; attempt++) {
      try {
        const probes = await Promise.all(Array.from({length: 64}, () => client.pulse({pid, note: 'capacity-reclaimed'})));
        const persisted = await client.crashCommand.queryResult(`rpc-probe.crash.${pid}`)
          .then(() => 'resolved', (error: any) => codeOf(error));
        await client.report({pid, phase: 'crash-recovered', commandCode: outcomes[0], settled: outcomes.length,
          capacity: probes.length, persisted});
        return;
      } catch (error: any) { lastCode = codeOf(error); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    process.stderr.write(`rpc_probe_crash_recovery_timeout pid=${pid} lastCode=${lastCode} outcomes=${JSON.stringify(outcomes)}\n`);
  })().catch(() => {}).finally(() => { crashPolling = false; });
}, 100);
crashTimer.unref?.();

function codeOf(error: any): string {
  if (typeof error?.code === 'string') return error.code;
  return error instanceof Error ? 'thrown' : 'unknown';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export class RpcProbeConsumer {
  static readonly name = 'rpc-probe-consumer';
  static readonly version = '1.0.0';
  client: any = null;

  async init(context: any): Promise<void> {
    const client = context?.services?.rpc?.consume('rpc-probe-provider', CONTRACT);
    if (!client) throw new Error('rpc-probe-consumer requires the control RPC client');
    this.client = client;
    crashClient = client;
    const pid = process.pid;
    const checked = async (stage: string, task: Promise<any>): Promise<any> => {
      try { return await task; }
      catch (error) {
        process.stderr.write(`${JSON.stringify({ event: 'rpc_probe_bootstrap_failed', pid, stage, code: codeOf(error) })}\n`);
        throw error;
      }
    };

    const bootstrap = await checked('echo', client.echo({ pid, note: 'bootstrap' }));
    const commandValue = await checked('allocate', client.allocate(COMMAND_PAYLOAD, { operationId: RPC_PROBE_OPERATION_ID }));
    const commandRepeat = await checked('repeat', client.allocate(COMMAND_PAYLOAD, { operationId: RPC_PROBE_OPERATION_ID }));
    const persisted = await checked('result', client.allocate.queryResult(RPC_PROBE_OPERATION_ID));
    let adminCode: string | null = null;
    try { await client.admin({ pid }); } catch (error) { adminCode = codeOf(error); }
    await client.report({
      pid,
      phase: 'bootstrap',
      echoPurpose: bootstrap?.purpose ?? null,
      commandValue,
      commandRepeat,
      persisted,
      adminCode,
    });

    backgroundTask = () => context.services.runBackground(() => this.runBackground(pid));
  }

  private async runBackground(pid: number): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const pulse = await client.pulse({ pid, note: 'background' });
      const commandValue = await client.allocate(COMMAND_PAYLOAD, { operationId: RPC_PROBE_OPERATION_ID });
      const persisted = await client.allocate.queryResult(RPC_PROBE_OPERATION_ID);

      const controller = new AbortController();
      // Install the rejection observer immediately, before yielding: a genuine
      // remote revocation must not become an unhandled worker rejection.
      const slowCall = client.slow({ pid }, { signal: controller.signal })
        .then(() => 'resolved', (error: any) => codeOf(error));
      // Observe this worker's actual callee entry before cancellation; elapsed time
      // cannot establish that a request has crossed the authenticated transport.
      const waitForSlow = async (aborted: boolean) => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const status = await client.crashStatus({ pid }, { timeoutMs: 5_000 });
          if (status.slow !== null && (!aborted || status.slow.aborted)) return status.slow;
          if (Date.now() >= deadline) throw new Error(`slow callee ${aborted ? 'abort' : 'entry'} not observed`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      let calleeEntered = false;
      try {
        const entered = await waitForSlow(false);
        if (entered.settled) throw new Error('slow callee settled before caller cancellation');
        calleeEntered = true;
      } finally { controller.abort(); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<string>(resolve => { timer = setTimeout(() => resolve('no-terminal'), 5_000); });
      let cancelCode = 'no-terminal';
      try {
        cancelCode = await Promise.race([
          slowCall,
          bounded,
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const callee = await waitForSlow(true);

      await client.report({
        pid,
        phase: 'background',
        pulsePurpose: pulse?.purpose ?? null,
        commandValue,
        persisted,
        cancelCode,
        calleeEntered,
        calleeAborted: callee.aborted,
      });
    } catch (error) {
      try { await client.report({ pid, phase: 'background-error', error: codeOf(error) }); } catch { /* best effort */ }
    } finally {
      backgroundStopped = true;
    }
  }

  bodyRequirements() { return { request: 'none' as const }; }

  register(): void {}
  async onDestroy(): Promise<void> { backgroundStopped = true; crashClient = null; clearInterval(crashTimer); }
}

export default RpcProbeConsumer;
