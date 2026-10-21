import { Database } from 'bun:sqlite';
import type { ControlHostContext, PluginInitContext, PluginScopeInfo, PluginStorage, TokenMeteringResult, TokenMeteringSubscription } from '@jeffusion/bungee-core/plugin';
import { migrateAccessDatabase } from '../../../../packages/core/src/migrations/migration-manager';
import { initializePluginStateDatabase } from '../../../../packages/core/src/plugin-state/schema';
import { SQLitePluginStorage } from '../../../../packages/core/src/plugin-storage';
import { createObservationAdapter, type TpsObservationClient } from '../../server/storage';

export function createStorage(access = new Database(':memory:'), state = new Database(':memory:')) {
  migrateAccessDatabase(access);
  initializePluginStateDatabase(state);
  const adapter = createObservationAdapter({ withDatabase: operation => operation(access) });
  const storage = Object.assign(new SQLitePluginStorage(state, 'llm-tps'), {
    invokeObservation: async <T>(operation: string, args: readonly unknown[]): Promise<T> => {
      if (operation === 'recordSample') return await adapter.recordSample(args[0] as Parameters<TpsObservationClient['recordSample']>[0]) as T;
      if (operation === 'queryStats') return await adapter.queryStats(args[0] as Parameters<TpsObservationClient['queryStats']>[0]) as T;
      throw new Error('unknown observation operation');
    },
  });
  return { access, state, adapter, storage, close() { access.close(); state.close(); } };
}

export function meteringContext(storage: PluginStorage, scope: PluginScopeInfo | undefined = { type: 'route', routeId: 'route-a' }) {
  const subscriptions = new Set<TokenMeteringSubscription>();
  const cleanups: Array<() => void> = [];
  const context = {
    config: {}, storage, scope, logger: { debug() {}, info() {}, warn() {}, error() {} },
    services: {
      consume(provider: string, id: string, version: number) {
        if (provider !== 'token-metering' || id !== 'token-metering.v1' || version !== 1) throw new Error('invalid service consumption');
        return { subscribe(subscription: TokenMeteringSubscription) { subscriptions.add(subscription); return () => { subscriptions.delete(subscription); }; } };
      },
      onDispose(cleanup: () => void) { cleanups.push(cleanup); }, publish() {},
    },
  } as unknown as PluginInitContext;
  return {
    context, subscriptions,
    emit(result: TokenMeteringResult) { for (const subscription of subscriptions) void subscription.onResult(result); },
    fail(result: TokenMeteringResult) { for (const subscription of subscriptions) void subscription.onFailure?.(new Error('observation failure'), result); },
    disposeServices() { for (const cleanup of cleanups) cleanup(); },
  };
}

export function result(patch: Partial<TokenMeteringResult> = {}): TokenMeteringResult {
  return {
    attemptId: 'attempt-a', requestId: 'request-a', routeId: 'route-a', upstreamId: 'endpoint-a',
    provider: 'openai', inputSource: 'none', outputSource: 'official', inputAuthority: 'none', outputAuthority: 'official',
    complete: false, observationIncomplete: false, outcome: 'completed', finishedAtMs: Date.now(),
    outputTokens: 100, generationDurationMs: 1000, generationOutput: { tokens: 100, source: 'official' }, settlementVersion: 1, ...patch,
  };
}

export function controlHost(storage: PluginStorage, signal = new AbortController().signal): ControlHostContext {
  return { storage, signal, secretStore: { namespace: 'llm-tps', async get() { return null; }, async compareAndSet() { return 1; }, async delete() {} } };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
