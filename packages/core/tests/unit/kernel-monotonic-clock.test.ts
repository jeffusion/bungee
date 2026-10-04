import { expect, test } from 'bun:test';
import { toArrayBuffer } from 'bun:ffi';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelMonotonicClock, kernelMonotonicNowNs, readKernelDeadlineClockId } from '../../src/master-runtime/kernel-monotonic-clock';
import { createConfigWorkerRuntimeController } from '../../src/config-publication/worker-runtime';
import { drainMessage, fakeLifecycle, PROCESS_IDENTITY, startMessage } from './config-publication-worker-runtime.fixtures';

const output = (address: number) => new BigInt64Array(toArrayBuffer(address, 0, 16));

test('QPC preserves integer precision and uses the Windows BOOL ABI', () => {
  let closed = false;
  const clock = createKernelMonotonicClock('win32', (_path, definitions) => {
    expect(definitions.QueryPerformanceCounter!.returns).toBe('i32');
    expect(definitions.QueryPerformanceFrequency!.returns).toBe('i32');
    return { close: () => { closed = true; }, symbols: {
      QueryPerformanceFrequency: address => { output(address)[0] = 3n; return 1; },
      QueryPerformanceCounter: address => { output(address)[0] = 9_007_199_254_740_995n; return 1; },
    } };
  });
  expect(clock()).toBe(9_007_199_254_740_995n * 1_000_000_000n / 3n);
  expect(closed).toBe(false);
});

test('clock initialization fails closed instead of falling back to a process clock', () => {
  let closed = false;
  expect(() => createKernelMonotonicClock('win32', () => ({
    close: () => { closed = true; }, symbols: { QueryPerformanceFrequency: () => 0 },
  }))).toThrow('frequency is unavailable');
  expect(closed).toBe(true);
  expect(() => createKernelMonotonicClock('freebsd')).toThrow('unsupported');
});

test('musl loader fallback keeps nanosecond validation and counts suspend time', () => {
  const paths: string[] = [];
  let invalid = false;
  const clock = createKernelMonotonicClock('linux', (path) => {
    paths.push(path);
    if (paths.length < 3) throw new Error('library absent');
    return { close() {}, symbols: { clock_gettime: (id, address) => {
      expect(id).toBe(7);
      const sample = output(address!);
      sample[0] = 100n; sample[1] = invalid ? 1_000_000_000n : 999_999_999n;
      return 0;
    } } };
  });
  expect(paths[2]).toContain('libc.musl-');
  expect(clock()).toBe(100_999_999_999n);
  invalid = true;
  expect(() => clock()).toThrow('sample is unavailable');
});

test('older worker accepts a younger controller deadline and preserves the shared exit window', async () => {
  const fake = fakeLifecycle();
  const clockId = await readKernelDeadlineClockId();
  const runtime = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
    bootNonce: 'c0000000-0000-4000-8000-000000000001', bootId: clockId, lifecycle: fake.lifecycle });
  try {
    expect((await runtime.apply(startMessage())).ok).toBe(true);
    // Exceeds C: the former process-relative implementation rejected this takeover.
    await Bun.sleep(6_000);
    const entry = fileURLToPath(new URL('../fixtures/kernel-clock-child.ts', import.meta.url));
    const before = kernelMonotonicNowNs();
    const child = Bun.spawn([process.execPath, entry], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const controller = JSON.parse(text) as { now: string; startDeadline: string; exitDeadline: string; clockId: string };
    const after = kernelMonotonicNowNs();
    expect(BigInt(controller.now)).toBeGreaterThanOrEqual(before);
    expect(BigInt(controller.now)).toBeLessThanOrEqual(after);
    expect(controller.clockId).toBe(clockId);
    // A much older parent must not truncate the younger worker's E window.
    const childExitRemaining = BigInt(controller.exitDeadline) - after;
    expect(childExitRemaining).toBeGreaterThan(0n);
    expect(childExitRemaining).toBeLessThanOrEqual(10_000_000_000n);
    // Mixed versions cannot mistake a legacy process-relative value for kernel time.
    const legacy = await runtime.apply({ ...drainMessage(), start_boot_id: clockId.replace('kernel-monotonic-v1:', ''),
      start_deadline_ns: controller.startDeadline });
    expect(legacy.ok).toBe(false);
    const expired = await runtime.apply({ ...drainMessage(), start_boot_id: clockId, start_deadline_ns: before.toString() });
    expect(expired.ok).toBe(false);
    const accepted = await runtime.apply({ ...drainMessage(), start_boot_id: clockId, start_deadline_ns: controller.startDeadline });
    expect(accepted.ok).toBe(true);
    await Bun.sleep(20);
    const terminal = runtime.drainStatus();
    expect(terminal?.ok).toBe(true);
    if (!terminal?.ok || terminal.message.status !== 'worker-drained') throw new Error('terminal drain evidence missing');
    const remaining = BigInt(terminal.message.exit_deadline_ns) - kernelMonotonicNowNs();
    expect(remaining).toBeGreaterThan(0n);
    expect(remaining).toBeLessThanOrEqual(BigInt(terminal.message.policy.worker_exit_timeout_ms) * 1_000_000n);
    const originalDeadline = terminal.message.exit_deadline_ns;
    await runtime.failClosed();
    const finalized = runtime.drainStatus();
    expect(finalized?.ok && 'exit_deadline_ns' in finalized.message ? finalized.message.exit_deadline_ns : null).toBe(originalDeadline);
  } finally { await runtime.failClosed(); }
}, 20_000);


test('compiled native executable reads the same shared kernel clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-kernel-clock-compiled-'));
  const entry = fileURLToPath(new URL('../fixtures/kernel-clock-child.ts', import.meta.url));
  const binary = join(directory, process.platform === 'win32' ? 'clock.exe' : 'clock');
  try {
    const build = Bun.spawn([process.execPath, 'build', '--compile', entry, '--outfile', binary], { stdout: 'pipe', stderr: 'pipe' });
    await new Response(build.stdout).text();
    const errors = await new Response(build.stderr).text();
    expect(await build.exited, errors).toBe(0);
    const before = kernelMonotonicNowNs();
    const child = Bun.spawn([binary], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    const value = JSON.parse(text) as { now: string; clockId: string };
    const after = kernelMonotonicNowNs();
    expect(BigInt(value.now)).toBeGreaterThanOrEqual(before);
    expect(BigInt(value.now)).toBeLessThanOrEqual(after);
    expect(value.clockId).toBe(await readKernelDeadlineClockId());
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
