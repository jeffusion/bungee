import type { LogicalConfiguration } from '@jeffusion/bungee-types';
import {
  commitLogicalConfiguration, ConfigurationOperationConflictError, ConfigurationOperationDegradedError,
  ConfigurationSubmissionUnknownError, duplicateConfigurationRoute, waitForConfigurationOperation, type ConfigurationSnapshot,
  type ConfigurationCommitOptions, type ConfigurationOperationState,
} from './config';
import { publicationRecovery } from '../stores/runtime';
import { retainAccepted } from '../components/domain/config/publication-state';
import { pendingPublicationKey } from '../components/domain/config/workspace';

/** Storage ACK ends an entity save. Publication remains visible across navigation. */
export async function saveLogicalConfiguration(snapshot: ConfigurationSnapshot, logical: LogicalConfiguration): Promise<void> {
  await saveConfigurationOperation(options => commitLogicalConfiguration(snapshot, logical, options), snapshot.revision);
}

export async function saveRouteCopy(path: string): Promise<void> {
  await saveConfigurationOperation(options => duplicateConfigurationRoute(path, options));
}

async function saveConfigurationOperation(
  submit: (options: ConfigurationCommitOptions) => Promise<ConfigurationOperationState>, expectedRevision?: number,
): Promise<void> {
  const commit = () => submit({
    completion: 'committed',
    onOperation(state) { retainAccepted(state.operation.mutation_id); },
  });
  try {
    try { await commit(); }
    catch (error) {
      if (!(error instanceof ConfigurationOperationConflictError)
        || (expectedRevision !== undefined && error.revision !== expectedRevision)) throw error;
      // The rejected write changed nothing; wait for the preceding publication.
      try { await waitForConfigurationOperation(error.operationId, { timeoutMs: 120_000 }); }
      catch (publicationError) {
        if (!(publicationError instanceof ConfigurationOperationDegradedError)) throw publicationError;
      }
      await commit();
    }
  } catch (error) {
    if (error instanceof ConfigurationSubmissionUnknownError) {
      // The settings workspace can reconcile this UUID after navigation/reload.
      // A plain UUID records an unknown result, rather than a storage ACK.
      try { sessionStorage.setItem(pendingPublicationKey, error.mutationId); } catch { /* Memory/error still carries the UUID. */ }
    }
    throw error;
  } finally {
    void publicationRecovery.refresh();
  }
}
