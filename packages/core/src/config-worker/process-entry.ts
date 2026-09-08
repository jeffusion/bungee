import { basename, resolve } from 'node:path';
import { createConfigWorkerProcessRuntime } from '../config-publication/worker-process-runtime';
import { createConfigWorkerRuntimeController } from '../config-publication/worker-runtime';
import { PluginPathResolver } from '../plugin-path-resolver';
import { PluginManifestCatalog } from '../plugin-manifest-catalog';
import { createConfigWorkerLifecycle } from './lifecycle';
import { parseConfigWorkerEnvironment } from './process-environment';
import { ProcessConfigWorkerChannel } from './process-channel';
import { createCatalogSnapshotCompiler } from './snapshot-compiler';
import { timeoutScheduler } from './timeout-scheduler';
import type { ConfigWorkerProcessChannel } from '../config-publication/worker-process-runtime';
import type { ControlIpcMessage, ControlIpcTransport } from '../plugin-control/ipc';
import {
  createBoundControlClientProvider,
  setBoundControlClientProvider,
} from './runtime-dependencies';

export type ConfigWorkerProcessDependencies = {
  readonly env?: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  readonly channel?: ConfigWorkerProcessChannel;
  readonly loadCatalog?: () => Promise<PluginManifestCatalog>;
};

export function resolveConfigWorkerCoreBaseDir(moduleDirectory: string): string {
  return basename(moduleDirectory) === 'config-worker'
    ? resolve(moduleDirectory, '..')
    : moduleDirectory;
}

export async function runConfigWorkerProcess(
  dependencies: ConfigWorkerProcessDependencies = {},
): Promise<void> {
  const channel = dependencies.channel ?? new ProcessConfigWorkerChannel();
  const controlListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const transport: ControlIpcTransport & {
    receive(message: unknown): void;
    disconnected(): void;
    dispose(): void;
  } = {
    send: (message: ControlIpcMessage) => channel.sendControl?.(message)
      ?? channel.send(message as never),
    subscribe(listener) {
      controlListeners.add(listener);
      return () => { controlListeners.delete(listener); };
    },
    subscribeDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => { disconnectListeners.delete(listener); };
    },
    receive(message) {
      for (const listener of [...controlListeners]) listener(message);
    },
    disconnected() {
      for (const listener of [...disconnectListeners]) listener();
    },
    dispose() {
      controlListeners.clear();
      disconnectListeners.clear();
    },
  };
  let providerInstalled = false;
  try {
    const environment = parseConfigWorkerEnvironment(dependencies.env ?? process.env);
    setBoundControlClientProvider(createBoundControlClientProvider({
      transport,
      identity: environment.identity,
      methods: [],
    }));
    providerInstalled = true;
    const pathResolver = new PluginPathResolver(resolveConfigWorkerCoreBaseDir(import.meta.dir), process.cwd());
    const loadCatalog = dependencies.loadCatalog
      ?? (() => PluginManifestCatalog.build({ pathResolver }));
    const controller = createConfigWorkerRuntimeController({
      pid: channel.pid,
      identity: environment.identity,
      lifecycle: createConfigWorkerLifecycle({
        transportSecret: environment.transportSecret,
      }),
      compileSnapshot: createCatalogSnapshotCompiler(loadCatalog),
    });
    const runtime = createConfigWorkerProcessRuntime({
      ...environment,
      channel,
      scheduler: timeoutScheduler,
      controller,
      onControlMessage: (message) => transport.receive(message),
      onDisconnect: () => transport.disconnected(),
      onShutdown: () => {
        setBoundControlClientProvider(null);
        transport.dispose();
      },
    });
    await runtime.start();
  } catch {
    if (providerInstalled) setBoundControlClientProvider(null);
    transport.dispose();
    channel.exit(1);
  }
}
