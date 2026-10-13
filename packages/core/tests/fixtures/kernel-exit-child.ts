import {createKernelExitTimer} from '../../src/master-runtime/kernel-exit-timer';
import {kernelMonotonicNowNs} from '../../src/master-runtime/kernel-monotonic-clock';
const timer = createKernelExitTimer();
timer.arm(kernelMonotonicNowNs()+250_000_000n);
console.log('armed');
const end=performance.now()+5000;
while(performance.now()<end) {}
throw new Error('native exit timer did not interrupt the owned busy child');
