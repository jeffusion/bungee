import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { TEST_WORKER_TRANSPORT_SECRET } from './config-worker-private-transport';

const workerEntry = process.env.TEST_WORKER_ENTRY;
const aggregateJson = process.env.TEST_WORKER_AGGREGATE;
const catalogHash = process.env.TEST_WORKER_CATALOG_HASH;
const contentHash = process.env.TEST_WORKER_CONTENT_HASH;
if (!workerEntry || !aggregateJson || !catalogHash || !contentHash || !process.send) {
  throw new Error('config worker parent fixture environment is incomplete');
}

const identity = {
  master_generation: '70000000-0000-4000-8000-000000000001',
  worker_instance_id: '80000000-0000-4000-8000-000000000001',
  worker_slot: 0,
};
const worker = spawn(process.execPath, [workerEntry], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    BUNGEE_ROLE: 'worker',
    BUNGEE_MASTER_GENERATION: identity.master_generation,
    BUNGEE_WORKER_INSTANCE_ID: identity.worker_instance_id,
    BUNGEE_WORKER_SLOT: '0',
    BUNGEE_MASTER_PID: String(process.pid),
    BUNGEE_HEARTBEAT_TIMEOUT_MS: '500',
    BUNGEE_SHUTDOWN_TIMEOUT_MS: '500',
    BUNGEE_INTERNAL_TRANSPORT_SECRET: TEST_WORKER_TRANSPORT_SECRET,
    BUNGEE_ACCESS_DB_PATH: join(process.cwd(), 'logs', 'access.db'),
  },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});

let sequence = 0;
setInterval(() => {
  sequence += 1;
  worker.send({ command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence });
}, 100);

worker.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('status' in message)) return;
  if (message.status === 'config-ready' && 'private_port' in message && typeof message.private_port === 'number') {
    process.send?.({ workerPid: worker.pid, port: message.private_port });
  }
});

worker.send({
  command: 'master-heartbeat', ...identity, master_pid: process.pid, sequence: ++sequence,
});
worker.send({
  command: 'start-current-config-worker', ...identity, revision: 1,
  content_hash: contentHash, plugin_catalog_hash: catalogHash,
  aggregate: JSON.parse(aggregateJson),
  activated_plugin_names: Object.freeze(JSON.parse(aggregateJson).plugin_activations.map(
    ({ plugin_name }: { plugin_name: string }) => plugin_name,
  )),
  publication: null,
});
