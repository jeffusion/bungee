import type { LogicalConfigurationV2 } from '@jeffusion/bungee-types';
import {
  commitLogicalConfiguration, ConfigurationOperationConflictError, ConfigurationOperationDegradedError,
  ConfigurationSubmissionUnknownError, waitForConfigurationOperation, type ConfigurationSnapshot,
} from './config';
import { publicationRecovery } from '../stores/runtime';
import { retainAccepted } from '../components/domain/config/publication-state';
import { pendingPublicationKey } from '../components/domain/config/workspace';

/** Storage ACK ends an entity save. Publication remains visible across navigation. */
export async function saveLogicalConfiguration(snapshot: ConfigurationSnapshot, logical: LogicalConfigurationV2): Promise<void> {
  const commit = () => commitLogicalConfiguration(snapshot, logical, {
    completion: 'committed',
    onOperation(state) { retainAccepted(state.operation.mutation_id); },
  });
  try {
    try { await commit(); }
    catch (error) {
      if (!(error instanceof ConfigurationOperationConflictError) || error.revision !== snapshot.revision) throw error;
      // A previous save is still publishing. The rejected PUT wrote nothing;
      // wait for that operation, then submit with the original CAS revision.
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
