import { describe, expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { CONFIG_WORKER_ENV_NAMES } from '../../src/config-worker/process-environment';
import type { ConfigProcessIdentity, PublicationScheduler, ScheduledTimeout } from '../../src/config-publication';
import { NodeChildProcessAdapter } from '../../src/config-publication';
import { resolveWorkerLaunch, type WorkerLaunch } from '../../src/master-runtime/process-options';
import {
  NodeConfigWorkerFactory,
  NodeConfigWorkerFactoryError,
  type ConfigWorkerSpawn,
} from '../../src/master-runtime/node-worker-factory';
import type { HeartbeatIntervalScheduler } from '../../src/master-runtime/heartbeat-sender';
import { TEST_WORKER_TRANSPORT_SECRET } from '../fixtures/config-worker-private-transport';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 3,
};
class ManualIntervals implements HeartbeatIntervalScheduler {
  readonly callbacks = new Set<() => void>();
  scheduleEvery(_intervalMs: number, callback: () => void): ScheduledTimeout {
    this.callbacks.add(callback);
    return { cancel: () => { this.callbacks.delete(callback); } };
  }
}

class ManualScheduler implements PublicationScheduler {
  readonly callbacks: (() => void)[] = [];
  schedule(_delayMs: number, callback: () => void): ScheduledTimeout {
    this.callbacks.push(callback);
    return { cancel: () => {
      const index = this.callbacks.indexOf(callback);
      if (index >= 0) this.callbacks.splice(index, 1);
    } };
  }
  fireNext(): void { this.callbacks.shift()?.(); }
}

type SpawnCall = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
};

function childProcess(pid: number): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { configurable: true, value: pid });
  Object.defineProperty(child, 'connected', { configurable: true, value: true, writable: true });
  Object.defineProperty(child, 'send', {
    configurable: true,
    value(_message: unknown, callback: (error: Error | null) => void) { callback(null); return true; },
  });
  return child;
}

function harness(launch: WorkerLaunch, env: NodeJS.ProcessEnv = {}) {
  const calls: SpawnCall[] = [];
  const children: ChildProcess[] = [];
  const intervals = new ManualIntervals();
  const terminationScheduler = new ManualScheduler();
  const spawn: ConfigWorkerSpawn = (executable, args, options) => {
    const child = childProcess(5000 + children.length);
    calls.push({ executable, args, options });
    children.push(child);
    return child;
  };
  const factory = new NodeConfigWorkerFactory({
    launch,
    masterPid: 9876,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 500,
    shutdownTimeoutMs: 250,
    transportSecret: TEST_WORKER_TRANSPORT_SECRET,
    accessLogDbPath: '/work/logs/access.db',
    env,
    spawn,
    heartbeatScheduler: intervals,
    terminationScheduler,
  });
  return { calls, children, factory, intervals, terminationScheduler };
}

async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) await Promise.resolve();
}

describe('NodeConfigWorkerFactory spawn', () => {
  test('uses resolved source, dist, and compiled argv without a shell', () => {
    // Given / When / Then
    const launches = [
      resolveWorkerLaunch({ executable: '/bun', entry: '/app/src/main.ts' }),
      resolveWorkerLaunch({ executable: '/bun', entry: '/app/dist/main.js' }),
      resolveWorkerLaunch({ executable: '/app/bungee', entry: '/app/bungee' }),
    ];
    for (const launch of launches) {
      const { calls, factory } = harness(launch);
      factory.spawn(IDENTITY);
      expect(calls[0]?.executable).toBe(launch.executable);
      expect(calls[0]?.args).toEqual(launch.args);
      expect(calls[0]?.options.detached).toBeFalse();
      expect(calls[0]?.options.shell).toBeFalse();
      expect(calls[0]?.options.stdio).toEqual(['ignore', 'inherit', 'inherit', 'ipc']);
    }
  });

  test('strips listener legacy env and injects exact config worker env', () => {
    // Given
    const inherited = {
      SAFE: 'kept', CONFIG_PATH: '/tmp/config.json', PORT: '8088', WORKER_ID: '7',
      HOST: '0.0.0.0', WORKER_COUNT: '4', BUNGEE_ROLE: 'master',
      [CONFIG_WORKER_ENV_NAMES.transportSecret]: 'old-secret',
    };
    const { calls, factory } = harness({ source: 'compiled', executable: '/app/bungee', args: [] }, inherited);

    // When
    factory.spawn(IDENTITY);

    // Then
    expect(calls[0]?.options.env).toEqual({
      SAFE: 'kept',
      BUNGEE_ROLE: 'worker',
      [CONFIG_WORKER_ENV_NAMES.masterGeneration]: IDENTITY.master_generation,
      [CONFIG_WORKER_ENV_NAMES.workerInstanceId]: IDENTITY.worker_instance_id,
      [CONFIG_WORKER_ENV_NAMES.workerSlot]: '3',
      [CONFIG_WORKER_ENV_NAMES.masterPid]: '9876',
      [CONFIG_WORKER_ENV_NAMES.heartbeatTimeoutMs]: '500',
      [CONFIG_WORKER_ENV_NAMES.shutdownTimeoutMs]: '250',
      [CONFIG_WORKER_ENV_NAMES.transportSecret]: TEST_WORKER_TRANSPORT_SECRET,
      [CONFIG_WORKER_ENV_NAMES.accessLogDbPath]: '/work/logs/access.db',
    });
  });

  test('wraps the exact child, owns it until exact exit, and rejects duplicate identity', () => {
    // Given
    const { children, factory, intervals } = harness({ source: 'compiled', executable: '/app/bungee', args: [] });

    // When
    const process = factory.spawn(IDENTITY);

    // Then
    expect(process).toBeInstanceOf(NodeChildProcessAdapter);
    expect(factory.snapshot()).toEqual([process]);
    expect(factory.pids()).toEqual([5000]);
    expect(() => factory.spawn(IDENTITY)).toThrow(NodeConfigWorkerFactoryError);
    children[0]?.emit('exit', 0, null);
    expect(factory.snapshot()).toEqual([]);
    expect(factory.pids()).toEqual([]);
    expect(intervals.callbacks.size).toBe(0);
  });

  test('publishes exact owned exits once, isolates listeners, and supports unsubscribe', () => {
    // Given
    const { children, factory } = harness({ source: 'compiled', executable: '/app/bungee', args: [] });
    const process = factory.spawn(IDENTITY);
    const exits: number[] = [];
    factory.subscribeExit(() => { throw new Error('listener failed'); });
    const unsubscribe = factory.subscribeExit((exited, evidence) => {
      expect(exited).toBe(process);
      exits.push(evidence.pid);
    });

    // When / Then
    expect(factory.owns(process)).toBeTrue();
    children[0]?.emit('exit', 0, null);
    children[0]?.emit('exit', 0, null);
    expect(factory.owns(process)).toBeFalse();
    expect(exits).toEqual([5000]);

    unsubscribe();
    const replacement = factory.spawn(IDENTITY);
    children[1]?.emit('exit', 0, null);
    expect(factory.owns(replacement)).toBeFalse();
    expect(exits).toEqual([5000]);
  });
});

