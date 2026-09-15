import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { MasterFixture, RunningMaster } from './master-real-process-harness';
import { processAlive, readWorkerDescriptors } from './master-real-process-harness';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');
const OPERATION_COLUMNS = `mutation_id,request_hash,expected_revision,committed_revision,kind,state,
  target_worker_count,result_status,error_code,error_detail,drain_recovery_generation,
  last_drain_recovery_previous_generation,created_at,updated_at`;
const WORKER_COLUMNS = `mutation_id,worker_slot,target_revision,drain_recovery_generation,
  attempt_no,last_begin_previous_attempt_no,last_begin_reason,state,applied_revision,last_error,updated_at`;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type RuntimeUpstreamsFailureEvidenceInput = {
  readonly fixture: MasterFixture;
  readonly master: RunningMaster;
  readonly mutationIds: readonly string[];
  readonly putResponses: readonly unknown[];
  readonly lastOperationJson: Readonly<Record<string, unknown>>;
  readonly failure: unknown;
};

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(authorization|token|secret|password|api[_-]?key|root[_-]?key)\s*([=:])\s*[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/[A-Za-z0-9+/]{43}=(?=\s|$|[,;])/g, '[REDACTED]');
}

function redact(value: unknown): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /authorization|token|secret|password|credential|root[_-]?key/i.test(key) ? '[REDACTED]' : redact(item),
    ])) as { readonly [key: string]: Json };
  }
  return String(value);
}

function commandOutput(args: readonly string[]): string | null {
  try {
    const result = Bun.spawnSync({ cmd: ['git', ...args], cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' });
    return result.exitCode === 0 ? Buffer.from(result.stdout).toString('utf8').trim() : null;
  } catch {
    return null;
  }
}

function sourceIdentity(): Json {
  const diff = commandOutput(['diff', '--binary', 'HEAD']);
  return {
    bun_version: Bun.version,
    git_head: commandOutput(['rev-parse', 'HEAD']),
    worktree_diff_sha256: diff === null ? null : createHash('sha256').update(diff).digest('hex'),
  };
}

function operationRows(path: string, mutationIds: readonly string[]): Json {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true });
    const operations = mutationIds.flatMap((mutationId) => database!.query(
      `SELECT ${OPERATION_COLUMNS} FROM configuration_operations WHERE mutation_id=?`,
    ).all(mutationId));
    const workers = mutationIds.flatMap((mutationId) => database!.query(
      `SELECT ${WORKER_COLUMNS} FROM configuration_operation_workers WHERE mutation_id=? ORDER BY worker_slot`,
    ).all(mutationId));
    return { configuration_operations: redact(operations), configuration_operation_workers: redact(workers) };
  } catch (error) {
    return { query_error: redactText(error instanceof Error ? error.message : String(error)) };
  } finally {
    database?.close();
  }
}

export async function writeRuntimeUpstreamsFailureEvidence(
  input: RuntimeUpstreamsFailureEvidenceInput,
): Promise<string> {
  const directory = makeCanonicalTempDir('bungee-runtime-upstreams-evidence');
  const descriptors = await readWorkerDescriptors(input.fixture);
  const pids = input.master.processes.registeredPids;
  const workerPids = descriptors.map(({ pid }) => pid).filter((pid): pid is number =>
    typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
  const report = {
    failure: redact(input.failure instanceof Error ? { name: input.failure.name, message: input.failure.message } : input.failure),
    mutations: {
      put_responses: redact(input.putResponses),
      mutation_ids: input.mutationIds,
      last_operation_json: redact(input.lastOperationJson),
    },
    sqlite_read_only: operationRows(input.fixture.dbPath, input.mutationIds),
    master: {
      output: redactText(input.master.output()),
      pid: input.master.child.pid ?? null,
      exit_code: input.master.child.exitCode,
      exit_signal: input.master.child.signalCode,
      registered_pids: pids.map((pid) => ({ pid, alive: processAlive(pid) })),
    },
    worker_descriptors: redact(descriptors),
    worker_pid_exit_evidence: workerPids.map((pid) => ({ pid, alive: processAlive(pid) })),
    source: sourceIdentity(),
  };
  const path = `${directory}/evidence.json`;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}
