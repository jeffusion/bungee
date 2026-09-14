import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { createLaunchingDaemonMetadataFile, readDaemonMetadataFile, transitionDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import { forceStopDaemon } from './force-stop';
import { TargetProcessMissingError } from './process-identity';
import type { ProcessTreeSnapshot } from './process-tree';
import { DaemonManager } from './manager';

const directories: string[] = [];

async function armedFixture(directory: string, state: 'armed' | 'starting' = 'armed', managementHost = '127.0.0.1', managementPort = 8089): Promise<DaemonMetadataV1> {
  const path = join(directory, 'daemon.json');
  const launching: DaemonMetadataV1 = {
    schema: 'bungee-daemon-metadata-v1', launcher_pid: process.pid, state: 'launching',
    boot_nonce: '44444444-4444-4444-8444-444444444444', shutdown_secret: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    executable: process.execPath, entrypoint: null, pid: null, instance_id: null, management_host: null, management_port: null,
  };
  await createLaunchingDaemonMetadataFile(path, launching, { runtimeDirectory: directory });
  const starting: DaemonMetadataV1 = { ...launching, state: 'starting', pid: 4242 };
  await transitionDaemonMetadataFile(path, {
    expectedBootNonce: launching.boot_nonce, expectedState: 'launching', expectedShutdownSecret: launching.shutdown_secret, next: starting,
  }, { runtimeDirectory: directory });
  if (state === 'starting') return starting;
  const armed: DaemonMetadataV1 = { ...starting, state: 'armed', instance_id: '55555555-5555-4555-8555-555555555555', management_host: managementHost as '127.0.0.1' | '::1', management_port: managementPort };
  await transitionDaemonMetadataFile(path, {
    expectedBootNonce: starting.boot_nonce, expectedState: 'starting', expectedShutdownSecret: starting.shutdown_secret, next: armed,
  }, { runtimeDirectory: directory });
  return armed;
}

function streamResponse(body: string, status = 202, onCancel?: () => void, onConsumed?: () => void): Response {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(bytes); controller.close(); onConsumed?.(); },
    cancel() { onCancel?.(); },
  }), { status });
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('DaemonManager Stage C-2 stop', () => {
  test('uses the exact authenticated shutdown request and waits for the old identity to disappear', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-rpc-'));
    directories.push(directory);
    const metadata = await armedFixture(directory);
    let alive = true;
    let bodyConsumed = false;
    let request: { url: string; init: RequestInit } | undefined;
    const manager = new DaemonManager(undefined, { kill: () => { throw new Error('stop must not signal'); } }, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'),
      probeProcess: async () => alive ? 'exact' : 'dead', findProcess: async () => 'none',
      httpRequest: async (url, init) => {
        request = { url, init };
        alive = false;
        const response = streamResponse(JSON.stringify({
          status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid,
        }), 202, undefined, () => { bodyConsumed = true; });
        return response;
      },
    });
    await manager.stop();
    expect(request?.url).toBe(`http://127.0.0.1:8089/__bungee/internal/daemon/v1/shutdown`);
    expect(request?.init.method).toBe('POST');
    expect(request?.init.body).toBeNull();
    expect(request?.init.headers).toEqual({
      authorization: `Bearer ${metadata.shutdown_secret}`, 'content-length': '0',
      'x-bungee-daemon-boot': metadata.boot_nonce, 'x-bungee-daemon-instance': metadata.instance_id!,
      'x-bungee-daemon-pid': String(metadata.pid),
    });
    expect(bodyConsumed).toBe(true);
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeFalse();
  });

  test('accepts a real stream ACK once and never reposts while the exact root remains', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-ack-once-'));
    directories.push(directory);
    const metadata = await armedFixture(directory);
    let clock = 0; let posts = 0; let forcedAt = -1;
    const manager = new DaemonManager(undefined, undefined, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      probeProcess: async () => forcedAt >= 0 ? 'dead' : 'exact', findProcess: async () => 'none',
      httpRequest: async () => { posts += 1; return streamResponse(JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid })); },
      forceStop: async () => { forcedAt = clock; },
    });
    manager['stopTimeoutMs'] = 300;
    await manager.stop();
    expect(posts).toBe(1);
    expect(forcedAt).toBeGreaterThanOrEqual(300);
  });

  test('cancels an oversized streamed ACK and forces only after the positive deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-ack-size-'));
    directories.push(directory);
    await armedFixture(directory);
    let clock = 0; let canceled = false; let forcedAt = -1;
    const manager = new DaemonManager(undefined, undefined, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      probeProcess: async () => forcedAt >= 0 ? 'dead' : 'exact', findProcess: async () => 'none',
      httpRequest: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(513)); }, cancel() { canceled = true; },
      }), { status: 202 }), forceStop: async () => { forcedAt = clock; },
    });
    manager['stopTimeoutMs'] = 300;
    await manager.stop();
    expect(canceled).toBe(true);
    expect(forcedAt).toBeGreaterThanOrEqual(300);
  });

  test('rejects wrong or non-canonical ACK identities after consuming the real stream', async () => {
    const bodies = [
      { status: 'accepted', boot_nonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', instance_id: '55555555-5555-4555-8555-555555555555', pid: 4242 },
      { status: 'accepted', boot_nonce: '44444444-4444-4444-8444-444444444444', instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pid: 4242 },
      { status: 'accepted', boot_nonce: '44444444-4444-4444-8444-444444444444', instance_id: '55555555-5555-4555-8555-555555555555', pid: 7 },
      { status: 'accepted', boot_nonce: '44444444-4444-4444-8444-444444444444', instance_id: '55555555-5555-4555-8555-555555555555', pid: 4242, extra: true },
      { status: 'accepted', boot_nonce: '44444444-4444-4444-8444-444444444444', instance_id: '55555555-5555-4555-8555-555555555555' },
    ];
    for (const body of bodies) {
      const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-ack-invalid-'));
      directories.push(directory); const metadata = await armedFixture(directory);
      let clock = 0; let forcedAt = -1;
      const manager = new DaemonManager(undefined, undefined, {
        runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), now: () => clock,
        sleep: async (milliseconds) => { clock += milliseconds; },
        probeProcess: async () => forcedAt >= 0 ? 'dead' : 'exact', findProcess: async () => 'none',
        httpRequest: async () => streamResponse(JSON.stringify(body)), forceStop: async () => { forcedAt = clock; },
      });
      manager['stopTimeoutMs'] = 300;
      void metadata;
      await manager.stop();
      expect(forcedAt).toBeGreaterThanOrEqual(300);
    }
  });

  test('uses bracketed IPv6 metadata without changing the exact shutdown path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-ipv6-'));
    directories.push(directory);
    const metadata = await armedFixture(directory, 'armed', '::1', 18089);
    let alive = true; let requestUrl = '';
    const manager = new DaemonManager(undefined, undefined, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), probeProcess: async () => alive ? 'exact' : 'dead', findProcess: async () => 'none',
      httpRequest: async (url) => { requestUrl = url; alive = false; return streamResponse(JSON.stringify({ status: 'accepted', boot_nonce: metadata.boot_nonce, instance_id: metadata.instance_id, pid: metadata.pid })); },
    });
    await manager.stop();
    expect(requestUrl).toBe('http://[::1]:18089/__bungee/internal/daemon/v1/shutdown');
  });

  test('aborts a timed-out RPC and forces only after the positive deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-abort-'));
    directories.push(directory); await armedFixture(directory);
    let aborted = false; let clock = 0; let forcedAt = -1;
    const manager = new DaemonManager(undefined, undefined, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), rpcTimeoutMs: 5,
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
      probeProcess: async () => forcedAt >= 0 ? 'dead' : 'exact', findProcess: async () => 'none',
      httpRequest: async (_url, init) => { init.signal?.addEventListener('abort', () => { aborted = true; }); return await new Promise<Response>(() => undefined); },
      forceStop: async () => { forcedAt = clock; },
    });
    manager['stopTimeoutMs'] = 300;
    await manager.stop();
    expect(aborted).toBe(true);
    expect(forcedAt).toBeGreaterThanOrEqual(300);
  });

  test('rejects metadata replacement before any force attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-replacement-'));
    directories.push(directory);
    const metadata = await armedFixture(directory);
    let forceCalled = false;
    const replacement = { ...metadata, state: 'launching' as const, boot_nonce: '66666666-6666-4666-8666-666666666666', shutdown_secret: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE', launcher_pid: process.pid, pid: null, instance_id: null, management_host: null, management_port: null };
    const manager = new DaemonManager(undefined, undefined, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'), probeProcess: async () => 'exact', findProcess: async () => 'none',
      httpRequest: async () => { await rm(join(directory, 'daemon.json')); await createLaunchingDaemonMetadataFile(join(directory, 'daemon.json'), replacement, { runtimeDirectory: directory }); return streamResponse('{"status":"accepted"}'); },
      forceStop: async () => { forceCalled = true; },
    });
    await expect(manager.stop()).rejects.toThrow('boot was replaced');
    expect(forceCalled).toBe(false);
  });

  test('does not force when current-user identity is different or unknown', async () => {
    for (const userProbe of ['different', 'unknown'] as const) {
      const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-user-'));
      directories.push(directory); await armedFixture(directory);
      let forceCalled = false;
      const manager = new DaemonManager(undefined, undefined, {
        runtimeDirectory: directory, probeProcess: async () => 'exact', probeCurrentUser: async () => userProbe, findProcess: async () => 'none',
        forceStop: async () => { forceCalled = true; },
      });
      await expect(manager.stop()).rejects.toThrow('Cannot safely inspect the daemon process');
      expect(forceCalled).toBe(false);
      expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBe(true);
    }
  });

  test('waits for starting without RPC and force-falls back only after the full deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-starting-'));
    directories.push(directory);
    await armedFixture(directory, 'starting');
    let forceCalled = false;
    let probeCalls = 0;
    let clock = 0;
    const manager = new DaemonManager(undefined, { kill: () => { throw new Error('stop must not signal'); } }, {
      runtimeDirectory: directory, pidFile: join(directory, 'bungee.pid'),
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; },
      probeProcess: async () => { probeCalls += 1; return 'exact'; }, findProcess: async () => 'none',
      httpRequest: async () => { throw new Error('starting must not RPC'); }, forceStop: async () => { forceCalled = true; },
    });
    manager['stopTimeoutMs'] = 300;
    await expect(manager.stop()).rejects.toThrow('Forced daemon stop did not prove process exit');
    expect(forceCalled).toBe(true);
    expect(clock).toBeGreaterThanOrEqual(300);
    expect(probeCalls).toBeGreaterThan(0);
  });

  test('does not force an unknown root and leaves metadata authoritative', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-unknown-'));
    directories.push(directory);
    await armedFixture(directory);
    let forceCalled = false;
    const manager = new DaemonManager(undefined, { kill: () => { throw new Error('stop must not signal'); } }, {
      runtimeDirectory: directory, probeProcess: async () => 'unknown', findProcess: async () => 'none',
      forceStop: async () => { forceCalled = true; },
    });
    await expect(manager.stop()).rejects.toThrow('Cannot safely inspect the daemon process');
    expect(forceCalled).toBe(false);
    expect(await Bun.file(join(directory, 'daemon.json')).exists()).toBeTrue();
  });

  test('does not spawn when restart stop fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bungee-c2-restart-fail-'));
    directories.push(directory);
    await armedFixture(directory);
    let spawns = 0;
    const manager = new DaemonManager(() => { spawns += 1; return { pid: 5252, unref() {} }; }, undefined, {
      runtimeDirectory: directory, probeProcess: async () => 'exact', findProcess: async () => 'none',
      httpRequest: async () => new Response('not found', { status: 404 }), forceStop: async () => { throw new Error('forced stop failed'); },
    });
    manager['stopTimeoutMs'] = 0;
    await expect(manager.restart()).rejects.toThrow('forced stop failed');
    expect(spawns).toBe(0);
  });
});

