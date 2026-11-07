import type { ConfigRepository } from '../../src/config-storage';

type FixtureMethod = 'getActivePublication' | 'claimPublicationTarget' | 'requestPublicationCancellation' | 'enterPublicationPrepare' | 'recordPublicationCandidateExit' | 'confirmPublicationCandidateExited' | 'getOutstandingPublicationCandidates' | 'registerWorkerLaunch' | 'fenceWorkerLaunchNotStarted' | 'recordWorkerLaunchAdmitted' | 'recordWorkerLaunchCapacityReclaimed' | 'recordWorkerLaunchExit' | 'getWorkerLaunch' | 'getWorkerLaunchAllocationFacts' | 'getUnsettledWorkerLaunches' | 'getWorkerLaunchInventory' | 'getOperation' | 'getOperationState' | 'getCurrentOperationState' | 'getRecovery' | 'getCurrentRecovery' | 'getPublicationRecoveryBarrier' | 'getLatestRecovery' | 'commit' | 'beginPublication' | 'beginWorkerAttempt' | 'beginDrainingRecovery' | 'recordWorkerResult' | 'finalizePublication' | 'markDraining' | 'createManualRecovery' | 'claimRecoveryAttempt' | 'scheduleRecoveryRetry' | 'succeedRecovery' | 'stopRecovery' | 'requeueRecovery' | 'appendServingSnapshot' | 'getServingSnapshot' | 'getRetirementDescriptorCleanupState' | 'getRetiredWorkerInstanceIds' | 'getPublicationRetirement' | 'freezePublicationRetirement' | 'recordPublicationRetirementEvidence' | 'stopPublicationRetirement' | 'retryPublicationRetirement' | 'markPublicationRetirementReleased' | 'getRuntimeRecoveryBudget' | 'consumeRuntimeRecoveryRestartTicket' | 'getRuntimeRecoveryStartupGate' | 'observeRuntimeRecoveryHealth' | 'getPublicationServingSet' | 'freezePublicationServingSet' | 'confirmPublicationServingMemberExit' | 'close';
type ConfigurationRepositoryFixture = {
  [M in FixtureMethod]: (...args: Parameters<ConfigRepository[M]>) => Promise<ReturnType<ConfigRepository[M]>>;
} & Pick<ConfigRepository, 'getSnapshot'>;

