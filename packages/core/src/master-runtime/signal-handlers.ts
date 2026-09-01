export type MasterSignal = 'SIGINT' | 'SIGTERM';

export interface MasterSignalRuntime {
  shutdown(): Promise<void>;
}

export interface MasterSignalSource {
  on(signal: MasterSignal, listener: () => void): unknown;
  off(signal: MasterSignal, listener: () => void): unknown;
}

export type MasterSignalHandlerOptions = {
  readonly runtime: MasterSignalRuntime;
  readonly source?: MasterSignalSource;
  readonly onError: (error: unknown) => void;
};

export interface MasterSignalController {
  shutdown(): Promise<void>;
  remove(): void;
}

export function installMasterSignalHandlers(
  options: MasterSignalHandlerOptions,
): MasterSignalController {
  const source = options.source ?? process;
  let shutdownPromise: Promise<void> | null = null;
  let installed = true;

  const remove = (): void => {
    if (!installed) return;
    installed = false;
    source.off('SIGINT', handleSignal);
    source.off('SIGTERM', handleSignal);
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) return shutdownPromise;
    shutdownPromise = options.runtime.shutdown();
    void shutdownPromise.then(remove, (error) => {
      remove();
      options.onError(error);
    });
    return shutdownPromise;
  };
  const handleSignal = (): void => { void shutdown(); };

  source.on('SIGINT', handleSignal);
  source.on('SIGTERM', handleSignal);
  return { shutdown, remove };
}
