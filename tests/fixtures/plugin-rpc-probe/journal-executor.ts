import { Database } from 'bun:sqlite';
import { CommandJournal } from '../../../packages/core/src/plugin-services/command-journal';
import type { RpcCommandExecution } from '../../../packages/core/src/plugin-services/rpc-runtime';

// This process owns both the durable pending row and the genuinely in-flight business task.
const source = JSON.parse(process.env.RPC_EXECUTOR_SOURCE!);
const db = new Database(process.env.RPC_EXECUTOR_DB!);
const journal = new CommandJournal({ db, namespace: 'rpc.proof', privateStateNamespace: 'test', setup: true,
  resolveExternal: () => ({ reconcile: () => ({ status: 'unknown' }) }) });
const execution = {
  contract: { id: 'test', version: 1, methods: {} }, method: 'run', operationId: 'proof-op', input: {},
  definition: { kind: 'command', input: { type: 'json' }, output: { type: 'json' }, purposes: ['management'],
    command: { deduplication: 'external-contract', resultRetentionMs: null, quotaBytes: 8192, maxResultBytes: 1024 } },
  context: { endpoint: { ...source, endpoint: 'proof', scope: 'global', subject: 'provider', service: 'test', version: 1 },
    caller: { subject: 'caller' }, method: 'run', kind: 'command', purpose: 'management', operationId: 'proof-op',
    signal: new AbortController().signal, callee: null },
  executeBusiness: async () => {
    process.stdout.write(`${JSON.stringify({ event: 'entered', source, pid: process.pid })}\n`);
    await new Promise(() => {});
    throw new Error('unreachable');
  },
} as unknown as RpcCommandExecution;
void journal.execute(execution).catch(error => { process.stderr.write(String(error)); process.exit(1); });
setInterval(() => {}, 1000);
