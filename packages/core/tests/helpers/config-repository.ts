import type { ConfigRepository } from '../../src/config-storage';

type FixtureMethod = 'getActivePublication' | 'getOperation' | 'getOperationState' | 'getCurrentOperationState' | 'getRecovery' | 'getCurrentRecovery' | 'getLatestRecovery' | 'commit' | 'beginPublication' | 'beginWorkerAttempt' | 'beginDrainingRecovery' | 'recordWorkerResult' | 'finalizePublication' | 'markDraining' | 'createManualRecovery' | 'claimRecoveryAttempt' | 'scheduleRecoveryRetry' | 'succeedRecovery' | 'stopRecovery' | 'requeueRecovery' | 'appendServingSnapshot' | 'getServingSnapshot' | 'close';
type ConfigurationRepositoryFixture = {
  [M in FixtureMethod]: (...args: Parameters<ConfigRepository[M]>) => Promise<ReturnType<ConfigRepository[M]>>;
} & Pick<ConfigRepository, 'getSnapshot'>;

/** An async fixture contract backed by an offline repository, with no production adapter. */
export function configurationRepositoryFixture(repository: ConfigRepository): ConfigurationRepositoryFixture {
  return {
    getSnapshot: () => repository.getSnapshot(),
    getActivePublication: async (...args: Parameters<ConfigRepository['getActivePublication']>) => repository.getActivePublication(...args),
    getOperation: async (...args: Parameters<ConfigRepository['getOperation']>) => repository.getOperation(...args),
    getOperationState: async (...args: Parameters<ConfigRepository['getOperationState']>) => repository.getOperationState(...args),
    getCurrentOperationState: async (...args: Parameters<ConfigRepository['getCurrentOperationState']>) => repository.getCurrentOperationState(...args),
    getRecovery: async (...args: Parameters<ConfigRepository['getRecovery']>) => repository.getRecovery(...args),
    getCurrentRecovery: async (...args: Parameters<ConfigRepository['getCurrentRecovery']>) => repository.getCurrentRecovery(...args),
    getLatestRecovery: async (...args: Parameters<ConfigRepository['getLatestRecovery']>) => repository.getLatestRecovery(...args),
    commit: async (...args: Parameters<ConfigRepository['commit']>) => repository.commit(...args),
    beginPublication: async (...args: Parameters<ConfigRepository['beginPublication']>) => repository.beginPublication(...args),
    beginWorkerAttempt: async (...args: Parameters<ConfigRepository['beginWorkerAttempt']>) => repository.beginWorkerAttempt(...args),
    beginDrainingRecovery: async (...args: Parameters<ConfigRepository['beginDrainingRecovery']>) => repository.beginDrainingRecovery(...args),
    recordWorkerResult: async (...args: Parameters<ConfigRepository['recordWorkerResult']>) => repository.recordWorkerResult(...args),
    finalizePublication: async (...args: Parameters<ConfigRepository['finalizePublication']>) => repository.finalizePublication(...args),
    markDraining: async (...args: Parameters<ConfigRepository['markDraining']>) => repository.markDraining(...args),
    createManualRecovery: async (...args: Parameters<ConfigRepository['createManualRecovery']>) => repository.createManualRecovery(...args),
    claimRecoveryAttempt: async (...args: Parameters<ConfigRepository['claimRecoveryAttempt']>) => repository.claimRecoveryAttempt(...args),
    scheduleRecoveryRetry: async (...args: Parameters<ConfigRepository['scheduleRecoveryRetry']>) => repository.scheduleRecoveryRetry(...args),
    succeedRecovery: async (...args: Parameters<ConfigRepository['succeedRecovery']>) => repository.succeedRecovery(...args),
    stopRecovery: async (...args: Parameters<ConfigRepository['stopRecovery']>) => repository.stopRecovery(...args),
    requeueRecovery: async (...args: Parameters<ConfigRepository['requeueRecovery']>) => repository.requeueRecovery(...args),
    appendServingSnapshot: async (...args: Parameters<ConfigRepository['appendServingSnapshot']>) => repository.appendServingSnapshot(...args),
    getServingSnapshot: async (...args: Parameters<ConfigRepository['getServingSnapshot']>) => repository.getServingSnapshot(...args),
    close: async (...args: Parameters<ConfigRepository['close']>) => repository.close(...args),
  };
}
