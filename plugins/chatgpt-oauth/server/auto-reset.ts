import { accountListItem, type AccountStore } from './accounts';
import { UsageError, type UsageService, type ResetCredit, type UsageSummary } from './usage';

export const AUTO_RESET_LEAD_MS = 30 * 60 * 1000;
export const AUTO_RESET_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface AccountPlan {
  credits: ResetCredit[];
  leadMinutes: number;
  expiryEnabled: boolean;
  lowBalance: boolean;
  handle?: unknown;
}

/** Injectable timer keeps simulations independent of wall-clock time and real services. */
export interface AutoResetTimer {
  schedule(callback: () => Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultTimer: AutoResetTimer = {
  schedule: (callback, delay) => {
    const timer = setTimeout(() => { void callback(); }, delay);
    timer.unref?.();
    return timer;
  },
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function isAutoResetDue(credit: ResetCredit, now: number, leadMinutes = 30): boolean {
  return credit.status === 'available' && typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt)
    && credit.expiresAt > now && credit.expiresAt - now <= leadMinutes * 60_000;
}

export function isLowBalance(usage: UsageSummary, remainingPercent: number, now: number): boolean {
  if (usage.state !== 'fresh' || usage.error) return false;
  // Duration, not primary/secondary ordering, identifies the unique longest window beyond five hours.
  const windows = [usage.primary, usage.secondary].filter(window => window !== undefined && Number.isFinite(window.windowSeconds) && window.windowSeconds > 18000);
  const longest = Math.max(...windows.map(window => window!.windowSeconds));
  const candidates = windows.filter(window => window!.windowSeconds === longest);
  const window = candidates[0];
  return candidates.length === 1 && window !== undefined && Number.isFinite(window.usedPercent)
    && window.usedPercent >= 0 && window.usedPercent <= 100 && window.resetAt > now
    && window.resetAt - now <= window.windowSeconds * 1000
    && 100 - window.usedPercent <= remainingPercent;
}

/** One host-owned loop, independent of browser tabs, requests and worker instances. */
export class AutoResetScheduler {
  private handle: unknown;
  private started = false;
  private disposed = false;
  private running?: Promise<void>;
  private readonly plans = new Map<string, AccountPlan>();
  private readonly accountRuns = new Map<string, Promise<void>>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly usage: UsageService,
    private readonly signal: AbortSignal,
    private readonly now: () => number = Date.now,
    private readonly timer: AutoResetTimer = defaultTimer,
  ) {}

  start(): void {
    if (this.started || this.disposed || this.signal.aborted) return;
    this.started = true;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.started || this.disposed || this.signal.aborted) return;
    this.handle = this.timer.schedule(async () => {
      try { await this.runOnce(); }
      catch { /* Store failures stop this scan; retry discovery on the next scan, never a pending POST. */ }
      finally { this.schedule(AUTO_RESET_INTERVAL_MS); }
    }, delay);
  }

