import {randomUUID} from 'node:crypto';
import type {AsyncConfigRepository} from '../config-storage';
import type {RuntimeRecoveryBudget, RuntimeRecoverySample} from '../config-storage/runtime-recovery-budget';
import {kernelMonotonicNowNs, readKernelDeadlineClockId} from './kernel-monotonic-clock';
import {createKernelExitTimer, hasWholeInstanceSupervisor} from './kernel-exit-timer';

export type ComponentRecoveryRepository = Pick<AsyncConfigRepository,'getRuntimeRecoveryStartupGate'|'consumeRuntimeRecoveryRestartTicket'|'observeRuntimeRecoveryHealth'>;
export class ComponentRecoveryStopped extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** One physical master owns one failure flight; storage records the budget across starts. */
export class ComponentRecovery {
  state: 'healthy'|'recovering'|'stopped' = 'healthy';
  reason: string | null = null;
  budget: RuntimeRecoveryBudget | null = null;
  private flight: Promise<void> | null = null;
  private keeper: ReturnType<typeof setInterval> | null = null;
  private healthFlight: Promise<void> | null = null;
  private timerArmed = false;
  private disposed = false;
  readonly sample: () => RuntimeRecoverySample;
  constructor(readonly owner: string, readonly bootId: string, private readonly options: {
    nowNs: () => bigint;
    supervisor: boolean;
    timer: {arm(deadline: bigint): void; dispose(): void} | null;
    exit: (code: number) => void;
    sleep: (ms: number) => Promise<void>;
  }) { this.sample = () => ({owner,boot_id:bootId,monotonic_ns:options.nowNs().toString()}); }

  static async create(owner: string): Promise<ComponentRecovery> {
    const bootId = await readKernelDeadlineClockId();
    const supervisor = hasWholeInstanceSupervisor();
    let timer: ReturnType<typeof createKernelExitTimer> | null = null;
    if (supervisor) { try { timer = createKernelExitTimer(); } catch { /* Unavailable hard exit stays stopped on failure. */ } }
    return new ComponentRecovery(owner,bootId,{nowNs:kernelMonotonicNowNs,supervisor,timer,
      exit:code => process.exit(code),sleep:ms => new Promise(resolve => setTimeout(resolve,ms))});
  }
  stop(reason: string): void {
    this.state = 'stopped'; this.reason = reason;
    // Docker must see a live stopped master, rather than another exited process.
    if (!this.disposed) this.keeper ??= setInterval(() => {},60_000);
  }
  async startup(repository: ComponentRecoveryRepository): Promise<void> {
    try {
      while (true) {
        const gate = await repository.getRuntimeRecoveryStartupGate(this.sample());
        this.budget = gate.budget;
        if (gate.kind === 'stopped') { this.stop(gate.reason); throw new ComponentRecoveryStopped(gate.reason); }
        if (gate.kind === 'ready') { this.state = 'healthy'; this.reason = null; return; }
        this.state = 'recovering'; this.reason = 'restart_backoff';
        await this.options.sleep(Math.max(1,Math.min(gate.remaining_ms,1000)));
      }
    } catch (error) {
      if (!(error instanceof ComponentRecoveryStopped)) this.stop('restart_budget_unavailable');
      throw error instanceof ComponentRecoveryStopped ? error : new ComponentRecoveryStopped(this.reason!);
    }
  }
  fail(reason: string, repository: ComponentRecoveryRepository | null, shutdown: () => Promise<void>, deadlineNs: bigint): Promise<void> {
    if (this.flight !== null) return this.flight;
    this.state = 'recovering'; this.reason = reason;
    this.flight = (async () => {
      if (!repository) { this.stop('restart_budget_unavailable'); return; }
      if (!this.options.supervisor || !this.options.timer) { this.stop('whole_instance_exit_unavailable'); return; }
      try { this.budget = await repository.consumeRuntimeRecoveryRestartTicket(randomUUID(),this.sample()); }
      catch (error) {
        this.stop((error as {code?:string})?.code === 'attempts_exhausted' ? 'restart_budget_exhausted' : 'restart_budget_unavailable'); return;
      }
      // Manual shutdown owns closure once requested; a late ticket ACK cannot restart its timer or keeper.
      if (this.disposed) return;
      try { this.options.timer.arm(deadlineNs); this.timerArmed = true; }
      catch { this.stop('whole_instance_exit_unavailable'); return; }
      // A cleanup exception cannot turn an accepted whole-domain restart into a lock-release claim.
      try { await shutdown(); } finally { this.options.exit(1); }
    })();
    return this.flight;
  }
  observe(repository: ComponentRecoveryRepository, healthy: boolean): Promise<void> {
    if (this.state !== 'healthy') return Promise.resolve();
    if (this.healthFlight !== null) return this.healthFlight;
    this.healthFlight = repository.observeRuntimeRecoveryHealth(this.sample(),healthy)
      .then(budget => {this.budget = budget;}).finally(() => {this.healthFlight = null;});
    return this.healthFlight;
  }
  remainingRetryMs(): number | null {
    if (!this.budget?.retry_at_ns || this.budget.retry_boot_id !== this.bootId) return null;
    const remaining = BigInt(this.budget.retry_at_ns) - this.options.nowNs();
    return Number(remaining > 0n ? (remaining + 999_999n) / 1_000_000n : 0n);
  }
  dispose(): void {
    this.disposed = true;
    if (this.keeper !== null) {clearInterval(this.keeper);this.keeper=null;}
    // Never disarm a timer after a restart ticket was accepted.
    if (!this.timerArmed) this.options.timer?.dispose();
  }
}