describe('NodeConfigWorkerFactory cleanup', () => {
  test('leaks no timer or child when spawn or adapter construction fails', () => {
    // Given / When / Then
    const spawnFailure = harness({ source: 'compiled', executable: '/app/bungee', args: [] });
    const error = new Error('spawn failed');
    const throwingFactory = new NodeConfigWorkerFactory({
      launch: { source: 'compiled', executable: '/app/bungee', args: [] }, masterPid: 9876,
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 500, shutdownTimeoutMs: 250,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET, accessLogDbPath: '/work/logs/access.db',
      spawn: () => { throw error; },
      heartbeatScheduler: spawnFailure.intervals, terminationScheduler: spawnFailure.terminationScheduler,
    });
    expect(() => throwingFactory.spawn(IDENTITY)).toThrow(error);
    expect(spawnFailure.intervals.callbacks.size).toBe(0);

    const child = childProcess(6000);
    const signals: NodeJS.Signals[] = [];
    Object.defineProperty(child, 'kill', { configurable: true, value(signal: NodeJS.Signals) {
      signals.push(signal); return true;
    } });
    const adapterFailure = new NodeConfigWorkerFactory({
      launch: { source: 'compiled', executable: '/app/bungee', args: [] }, masterPid: 9876,
      heartbeatIntervalMs: 100, heartbeatTimeoutMs: 500, shutdownTimeoutMs: 250,
      transportSecret: TEST_WORKER_TRANSPORT_SECRET, accessLogDbPath: '/work/logs/access.db', spawn: () => child,
      adapterFactory: () => { throw new Error('adapter failed'); },
      heartbeatScheduler: spawnFailure.intervals, terminationScheduler: spawnFailure.terminationScheduler,
    });
    expect(() => adapterFailure.spawn(IDENTITY)).toThrow('adapter failed');
    expect(signals).toEqual(['SIGKILL']);
    expect(spawnFailure.intervals.callbacks.size).toBe(0);
  });

  test('stops heartbeat, escalates, and returns exact confirmed and unconfirmed evidence', async () => {
    // Given
    const { children, factory, intervals, terminationScheduler } = harness({
      source: 'compiled', executable: '/app/bungee', args: [],
    });
    const confirmed = factory.spawn(IDENTITY);
    const unconfirmed = factory.spawn({ ...IDENTITY,
      worker_instance_id: '20000000-0000-4000-8000-000000000002', worker_slot: 4 });
    const signals: NodeJS.Signals[][] = [[], []];
    children.forEach((child, index) => {
      Object.defineProperty(child, 'kill', { configurable: true, value(signal: NodeJS.Signals) {
        signals[index]?.push(signal);
        if (index === 0) child.emit('exit', 0, signal);
        return true;
      } });
    });

    // When
    const pending = factory.shutdownAll();
    await settle();
    terminationScheduler.fireNext();
    await settle();
    terminationScheduler.fireNext();
    const results = await pending;

    // Then
    expect(intervals.callbacks.size).toBe(0);
    expect(signals).toEqual([['SIGTERM'], ['SIGTERM', 'SIGKILL']]);
    expect(results).toEqual([
      { process: confirmed, exitEvidence: { exited: true, pid: 5000 } },
      { process: unconfirmed, exitEvidence: null },
    ]);
    expect(factory.snapshot()).toEqual([unconfirmed]);
    expect(factory.pids()).toEqual([5001]);
  });
});