  runOnce(): Promise<void> {
    if (this.disposed || this.signal.aborted) return Promise.resolve();
    if (!this.running) this.running = this.scan().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async scan(): Promise<void> {
    const accounts = await this.accounts.list();
    const eligible = new Set(accounts.filter(account => account.available && (account.autoResetCredits || account.autoResetOnLowBalance)
      && (!account.pendingAutoReset || this.accountRuns.has(account.id))).map(account => account.id));
    for (const id of this.plans.keys()) if (!eligible.has(id)) this.cancelPlan(id);
    for (const account of accounts) {
      if (this.disposed || this.signal.aborted) return;
      if (!eligible.has(account.id)) continue;
      // An owned redemption will arm its remaining credits when it finishes. Discovery must not cancel that plan.
      if (this.accountRuns.has(account.id)) continue;
      try {
        const snapshot = await this.usage.get(account.id, this.signal, { forceFresh: true });
        if (this.disposed || this.signal.aborted) return;
        // Keep a known deadline on a failed discovery; consumption still requires its own fresh validation.
        if (snapshot.resetCredits.state !== 'fresh') continue;
        this.cancelPlan(account.id);
        if ((snapshot.resetCredits.availableCount ?? 0) <= 0) continue;
        const credits = [...(snapshot.resetCredits.credits ?? [])].filter(credit => credit.status === 'available'
          && typeof credit.expiresAt === 'number' && Number.isFinite(credit.expiresAt) && credit.expiresAt > this.now())
          .sort((a, b) => a.expiresAt! - b.expiresAt!);
        const plan: AccountPlan = { credits, leadMinutes: account.autoResetLeadMinutes, expiryEnabled: account.autoResetCredits,
          lowBalance: account.autoResetOnLowBalance && isLowBalance(snapshot.usage, account.autoResetRemainingPercent, this.now()) };
        this.plans.set(account.id, plan);
        await this.executePlan(account.id, plan);
      } catch { /* Keep known deadlines; one unavailable account must not stop other accounts. */ }
    }
  }

  private cancelPlan(accountRef: string, expected?: AccountPlan): void {
    const plan = this.plans.get(accountRef);
    if (expected && plan !== expected) return;
    if (plan?.handle !== undefined) this.timer.cancel(plan.handle);
    this.plans.delete(accountRef);
  }

  private armPlan(accountRef: string, plan: AccountPlan): void {
    if (this.disposed || this.signal.aborted || this.plans.get(accountRef) !== plan) return;
    if (plan.credits.length === 0) { this.cancelPlan(accountRef); return; }
    if (!plan.expiryEnabled) { this.cancelPlan(accountRef); return; }
    const dueAt = plan.credits[0].expiresAt! - plan.leadMinutes * 60_000;
    // Cap long delays: native timers overflow beyond roughly 24 days.
    plan.handle = this.timer.schedule(() => this.executePlan(accountRef, plan), Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - this.now())));
  }

  private executePlan(accountRef: string, plan: AccountPlan): Promise<void> {
    // Discovery and a deadline may overlap; serialize only this account, preserving the durable CAS fence.
    const previous = this.accountRuns.get(accountRef) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (this.disposed || this.signal.aborted || this.plans.get(accountRef) !== plan) return;
      try {
        const account = accountListItem(await this.accounts.get(accountRef));
        if (!account.available || !(account.autoResetCredits || account.autoResetOnLowBalance) || account.pendingAutoReset) { this.cancelPlan(accountRef, plan); return; }
        plan.leadMinutes = account.autoResetLeadMinutes;
        plan.expiryEnabled = account.autoResetCredits;
        while (this.plans.get(accountRef) === plan && plan.credits.length > 0) {
          if (this.disposed || this.signal.aborted) return;
          const credit = plan.credits[0];
          const latestConfig = accountListItem(await this.accounts.get(accountRef));
          plan.leadMinutes = latestConfig.autoResetLeadMinutes;
          plan.expiryEnabled = latestConfig.autoResetCredits;
          const balanceAttempt = plan.lowBalance && latestConfig.autoResetOnLowBalance;
          if (!balanceAttempt && (!plan.expiryEnabled || credit.expiresAt! - plan.leadMinutes * 60_000 > this.now())) break;
          plan.credits.shift();
          if (balanceAttempt) plan.lowBalance = false;
          if (!balanceAttempt && !isAutoResetDue(credit, this.now(), plan.leadMinutes)) continue;
          const attempt = await this.accounts.claimAutoReset(accountRef, credit, this.now());
          if (!attempt) {
            continue;
          }
          let deferred: ResetCredit | undefined;
          try {
            const result = await this.usage.consume(accountRef, attempt.redeemRequestId, credit.id, this.signal, {
              canConsume: async selected => {
                const fresh = balanceAttempt ? await this.usage.get(accountRef, this.signal, { forceFresh: true }).catch(() => undefined) : undefined;
                const latest = accountListItem(await this.accounts.get(accountRef));
                if (this.disposed || this.signal.aborted || !latest.available) return false;
                if (balanceAttempt) {
                  const first = fresh?.resetCredits.state === 'fresh' && (fresh.resetCredits.availableCount ?? 0) > 0
                    ? [...(fresh.resetCredits.credits ?? [])].filter(item => item.status === 'available' && Number.isFinite(item.expiresAt) && item.expiresAt! > this.now()).sort((a, b) => a.expiresAt! - b.expiresAt!)[0] : undefined;
                  if (latest.autoResetOnLowBalance && fresh !== undefined && first?.id === selected.id
                    && isLowBalance(fresh.usage, latest.autoResetRemainingPercent, this.now())) return true;
                }
                if (!latest.autoResetCredits) return false;
                if (selected.status === 'available' && typeof selected.expiresAt === 'number' && Number.isFinite(selected.expiresAt)
                  && selected.expiresAt - latest.autoResetLeadMinutes * 60_000 > this.now()) deferred = selected;
                return isAutoResetDue(selected, this.now(), latest.autoResetLeadMinutes);
              },
            });
            if (result.outcome === 'reset_outcome_unknown') { this.cancelPlan(accountRef, plan); return; }
            // The provider reported that this redemption did not use the card: release the claim so a later
            // scheduled scan can re-evaluate the same card, and stop this round instead of trying another card.
            if (result.outcome === 'nothing_to_reset' || result.outcome === 'no_credit') {
              await this.accounts.finishAutoReset(accountRef, attempt.redeemRequestId, true);
              this.cancelPlan(accountRef, plan);
              return;
            }
            await this.accounts.finishAutoReset(accountRef, attempt.redeemRequestId);
            // The balance opportunity is spent; remaining cards still follow their independent expiry deadlines.
          } catch (error) {
            // These errors occur before this request's POST. All other failures remain pending across restarts.
            if (error instanceof UsageError && ['credits_unavailable', 'credit_unavailable', 'reset_in_progress'].includes(error.code)) {
              await this.accounts.finishAutoReset(accountRef, attempt.redeemRequestId, true);
              if (error.code === 'credit_unavailable') {
                if (deferred) {
                  plan.credits.push(deferred);
                  plan.credits.sort((a, b) => a.expiresAt! - b.expiresAt!);
                }
                continue;
              }
            }
            this.cancelPlan(accountRef, plan);
            return;
          }
        }
        this.armPlan(accountRef, plan);
      } catch { this.cancelPlan(accountRef, plan); }
    }).finally(() => {
      if (this.accountRuns.get(accountRef) === operation) this.accountRuns.delete(accountRef);
    });
    this.accountRuns.set(accountRef, operation);
    return operation;
  }

  dispose(): void {
    this.started = false;
    this.disposed = true;
    this.timer.cancel(this.handle);
    for (const id of this.plans.keys()) this.cancelPlan(id);
  }
}