/** An async fixture contract backed by an offline repository, with no production adapter. */
export function configurationRepositoryFixture(repository: ConfigRepository): ConfigurationRepositoryFixture {
  return {
    getSnapshot: () => repository.getSnapshot(),
    getPublicationServingSet: async (...args: Parameters<ConfigRepository['getPublicationServingSet']>) => repository.getPublicationServingSet(...args),
    freezePublicationServingSet: async (...args: Parameters<ConfigRepository['freezePublicationServingSet']>) => repository.freezePublicationServingSet(...args),
    confirmPublicationServingMemberExit: async (...args: Parameters<ConfigRepository['confirmPublicationServingMemberExit']>) => repository.confirmPublicationServingMemberExit(...args),

    getRetirementDescriptorCleanupState: async (instance: string) => repository.getRetirementDescriptorCleanupState(instance),
    getRetiredWorkerInstanceIds: async () => repository.getRetiredWorkerInstanceIds(),
    getPublicationRetirement: async (...args: Parameters<ConfigRepository['getPublicationRetirement']>) => repository.getPublicationRetirement(...args),
    freezePublicationRetirement: async (...args: Parameters<ConfigRepository['freezePublicationRetirement']>) => repository.freezePublicationRetirement(...args),
    recordPublicationRetirementEvidence: async (...args: Parameters<ConfigRepository['recordPublicationRetirementEvidence']>) => repository.recordPublicationRetirementEvidence(...args),
    stopPublicationRetirement: async (...args: Parameters<ConfigRepository['stopPublicationRetirement']>) => repository.stopPublicationRetirement(...args),
    retryPublicationRetirement: async (...args: Parameters<ConfigRepository['retryPublicationRetirement']>) => repository.retryPublicationRetirement(...args),
    markPublicationRetirementReleased: async (...args: Parameters<ConfigRepository['markPublicationRetirementReleased']>) => repository.markPublicationRetirementReleased(...args),
    getRuntimeRecoveryBudget: async (...args: Parameters<ConfigRepository['getRuntimeRecoveryBudget']>) => repository.getRuntimeRecoveryBudget(...args),
    consumeRuntimeRecoveryRestartTicket: async (...args: Parameters<ConfigRepository['consumeRuntimeRecoveryRestartTicket']>) => repository.consumeRuntimeRecoveryRestartTicket(...args),
    getRuntimeRecoveryStartupGate: async (...args: Parameters<ConfigRepository['getRuntimeRecoveryStartupGate']>) => repository.getRuntimeRecoveryStartupGate(...args),
    observeRuntimeRecoveryHealth: async (...args: Parameters<ConfigRepository['observeRuntimeRecoveryHealth']>) => repository.observeRuntimeRecoveryHealth(...args),

    getActivePublication: async (...args: Parameters<ConfigRepository['getActivePublication']>) => repository.getActivePublication(...args),
    claimPublicationTarget: async (...args: Parameters<ConfigRepository['claimPublicationTarget']>) => repository.claimPublicationTarget(...args),
    requestPublicationCancellation: async (...args: Parameters<ConfigRepository['requestPublicationCancellation']>) => repository.requestPublicationCancellation(...args),
    enterPublicationPrepare: async (...args: Parameters<ConfigRepository['enterPublicationPrepare']>) => repository.enterPublicationPrepare(...args),
    recordPublicationCandidateExit: async (...args: Parameters<ConfigRepository['recordPublicationCandidateExit']>) => repository.recordPublicationCandidateExit(...args),
    confirmPublicationCandidateExited: async (...args: Parameters<ConfigRepository['confirmPublicationCandidateExited']>) => repository.confirmPublicationCandidateExited(...args),
    getOutstandingPublicationCandidates: async (...args: Parameters<ConfigRepository['getOutstandingPublicationCandidates']>) => repository.getOutstandingPublicationCandidates(...args),
    registerWorkerLaunch: async (...args: Parameters<ConfigRepository['registerWorkerLaunch']>) => repository.registerWorkerLaunch(...args),
    fenceWorkerLaunchNotStarted: async (...args: Parameters<ConfigRepository['fenceWorkerLaunchNotStarted']>) => repository.fenceWorkerLaunchNotStarted(...args),
    recordWorkerLaunchAdmitted: async (...args: Parameters<ConfigRepository['recordWorkerLaunchAdmitted']>) => repository.recordWorkerLaunchAdmitted(...args),
    recordWorkerLaunchExit: async (...args: Parameters<ConfigRepository['recordWorkerLaunchExit']>) => repository.recordWorkerLaunchExit(...args),
    recordWorkerLaunchCapacityReclaimed: async (...args: Parameters<ConfigRepository['recordWorkerLaunchCapacityReclaimed']>) => repository.recordWorkerLaunchCapacityReclaimed(...args),
    getWorkerLaunch: async (...args: Parameters<ConfigRepository['getWorkerLaunch']>) => repository.getWorkerLaunch(...args),
    getWorkerLaunchAllocationFacts: async (...args: Parameters<ConfigRepository['getWorkerLaunchAllocationFacts']>) => repository.getWorkerLaunchAllocationFacts(...args),
    getUnsettledWorkerLaunches: async (...args: Parameters<ConfigRepository['getUnsettledWorkerLaunches']>) => repository.getUnsettledWorkerLaunches(...args),
    getWorkerLaunchInventory: async (...args: Parameters<ConfigRepository['getWorkerLaunchInventory']>) => repository.getWorkerLaunchInventory(...args),
    getOperation: async (...args: Parameters<ConfigRepository['getOperation']>) => repository.getOperation(...args),
    getOperationState: async (...args: Parameters<ConfigRepository['getOperationState']>) => repository.getOperationState(...args),
    getCurrentOperationState: async (...args: Parameters<ConfigRepository['getCurrentOperationState']>) => repository.getCurrentOperationState(...args),
    getRecovery: async (...args: Parameters<ConfigRepository['getRecovery']>) => repository.getRecovery(...args),
    getCurrentRecovery: async (...args: Parameters<ConfigRepository['getCurrentRecovery']>) => repository.getCurrentRecovery(...args),
    getPublicationRecoveryBarrier: async (...args: Parameters<ConfigRepository['getPublicationRecoveryBarrier']>) => repository.getPublicationRecoveryBarrier(...args),
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
