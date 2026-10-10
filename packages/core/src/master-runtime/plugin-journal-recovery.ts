import { createHash } from 'node:crypto';
import type { PluginStateClient, AsyncCommunicationNamespaceStore } from '../plugin-state/client';
import type { CommandRecoveryAuthorizer, CommandSourceIdentity } from '../plugin-services/command-journal';
import { captureProcessIdentity, probeProcessIdentity, readKernelBootId } from './process-identity';
import { decodePluginExecutorProof, type PluginExecutorProof } from '../plugin-services/peer-executor-proof';

const NAMESPACE = 'host:rpc:executors';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function key(source: CommandSourceIdentity): string {
  return createHash('sha256').update(JSON.stringify([source.process, source.instance, source.catalog, source.generation])).digest('hex');
}

/** Host evidence only. Neither a lost peer nor a new controller proves executor exit. */
export class PluginJournalRecovery {
  private cursor = '';
  private readonly client: Pick<PluginStateClient,'executorProofPage'|'executorHasPending'>;
  private readonly store: AsyncCommunicationNamespaceStore;
  private readonly terminal = new Set<string>();
  private currentKey: string | null = null;
  private boot: string | null = null;
  private proof: PluginExecutorProof | null = null;
  /** The current executor's durable identity, exposed only on the authenticated Host peer read. */
  get currentProof(): PluginExecutorProof | null { return this.proof; }
  constructor(client: Pick<PluginStateClient, 'channelStore'|'executorProofPage'|'executorHasPending'>,
    private readonly probe = probeProcessIdentity, private readonly now = Date.now) {
    this.store = client.channelStore(NAMESPACE);
    this.client = client;
  }

  async register(source: CommandSourceIdentity, pid: number, marker: string): Promise<void> {
    const physical = await captureProcessIdentity(pid, marker);
    const boot = await readKernelBootId();
    const proof = decodePluginExecutorProof({ source, physical, boot });
    if (proof === null) throw new Error('executor_proof_invalid');
    const id = key(source);
    // Required evidence is charged against the existing communication quota.
    // It must be durable before this source accepts journaled commands.
    await this.store.put(id, encoder.encode(JSON.stringify(proof)), { required: true });
    this.currentKey = id;
    this.boot = boot;
    this.proof = proof;
  }

  hasCurrentProof(source: CommandSourceIdentity): boolean { return this.currentKey === key(source); }

  readonly authorize: CommandRecoveryAuthorizer = request => this.terminal.has(key(request.source))
    ? Object.freeze({ owner: request.owner, epoch: request.epoch, issuedAt: this.now() }) : null;

  async maintain(): Promise<{ checked: number; removed: number }> {
    if (this.boot === null) this.boot = await readKernelBootId();
    const rows = await this.client.executorProofPage(this.cursor,8);
    this.cursor = rows.length === 8 ? rows.at(-1)!.key : '';
    let removed = 0;
    const results = await Promise.allSettled(rows.map(async row => {
      if (row.key === this.currentKey) return;
      const record = await this.store.get(row.key);
      if (record === null) return;
      const proof = decodePluginExecutorProof(JSON.parse(decoder.decode(record.payload)));
      if (proof === null || key(proof.source) !== row.key) throw new Error('executor_proof_corrupt');
      const state = proof.boot !== this.boot ? 'dead' : await this.probe(proof.physical);
      if (state !== 'dead' && state !== 'mismatch') return;
      this.terminal.add(row.key);
      // Unknown/committed command records and receipts are never removed here.
      // Physical evidence may be released only after no pending command needs it.
      if (!await this.client.executorHasPending(proof.source)) {
        await this.store.ack(row.key);this.terminal.delete(row.key);removed++;
      }
    }));
    // Bound the acceleration cache; persisted proofs are rescanned fairly.
    while (this.terminal.size > 256) this.terminal.delete(this.terminal.values().next().value!);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'executor proof maintenance failed');
    return { checked: rows.length, removed };
  }
}
