type DirectChild = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  readonly exited?: Promise<number>;
  readonly kill: (...args: any[]) => unknown;
  readonly once?: (...args: any[]) => unknown;
};

/** Only retain handles explicitly registered by this test. */
export class ProcessRegistry {
  private readonly children = new Set<DirectChild>();
  registerChild(child: DirectChild): void { this.children.add(child); }
  get registeredPids(): readonly number[] { return [...this.children].flatMap(child => child.pid === undefined ? [] : [child.pid]); }
  get registeredProcesses(): readonly DirectChild[] { return [...this.children]; }
}
function exited(child: DirectChild): boolean {
  return child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined;
}
async function waitForExit(child: DirectChild, timeoutMs: number): Promise<void> {
  if (exited(child)) return;
  const completion = child.exited ?? (child.once
    ? new Promise<void>(resolve => child.once!('close', resolve))
    : Promise.reject(new Error('Registered child has no exit evidence')));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([completion, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Registered child exit timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
export async function cleanupProcesses(registry: ProcessRegistry, timeoutMs = 5000): Promise<void> {
  const errors: unknown[] = [];
  for (const child of registry.registeredProcesses) {
    try {
      if (!exited(child)) child.kill('SIGTERM');
      await waitForExit(child, timeoutMs);
    } catch (error) {
      errors.push(error);
      try { if (!exited(child)) child.kill('SIGKILL'); await waitForExit(child, timeoutMs); }
      catch (forcedError) { errors.push(forcedError); }
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Registered process cleanup failed');
}
