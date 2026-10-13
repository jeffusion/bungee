import {expect,test} from 'bun:test';
import {ComponentRecovery,ComponentRecoveryStopped,type ComponentRecoveryRepository} from '../../../src/master-runtime/component-recovery';

function fixture() {
  let now = 100n;
  const calls: string[] = [];
  const budget = {tickets:1,last_ticket_id:crypto.randomUUID(),retry_boot_id:'boot',retry_at_ns:'100',
    healthy_owner:null,healthy_boot_id:null,healthy_since_ns:null,healthy_last_ns:null};
  const recovery = new ComponentRecovery(crypto.randomUUID(),'boot',{nowNs:()=>now,supervisor:true,
    timer:{arm:()=>{calls.push('armed');},dispose:()=>{calls.push('disposed');}},
    exit:()=>{calls.push('exit');},sleep:async ms=>{calls.push('wait');now+=BigInt(ms)*1_000_000n;}});
  const repository: ComponentRecoveryRepository = {
    getRuntimeRecoveryStartupGate:async()=>({kind:'ready',budget}),
    consumeRuntimeRecoveryRestartTicket:async()=>{calls.push('durable');return budget;},
    observeRuntimeRecoveryHealth:async()=>budget,
  };
  return {recovery,repository,calls,budget};
}
test('durable ticket precedes hard timer, physical cleanup and exit; concurrent failure is one flight',async()=>{
  const f=fixture();let finish!:()=>void;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  const first=f.recovery.fail('plugin_state',f.repository,async()=>{f.calls.push('cleanup');await pending;},1000n);
  expect(f.recovery.fail('second',f.repository,async()=>{throw new Error('duplicate cleanup');},1000n)).toBe(first);
  await Promise.resolve();await Promise.resolve();
  expect(f.calls).toEqual(['durable','armed','cleanup']);
  finish();await first;expect(f.calls).toEqual(['durable','armed','cleanup','exit']);f.recovery.dispose();
});
test.each(['attempts_exhausted','result_unknown'])('budget %s stays alive without timer or cleanup',async code=>{
  const f=fixture();f.repository.consumeRuntimeRecoveryRestartTicket=async()=>{throw Object.assign(new Error('budget'),{code});};
  await f.recovery.fail('plugin_state',f.repository,async()=>{f.calls.push('cleanup');},1000n);
  expect(f.recovery.state).toBe('stopped');expect(f.calls).toEqual([]);f.recovery.dispose();
});
test('unsupported whole-domain exit stops and retains resources',async()=>{
  const calls:string[]=[];
  const f=fixture();const recovery=new ComponentRecovery(crypto.randomUUID(),'boot',{nowNs:()=>100n,
    supervisor:false,timer:null,exit:()=>{calls.push('exit');},sleep:async()=>{}});
  await recovery.fail('plugin_state',f.repository,async()=>{calls.push('cleanup');},1000n);
  expect(recovery.reason).toBe('whole_instance_exit_unavailable');expect(calls).toEqual([]);expect(f.calls).toEqual([]);recovery.dispose();f.recovery.dispose();
});
test('startup only waits the persisted backoff and does not consume another ticket',async()=>{
  const f=fixture();let read=0;
  f.repository.getRuntimeRecoveryStartupGate=async()=>++read===1 ? {kind:'waiting',remaining_ms:5,budget:f.budget}:{kind:'ready',budget:f.budget};
  await f.recovery.startup(f.repository);expect(f.calls).toEqual(['wait']);expect(f.recovery.state).toBe('healthy');f.recovery.dispose();
});
test('unreadable startup budget cannot enter serving or exit',async()=>{
  const f=fixture();f.repository.getRuntimeRecoveryStartupGate=async()=>{throw new Error('unavailable');};
  await expect(f.recovery.startup(f.repository)).rejects.toBeInstanceOf(ComponentRecoveryStopped);
  expect(f.recovery.reason).toBe('restart_budget_unavailable');expect(f.calls).toEqual([]);f.recovery.dispose();
});
test('manual shutdown disposes stopped keeper and the unarmed timer, but preserves an armed exit',async()=>{
  const stopped=fixture();stopped.repository.consumeRuntimeRecoveryRestartTicket=async()=>{throw new Error('unknown');};
  await stopped.recovery.fail('fault',stopped.repository,async()=>{},1000n);
  stopped.recovery.dispose();expect(stopped.calls).toEqual(['disposed']);
  const armed=fixture();await armed.recovery.fail('fault',armed.repository,async()=>{},1000n);
  armed.recovery.dispose();expect(armed.calls).toEqual(['durable','armed','exit']);
});
test('manual shutdown during a pending ticket cannot arm or recreate the stopped keeper',async()=>{
  for(const failure of [false,true]) {
    const f=fixture();let resolve!:(value:any)=>void,reject!:(error:Error)=>void;
    f.repository.consumeRuntimeRecoveryRestartTicket=()=>new Promise((done,fail)=>{resolve=done;reject=fail;});
    const pending=f.recovery.fail('fault',f.repository,async()=>{f.calls.push('cleanup');},1000n);
    f.recovery.dispose();
    if(failure)reject(new Error('unconfirmed'));else resolve(f.budget);
    await pending;expect(f.calls).toEqual(['disposed']);
    f.recovery.stop('late_failure');f.recovery.dispose();
    expect(f.calls).toEqual(['disposed','disposed']);
  }
});
test('failed cleanup still performs the accepted whole-instance exit without claiming cleanup success',async()=>{
  const f=fixture();await expect(f.recovery.fail('plugin_state',f.repository,async()=>{f.calls.push('cleanup');throw new Error('unknown');},1000n)).rejects.toThrow('unknown');
  expect(f.calls).toEqual(['durable','armed','cleanup','exit']);f.recovery.dispose();
});
