import { kernelMonotonicNowNs, readKernelDeadlineClockId } from '../../src/master-runtime/kernel-monotonic-clock';
const clockId = await readKernelDeadlineClockId();
const now = kernelMonotonicNowNs();
// This one-shot probe is complete once its sample reaches the parent.
process.stdout.write(JSON.stringify({ clockId, now: now.toString(), startDeadline: (now + 5_000_000_000n).toString(),
  exitDeadline: (now + 10_000_000_000n).toString() }) + '\n', () => process.exit(0));
