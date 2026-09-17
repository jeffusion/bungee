type DirectChild = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  readonly exited?: Promise<number>;
  readonly kill: (...args: any[]) => unknown;
  readonly once?: (...args: any[]) => unknown;
};

/** Focused subprocess cleanup: only handles explicitly registered by the test. */
export class ProcessRegistry {
  private readonly children = new Set<DirectChild>();

  registerChild(child: DirectChild): void {
    this.children.add(child);
  }

  get registeredPids(): readonly number[] {
    return [...this.children].flatMap((child) => child.pid === undefined ? [] : [child.pid]);
  }

  get registeredProcesses(): readonly DirectChild[] {
    return [...this.children];
  }
}

async function waitForExit(child: DirectChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.exited !== undefined) {
    await child.exited;
    return;
  }
  if (child.once === undefined) return;
  await new Promise<void>((resolve) => child.once?.('close', resolve));
}

export async function cleanupProcesses(registry: ProcessRegistry): Promise<void> {
  for (const child of registry.registeredProcesses) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await waitForExit(child);
  }
}
