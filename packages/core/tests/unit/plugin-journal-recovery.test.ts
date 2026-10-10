import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PluginJournalRecovery } from '../../src/master-runtime/plugin-journal-recovery';
import { PluginCommunicationStore } from '../../src/plugin-services/persistence';
import { CommandJournal, type CommandRecoveryRequest } from '../../src/plugin-services/command-journal';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePluginExecutorProof } from '../../src/plugin-services/peer-executor-proof';

test('physical source proof authorizes recovery only after exact exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-journal-executor-'));
  const marker = crypto.randomUUID();
  const source = { process: 'control', instance: marker, catalog: 'test-catalog', generation: 3 };
  const path = join(root, 'journal.db');
  const child = Bun.spawn([process.execPath, new URL('../../../../tests/support/plugin-rpc-probe/journal-executor.ts', import.meta.url).pathname,
    `--bungee-process-identity=${marker}`], { env: { ...process.env, RPC_EXECUTOR_DB: path, RPC_EXECUTOR_SOURCE: JSON.stringify(source) }, stdout: 'pipe', stderr: 'pipe' });
  let db: Database | undefined;
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read(); reader.releaseLock();
    expect(JSON.parse(new TextDecoder().decode(value))).toEqual({ event: 'entered', source, pid: child.pid });
    db = new Database(path);
    const store = new PluginCommunicationStore(db);
    const asyncStore = Object.fromEntries(Object.entries(store.forNamespace('host:rpc:executors')).map(([name,value])=>[name,typeof value==='function' ? async (...args:any[])=>value(...args) : value])) as any;
    const client = {channelStore:()=>asyncStore,
      executorProofPage:async(after:string,limit:number)=>db!.query<{key:string},[string,number]>("SELECT key FROM plugin_communication_records WHERE namespace='host:rpc:executors' AND key>? ORDER BY key LIMIT ?").all(after,limit),
      executorHasPending:async(source:any)=>db!.query<{key:string},[string,string,string,number]>("SELECT key FROM plugin_communication_records WHERE namespace LIKE 'rpc.%' AND key LIKE 'j.%' AND json_valid(CAST(payload AS TEXT)) AND json_extract(CAST(payload AS TEXT),'$.state')='pending' AND json_extract(CAST(payload AS TEXT),'$.source.process')=? AND json_extract(CAST(payload AS TEXT),'$.source.instance')=? AND json_extract(CAST(payload AS TEXT),'$.source.catalog')=? AND json_extract(CAST(payload AS TEXT),'$.source.generation')=? LIMIT 1").get(source.process,source.instance,source.catalog,source.generation)!==null};
    const original = new PluginJournalRecovery(client);
    await original.register(source, child.pid, marker);
    const recovered = new PluginJournalRecovery(client);
    const journal = new CommandJournal({ db, namespace: 'rpc.proof', privateStateNamespace: 'test', setup: true, authorizeRecovery: recovered.authorize, resolveExternal: () => ({ reconcile: () => ({ status: 'unknown' }) }) });
    expect(journal.inspect('proof-op', { subject: 'caller' }).status).toBe('pending');
    await recovered.maintain();
    expect(journal.recoverPending()).toBe(0);
    expect(journal.inspect('proof-op', { subject: 'caller' }).status).toBe('pending');
    const uncertain = new PluginJournalRecovery(client, async () => 'unknown');
    await uncertain.maintain();
    expect(uncertain.authorize({ source } as CommandRecoveryRequest)).toBeNull();
    child.kill('SIGKILL');
    await child.exited;
    await recovered.maintain();
    expect(journal.recoverPending()).toBe(1);
    expect(journal.inspect('proof-op', { subject: 'caller' }).status).toBe('unknown');
    await recovered.maintain();
    expect(store.forNamespace('host:rpc:executors').list()).toHaveLength(0);
    // Recovery must not silently claim committed, execute again or erase unknown.
    expect(journal.inspect('proof-op', { subject: 'caller' }).status).toBe('unknown');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL'); await child.exited;
    db?.close(); await rm(root, { recursive: true, force: true });
  }
});


test('executor evidence rejects incomplete PID-only, invalid boot and malformed source records', () => {
  const proof = { source: { process: 'control', instance: 'master', catalog: 'catalog', generation: 1 },
    physical: { pid: 123, startToken: '42', executable: '/usr/bin/bun', processInstanceId: crypto.randomUUID() },
    boot: `linux:${crypto.randomUUID()}` };
  expect(decodePluginExecutorProof(proof)).not.toBeNull();
  expect(decodePluginExecutorProof({ ...proof, physical: { pid: 123 } })).toBeNull();
  expect(decodePluginExecutorProof({ ...proof, boot: 'same-epoch' })).toBeNull();
  expect(decodePluginExecutorProof({ ...proof, source: { ...proof.source, generation: 0 } })).toBeNull();
  expect(decodePluginExecutorProof({ ...proof, physical: { ...proof.physical, processInstanceId: '' } })).toBeNull();
});
