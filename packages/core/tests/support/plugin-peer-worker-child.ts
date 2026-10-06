/**
 * Real worker-process body for the P4 control ↔ worker chain integration test.
 *
 * It is the production construction path in miniature: the real supervision
 * credential is derived from the real worker seed, the canonical worker service
 * host is created with the real peer broker, and a real `ScopedPluginRegistry`
 * initializes a plugin whose `createHandler` consumes a control-provided RPC
 * service inside the host bootstrap frame.
 *
 * All inputs come from the environment exactly like the supervised worker
 * environment; nothing is mocked and no transport is replaced.
 */

import { PluginServiceHost, defineRpcService, type AsyncRpcClient } from '../../src/plugin-services';
import { WorkerPeerBroker, pluginPeerLifecycleIdentity } from '../../src/plugin-services/peer-broker';
import { ScopedPluginRegistry, type PluginClass } from '../../src/scoped-plugin-registry';
import { PluginDependencyGraph } from '../../src/plugin-dependencies';
import { deriveWorkerSupervisionCredential, importWorkerSupervisionSeed } from '../../src/supervision';

const SERVICE_ID = 'control.quota.v1';

const CONTRACT = defineRpcService({
  id: SERVICE_ID,
  version: 1,
  methods: {
    read: { kind: 'query', input: { type: 'string' }, output: { type: 'string' }, purposes: ['bootstrap', 'background'] },
  },
});

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<number> {
  const masterGeneration = required('PEER_MASTER_GENERATION');
  const workerInstanceId = required('PEER_WORKER_INSTANCE');
  const bootNonce = required('PEER_BOOT_NONCE');
  const workerSlot = Number(required('PEER_WORKER_SLOT'));
  const controllerEpoch = Number(required('PEER_CONTROLLER_EPOCH'));
  const controllerId = required('PEER_CONTROLLER_ID');
  const masterControlPort = Number(required('PEER_MASTER_CONTROL_PORT'));
  const catalog = required('PEER_CATALOG');
  const authority = Object.freeze({ controller_epoch: controllerEpoch, controller_id: controllerId });
  const credential = deriveWorkerSupervisionCredential(
    importWorkerSupervisionSeed(required('BUNGEE_WORKER_SUPERVISION_SEED')),
    bootNonce,
  );

  const graph = new PluginDependencyGraph([
    {
      name: 'provider', version: '1.0.0', runtimeScope: 'global',
      capabilities: ['api', 'dynamicRuntimeLoad', 'controlPlane'],
      services: { provides: [{ id: SERVICE_ID, version: 1, process: 'control', kind: 'rpc' }] },
    },
    {
      name: 'consumer', version: '1.0.0', dependencies: { provider: '^1.0.0' },
      services: { consumes: [{ plugin: 'provider', id: SERVICE_ID, version: 1, process: 'worker', kind: 'rpc' }] },
    },
  ]);

  let services!: PluginServiceHost;
  let broker!: WorkerPeerBroker;
  services = new PluginServiceHost('worker', {
    identity: (plugin, scope) => pluginPeerLifecycleIdentity({
      process: 'worker', instance: workerInstanceId, generation: Math.max(1, controllerEpoch), catalog,
    }, plugin, scope),
    resolvePlacement: request => broker.placementResolver(request),
    resolveJournal: () => null,
    resolveCallee: (): unknown => services.currentInvocation()?.callee ?? null,
    ensureRemoteRoute: input => { broker.ensureRemoteRoute(input); },
  });
  broker = new WorkerPeerBroker({
    services,
    credential,
    masterGeneration,
    workerInstanceId,
    bootNonce,
    workerSlot,
    masterControlPort: () => masterControlPort,
    catalog: () => catalog,
    authority: () => authority,
  });
  broker.start();

  const captured: { client: AsyncRpcClient<typeof CONTRACT.methods> | null } = { client: null };
  let bootstrapValue: string | undefined;
  const registry = new ScopedPluginRegistry(process.cwd(), services);
  registry.ensurePluginClassLoaded = async config => {
    const name = typeof config === 'string' ? config : config.name;
    const pluginClass: PluginClass = {
      name, version: '1.0.0',
      createHandler: async (_options, context) => {
        const consumer = context.services!.rpc!.consume('provider', CONTRACT);
        bootstrapValue = await consumer.read('child-bootstrap');
        captured.client = consumer;
        return { pluginName: name, config: {}, register() {}, async destroy() { /* nothing */ } };
      },
    };
    return pluginClass;
  };
  // Real startup gate, exactly like the production entry: control's published
  // directory must be loaded over the authenticated transport before any plugin
  // initializes (registry-level gate plus the explicit await).
  registry.setBeforeBootstrapHook(signal => broker.waitUntilDirectoryLoaded({ signal, timeoutMs: 5_000 }));
  await broker.waitUntilDirectoryLoaded({ timeoutMs: 5_000 });
  const result = await registry.initializeFromConfig({ plugins: ['consumer'] }, graph);
  const consumer = captured.client;
  const background = result.success === 1 && consumer !== null ? await consumer.read('child-background') : null;
  process.stdout.write(`${JSON.stringify({
    ok: result.success === 1 && result.failed === 0,
    bootstrap: bootstrapValue ?? null,
    background,
    attached: broker.status.attached,
  })}\n`);
  await registry.destroy();
  broker.dispose();
  return result.success === 1 ? 0 : 1;
}

main().then(code => process.exit(code), error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message.slice(0, 512) : 'unknown' })}\n`);
  process.exit(1);
});
