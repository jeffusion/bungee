import { ConfigRepository } from '../../src/config-storage/config-repository';
import type { PreparedCommitCommand } from '../../src/config-storage/prepared-command';

const scope = globalThis as unknown as { onmessage(event: MessageEvent<any>): void; postMessage(value: unknown): void; close(): void };
let repository: ConfigRepository;
scope.onmessage = ({ data }) => {
  if (data.method === 'open') {
    repository = ConfigRepository.open(data.args[0]);
    scope.postMessage({ id: data.id, ok: true, result: {
      snapshot: repository.getSnapshot(), supervision: repository.getSupervisionState(),
    } });
  } else if (data.method === 'commitPrepared') {
    // Durable success followed by lost acknowledgement is deliberately ambiguous
    // to the client. A subsequent open/query must use the original mutation ID.
    repository.commitPrepared(data.args[0] as PreparedCommitCommand);
    repository.close();
    scope.close();
  }
};
