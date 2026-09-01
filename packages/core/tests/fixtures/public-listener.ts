import type { Sha256Digest } from '@jeffusion/bungee-types';
import type {
  ConfigMasterMessage,
  ConfigProcessIdentity,
  ConfigPublicationWorkerProcess,
  ServingConfigWorker,
} from '../../src/config-publication';

const MASTER_GENERATION = '90000000-0000-4000-8000-000000000001';
const CONTENT_HASH: Sha256Digest = `sha256:${'a'.repeat(64)}`;
const CATALOG_HASH: Sha256Digest = `sha256:${'b'.repeat(64)}`;

class ListenerTestProcess implements ConfigPublicationWorkerProcess {
  readonly identity: ConfigProcessIdentity;

  constructor(readonly slot: number, readonly pid: number) {
    this.identity = {
      master_generation: MASTER_GENERATION,
      worker_instance_id: `91000000-0000-4000-8000-${String(slot + 1).padStart(12, '0')}`,
      worker_slot: slot,
    };
  }

  async send(_message: ConfigMasterMessage): Promise<void> {}
  subscribeMessage(_listener: (message: unknown) => void): () => void { return () => undefined; }
  subscribeExit(_listener: (evidence: { readonly exited: true; readonly pid: number }) => void): () => void {
    return () => undefined;
  }
  async terminate(_mode: 'graceful' | 'force'): Promise<void> {}
}

export function servingWorker(slot: number, privatePort: number): ServingConfigWorker {
  return {
    process: new ListenerTestProcess(slot, 50_000 + slot),
    revision: 1,
    content_hash: CONTENT_HASH,
    plugin_catalog_hash: CATALOG_HASH,
    private_port: privatePort,
    publication: null,
  };
}