describe('force stop identity rules', () => {
  test('uses Windows taskkill with no process signal and validates the root afterwards', async () => {
    const metadata = {
      state: 'armed', pid: 4242, boot_nonce: '44444444-4444-4444-8444-444444444444', executable: 'C:/Bun/bun.exe', entrypoint: null,
    } as unknown as DaemonMetadataV1;
    let probes = 0;
    let taskkillPid = 0;
    await forceStopDaemon(metadata, {
      platform: 'win32', probeProcess: async () => probes++ === 0 ? 'exact' : 'dead', findProcess: async () => 'none',
      kill: () => { throw new Error('Windows force must not process.kill'); }, taskkill: async (pid) => { taskkillPid = pid; },
    });
    expect(taskkillPid).toBe(4242);
    expect(probes).toBe(2);
  });

  test('accepts a taskkill race when the exact old process is already gone', async () => {
    const metadata = { state: 'armed', pid: 4242, boot_nonce: '44444444-4444-4444-8444-444444444444', executable: 'C:/Bun/bun.exe', entrypoint: null } as unknown as DaemonMetadataV1;
    let probes = 0;
    await forceStopDaemon(metadata, {
      platform: 'win32', probeProcess: async () => probes++ === 0 ? 'exact' : 'dead', findProcess: async () => 'none',
      kill: () => { throw new Error('Windows force must not process.kill'); }, taskkill: async () => { throw new Error('already gone'); },
    });
    expect(probes).toBe(2);
  });

  test('revalidates POSIX descendants and kills leaf-first before the exact root', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const node = (pid: number, ppid: number): ProcessTreeSnapshot => ({
      pid, ppid, startTime: String(pid), state: 'R', uid, executable: '/usr/bin/bun',
      cmdline: ['bun', '--bungee-daemon-boot=44444444-4444-4444-8444-444444444444'],
      bootNonce: '44444444-4444-4444-8444-444444444444', processIdentity: pid === 10 ? null : `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`, role: null,
    });
    const root = node(10, 1); const child = node(11, 10); const leaf = node(12, 11);
    const frozen = (value: ProcessTreeSnapshot) => ({ ...value, state: 'Ts' });
    const kills: Array<[number, NodeJS.Signals | number]> = [];
    const dead = new Set<number>();
    let probes = 0;
    await forceStopDaemon({ state: 'armed', pid: 10, boot_nonce: '44444444-4444-4444-8444-444444444444', executable: '/usr/bin/bun', entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', forceWaitMs: 0, probeProcess: async () => probes++ < 6 ? 'exact' : 'dead', findProcess: async () => 'none',
      kill: (pid, signal) => { kills.push([pid, signal]); if (signal === 'SIGKILL') dead.add(pid); },
      captureTree: async () => probes < 3 ? [root, child, leaf] : [frozen(root), frozen(child), frozen(leaf)], readSnapshot: async (pid) => {
        if (dead.has(pid)) throw new TargetProcessMissingError('test dead');
        return frozen(({ 11: child, 12: leaf, 10: root }[pid]!));
      },
    });
    expect(kills).toEqual([[10, 'SIGSTOP'], [11, 'SIGSTOP'], [12, 'SIGSTOP'], [12, 'SIGKILL'], [11, 'SIGKILL'], [10, 'SIGKILL']]);
  });

  test('does not declare success when the root exits before surviving descendants', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const root: ProcessTreeSnapshot = { pid: 20, ppid: 1, startTime: '20', state: 'Ts', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, role: null };
    const child: ProcessTreeSnapshot = { ...root, pid: 21, ppid: 20, startTime: '21', processIdentity: '00000000-0000-4000-8000-000000000021' };
    const killed = new Set<number>();
    let probes = 0;
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    await forceStopDaemon({ state: 'armed', pid: 20, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', forceWaitMs: 0, probeProcess: async () => probes++ < 3 ? 'exact' : 'dead', findProcess: async () => 'none',
      kill: (pid, signal) => { calls.push([pid, signal]); if (signal === 'SIGKILL') killed.add(pid); }, captureTree: async () => [root, child],
      readSnapshot: async (pid) => { if (killed.has(pid)) throw new TargetProcessMissingError('test dead'); return pid === 20 ? root : child; },
    });
    expect(calls).toEqual([[20, 'SIGSTOP'], [21, 'SIGSTOP'], [21, 'SIGKILL']]);
  });

  test('freezes a T1 descendant before hard kill', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const root: ProcessTreeSnapshot = { pid: 30, ppid: 1, startTime: '30', state: 'Ts', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, role: null };
    const newcomer: ProcessTreeSnapshot = { ...root, pid: 31, ppid: 30, startTime: '31', processIdentity: '00000000-0000-4000-8000-000000000031' };
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    let captures = 0;
    const dead = new Set<number>();
    await forceStopDaemon({ state: 'armed', pid: 30, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', probeProcess: async () => 'exact', findProcess: async () => 'none', kill: (pid, signal) => { calls.push([pid, signal]); if (signal === 'SIGKILL') dead.add(pid); },
      captureTree: async () => captures++ === 0 ? [root] : [root, newcomer], readSnapshot: async (pid) => {
        if (dead.has(pid)) throw new TargetProcessMissingError('test dead');
        return pid === 30 ? root : newcomer;
      },
    });
    expect(calls).toEqual([[30, 'SIGSTOP'], [31, 'SIGSTOP'], [31, 'SIGKILL'], [30, 'SIGKILL']]);
  });

  test('resumes every confirmed frozen ancestor when a child freeze fails', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const root: ProcessTreeSnapshot = { pid: 40, ppid: 1, startTime: '40', state: 'Ts', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, role: null };
    const child: ProcessTreeSnapshot = { ...root, pid: 41, ppid: 40, startTime: '41', processIdentity: '00000000-0000-4000-8000-000000000041' };
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    let resumed = false;
    let clock = 0;
    const error = await forceStopDaemon({ state: 'armed', pid: 40, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', probeProcess: async () => 'exact', findProcess: async () => 'none',
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        if (pid === 41 && signal === 'SIGSTOP') throw new Error('child freeze failed');
        if (signal === 'SIGCONT') resumed = true;
      }, captureTree: async () => [root, child], readSnapshot: async (pid) => pid === 40 && resumed ? { ...root, state: 'R' } : pid === 40 ? root : child,
      now: () => clock, sleep: async (milliseconds) => { clock += milliseconds; }, resumeWaitMs: 20,
    }).catch((value) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(calls).toEqual([[40, 'SIGSTOP'], [41, 'SIGSTOP'], [40, 'SIGCONT']]);
  });

  test('resumes the root when capture fails after root freeze', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const root = { pid: 50, ppid: 1, startTime: '50', state: 'R', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, processIdentity: null, role: null } as ProcessTreeSnapshot;
    const stoppedRoot = { ...root, state: 'Ts' };
    let captures = 0; let resumed = false; let clock = 0;
    const calls: Array<[number, NodeJS.Signals | number]> = [];
    const error = await forceStopDaemon({ state: 'armed', pid: 50, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', probeProcess: async () => 'exact', findProcess: async () => 'none', now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; }, resumeWaitMs: 20,
      kill: (pid, signal) => { calls.push([pid, signal]); if (signal === 'SIGCONT') resumed = true; },
      captureTree: async () => { if (captures++ === 0) return [root]; throw new Error('T1 capture failed'); },
      readSnapshot: async () => resumed ? { ...stoppedRoot, state: 'R' } : stoppedRoot,
    }).catch((value) => value as Error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(calls).toEqual([[50, 'SIGSTOP'], [50, 'SIGCONT']]);
  });

  test('resumes unfired survivors after a partial hard-kill failure', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const node = (pid: number, ppid: number): ProcessTreeSnapshot => ({ pid, ppid, startTime: String(pid), state: 'R', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, processIdentity: pid === 60 ? null : `00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`, role: null });
    const root = node(60, 1); const child = node(61, 60); const frozen = (value: ProcessTreeSnapshot) => ({ ...value, state: 'Ts' });
    const killed = new Set<number>(); const resumed = new Set<number>(); const calls: Array<[number, NodeJS.Signals | number]> = [];
    let captures = 0; let clock = 0;
    const error = await forceStopDaemon({ state: 'armed', pid: 60, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', probeProcess: async () => killed.has(60) ? 'dead' : 'exact', findProcess: async () => 'none', now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; }, forceWaitMs: 0, resumeWaitMs: 20,
      kill: (pid, signal) => { calls.push([pid, signal]); if (signal === 'SIGSTOP') return; if (signal === 'SIGKILL' && pid === 61) throw new Error('leaf kill failed'); if (signal === 'SIGKILL') killed.add(pid); if (signal === 'SIGCONT') resumed.add(pid); },
      captureTree: async () => captures++ === 0 ? [root, child] : [frozen(root), frozen(child)],
      readSnapshot: async (pid) => { if (killed.has(pid)) throw new TargetProcessMissingError('dead'); const value = pid === 60 ? root : child; return resumed.has(pid) ? value : frozen(value); },
    }).catch((value) => value as Error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(calls).toContainEqual([61, 'SIGCONT']);
    expect(calls).not.toContainEqual([60, 'SIGCONT']);
  });

  test('aggregates SIGCONT failure while a frozen process remains stopped', async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const boot = '44444444-4444-4444-8444-444444444444';
    const root = { pid: 70, ppid: 1, startTime: '70', state: 'R', uid, executable: '/usr/bin/bun', cmdline: ['bun', `--bungee-daemon-boot=${boot}`], bootNonce: boot, processIdentity: null, role: null } as ProcessTreeSnapshot;
    let captures = 0; let clock = 0; const calls: Array<[number, NodeJS.Signals | number]> = [];
    const error = await forceStopDaemon({ state: 'armed', pid: 70, boot_nonce: boot, executable: root.executable, entrypoint: null } as unknown as DaemonMetadataV1, {
      platform: 'linux', probeProcess: async () => 'exact', findProcess: async () => 'none', now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; }, resumeWaitMs: 20,
      kill: (pid, signal) => { calls.push([pid, signal]); if (signal === 'SIGCONT') throw new Error('resume failed'); },
      captureTree: async () => captures++ === 0 ? [root] : Promise.reject(new Error('capture failed')),
      readSnapshot: async () => ({ ...root, state: 'Ts' }),
    }).catch((value) => value as Error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(calls.filter(([, signal]) => signal === 'SIGCONT').length).toBeGreaterThan(0);
  });
});
