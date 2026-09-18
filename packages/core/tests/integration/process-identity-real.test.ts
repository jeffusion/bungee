import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { captureProcessIdentity, probeProcessIdentity } from '../../src/master-runtime/process-identity';

const CAPTURE_DEADLINE_MS = 15_000;
const CAPTURE_RETRY_MS = 100;
const EXIT_DEADLINE_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawns a live bun child whose real OS argv carries the exact identity marker. */
function spawnMarkedChild(marker: string): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', marker], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(EXIT_DEADLINE_MS),
  ]);
}

test('real OS capture and exact probe lock the production sampler', async () => {
  const processInstanceId = randomUUID();
  const marker = `--bungee-process-identity=${processInstanceId}`;
  const child = spawnMarkedChild(marker);
  try {
    expect(child.pid).toBeGreaterThan(0);
    const pid = child.pid!;
    // A freshly exec'd child may not expose its identity records yet; retry the real
    // capture until the platform sampler observes the marker.
    const deadline = Date.now() + CAPTURE_DEADLINE_MS;
    let captured: Awaited<ReturnType<typeof captureProcessIdentity>> | null = null;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        captured = await captureProcessIdentity(pid, processInstanceId);
        break;
      } catch (error) {
        lastError = error;
        await sleep(CAPTURE_RETRY_MS);
      }
    }
    expect(captured).not.toBeNull();
    expect(captured!.pid).toBe(pid);
    expect(captured!.processInstanceId).toBe(processInstanceId);
    expect(await probeProcessIdentity(captured!)).toBe('exact');
    void lastError;
  } finally {
    // Only the original ChildProcess handle may stop the child; the PID is never signaled.
    child.kill();
    await waitForExit(child);
  }
}, 30_000);
