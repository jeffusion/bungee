import { createConfigWorkerRuntimeController } from '../../src/config-publication/worker-runtime';
import type { ConfigProcessIdentity } from '../../src/config-publication/types';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed } from '../../src/supervision/protocol';
import { WorkerSupervisionHttpServer } from '../../src/supervision/worker-http';
import { readKernelBootId } from '../../src/master-runtime/process-identity';

const identity = JSON.parse(process.env.BUNGEE_TEST_WORKER_IDENTITY ?? '') as ConfigProcessIdentity;
const bootNonce = process.env.BUNGEE_TEST_WORKER_BOOT ?? '';
const seedText = process.env.BUNGEE_TEST_WORKER_SEED ?? '';
const authority = {
  controller_epoch: 1,
  controller_id: '83000000-0000-4000-8000-000000000001',
} as const;
const rootKey = Uint8Array.from(Buffer.from(seedText, 'base64'));
const seed = deriveWorkerSupervisionSeed(rootKey, identity.master_generation, identity.worker_instance_id, identity.worker_slot);
const credential = deriveWorkerSupervisionCredential(seed, bootNonce);
const kernelBootId = await readKernelBootId();

function event(name: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ event: name, ...extra })}\n`);
}

let releaseDrain!: () => void;
const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
let privateServer: ReturnType<typeof Bun.serve> | null = null;
let cleanupCount = 0;
let supervision: WorkerSupervisionHttpServer;
const holdDrain = process.argv.includes('--bungee-test-hold-drain') || process.env.BUNGEE_TEST_HOLD_DRAIN === '1';

const runtime = createConfigWorkerRuntimeController({
  pid: process.pid,
  identity,
  bootNonce,
  bootId: kernelBootId,
  requestShutdown: () => { void shutdown(); },
  persistTerminalEvidence: async (message) => { await supervision.persistTerminalEvidence(message); },
  lifecycle: {
    async start() {
      privateServer = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: (request) => {
        if (new URL(request.url).pathname !== '/hold') return new Response('ready');
        request.signal.addEventListener('abort', () => event('upstream_cancelled'), { once: true });
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: stream-open\n\n'));
          event('stream_started');
        }, cancel() { event('stream_cancelled'); } }), { headers: { 'content-type': 'text/event-stream' } });
      } });
      if (privateServer.port === undefined) throw new Error('private listener did not bind');
      return {
        handle: privateServer,
        private_port: privateServer.port,
        plugin_runtime_generation: 1,
        plugin_status: { generation: 1, appliedAt: new Date().toISOString(), plugins: [], summary: { total: 0, serving: 0, disabled: 0, degraded: 0, quarantined: 0 } },
      } as any;
    },
    async stopAccepting() {},
    async drain() {
      event('drain_enter');
      if (!holdDrain) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseDrain();
        event('drain_complete');
      } else await drainGate;
    },
    async forceStop() {
      event('force_stop_enter');
      await privateServer?.stop(true);
      privateServer = null;
      releaseDrain();
      event('force_stop_complete');
    },
    async stop() {
      event('stop_enter');
      releaseDrain();
      await privateServer?.stop(true);
      privateServer = null;
      cleanupCount += 1;
      event('cleanup', { count: cleanupCount });
    },
  },
  compileSnapshot: (command) => ({
    revision: command.revision,
    content_hash: command.content_hash,
    config: { config_version: 4, routes: [] },
  } as any),
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let exitCode = 0;
  event('shutdown_enter');
  try {
    await runtime.failClosed(async () => {
      event('control_stop_enter');
      await supervision.stop();
      event('control_stopped');
    });
  } catch (error) {
    exitCode = 1;
    event('shutdown_failed', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    process.exit(exitCode);
  }
}

supervision = new WorkerSupervisionHttpServer({
  credential,
  identity,
  runtime,
  masterControlPort: 3011,
  controlPort: 0,
  descriptorPath: process.env.BUNGEE_WORKER_DESCRIPTOR_PATH,
  onShutdown: shutdown,
});

try {
  const port = await supervision.listen();
  event('ready', { port, pid: process.pid, boot_nonce: bootNonce, worker_instance_id: identity.worker_instance_id });
} catch (error) {
  event('error', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

await new Promise<void>(() => undefined);
