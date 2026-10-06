import { getScopedPluginRegistry } from '../scoped-plugin-registry';
import type { BoundControlClientProvider } from './runtime-dependencies';

/** Existing bound-client call shape, transported by the canonical peer Host RPC. */
export function createWorkerPluginControlPeerProvider(beforeCall?: (signal: AbortSignal) => Promise<void>): {provider: BoundControlClientProvider; dispose(): void} {
  let disposed = false;
  return {provider: (binding, attempt) => ({call: async <T>(method: string, payload: unknown, signal: AbortSignal): Promise<T> => {
    const registry = getScopedPluginRegistry();
    if (disposed || !attempt || !registry) throw new Error('bound control caller unavailable');
    // An adopted worker retains its registry while control gets a fresh peer
    // lifetime. Wait before dispatch, never replay an uncertain command.
    await beforeCall?.(signal);
    if (disposed || signal.aborted) throw new Error('bound control caller unavailable');
    return await registry.invokeBoundControl(binding, attempt, method, payload, signal) as T;
  }}), dispose() {disposed = true;}};
}
