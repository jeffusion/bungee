import {expect,test} from 'bun:test';
test('kernel exit timer interrupts its owned busy child without JavaScript progress',async()=>{
  if(process.platform!=='linux') {
    const {createKernelExitTimer}=await import('../../src/master-runtime/kernel-exit-timer');
    expect(()=>createKernelExitTimer()).toThrow('kernel_exit_timer_unsupported');return;
  }
  const child=Bun.spawn([process.execPath,new URL('../fixtures/kernel-exit-child.ts',import.meta.url).pathname],{stdout:'pipe',stderr:'pipe'});
  try {
    const output=await new Response(child.stdout).text();await child.exited;
    expect(output.trim()).toBe('armed');expect(child.signalCode).toBe('SIGKILL');
  } finally {if(child.exitCode===null)child.kill('SIGKILL');await child.exited;}
});
