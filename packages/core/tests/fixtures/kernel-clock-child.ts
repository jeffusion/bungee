import { kernelMonotonicNowNs, readKernelDeadlineClockId } from '../../src/master-runtime/kernel-monotonic-clock';
const clockId = await readKernelDeadlineClockId();
const now = kernelMonotonicNowNs();
console.log(JSON.stringify({ clockId, now: now.toString(), startDeadline: (now + 5_000_000_000n).toString(),
  exitDeadline: (now + 10_000_000_000n).toString() }));
