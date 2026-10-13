import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { armProcessLifetimeGuard, parseProcessLifetimeHeldAck, probeExistingProcessLifetimeGuard,
  PROCESS_LIFETIME_GUARD_ENV, writeProcessLifetimeHeldAck, type HeldProcessLifetimeGuardFacts } from '../../src/supervision/process-lifetime-guard';
import { cleanupProcesses, ProcessRegistry } from '../helpers/process-cleanup';

const childEntry = new URL('../fixtures/process-lifetime-child.ts', import.meta.url).pathname;

test('a reopened FD cannot acquire a free lock or resurrect an irreversibly retired identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-lifetime-no-reacquire-'));
  const guard = armProcessLifetimeGuard({ directory, processInstanceId: randomUUID() });
  const checkReopened = (message: string) => {
    const fd = openSync(guard.facts.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const child = spawnSync(process.execPath, [childEntry, 'check-inheritance'], {
        stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8',
        env: { ...process.env, [PROCESS_LIFETIME_GUARD_ENV]: JSON.stringify(guard.facts), BUNGEE_TEST_PROCESS_INSTANCE_ID: guard.facts.process_instance_id },
      });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ error: message });
    } finally { closeSync(fd); }
  };
  try {
    // Busy on another open description is not proof that FD3 inherited it.
    checkReopened('inherited process lifetime guard is not held');
    guard.closeAfterChildExit();
    // Before any probe, an unlocked original file must also reject a new ACK.
    checkReopened('inherited process lifetime guard is not held');
    const proof = probeExistingProcessLifetimeGuard(guard.facts);
    expect(proof.kind).toBe('confirmed');
    if (proof.kind !== 'confirmed') throw new Error('retirement proof missing');
    proof.fence.close();
    // Reviewer reproducer: confirmed probe, release fence, reopen FD3, ACK.
    checkReopened('inherited process lifetime guard identity is retired');
    const repeated = probeExistingProcessLifetimeGuard(guard.facts);
    expect(repeated.kind).toBe('confirmed');
    if (repeated.kind === 'confirmed') repeated.fence.close();
  } finally { guard.closeAfterChildExit(); rmSync(directory, { recursive: true, force: true }); }
});

test('FD3 handoff survives parent close, descendants cannot inherit and OS exit releases the exact lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-lifetime-fd-'));
  const registry = new ProcessRegistry();
  const guard = armProcessLifetimeGuard({ directory, processInstanceId: randomUUID() });
  try {
    const child = spawn(process.execPath, [childEntry], { stdio: ['ignore', 'pipe', 'pipe', guard.fd],
      env: { ...process.env, [PROCESS_LIFETIME_GUARD_ENV]: JSON.stringify(guard.facts), BUNGEE_TEST_PROCESS_INSTANCE_ID: guard.facts.process_instance_id } });
    registry.registerChild(child);
    const ready = await new Promise<{ held: HeldProcessLifetimeGuardFacts; descendant: { inherited: boolean } }>((resolve, reject) => {
      let output = ''; let errors = '';
      const timer = setTimeout(() => reject(new Error(`guard handoff timed out: ${errors}`)), 5_000);
      child.stderr!.on('data', value => { errors += value.toString(); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`guard child exited: ${errors}`)); });
      child.stdout!.on('data', value => { output += value.toString(); if (output.includes('\n')) { clearTimeout(timer); resolve(JSON.parse(output.trim())); } });
    });
    expect(ready.descendant.inherited).toBe(false);
    guard.closeAfterHeldAck(ready.held);
    expect(probeExistingProcessLifetimeGuard(guard.facts)).toEqual({ kind: 'live' });
    await cleanupProcesses(registry);
    const proof = probeExistingProcessLifetimeGuard(guard.facts);
    expect(proof.kind).toBe('confirmed');
    if (proof.kind !== 'confirmed') throw new Error('guard exit was not proven');
    // The retirement fence stays exclusive until its durable authority is written.
    expect(probeExistingProcessLifetimeGuard(guard.facts)).toEqual({ kind: 'live' });
    proof.fence.close();
    const next = probeExistingProcessLifetimeGuard(guard.facts);
    expect(next.kind).toBe('confirmed');
    if (next.kind === 'confirmed') next.fence.close();
  } finally { guard.closeAfterChildExit(); await cleanupProcesses(registry); rmSync(directory, { recursive: true, force: true }); }
});

test('missing/replaced files and a foreign host boot never become exit proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-lifetime-file-'));
  const guard = armProcessLifetimeGuard({ directory, processInstanceId: randomUUID() });
  try {
    expect(probeExistingProcessLifetimeGuard({ ...guard.facts, host_boot_id: `linux:${randomUUID()}` })).toEqual({ kind: 'unknown', reason: 'domain' });
    renameSync(guard.facts.path, `${guard.facts.path}.original`);
    expect(probeExistingProcessLifetimeGuard(guard.facts)).toEqual({ kind: 'unknown', reason: 'missing' });
    writeFileSync(guard.facts.path, JSON.stringify(guard.facts));
    expect(probeExistingProcessLifetimeGuard(guard.facts)).toEqual({ kind: 'unknown', reason: 'replaced' });
  } finally { guard.closeAfterChildExit(); rmSync(directory, { recursive: true, force: true }); }
});

test('held ACK is signed and binds the random guard, process identity and boot nonce', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bungee-lifetime-ack-'));
  const guard = armProcessLifetimeGuard({ directory, processInstanceId: randomUUID() });
  try {
    const key = randomBytes(32); const nonce = randomUUID(); const path = join(directory, 'held.json');
    writeProcessLifetimeHeldAck(path, { ...guard.facts, held: true }, nonce, key);
    const raw = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    expect(parseProcessLifetimeHeldAck(raw, key).boot_nonce).toBe(nonce);
    expect(() => parseProcessLifetimeHeldAck({ ...raw, boot_nonce: randomUUID() }, key)).toThrow('signature');
    expect(() => parseProcessLifetimeHeldAck(raw, randomBytes(32))).toThrow('signature');
    expect(() => guard.closeAfterHeldAck({ ...raw.guard, identity: randomUUID() })).toThrow('identity mismatch');
  } finally { guard.closeAfterChildExit(); rmSync(directory, { recursive: true, force: true }); }
});

test('an adopted colliding raw PID with missing guard evidence never becomes exit proof', async () => {
  const { SupervisedConfigWorkerProcessAdapter } = await import('../../src/master-runtime/supervised-worker-process-adapter');
  const { deriveWorkerSupervisionSeed, deriveWorkerSupervisionCredential } = await import('../../src/supervision');
  const identity = { master_generation: randomUUID(), worker_instance_id: randomUUID(), worker_slot: 0 };
  const seed = deriveWorkerSupervisionSeed(randomBytes(32), identity.master_generation, identity.worker_instance_id, 0);
  const credential = deriveWorkerSupervisionCredential(seed, randomUUID());
  const readyClient = { credential, cachedStatus: null, subscribeControlState: () => () => undefined, disconnect() {} };
  const adapter = new SupervisedConfigWorkerProcessAdapter({ identity, descriptorPath: `/tmp/bungee-missing-guard-${randomUUID()}`,
    supervisionSeed: seed, client: { authority: { controller_epoch: 1, controller_id: randomUUID() } },
    pid: process.pid, readyClient: readyClient as any, kernelBootId: async () => 'kernel-monotonic-v1:test-host' });
  try {
    await expect(adapter.initialization).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(adapter.verifyExactExit()).rejects.toThrow('exit remains unknown');
  } finally { adapter.disconnect(); }
});
