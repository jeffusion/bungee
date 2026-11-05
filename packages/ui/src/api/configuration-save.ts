import type { LogicalConfiguration } from '@jeffusion/bungee-types';
import {
  commitLogicalConfiguration, duplicateConfigurationRoute, isDefinitiveConfigurationRejection,
  type ConfigurationSnapshot, type ConfigurationCommitOptions, type ConfigurationOperationState,
} from './config';
import { publicationRecovery } from '../stores/runtime';
import { configurationWrite } from '../stores/configuration-write';

/** Persistence ACK ends an entity save. Publication continues in the shared runtime view. */
export async function saveLogicalConfiguration(snapshot: ConfigurationSnapshot, logical: LogicalConfiguration): Promise<ConfigurationOperationState> {
  return saveConfigurationOperation(options => commitLogicalConfiguration(snapshot, logical, options));
}

export async function saveRouteCopy(path: string): Promise<ConfigurationOperationState> {
  return saveConfigurationOperation(options => duplicateConfigurationRoute(path, options));
}

async function saveConfigurationOperation(
  submit: (options: ConfigurationCommitOptions) => Promise<ConfigurationOperationState>,
): Promise<ConfigurationOperationState> {
  try {
    return await submit({
      completion: 'committed',
      onDispatch(mutationId) { configurationWrite.markDispatched(mutationId); },
      onOperation(state) { configurationWrite.markAccepted(state.operation.mutation_id); },
    });
  } catch (error) {
    // Only a rejection that proves nothing was committed may release the identity. Malformed
    // ACKs, transport failures, result_unknown and unproven lookups keep the original marker.
    if (isDefinitiveConfigurationRejection(error)) configurationWrite.clear();
    throw error;
  } finally {
    void publicationRecovery.refresh();
  }
}
