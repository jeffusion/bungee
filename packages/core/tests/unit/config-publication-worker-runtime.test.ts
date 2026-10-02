import { describe, expect, test } from 'bun:test';
import { DEFAULT_PUBLICATION_POLICY } from '@jeffusion/bungee-types';
import { createConfigWorkerRuntimeController as createRuntimeController, type ConfigWorkerLifecycle } from '../../src/config-publication';
import { parseConfigWorkerMessage } from '../../src/config-publication/messages';
import { compileRuntimeConfigSnapshot } from '../../src/config-storage';
import { IDS, PLUGIN_CATALOG_HASH, PRIVATE_PORT, PROCESS_IDENTITY, aggregate, drainMessage, expectMessage, fakeLifecycle, type Handle, startCurrentMessage, startMessage, statusReport } from './config-publication-worker-runtime.fixtures';

const TEST_BOOT_ID = 'linux:11111111-1111-4111-8111-111111111111';
function createConfigWorkerRuntimeController<ServingHandle>(
  options: Parameters<typeof createRuntimeController<ServingHandle>>[0],
): ReturnType<typeof createRuntimeController<ServingHandle>> {
  return createRuntimeController<ServingHandle>({ ...options, bootId: TEST_BOOT_ID });
}

describe('config publication worker runtime', () => {
  test('awaits asynchronous compilation with command context before lifecycle start', async () => {
    const fake = fakeLifecycle();
    const command = startMessage();
    let receivedCommand: unknown;
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fake.lifecycle,
      async compileSnapshot(snapshot, context) {
        receivedCommand = context;
        await Promise.resolve();
        return compileRuntimeConfigSnapshot(snapshot);
      },
    });

    const result = await controller.apply(command);

    expect(result.ok).toBe(true);
    expect(receivedCommand).toEqual(command);
    expect(fake.calls[0]).toBe('start');
  });
  test('publishes catalog and actual loopback port only after lifecycle validates the command', async () => {
    const seenCommands: unknown[] = [];
    const report = statusReport(['alpha', 'service-plugin', 'upstream-plugin', 'zeta']);
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      async start(_config, command) {
        seenCommands.push(command);
        if (command.plugin_catalog_hash !== PLUGIN_CATALOG_HASH) throw new Error('local catalog mismatch');
        return { handle: { id: 1 }, private_port: 41001,
          plugin_runtime_generation: report.generation, plugin_status: report };
      },
      async stop() {}, async stopAccepting() {}, async drain() {},
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle });

    const message = expectMessage(await controller.apply({ ...startMessage(),
      plugin_catalog_hash: PLUGIN_CATALOG_HASH }));

    expect(seenCommands).toHaveLength(1);
    expect(message).toMatchObject({ status: 'config-ready',
      plugin_catalog_hash: PLUGIN_CATALOG_HASH, private_port: 41001 });
  });

  test('reports target catalog hash when lifecycle local validation fails', async () => {
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      async start() { throw new Error('local catalog mismatch'); },
      async stop() {}, async stopAccepting() {}, async drain() {},
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle });

    const message = expectMessage(await controller.apply({ ...startMessage(),
      plugin_catalog_hash: PLUGIN_CATALOG_HASH }));

    expect(message).toMatchObject({ status: 'config-apply-failed',
      target_plugin_catalog_hash: PLUGIN_CATALOG_HASH });
  });

  test('rejects invalid lifecycle private ports and cleans up the started handle', async () => {
    for (const private_port of [0, 65_536]) {
      const fake = fakeLifecycle();
      const lifecycle: ConfigWorkerLifecycle<Handle> = {
        ...fake.lifecycle,
        async start(config, command) {
          return { ...await fake.lifecycle.start(config, command), private_port };
        },
      };
      const controller = createConfigWorkerRuntimeController({
        pid: 4321, identity: PROCESS_IDENTITY, lifecycle,
      });

      const message = expectMessage(await controller.apply(startMessage()));

      expect(message).toMatchObject({ status: 'config-apply-failed',
        target_plugin_catalog_hash: PLUGIN_CATALOG_HASH, error: 'worker private port is invalid' });
      expect(fake.calls).toEqual(['start', 'stop:1']);
    }
  });

  test('does not treat a different plugin catalog as the same start attempt', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
    const first = { ...startMessage(), plugin_catalog_hash: PLUGIN_CATALOG_HASH };
    expectMessage(await controller.apply(first));

    const conflict = expectMessage(await controller.apply({ ...first,
      plugin_catalog_hash: `sha256:${'d'.repeat(64)}` }));

    expect(conflict).toMatchObject({ status: 'config-apply-failed',
      target_plugin_catalog_hash: `sha256:${'d'.repeat(64)}`, serving_revision: 7 });
    expect(fake.calls).toEqual(['start']);
  });

  test('compiles one owned config and reports exact identity after every required plugin serves', async () => {
    // Given
    const fake = fakeLifecycle();
    const options = { pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle };
    const controller = createConfigWorkerRuntimeController(options);
    const input = startMessage();
    options.pid = 9999;

    // When
    const message = expectMessage(await controller.apply(input));

    // Then
    expect(message).toEqual({
      status: 'config-ready', ...PROCESS_IDENTITY, boot_nonce: expect.any(String), pid: 4321, revision: 7,
      content_hash: input.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      private_port: PRIVATE_PORT, plugin_runtime_generation: 11,
      required_plugins: ['alpha', 'service-plugin', 'upstream-plugin', 'zeta'],
      serving_plugins: ['alpha', 'service-plugin', 'upstream-plugin', 'zeta'],
      publication: { mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 3 },
    });
    expect(parseConfigWorkerMessage(message)).toEqual(message);
    expect(fake.calls).toEqual(['start']);
    expect(fake.configs[0]?.services?.[0]?.endpoints.map(({ id }) => id)).toEqual([IDS.upstreamA, IDS.upstreamB]);
    expect(fake.configs[0]?.plugins).toEqual([
      { id: IDS.disabledBinding, name: 'disabled-override', enabled: false },
      { id: IDS.globalBinding, name: 'zeta', enabled: true },
    ]);
  });

  test('echoes null publication identity for current snapshot startup', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });

    const message = expectMessage(await controller.apply(startCurrentMessage()));

    expect(message).toMatchObject({ status: 'config-ready', revision: 7, publication: null });
  });

  test('echoes null publication identity when current snapshot startup fails', async () => {
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      async start() { throw new Error('startup failed'); },
      async stop() {}, async stopAccepting() {}, async drain() {},
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle });

    const message = expectMessage(await controller.apply(startCurrentMessage()));

    expect(message).toMatchObject({ status: 'config-apply-failed', publication: null });
  });

  test('does not require an activation without a binding or a disabled binding', async () => {
    const fake = fakeLifecycle(statusReport(['alpha', 'service-plugin', 'upstream-plugin', 'zeta', 'extra-serving']));
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });

    const message = expectMessage(await controller.apply(startMessage()));

    expect(message).toMatchObject({
      required_plugins: ['alpha', 'service-plugin', 'upstream-plugin', 'zeta'],
      serving_plugins: ['alpha', 'extra-serving', 'service-plugin', 'upstream-plugin', 'zeta'],
    });
    expect(parseConfigWorkerMessage(message)).toEqual(message);
  });

  test('cleans up and reports every missing or non-serving required plugin without partial readiness', async () => {
    const report = statusReport(
      ['alpha', 'upstream-plugin', 'zeta'],
      11,
      { alpha: 'loaded', 'upstream-plugin': 'degraded', zeta: 'quarantined' },
    );
    const fake = fakeLifecycle(report);
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });

    const message = expectMessage(await controller.apply(startMessage()));

    expect(message).toMatchObject({
      status: 'config-apply-failed', serving_revision: null, serving_content_hash: null,
      failed_plugins: ['alpha', 'service-plugin', 'upstream-plugin', 'zeta'],
      publication: { mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 3 },
    });
    expect(fake.calls).toEqual(['start', 'stop:1']);

    const duplicate = expectMessage(await controller.apply(startMessage()));
    expect(duplicate).toEqual(message);
    expect(fake.calls).toEqual(['start', 'stop:1']);
  });

  test('reports plugin cleanup failure without misclassifying it as lifecycle start failure', async () => {
    // Given
    const fake = fakeLifecycle(statusReport([]));
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async stop(handle) {
        fake.calls.push(`stop:${handle.id}`);
        throw new Error('cleanup failed');
      },
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle });

    // When
    const message = expectMessage(await controller.apply(startMessage()));

    // Then
    expect(message).toMatchObject({
      status: 'config-apply-failed',
      failed_plugins: ['alpha', 'service-plugin', 'upstream-plugin', 'zeta'],
      error: 'required plugins are not serving; cleanup failed',
    });
    expect(fake.calls).toEqual(['start', 'stop:1']);
  });

  test('rejects stale plugin generation evidence and cleans up the handle', async () => {
    const report = statusReport(['alpha', 'service-plugin', 'upstream-plugin', 'zeta'], 10);
    const fake = fakeLifecycle(report);
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async start(config, command) {
        const started = await fake.lifecycle.start(config, command);
        return { ...started, plugin_runtime_generation: 11 };
      },
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle });

    const message = expectMessage(await controller.apply(startMessage()));

    expect(message).toMatchObject({ status: 'config-apply-failed' });
    expect(fake.calls).toEqual(['start', 'stop:1']);
  });

  test('reports compile and lifecycle failures with bounded wire errors', async () => {
    // Given
    const throwing: ConfigWorkerLifecycle<Handle> = {
      async start() { throw new Error(`secret-token ${'x'.repeat(600)}`); },
      async stop() {}, async stopAccepting() {}, async drain() {},
    };
    const compileController = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fakeLifecycle().lifecycle,
      compileSnapshot() { throw new Error('compiler secret'); },
    });
    const startController = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: throwing });

    // When
    const compileFailure = expectMessage(await compileController.apply(startMessage()));
    const startFailure = expectMessage(await startController.apply(startMessage()));

    // Then
    expect(compileFailure).toMatchObject({ status: 'config-apply-failed', failed_plugins: [] });
    expect(startFailure).toMatchObject({
      status: 'config-apply-failed', failed_plugins: [],
      publication: { mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 3 },
    });
    if (!('status' in compileFailure) || compileFailure.status !== 'config-apply-failed'
      || !('status' in startFailure) || startFailure.status !== 'config-apply-failed') return;
    expect(compileFailure.error.length).toBeGreaterThan(0);
    expect(startFailure.error.length).toBeLessThanOrEqual(512);
    expect(startFailure.error).not.toContain('secret-token');
  });

  test('echoes parsed command identity even when an injected compiler returns different metadata', async () => {
    // Given
    const fake = fakeLifecycle();
    const input = startMessage();
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fake.lifecycle,
      compileSnapshot(_snapshot) {
        return {
          revision: 999,
          content_hash: `sha256:${'f'.repeat(64)}`,
          config: { config_version: 4, routes: [], plugins: [{ name: 'alpha', enabled: true }] },
        };
      },
    });

    // When
    const message = expectMessage(await controller.apply(input));

    // Then
    expect(message).toMatchObject({ revision: 7, content_hash: input.content_hash });
  });

  test('returns the same ready evidence for duplicate and concurrent starts without restarting', async () => {
    const fake = fakeLifecycle();
    fake.holdStart();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
    const input = startMessage();

    const first = controller.apply(input);
    const second = controller.apply(structuredClone(input));
    await fake.waitForStart();
    fake.releaseStart();
    const [firstMessage, secondMessage] = await Promise.all([first, second]);

    expect(expectMessage(firstMessage)).toEqual(expectMessage(secondMessage));
    expect(fake.calls).toEqual(['start']);
  });

  test('snapshots a concurrent command before it waits in the serial queue', async () => {
    // Given
    const fake = fakeLifecycle();
    fake.holdStart();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
    const input = startMessage();

    // When
    const first = controller.apply(input);
    const duplicate = controller.apply(input);
    input.revision = 8;
    await fake.waitForStart();
    fake.releaseStart();

    // Then
    expect(expectMessage(await duplicate)).toMatchObject({ status: 'config-ready', revision: 7 });
    expectMessage(await first);
    expect(fake.calls).toEqual(['start']);
  });

  test('refuses a hash conflict or replacement revision while preserving the serving generation', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
    const serving = startMessage();
    expectMessage(await controller.apply(serving));
    const changed = aggregate();
    const hashConflict = startMessage(7, {
      ...changed,
      logical_configuration: {
        ...changed.logical_configuration,
        log_level: 'debug',
      },
    });

    const conflict = expectMessage(await controller.apply(hashConflict));
    const replacement = expectMessage(await controller.apply(startMessage(8)));

    expect(conflict).toMatchObject({
      status: 'config-apply-failed', serving_revision: 7, serving_content_hash: serving.content_hash,
    });
    expect(replacement).toMatchObject({
      status: 'config-apply-failed', target_revision: 8, serving_revision: 7,
    });
    expect(fake.calls).toEqual(['start']);
  });

  test('refuses same revision and hash with different publication fencing identity', async () => {
    const variants = [
      { mutation_id: 'mutation-2', attempt_no: 2, drain_recovery_generation: 3 },
      { mutation_id: 'mutation-1', attempt_no: 3, drain_recovery_generation: 3 },
      { mutation_id: 'mutation-1', attempt_no: 2, drain_recovery_generation: 4 },
    ];
    for (const publication of variants) {
      const fake = fakeLifecycle();
      const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
      const serving = startMessage();
      expectMessage(await controller.apply(serving));

      const conflict = expectMessage(await controller.apply({ ...serving, publication }));

      expect(conflict).toMatchObject({
        status: 'config-apply-failed', publication, serving_revision: 7,
      });
      expect(fake.calls).toEqual(['start']);
    }
  });

  test('stops accepting before graceful drain and makes duplicate drain idempotent', async () => {
    const fake = fakeLifecycle();
    fake.holdDrain();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle: fake.lifecycle });
    expectMessage(await controller.apply(startMessage()));
    const drain = drainMessage();

    const first = expectMessage(await controller.apply(drain));
    const duplicate = expectMessage(await controller.apply(drain));

    expect(first).toMatchObject({ status: 'worker-draining', ...PROCESS_IDENTITY, boot_nonce: expect.any(String), pid: 4321,
      revision: 7, content_hash: drain.content_hash, plugin_catalog_hash: PLUGIN_CATALOG_HASH,
      drain_id: drain.drain_id, policy: drain.policy, remaining_ms: drain.policy.drain_timeout_ms,
      publication: drain.publication });
    expect(duplicate).toMatchObject({ status: 'worker-draining', drain_id: drain.drain_id, policy: drain.policy });
    await fake.waitForDrainStart();
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1']);
    fake.releaseDrain();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-drained', drain_id: drain.drain_id } });
  });

  test('serializes duplicate concurrent drain commands and drains once', async () => {
    // Given
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle: fake.lifecycle });
    expectMessage(await controller.apply(startMessage()));
    const drain = drainMessage();

    // When
    const [first, duplicate] = await Promise.all([controller.apply(drain), controller.apply(drain)]);

    // Then
    expect(['worker-draining', 'worker-drained']).toContain(expectMessage(first).status);
    expect(['worker-draining', 'worker-drained']).toContain(expectMessage(duplicate).status);
    expect(expectMessage(first)).toMatchObject({ drain_id: drain.drain_id });
    expect(expectMessage(duplicate)).toMatchObject({ drain_id: drain.drain_id });
    await controller.failClosed();
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1', 'stop:1']);
  });

  test('rejects conflicting drain task identity without resetting the active drain', async () => {
    const fake = fakeLifecycle();
    fake.holdDrain();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle: fake.lifecycle });
    expectMessage(await controller.apply(startMessage()));
    const original = drainMessage();
    expect(expectMessage(await controller.apply(original))).toMatchObject({ status: 'worker-draining' });

    const conflict = await controller.apply({ ...original, drain_id: '93000000-0000-4000-8000-000000000001' });

    expect(conflict).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1']);
    fake.releaseDrain();
  });

  test('forces HTTP stop only after D expires and never reports natural drained success', async () => {
    const fake = fakeLifecycle();
    fake.holdDrain();
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async forceStop() { fake.calls.push('force-stop'); },
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle });
    expectMessage(await controller.apply(startMessage()));
    const command = { ...drainMessage(), policy: {
      drain_start_timeout_ms: 1_000, drain_timeout_ms: 1_000, worker_exit_timeout_ms: 1_000,
    } };

    expectMessage(await controller.apply(command));
    await fake.waitForDrainStart();
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(fake.calls).toContain('force-stop');
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-drain-failed', error_code: 'timeout' } });
    fake.releaseDrain();
  });

  test('rejects drain before start and mismatched drain without touching the runtime', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });

    const beforeStart = await controller.apply(drainMessage());
    expect(beforeStart.ok).toBe(false);
    expectMessage(await controller.apply(startMessage()));
    const wrongSlot = await controller.apply({ ...drainMessage(), worker_slot: 4 });
    const wrongRevision = await controller.apply({ ...drainMessage(), revision: 8 });

    expect(wrongSlot.ok).toBe(false);
    expect(wrongRevision.ok).toBe(false);
    expect(fake.calls).toEqual(['start']);
  });

  test.each(['reject', 'hang'] as const)('attempts cleanup and shutdown when HTTP force-stop %s', async (mode) => {
    const fake = fakeLifecycle();
    fake.holdDrain();
    let shutdownRequested!: () => void;
    const shutdown = new Promise<void>((resolve) => { shutdownRequested = resolve; });
    const controller = createConfigWorkerRuntimeController({
      pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001',
      requestShutdown: shutdownRequested,
      lifecycle: { ...fake.lifecycle, async forceStop() {
        fake.calls.push('force-stop');
        if (mode === 'reject') throw new Error('HTTP stop failed');
        await new Promise(() => undefined);
      } },
    });
    expectMessage(await controller.apply(startMessage()));
    expectMessage(await controller.apply({ ...drainMessage(), policy: {
      drain_start_timeout_ms: 1000, drain_timeout_ms: 1000, worker_exit_timeout_ms: 1000,
    } }));
    await Promise.race([shutdown, Bun.sleep(3000).then(() => { throw new Error('shutdown was skipped'); })]);
    expect(fake.calls.filter((call) => call === 'stop:1')).toHaveLength(1);
    if (mode === 'reject') {
      await controller.failClosed();
      expect(controller.drainStatus()).toMatchObject({ ok: true, message: {
        status: 'worker-drain-failed', error_code: 'timeout', http_stopped: true, cleanup_state: 'success',
      } });
    } else {
      expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    }
    fake.releaseDrain();
  }, 4000);

  test('rejects every wrong process identity before start and responds with authoritative identity', async () => {
    // Given / When / Then
    for (const identity of [
      { ...PROCESS_IDENTITY, master_generation: '50000000-0000-4000-8000-000000000002' },
      { ...PROCESS_IDENTITY, worker_instance_id: '60000000-0000-4000-8000-000000000002' },
      { ...PROCESS_IDENTITY, worker_slot: 4 },
    ]) {
      const fake = fakeLifecycle();
      const controller = createConfigWorkerRuntimeController({
        pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle,
      });

      const result = expectMessage(await controller.apply({ ...startMessage(), ...identity }));

      expect(result).toMatchObject({ status: 'config-apply-failed', ...PROCESS_IDENTITY, pid: 4321 });
      expect(fake.calls).toEqual([]);
    }
  });

  test('rejects wrong drain identity hash or publication before lifecycle drain', async () => {
    // Given
    const variants = [
      { ...drainMessage(), master_generation: '50000000-0000-4000-8000-000000000002' },
      { ...drainMessage(), worker_instance_id: '60000000-0000-4000-8000-000000000002' },
      { ...drainMessage(), worker_slot: 4 },
      { ...drainMessage(), content_hash: `sha256:${'f'.repeat(64)}` },
      { ...drainMessage(), publication: { mutation_id: 'mutation-2', attempt_no: 2, drain_recovery_generation: 3 } },
    ];
    for (const command of variants) {
      const fake = fakeLifecycle();
      const controller = createConfigWorkerRuntimeController({
        pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle,
      });
      expectMessage(await controller.apply(startMessage()));

      // When
      const result = await controller.apply(command);

      // Then
      expect(result).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
      expect(fake.calls).toEqual(['start']);
    }
  });

  test('returns a typed drain error and does not emit drained when graceful drain fails', async () => {
    // Given
    const fake = fakeLifecycle();
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async drain(handle) {
        fake.calls.push(`drain:${handle.id}`);
        throw new Error('drain failed');
      },
      async forceStop() { fake.calls.push('force-stop'); },
    };
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle });
    expectMessage(await controller.apply(startMessage()));

    // When
    const command = { ...drainMessage(), policy: { ...DEFAULT_PUBLICATION_POLICY, drain_timeout_ms: 1_000 } };
    const result = await controller.apply(command);
    const duplicate = await controller.apply(command);

    // Then
    expect(result).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    expect(duplicate.ok).toBe(true);
    await Bun.sleep(1_050);
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-drain-failed', error_code: 'drain_failed' } });
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1', 'force-stop', 'stop:1']);
  });

  test('rejects a drain command delivered after C without starting D', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY,
      bootNonce: 'c0000000-0000-4000-8000-000000000001', lifecycle: fake.lifecycle });
    expectMessage(await controller.apply(startMessage()));
    const late = { ...drainMessage(), start_deadline_ns: '0' };
    const result = await controller.apply(late);
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(controller.drainStatus()).toBeNull();
    expect(fake.calls).toEqual(['start']);
  });

  test('uses one kernel E deadline across natural drain, descriptor persistence, and cleanup', async () => {
    const fake = fakeLifecycle();
    let monotonicNs = 0n;
    const persisted: Array<{ boot_id: string; exit_deadline_ns: string; cleanup_state: string; exit_remaining_ms: number }> = [];
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async stop(handle) {
        await fake.lifecycle.stop(handle);
        monotonicNs += 500_000_000n;
      },
    };
    const controller = createConfigWorkerRuntimeController({
      pid: 4321, identity: PROCESS_IDENTITY, bootNonce: 'c0000000-0000-4000-8000-000000000001',
      lifecycle, monotonicNow: () => monotonicNs,
      async persistTerminalEvidence(message) {
        persisted.push({ boot_id: message.boot_id, exit_deadline_ns: message.exit_deadline_ns,
          exit_remaining_ms: message.exit_remaining_ms, cleanup_state: message.cleanup_state });
        monotonicNs += 100_000_000n;
      },
    });
    expectMessage(await controller.apply(startMessage()));
    const command = { ...drainMessage(), policy: { ...DEFAULT_PUBLICATION_POLICY,
      drain_timeout_ms: 1_000, worker_exit_timeout_ms: 2_000 } };
    expectMessage(await controller.apply(command));
    let beforeCleanup = controller.drainStatus();
    for (let attempt = 0; attempt < 20
      && !(beforeCleanup?.ok === true && beforeCleanup.message.status === 'worker-drained'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      beforeCleanup = controller.drainStatus();
    }
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1', 'stop:1']);
    expect(persisted.length).toBe(1);
    expect(beforeCleanup).toMatchObject({ ok: true, message: { status: 'worker-drained', cleanup_state: 'pending' } });
    if (beforeCleanup?.ok !== true || beforeCleanup.message.status !== 'worker-drained') throw new Error('worker drain terminal evidence missing');
    await controller.failClosed();
    const afterCleanup = controller.drainStatus();
    expect(afterCleanup).toMatchObject({ ok: true, message: { status: 'worker-drained', cleanup_state: 'success' } });
    if (afterCleanup?.ok !== true || afterCleanup.message.status !== 'worker-drained') throw new Error('worker cleanup evidence missing');
    expect(afterCleanup.message.exit_deadline_ns).toBe(beforeCleanup.message.exit_deadline_ns);
    expect(afterCleanup.message.exit_remaining_ms).toBeLessThan(beforeCleanup.message.exit_remaining_ms);
    expect(persisted.map(({ cleanup_state }) => cleanup_state)).toEqual(['pending', 'success']);
    expect(persisted[0]?.exit_deadline_ns).toBe(persisted[1]?.exit_deadline_ns);
  });

  test('cleanup failure replaces natural terminal evidence with signed failure before exit', async () => {
    const fake = fakeLifecycle();
    const persisted: Array<{ status: string; cleanup_state: string; exit_deadline_ns: string }> = [];
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async stop(handle) { fake.calls.push(`stop:${handle.id}`); throw new Error('resource cleanup failed'); },
    };
    const controller = createConfigWorkerRuntimeController({
      pid: 4321, identity: PROCESS_IDENTITY, bootNonce: 'c0000000-0000-4000-8000-000000000001',
      lifecycle,
      async persistTerminalEvidence(message) { persisted.push({ status: message.status,
        cleanup_state: message.cleanup_state, exit_deadline_ns: message.exit_deadline_ns }); },
    });
    expectMessage(await controller.apply(startMessage()));
    expectMessage(await controller.apply(drainMessage()));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = controller.drainStatus();
      if (status?.ok === true && status.message.status === 'worker-drained') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(controller.failClosed()).rejects.toThrow('worker runtime shutdown failed');
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: {
      status: 'worker-drain-failed', error_code: 'drain_failed', cleanup_state: 'failed',
    } });
    expect(persisted.map(({ status, cleanup_state, exit_deadline_ns }) => [status, cleanup_state, exit_deadline_ns])).toEqual([
      ['worker-drained', 'pending', expect.any(String)], ['worker-drain-failed', 'failed', expect.any(String)],
    ]);
    expect(persisted[0]?.exit_deadline_ns).toBe(persisted[1]?.exit_deadline_ns);
  });

  test('a supervision-server stop failure cannot persist a green cleanup terminal', async () => {
    const fake = fakeLifecycle();
    const persisted: Array<{ status: string; cleanup_state: string }> = [];
    const controller = createConfigWorkerRuntimeController({
      pid: 4321, identity: PROCESS_IDENTITY, bootNonce: 'c0000000-0000-4000-8000-000000000001',
      bootId: 'linux:11111111-1111-4111-8111-111111111111', lifecycle: fake.lifecycle,
      async persistTerminalEvidence(message) { persisted.push({ status: message.status, cleanup_state: message.cleanup_state }); },
    });
    expectMessage(await controller.apply(startMessage()));
    expectMessage(await controller.apply(drainMessage()));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = controller.drainStatus();
      if (status?.ok === true && status.message.status === 'worker-drained') break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(controller.failClosed(async () => { throw new Error('supervision stop failed'); }))
      .rejects.toThrow('worker runtime shutdown failed');
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: {
      status: 'worker-drain-failed', error_code: 'drain_failed', cleanup_state: 'failed',
    } });
    expect(persisted).toEqual([
      { status: 'worker-drained', cleanup_state: 'pending' },
      { status: 'worker-drain-failed', cleanup_state: 'failed' },
    ]);
  });

  test('terminal descriptor write failure stays unknown and is never advertised as drained', async () => {
    const fake = fakeLifecycle();
    let writeAttempts = 0;
    const lifecycle: ConfigWorkerLifecycle<Handle> = {
      ...fake.lifecycle,
      async stop(handle) { fake.calls.push(`stop:${handle.id}`); },
    };
    const controller = createConfigWorkerRuntimeController({
      pid: 4321, identity: PROCESS_IDENTITY, bootNonce: 'c0000000-0000-4000-8000-000000000001',
      lifecycle,
      async persistTerminalEvidence() { writeAttempts += 1; throw new Error('descriptor fsync failed'); },
    });
    expectMessage(await controller.apply(startMessage()));
    expectMessage(await controller.apply(drainMessage()));
    for (let attempt = 0; attempt < 20 && writeAttempts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writeAttempts).toBe(1);
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-draining', remaining_ms: 0 } });
    for (let attempt = 0; attempt < 20 && !fake.calls.includes('stop:1'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fake.calls).toContain('stop:1');
  });

  test('rejects malformed values and accessors without invoking them', async () => {
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: fake.lifecycle });
    let getterCalls = 0;
    const accessor = { command: 'drain-worker', ...PROCESS_IDENTITY };
    Object.defineProperty(accessor, 'revision', {
      enumerable: true,
      get() { getterCalls += 1; return 7; },
    });

    const malformed = await controller.apply({ command: 'drain-worker' });
    const unsafe = await controller.apply(accessor);

    expect(malformed.ok).toBe(false);
    expect(unsafe.ok).toBe(false);
    expect(getterCalls).toBe(0);
    expect(fake.calls).toEqual([]);
  });
});
