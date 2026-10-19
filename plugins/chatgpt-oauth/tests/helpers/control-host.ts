import type { ControlHostContext, SecretStore } from '@jeffusion/bungee-core/plugin';

// OAuth control state belongs in SecretStore. Any ordinary KV access is a test failure.
export function controlHost(secretStore: SecretStore, signal = new AbortController().signal): ControlHostContext {
  const unexpectedStorage = async (): Promise<never> => { throw new Error('unexpected OAuth KV access'); };
  return { signal, secretStore, storage: {
    get: unexpectedStorage, set: unexpectedStorage, delete: unexpectedStorage,
    keys: unexpectedStorage, clear: unexpectedStorage,
    increment: unexpectedStorage, compareAndSet: unexpectedStorage,
  } };
}
