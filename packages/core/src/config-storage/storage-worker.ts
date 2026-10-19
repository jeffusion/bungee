import { ConfigRepository } from './config-repository';
import { ConfigRepositoryError } from './repository-types';
import { STORAGE_METHODS, safeStorageError, type StorageRequest, type StorageResponse } from './storage-protocol';

// This is a separate Bun Worker entry. All SQLite calls, including startup audits,
// run here, never in the master event loop.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: StorageResponse): void;
  close(): void;
};
let repository: ConfigRepository | null = null;
let closed = false;
const methods = new Set<string>(STORAGE_METHODS);

scope.onmessage = (event) => {
  const request = event.data as Partial<StorageRequest> | null;
  if (request === null || typeof request !== 'object' || !Number.isSafeInteger(request.id) || request.id! <= 0) return;
  const id = request.id!;
  try {
    if (closed || !Array.isArray(request.args)) throw new ConfigRepositoryError('invalid_command', 'storage request is invalid');
    if (request.method === 'open') {
      if (repository !== null || request.args.length !== 2 || typeof request.args[0] !== 'string' ||
          typeof request.args[1] !== 'object' || request.args[1] === null || typeof request.args[1].offline !== 'boolean' ||
          !Array.isArray(request.args[1].managementProviders) || request.args[1].managementProviders.some((name: unknown) => typeof name !== 'string') ||
          (request.args[1].availablePlugins !== undefined && (!Array.isArray(request.args[1].availablePlugins) ||
            request.args[1].availablePlugins.some((name: unknown) => typeof name !== 'string')))) {
        throw new ConfigRepositoryError('invalid_command', 'storage open request is invalid');
      }
      repository = ConfigRepository.open(request.args[0], { offline: request.args[1].offline,
        compileOptions: { pluginSchemas: new Map(), managementProviders: new Set(request.args[1].managementProviders),
          availablePlugins: request.args[1].availablePlugins === undefined ? undefined : new Set(request.args[1].availablePlugins) } });
      scope.postMessage({ id, ok: true, result: {
        ...repository.getControlProjection(), supervision: repository.getSupervisionState(),
      } });
      return;
    }
    if (repository === null) throw new ConfigRepositoryError('repository_failure', 'storage is not open');
    if (request.method === 'close') {
      if (request.args.length !== 0) throw new ConfigRepositoryError('invalid_command', 'storage close request is invalid');
      repository.close();
      repository = null;
      closed = true;
      scope.postMessage({ id, ok: true, result: null });
      scope.close();
      return;
    }
    if (typeof request.method !== 'string' || !methods.has(request.method)) {
      throw new ConfigRepositoryError('invalid_command', 'storage method is not permitted');
    }
    const method = request.method as typeof STORAGE_METHODS[number];
    const execute = repository[method] as (...args: unknown[]) => unknown;
    const result = execute.apply(repository, request.args);
    scope.postMessage({ id, ok: true, result });
  } catch (error) {
    scope.postMessage({ id, ok: false, error: safeStorageError(error) });
  }
};
