import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcessIdentity } from '../../packages/core/src/master-runtime/process-identity';
import {
  cleanupGatewayFixture,
  quarantinePortBlock,
  reservePortBlock,
  releasePortBlock,
  startTrackedGatewayMaster,
  stopOwnedMaster,
  type GatewayFixture,
  type GatewayMasterStartupState,
  type OwnedMaster,
  type PortLease,
} from './token-stats-gateway';

async function ownedChild(mode: 'fail' | 'delay'): Promise<OwnedMaster> {
  const child = spawn(process.execPath, ['-e', `
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (value) => {
      if (value.includes('shutdown')) ${mode === 'fail' ? 'process.exit(1)' : 'setTimeout(() => process.exit(0), 2000)'};
    });
    console.log('READY');
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'pipe'] });
  const output: string[] = [];
  const workers: ChildProcess[] = [];
  const records: Array<{ pid: number; workerInstanceId: string; identity: Awaited<ReturnType<typeof captureProcessIdentity>> }> = [];
  let ready = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  let buffered = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffered = (buffered + chunk.toString('utf8')).slice(-4_096);
    if (!ready && buffered.includes('READY')) { ready = true; readyResolve(); }
  });
  child.once('error', (error) => { if (!ready) readyReject(error); });
  child.once('close', (code, signal) => {
    if (!ready) readyReject(new Error(`fault-injection child exited during initialization (${String(code ?? signal)})`));
  });

  const children: ChildProcess[] = [child];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workersReady: Promise<void> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('fault-injection child did not initialize')), 2_000); });
    workersReady = (async () => {
      for (let index = 0; index < 2; index++) {
        const workerInstanceId = randomUUID();
        const worker = spawn(process.execPath, ['-e', 'process.stdin.setEncoding("utf8"); process.stdin.on("data", () => process.exit(0)); setInterval(() => {}, 1000);', `--bungee-process-identity=${workerInstanceId}`], { stdio: ['pipe', 'ignore', 'ignore'] });
        children.push(worker);
        worker.once('error', () => undefined);
        if (worker.pid === undefined) throw new Error('fault-injection worker did not spawn');
        worker.unref();
        workers.push(worker);
        records.push({ pid: worker.pid, workerInstanceId, identity: await captureProcessIdentity(worker.pid, workerInstanceId) });
      }
    })();
    await Promise.race([Promise.all([readyPromise, workersReady]), timeout]);
    return {
      child, output, token: 'not-used', workers: new Map(records.map((worker) => [worker.workerInstanceId, worker])),
      workerInventoryComplete: true,
      shutdown: async () => {
        child.stdin?.write('shutdown\n');
        for (const worker of workers) worker.stdin?.write('exit\n');
      },
    };
  } catch (error) {
    await workersReady?.catch(() => undefined);
    const unconfirmed = await terminateExactlyOwnedChildren(children);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${unconfirmed.length ? `owned child exit unconfirmed: ${unconfirmed.join(',')}` : 'all spawned fixture children exited'}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function terminateExactlyOwnedChildren(children: readonly ChildProcess[]): Promise<number[]> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  const unconfirmed: number[] = [];
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited && child.pid !== undefined) unconfirmed.push(child.pid);
  }
  return unconfirmed;
}

test('shutdown rejects nonzero exit and refuses to treat a bounded timeout as graceful', async () => {
  const failedExit = await ownedChild('fail');
  const nonzeroFailure = await stopFailure(failedExit, { graceTimeoutMs: 500, forceTimeoutMs: 500 });
  expect(nonzeroFailure).toMatchObject({ name: 'OwnedMasterShutdownError', workersVerifiedExited: true });
  expect(nonzeroFailure.message).toContain('exitCode=1');
  expect(failedExit.child.exitCode).toBe(1);
  expect(failedExit.child.signalCode).toBeNull();

  const delayedExit = await ownedChild('delay');
  const timeoutFailure = await stopFailure(delayedExit, { graceTimeoutMs: 30, forceTimeoutMs: 500 });
  expect(timeoutFailure).toMatchObject({ name: 'OwnedMasterShutdownError', workersVerifiedExited: true });
  expect(timeoutFailure.message).toContain('exceeded graceful shutdown deadline');
  expect(delayedExit.child.exitCode).toBeNull();
  expect(delayedExit.child.signalCode).not.toBeNull();
});

test('preserves fixture evidence when startup spawned a master that exited before worker inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-stats-gateway-startup-failure-'));
  const evidencePath = join(root, 'bungee.error.log');
  const fixture: GatewayFixture = {
    root,
    configDbPath: join(root, 'config.db'),
    accessDbPath: join(root, 'access.db'),
    pluginsPath: join(root, 'plugins'),
    pluginSecretsKey: 'fixture-plugin-secret',
    token: 'fixture-token',
  };
  await writeFile(evidencePath, 'original startup failure', 'utf8');
  const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 1 ? resolve() : reject(new Error(`expected child exit 1, got ${String(code)}`)));
  });
  const failedStartup: OwnedMaster = {
    child,
    output: [],
    token: fixture.token,
    workers: new Map(),
    workerInventoryComplete: false,
  };

  const removed = await cleanupGatewayFixture(fixture, {
    startupAttempted: true,
    master: failedStartup,
    shutdownVerified: false,
    portsVerifiedClosed: true,
  });
  expect(removed).toBe(false);
  expect(await readFile(evidencePath, 'utf8')).toBe('original startup failure');
  expect(failedStartup.child.exitCode).toBe(1);

  await cleanupGatewayFixture(fixture);
});

test('preserves fixture and quarantines lease when processes exited but ports were not verified closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'token-stats-gateway-open-port-'));
  const evidencePath = join(root, 'bungee.error.log');
  const fixture: GatewayFixture = {
    root,
    configDbPath: join(root, 'config.db'),
    accessDbPath: join(root, 'access.db'),
    pluginsPath: join(root, 'plugins'),
    pluginSecretsKey: 'fixture-plugin-secret',
    token: 'fixture-token',
  };
  await writeFile(evidencePath, 'port-close evidence', 'utf8');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`expected child exit 0, got ${String(code)}`)));
  });
  const verifiedMaster: OwnedMaster = {
    child, output: [], token: fixture.token,
    workers: new Map([
      ['00000000-0000-4000-8000-000000000001', { pid: 1, workerInstanceId: '00000000-0000-4000-8000-000000000001' }],
      ['00000000-0000-4000-8000-000000000002', { pid: 2, workerInstanceId: '00000000-0000-4000-8000-000000000002' }],
    ]),
    workerInventoryComplete: true,
  };
  const lease = await reservePortBlock();
  quarantinePortBlock(lease);

  const removed = await cleanupGatewayFixture(fixture, {
    startupAttempted: true,
    master: verifiedMaster,
    shutdownVerified: true,
    portsVerifiedClosed: false,
  });
  expect(removed).toBe(false);
  expect(await readFile(evidencePath, 'utf8')).toBe('port-close evidence');
  await expect(releasePortBlock(lease)).rejects.toThrow();
  await cleanupGatewayFixture(fixture);
});

test('restart startup failure keeps the newly spawned child registered and aggregates its error', async () => {
  const fixture = {
    root: '/tmp/token-stats-gateway-restart', configDbPath: '', accessDbPath: '', pluginsPath: '',
    pluginSecretsKey: 'test-key', token: 'test-token',
  } satisfies GatewayFixture;
  const lease = { base: 1, block: {} as PortLease['block'] } satisfies PortLease;
  const state: GatewayMasterStartupState = { attempted: false, errors: [] };
  const firstChild = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    firstChild.once('error', reject);
    firstChild.once('close', (code) => code === 0 ? resolve() : reject(new Error(`expected first master exit 0, got ${String(code)}`)));
  });
  const firstOwner: OwnedMaster = { child: firstChild, output: [], token: fixture.token, workers: new Map(), workerInventoryComplete: false };
  const restartedChild = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
  let launchCount = 0;
  const launch: typeof import('./token-stats-gateway').spawnMaster = async (_fixture, _lease, onSpawn) => {
    launchCount++;
    if (launchCount === 1) {
      onSpawn?.(firstOwner);
      return firstOwner;
    }
    const restartedOwner: OwnedMaster = {
      child: restartedChild, output: [], token: fixture.token, workers: new Map(), workerInventoryComplete: false,
    };
    onSpawn?.(restartedOwner);
    await new Promise<void>((resolve, reject) => {
      restartedChild.once('error', reject);
      restartedChild.once('close', (code) => code === 1 ? resolve() : reject(new Error(`expected restart exit 1, got ${String(code)}`)));
    });
    throw new Error('simulated restart start failure');
  };
  await startTrackedGatewayMaster(state, fixture, lease, launch);
  expect(state.master).toBe(firstOwner);
  await expect(startTrackedGatewayMaster(state, fixture, lease, launch)).rejects.toThrow('simulated restart start failure');
  expect(state.attempted).toBe(true);
  expect(state.master?.child).toBe(restartedChild);
  expect(state.errors).toHaveLength(1);
  expect(state.errors[0]).toBeInstanceOf(Error);
});

async function stopFailure(master: OwnedMaster, options: { graceTimeoutMs: number; forceTimeoutMs: number }): Promise<Error> {
  try {
    await stopOwnedMaster(master, options);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('shutdown helper rejected with a non-Error value');
  }
  throw new Error('shutdown helper incorrectly reported success');
}
