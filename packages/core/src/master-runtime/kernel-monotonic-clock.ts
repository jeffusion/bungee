import { dlopen, ptr } from 'bun:ffi';
import { readKernelBootId } from './process-identity';

// Include the clock domain in the boot identity: legacy process-relative deadlines
// must never be interpreted as shared kernel deadlines, even on the same host boot.
export const KERNEL_CLOCK_DOMAIN = 'kernel-monotonic-v1:';

type NativeLibrary = { symbols: Record<string, (...args: number[]) => number>; close(): void };
type NativeFunction = { readonly args: readonly ('i32' | 'ptr')[]; readonly returns: 'i32' };
type NativeLoader = (path: string, symbols: Record<string, NativeFunction>) => NativeLibrary;

export function createKernelMonotonicClock(
  platform: NodeJS.Platform = process.platform,
  load: NativeLoader = (path, symbols) => dlopen(path, symbols),
): () => bigint {
  if (process.arch !== 'x64' && process.arch !== 'arm64') throw new Error('kernel monotonic clock requires a 64-bit ABI');
  const sample = new BigInt64Array(2);
  const address = ptr(sample);
  let read: () => bigint;
  if (platform === 'win32') {
    const library = load('Kernel32.dll', {
      QueryPerformanceCounter: { args: ['ptr'], returns: 'i32' },
      QueryPerformanceFrequency: { args: ['ptr'], returns: 'i32' },
    });
    try {
      if (library.symbols.QueryPerformanceFrequency!(address) === 0 || sample[0]! <= 0n) throw new Error('kernel clock frequency is unavailable');
      const frequency = sample[0]!;
      read = () => {
        if (library.symbols.QueryPerformanceCounter!(address) === 0 || sample[0]! < 0n) throw new Error('kernel clock counter is unavailable');
        return sample[0]! * 1_000_000_000n / frequency;
      };
      read();
    } catch (error) { library.close(); throw error; }
  } else if (platform === 'linux' || platform === 'darwin') {
    const paths = platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib']
      : ['libc.so.6', 'libc.so', `/lib/libc.musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`];
    let library: NativeLibrary | undefined;
    const errors: unknown[] = [];
    for (const path of paths) {
      try { library = load(path, { clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' } }); break; }
      catch (error) { errors.push(error); }
    }
    if (library === undefined) throw new AggregateError(errors, 'kernel monotonic clock library is unavailable');
    const loaded = library;
    // Linux BOOTTIME and macOS MONOTONIC_RAW both include suspend time. Wall-clock
    // changes cannot restart a C/E window; processes on one boot share the origin.
    const clockId = platform === 'linux' ? 7 : 4;
    read = () => {
      if (loaded.symbols.clock_gettime!(clockId, address) !== 0
        || sample[0]! < 0n || sample[1]! < 0n || sample[1]! >= 1_000_000_000n) throw new Error('kernel monotonic clock sample is unavailable');
      return sample[0]! * 1_000_000_000n + sample[1]!;
    };
    try { read(); } catch (error) { loaded.close(); throw error; }
  } else {
    throw new Error(`kernel monotonic clock is unsupported on ${platform}`);
  }
  return read;
}

let clock: (() => bigint) | undefined;
export function kernelMonotonicNowNs(): bigint {
  clock ??= createKernelMonotonicClock();
  return clock();
}

export async function readKernelDeadlineClockId(): Promise<string> {
  // Validate the native clock before admitting a worker/controller, rather than
  // discovering a missing library halfway through publication.
  kernelMonotonicNowNs();
  return KERNEL_CLOCK_DOMAIN + await readKernelBootId();
}
