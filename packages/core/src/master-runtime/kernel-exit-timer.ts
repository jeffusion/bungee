import {dlopen, ptr, type Pointer} from 'bun:ffi';
import {readFileSync} from 'node:fs';

/** Only the official whole-container supervisor can turn a master exit into domain exit. */
export function hasWholeInstanceSupervisor(): boolean {
  if (process.platform !== 'linux' || process.ppid !== 1 || process.env.BUNGEE_INSTANCE_SUPERVISOR !== 'tini') return false;
  try { return readFileSync('/proc/1/comm', 'utf8').trim() === 'tini'; } catch { return false; }
}

/** An absolute BOOTTIME SIGKILL remains armed even when the JavaScript loop stalls. */
export function createKernelExitTimer(): {arm(deadlineNs: bigint): void; dispose(): void} {
  if (process.platform !== 'linux' || !['x64','arm64'].includes(process.arch)) throw new Error('kernel_exit_timer_unsupported');
  const paths = ['libc.so.6','libc.so',`/lib/libc.musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`];
  let library: ReturnType<typeof dlopen> | undefined;
  for (const path of paths) {
    try { library = dlopen(path, {
      timer_create: {args:['i32','ptr','ptr'],returns:'i32'},
      timer_settime: {args:['ptr','i32','ptr','ptr'],returns:'i32'},
      timer_delete: {args:['ptr'],returns:'i32'},
    }); break; } catch { /* Try the next system C library. */ }
  }
  if (!library) throw new Error('kernel_exit_timer_unavailable');
  const symbols = library.symbols as unknown as {
    timer_create(clock: number,event: Pointer,output: Pointer): number;
    timer_settime(handle: number,flags: number,value: Pointer,previous: null): number;
    timer_delete(handle: number): number;
  };
  const event = Buffer.alloc(64); event.writeInt32LE(9,8); event.writeInt32LE(0,12);
  const output = new BigUint64Array(1);
  if (symbols.timer_create(7,ptr(event),ptr(output)) !== 0) { library.close(); throw new Error('kernel_exit_timer_create_failed'); }
  const handle = Number(output[0]);
  const loaded = library;
  let disposed = false;
  return {
    arm(deadlineNs) {
      if (disposed || deadlineNs <= 0n) throw new Error('kernel_exit_timer_invalid');
      const value = new BigInt64Array([0n,0n,deadlineNs / 1_000_000_000n,deadlineNs % 1_000_000_000n]);
      if (symbols.timer_settime(handle,1,ptr(value),null) !== 0) throw new Error('kernel_exit_timer_arm_failed');
    },
    dispose() {
      if (disposed) return;
      if (symbols.timer_delete(handle) !== 0) throw new Error('kernel_exit_timer_delete_failed');
      disposed = true; loaded.close();
    },
  };
}
