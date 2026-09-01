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
  try {
    const environment = parseConfigWorkerEnvironment(dependencies.env ?? process.env);
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
    });
    await runtime.start();
  } catch {
    channel.exit(1);
  }
}
