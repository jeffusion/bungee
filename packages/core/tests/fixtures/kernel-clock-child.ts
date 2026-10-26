import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { kernelMonotonicNowNs, readKernelDeadlineClockId } from '../../src/master-runtime/kernel-monotonic-clock';
const diagnosticDir = process.env.BUNGEE_CLOCK_DIAGNOSTIC_DIR;
const recordClockStage = (stage: string): void => {
  if (process.env.BUNGEE_CLOCK_DIAGNOSTIC_CHILD !== '1' || !diagnosticDir) return;
  try {
    appendFileSync(join(diagnosticDir, `child-${process.pid}.jsonl`),
      `${JSON.stringify({ timeMs: Date.now(), pid: process.pid, ppid: process.ppid, stage })}\n`);
  } catch { console.error('[clock-diagnostic] marker-write-unavailable'); }
};
recordClockStage('entry');
const clockId = await readKernelDeadlineClockId();
recordClockStage('boot-id-complete');
const now = kernelMonotonicNowNs();
recordClockStage('sample-complete');
console.log(JSON.stringify({ clockId, now: now.toString(), startDeadline: (now + 5_000_000_000n).toString(),
  exitDeadline: (now + 10_000_000_000n).toString() }));
recordClockStage('json-written');
