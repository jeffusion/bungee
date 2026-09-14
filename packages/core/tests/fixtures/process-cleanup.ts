import { readFileSync } from 'node:fs';

type ProcessHandle = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
};

const WAIT_STEP_MS = 25;
const TERM_WAIT_MS = 1_500;
const KILL_WAIT_MS = 3_000;

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch { /* process state is unavailable on non-Linux hosts */ }
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

async function waitForDead(
  pids: readonly number[],
  timeoutMs: number,
  alive: (pid: number) => boolean = processAlive,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(processAlive)) await Bun.sleep(WAIT_STEP_MS);
}

function send(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, process.platform === 'win32' ? undefined : signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
}

export class ProcessRegistry {
  private readonly pids = new Set<number>();
  private readonly handles = new Map<number, ProcessHandle>();
  private cleanupPromise: Promise<void> | undefined;

  registerPid(pid: number | undefined): number | undefined {
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) this.pids.add(pid);
    return pid;
  }

  registerChild(child: ProcessHandle): ProcessHandle {
    this.registerPid(child.pid);
    if (child.pid !== undefined) this.handles.set(child.pid, child);
    return child;
  }

  registerPids(pids: readonly number[]): void {
    for (const pid of pids) this.registerPid(pid);
  }

  get registeredPids(): readonly number[] {
    return [...this.pids];
  }

  cleanup(shutdown?: () => Promise<void> | void): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      try {
        await this.runCleanup(shutdown);
      } finally {
        this.cleanupPromise = undefined;
      }
    })();
    return this.cleanupPromise;
  }

  private async runCleanup(shutdown?: () => Promise<void> | void): Promise<void> {
    const pids = [...this.pids];
    const alive = (pid: number): boolean => {
      const handle = this.handles.get(pid);
      if (handle?.exitCode !== null && handle?.exitCode !== undefined) return false;
      if (handle?.signalCode !== null && handle?.signalCode !== undefined) return false;
      return processAlive(pid);
    };
    if (shutdown !== undefined) {
      try { await shutdown(); } catch { /* fall back to signals below */ }
      await waitForDead(pids, TERM_WAIT_MS, alive);
    }
    for (const pid of pids) {
      if (alive(pid)) send(pid, 'SIGTERM');
    }
    await waitForDead(pids, TERM_WAIT_MS, alive);
    for (const pid of pids) if (alive(pid)) send(pid, 'SIGKILL');
    await waitForDead(pids, KILL_WAIT_MS, alive);
    const survivors = pids.filter(alive);
    if (survivors.length > 0) throw new Error(`registered processes remained alive: ${survivors.join(',')}`);
  }
}

export async function cleanupProcesses(registry: ProcessRegistry, shutdown?: () => Promise<void> | void): Promise<void> {
  await registry.cleanup(shutdown);
}
