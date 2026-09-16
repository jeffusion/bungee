import { createHash } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';
import { appendFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  cleanupSpawnedProcesses, createMasterCleanupScope, createMasterFixture, freePort, removeFixture, spawnMaster, waitForHealth,
  type MasterEntry, type RunningMaster,
} from '../tests/fixtures/master-real-process-harness';
import {
  prewarmUpstream, requestScenarioStop, runScenario, SCENARIO_NAMES, startUpstream, type ScenarioName, type ScenarioProfile, type ScenarioReport, type UpstreamProbe,
} from './real-proxy-scenarios';
import { compareScenario, compareSuite, type ScenarioComparison, type SuiteComparison } from './real-proxy-compare';

export const FORMAL_PROFILE: Readonly<ScenarioProfile & { readonly repeats: number; readonly workers: number }> = Object.freeze({
  repeats: 5, workers: 2, warmupMs: 5_000, measureMs: 15_000, publicationSwitchMs: 3_000,
  requestTimeoutMs: 2_000, latencySampleCap: 100_000, publicationRate: 100, publicationMaxInFlight: 256,
});

export type TestProfile = ScenarioProfile & {
  readonly repeats: number;
  readonly workers: number;
  readonly scenarios?: readonly ScenarioName[];
};

export const SHORT_PROFILE: Readonly<TestProfile> = Object.freeze({
  ...FORMAL_PROFILE, repeats: 1, workers: 2, warmupMs: 500, measureMs: 2_500,
  publicationSwitchMs: 500, requestTimeoutMs: 1_000, publicationRate: 20, publicationMaxInFlight: 256,
});

export type TargetInfo = {
  readonly root: string;
  readonly source: string;
  readonly lock: string;
  readonly workspace: string;
  readonly commit: string;
  readonly tree: string;
  readonly clean: true;
};

type CliArguments = { readonly beforeRoot: string; readonly afterRoot: string; readonly output: string; readonly help: boolean };
type Leg = 'AB' | 'BA';
type TargetConfigEvidence = {
  readonly target_root: string;
  readonly upstream_port: number;
  readonly initial: { readonly path: '/a'; readonly hash: string };
  readonly measured: { readonly path: '/a' | '/b'; readonly hash: string };
};
export type PairRecord = {
  readonly schema: 'bungee.performance.real-proxy.raw';
  readonly version: 3;
  readonly logical_block: number;
  readonly repeat: number;
  readonly scenario: ScenarioName;
  readonly scenario_order: readonly ScenarioName[];
  readonly leg: Leg;
  readonly order: readonly ('before' | 'after')[];
  readonly run: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly runner_sha: string;
    readonly profile_hash: string;
    readonly config: { readonly before: TargetConfigEvidence; readonly after: TargetConfigEvidence };
  };
  readonly before: TrialRecord;
  readonly after: TrialRecord;
};
type TrialRecord = {
  readonly label: 'before' | 'after';
  readonly target: TargetInfo;
  readonly upstream_instance_id: string;
  readonly upstream_port: number;
  readonly valid: boolean;
  readonly report: ScenarioReport;
};
type TrialStage = 'health' | 'initial-publication' | 'scenario';
type LatestOperation = { readonly status: number; readonly body: unknown };
class ConfigurationDeadlineExceeded extends Error {}
type CleanupPhase = 'process_cleanup:first' | 'process_cleanup:retry' | 'fixture_remove' | 'upstream_stop';

const USAGE = 'bun run benchmark --before-root ABS --after-root ABS --output ABS';
const ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'BUN_INSTALL', 'LANG', 'LC_ALL', 'TZ'] as const;
const MAX_EVIDENCE_BYTES = 16 * 1024;
const FAILURE_EVIDENCE_BYTES = 48 * 1024;
const MAX_FAILURE_NODES = 128;
const MAX_FAILURE_ERRORS = 32;
const EVIDENCE_BUDGET_EXCEEDED = '[evidence budget exceeded]';
const FAILURE_PHASE_BYTES = 2 * 1024;
const FAILURE_PRIMARY_BYTES = 6 * 1024;
const FAILURE_DETAILS_BYTES = 24 * 1024;
const FAILURE_MASTER_BYTES = 12 * 1024;
const CONFIG_PUT_TRANSPORT_SLICE_MS = 250;

function parsePositiveInteger(name: string, value: string, max: number): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a finite positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) throw new Error(`${name} exceeds ${max}`);
  return parsed;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 1 && argv[0] === '--help') return { beforeRoot: '', afterRoot: '', output: '', help: true };
  const values: Partial<Record<'before-root' | 'after-root' | 'output', string>> = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const option = (['--before-root', '--after-root', '--output'] as const).find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
    if (!option) throw new Error(`unknown argument: ${arg}`);
    if (seen.has(option)) throw new Error(`duplicate argument: ${option}`);
    seen.add(option);
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++index];
    if (!value) throw new Error(`${option} requires an absolute path`);
    if (!isAbsolute(value)) throw new Error(`${option} must be absolute`);
    values[option.slice(2) as 'before-root' | 'after-root' | 'output'] = resolve(value);
  }
  if (!values['before-root'] || !values['after-root'] || !values.output) throw new Error(`required options: ${USAGE}`);
  return { beforeRoot: values['before-root'], afterRoot: values['after-root'], output: values.output, help: false };
}

function command(cmd: readonly string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd: [...cmd], cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
}

function isStartupAddressCollision(error: unknown, master: RunningMaster | undefined): boolean {
  return isAddressInUse(error) || (master !== undefined && /\bEADDRINUSE\b/u.test(master.output()));
}

const MAX_STARTUP_RETRIES = 3;
async function requiredRealpath(path: string, label: string): Promise<string> {
  try { return await realpath(path); }
  catch { throw new Error(`${label} does not exist: ${path}`); }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

const GENERATED_UI_ASSET = 'packages/core/src/ui/assets.ts';
const GENERATED_UI_MARKERS = ['// Auto-generated by scripts/bundle-ui.ts', '// Do not edit manually'] as const;

async function requiredGeneratedUiAsset(root: string): Promise<void> {
  const path = join(root, GENERATED_UI_ASSET);
  let generated: string;
  try { generated = await realpath(path); }
  catch { throw new Error(`target generated UI asset is missing: ${path}; run full \`bun run build\` in this target first (the build generates and bundles UI assets)`); }
  if (!inside(root, generated)) {
    throw new Error(`target generated UI asset escapes repository: ${path} -> ${generated}; run full \`bun run build\` in this target first (the build generates and bundles UI assets)`);
  }
  let lines: readonly string[];
  try {
    const file = await open(generated, 'r');
    try {
      const buffer = new Uint8Array(256);
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
      lines = new TextDecoder().decode(buffer.subarray(0, bytesRead)).split('\n');
    } finally { await file.close(); }
  }
  catch { throw new Error(`target generated UI asset cannot be read: ${path}; run full \`bun run build\` in this target first (the build generates and bundles UI assets)`); }
  if (lines[0] !== GENERATED_UI_MARKERS[0] || lines[1] !== GENERATED_UI_MARKERS[1]) {
    throw new Error(`target generated UI asset has invalid generation markers: ${path}; run full \`bun run build\` in this target first (the build generates and bundles UI assets)`);
  }
}

export async function validateTarget(rootInput: string, strict = true): Promise<TargetInfo> {
  if (!isAbsolute(rootInput)) throw new Error('target roots must be absolute');
  const root = await requiredRealpath(rootInput, 'target root');
  await requiredGeneratedUiAsset(root);
  const source = await requiredRealpath(join(root, 'packages/core/src/main.ts'), 'target source');
  const workspace = await requiredRealpath(join(root, 'package.json'), 'target workspace package');
  let lock: string;
  try { lock = await requiredRealpath(join(root, 'bun.lock'), 'target lockfile'); }
  catch { lock = await requiredRealpath(join(root, 'bun.lockb'), 'target lockfile'); }
  const gitRoot = await requiredRealpath(command(['git', 'rev-parse', '--show-toplevel'], root), 'git root');
  if (gitRoot !== root) throw new Error(`target must be a repository root: ${root}`);
  const commit = command(['git', 'rev-parse', 'HEAD'], root);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`target HEAD is not a commit: ${root}`);
  const status = command(['git', 'status', '--porcelain=v1'], root);
  if (strict && status !== '') throw new Error(`target is not clean: ${root}`);
  const tree = command(['git', 'write-tree'], root);
  if (source !== await requiredRealpath(join(root, 'packages/core/src/main.ts'), 'target source')) throw new Error('target source changed during preflight');
  if (!inside(root, source) || !inside(root, lock) || !inside(root, workspace)) throw new Error('target realpaths escape repository');
  return { root, source, lock, workspace, commit, tree, clean: true };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function operationDetails(body: unknown): { readonly state?: string; readonly errorCode?: string } {
  const root = record(body);
  const operation = record(root?.operation) ?? root;
  return {
    state: typeof operation?.state === 'string' ? operation.state : undefined,
    errorCode: typeof operation?.error_code === 'string' ? operation.error_code : undefined,
  };
}

function boundedEvidence(value: string, limit = MAX_EVIDENCE_BYTES): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= limit) return value;
  const prefix = '...[truncated]...\n';
  const suffix = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.byteLength - (limit - new TextEncoder().encode(prefix).byteLength))));
  return `${prefix}${suffix}`;
}

function redactEvidence(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:["']?[\w.-]*(?:secret|token|key)|["']?(?:authorization|proxy-authorization|cookie|set-cookie|password))["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/(?:^|\s)-{1,2}EncodedCommand(?:\s+[^\s;]*)?/gi, ' [REDACTED]')
    .replace(/\b(?:env|environment|child[ _-]?env|encodedcommand)\b\s*[:=]\s*[^\r\n;]*/gi, '[REDACTED]')
    .replace(/\bACL(?:\s+path)?\b[^\r\n;]*/gi, 'ACL path=[REDACTED]');
}

function safeArguments(argv: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    result.push(redactEvidence(argument));
    if (/^-{1,2}EncodedCommand$/iu.test(argument) && index + 1 < argv.length) {
      result.push('[REDACTED]');
      index += 1;
    }
  }
  return result;
}

function safeErrorMessage(error: unknown): string {
  return boundedEvidence(redactEvidence(error instanceof Error ? error.message : String(error)));
}

function masterEvidence(master: RunningMaster | undefined, budget = FAILURE_MASTER_BYTES): string {
  const child = master?.child;
  let output = '';
  if (master !== undefined) {
    const fixed = `master_child_exit=${child?.exitCode ?? 'unknown'} master_child_signal=${child?.signalCode ?? 'unknown'} master_output_tail=`;
    const outputBudget = Math.max(0, budget - new TextEncoder().encode(`${fixed}""`).byteLength);
    try { output = boundedEvidence(redactEvidence(master.output()), outputBudget); }
    catch (error) { output = `[master output unavailable: ${safeErrorMessage(error)}]`; }
  }
  return boundedEvidence(`master_child_exit=${child?.exitCode ?? 'unknown'} master_child_signal=${child?.signalCode ?? 'unknown'} master_output_tail=${JSON.stringify(output)}`, budget);
}

const CLEANUP_EVIDENCE_PHASES = new Set(['sigterm_verify', 'sigterm_signal', 'sigterm_wait', 'sigkill_verify', 'sigkill_signal', 'sigkill_wait', 'final_verify']);
const CLEANUP_EVIDENCE_OUTCOMES = new Set(['probe_error', 'identity_unknown', 'identity_mismatch', 'signal_error', 'survivor']);
const CLEANUP_EVIDENCE_SIGNALS = new Set(['none', 'SIGTERM', 'SIGKILL']);
const CLEANUP_EVIDENCE_CODES = new Set(['ESRCH', 'EPERM', 'ETIMEDOUT', 'UNKNOWN']);
const CLEANUP_EVIDENCE_ROLES = new Set(['root', 'worker', 'ingress', 'child']);
const CLEANUP_HANDLE_SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO', 'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT', 'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1', 'SIGUSR2', 'SIGVTALRM', 'SIGXCPU', 'SIGXFSZ']);

function cleanupEvidenceText(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.process_cleanup_evidence)) return undefined;
  const evidence = value.process_cleanup_evidence.flatMap((entry) => {
    const event = record(entry);
    if (event === undefined || !CLEANUP_EVIDENCE_PHASES.has(String(event.phase)) || !Number.isSafeInteger(event.pid)
      || !CLEANUP_EVIDENCE_ROLES.has(String(event.role)) || !CLEANUP_EVIDENCE_OUTCOMES.has(String(event.outcome))
      || !CLEANUP_EVIDENCE_SIGNALS.has(String(event.signal)) || !CLEANUP_EVIDENCE_CODES.has(String(event.error_code))
      || typeof event.has_handle !== 'boolean' || typeof event.identity_present !== 'boolean'
      || (event.handle_exit_code !== null && !Number.isInteger(event.handle_exit_code))
      || (event.handle_signal_code !== null && (typeof event.handle_signal_code !== 'string' || !CLEANUP_HANDLE_SIGNALS.has(event.handle_signal_code)))) return [];
    return [{
      phase: event.phase, pid: event.pid, role: event.role, outcome: event.outcome, signal: event.signal,
      error_code: event.error_code, has_handle: event.has_handle, identity_present: event.identity_present,
      handle_exit_code: event.handle_exit_code, handle_signal_code: event.handle_signal_code,
    }];
  });
  if (evidence.length === 0) return undefined;
  const counts = ['entry_count', 'root_count', 'worker_count', 'ingress_count', 'child_count']
    .map((key) => `${key}=${Number.isSafeInteger(value[key]) ? value[key] : 0}`).join(' ');
  return `process_cleanup_evidence=${JSON.stringify(evidence)} ${counts}`;
}

export function phaseSummary(error: unknown): string {
  const seen = new WeakSet<object>();
  const evidenceOwners = new WeakSet<object>();
  const summaries: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== 'object' || value === null) return;
    const candidate = value as Error & { cleanup_phase?: unknown; cleanup_category?: unknown; cleanup_detail?: unknown; process_cleanup_evidence?: unknown };
    if (!evidenceOwners.has(candidate)) {
      const evidence = cleanupEvidenceText(candidate as unknown as Record<string, unknown>);
      if (evidence !== undefined) { evidenceOwners.add(candidate); summaries.push(evidence); }
    }
    if (depth >= 4 || summaries.length >= MAX_FAILURE_ERRORS) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (typeof candidate.cleanup_phase === 'string') {
      const category = typeof candidate.cleanup_category === 'string' ? candidate.cleanup_category : candidate.name;
      summaries.push(`${candidate.cleanup_phase} category=${category} message=${boundedEvidence(redactEvidence(candidate.message), 384)}`
        + (typeof candidate.cleanup_detail === 'string' && candidate.cleanup_detail !== '' ? ` detail=${boundedEvidence(redactEvidence(candidate.cleanup_detail), 384)}` : ''));
    }
    if ('cause' in candidate) visit(candidate.cause, depth + 1);
    if (value instanceof AggregateError) for (const entry of value.errors) visit(entry, depth + 1);
  };
  visit(error, 0);
  return boundedEvidence(summaries.length === 0 ? 'none' : summaries.join(' | '), FAILURE_PHASE_BYTES);
}

function diagnosticMessage(
  error: unknown,
  label: 'before' | 'after',
  scenario: ScenarioName,
  stage: TrialStage,
  master: RunningMaster | undefined,
  primary: unknown = error,
): string {
  const details = boundedEvidence(JSON.stringify(failureCause(error, { seen: new WeakSet<object>(), remaining: FAILURE_DETAILS_BYTES, nodes: 0 })), FAILURE_DETAILS_BYTES);
  return `real-proxy ${label}/${scenario} failed at ${stage}; primary=${boundedEvidence(safeErrorMessage(primary), FAILURE_PRIMARY_BYTES)}; `
    + `phases=${phaseSummary(error)}; details=${details}; ${masterEvidence(master)}`;
}

function trialFailure(error: unknown, label: 'before' | 'after', scenario: ScenarioName, stage: TrialStage, master: RunningMaster | undefined): Error {
  return new Error(diagnosticMessage(error, label, scenario, stage, master), { cause: error });
}

function cleanupPhaseError(phase: CleanupPhase, error: unknown, detail = ''): Error {
  const tagged = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  Object.defineProperties(tagged, {
    cleanup_phase: { value: phase, enumerable: true },
    cleanup_category: { value: error instanceof Error ? error.name : typeof error, enumerable: true },
    cleanup_detail: { value: detail, enumerable: true },
  });
  return tagged;
}

type FailureEvidenceContext = {
  readonly seen: WeakSet<object>;
  remaining: number;
  nodes: number;
};

function evidenceText(value: string, context: FailureEvidenceContext): string {
  if (context.remaining <= 0) return EVIDENCE_BUDGET_EXCEEDED;
  const bounded = boundedEvidence(redactEvidence(value));
  const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
  if (bytes > context.remaining) {
    context.remaining = 0;
    return EVIDENCE_BUDGET_EXCEEDED;
  }
  context.remaining -= bytes;
  return bounded;
}

function omittedEvidence(message: string): Record<string, unknown> {
  return { name: 'Error', message, stack: null, cause: null, errors: null };
}

function failureCause(error: unknown, context: FailureEvidenceContext, depth = 0): Record<string, unknown> {
  if (depth >= 4) return omittedEvidence('[cause depth exceeded]');
  if (context.nodes >= MAX_FAILURE_NODES) return omittedEvidence(EVIDENCE_BUDGET_EXCEEDED);
  context.nodes += 1;
  if (typeof error === 'object' && error !== null) {
    if (context.seen.has(error)) return omittedEvidence('[cycle omitted]');
    context.seen.add(error);
  }
  if (!(error instanceof Error)) {
    return { name: typeof error, message: evidenceText(String(error), context), stack: null, cause: null, errors: null };
  }
  const cause = 'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined;
  const aggregateErrors = error instanceof AggregateError ? error.errors.slice(0, MAX_FAILURE_ERRORS) : [];
  const cleanupPhase = 'cleanup_phase' in error && typeof (error as Error & { cleanup_phase?: unknown }).cleanup_phase === 'string'
    ? (error as Error & { cleanup_phase: string }).cleanup_phase : undefined;
  const cleanupDetail = 'cleanup_detail' in error && typeof (error as Error & { cleanup_detail?: unknown }).cleanup_detail === 'string'
    ? (error as Error & { cleanup_detail: string }).cleanup_detail : undefined;
  const cleanupCategory = 'cleanup_category' in error && typeof (error as Error & { cleanup_category?: unknown }).cleanup_category === 'string'
    ? (error as Error & { cleanup_category: string }).cleanup_category : undefined;
  const causeEvidence = cause === undefined ? null : failureCause(cause, context, depth + 1);
  const errorsEvidence = aggregateErrors.length === 0 ? null : aggregateErrors.map((entry) => failureCause(entry, context, depth + 1));
  const stackEvidence = error.stack === undefined ? null : evidenceText(error.stack, context);
  return {
    ...(cleanupPhase === undefined ? {} : { phase: evidenceText(cleanupPhase, context) }),
    ...(cleanupCategory === undefined ? {} : { category: evidenceText(cleanupCategory, context) }),
    ...(cleanupDetail === undefined || cleanupDetail === '' ? {} : { detail: evidenceText(cleanupDetail, context) }),
    name: evidenceText(error.name, context),
    message: evidenceText(error.message, context),
    stack: stackEvidence,
    cause: causeEvidence,
    errors: errorsEvidence,
  };
}

export function formatBenchmarkError(error: unknown): Record<string, unknown> {
  const formatted = failureCause(error, { seen: new WeakSet<object>(), remaining: FAILURE_EVIDENCE_BYTES, nodes: 0 });
  if (new TextEncoder().encode(JSON.stringify(formatted)).byteLength <= FAILURE_EVIDENCE_BYTES) return formatted;
  return omittedEvidence(EVIDENCE_BUDGET_EXCEEDED);
}

function runnerMetadata(): { readonly bun: string; readonly sha: string } {
  return { bun: Bun.version, sha: command(['git', 'rev-parse', 'HEAD'], process.cwd()) };
}

function environmentMetadata(preflight: Awaited<ReturnType<typeof validatePreflight>>): Record<string, unknown> {
  return {
    bun: Bun.version, os: process.platform, arch: process.arch,
    cpu: { model: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
    memory: { total: totalmem(), free_at_start: freemem() },
  };
}

export async function validatePreflight(beforeInput: string, afterInput: string, outputInput: string): Promise<{ before: TargetInfo; after: TargetInfo; output: string }> {
  if (!isAbsolute(outputInput)) throw new Error('output must be absolute');
  const [beforeRoot, afterRoot] = await Promise.all([requiredRealpath(beforeInput, 'before root'), requiredRealpath(afterInput, 'after root')]);
  if (beforeRoot === afterRoot) throw new Error('before and after roots must be distinct realpaths');
  const [before, after] = await Promise.all([validateTarget(beforeInput), validateTarget(afterInput)]);
  if (before.root === after.root) throw new Error('before and after roots must be distinct realpaths');
  const driver = await requiredRealpath(process.cwd(), 'driver cwd');
  if (inside(before.root, driver) || inside(after.root, driver)) throw new Error('driver must be outside both targets');
  const output = resolve(outputInput);
  if (inside(before.root, output) || inside(after.root, output)) throw new Error('output must be outside both targets');
  try { await stat(output); throw new Error(`output must be a new path: ${output}`); }
  catch (error) { if (error instanceof Error && !('code' in error)) throw error; }
  const outputParent = await requiredRealpath(dirname(output), 'output parent');
  if (inside(before.root, outputParent) || inside(after.root, outputParent)) throw new Error('output must be outside both targets');
  return { before, after, output };
}

function childEnvironment(): Readonly<NodeJS.ProcessEnv> {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ENV_NAMES) if (process.env[name] !== undefined) result[name] = process.env[name];
  return result;
}

function hash(value: unknown): string { return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

function configurationAggregate(upstreamPort: number, targetPath: string): ConfigurationAggregateV2 {
  return {
    plugin_activations: [],
    logical_configuration: {
      auth: { enabled: false, tokens: [] }, plugins: [],
      services: [{ id: 'b5000000-0000-4000-8000-000000000001', position: 1, name: 'benchmark-service', plugins: [], endpoints: [{
        id: 'b5000000-0000-4000-8000-000000000002', position: 1, target: `http://127.0.0.1:${upstreamPort}${targetPath}`,
        weight: 100, priority: 1, is_disabled: false, plugins: [],
      }] }],
      routes: [{ id: 'b5000000-0000-4000-8000-000000000003', position: 1, path: '/bench', service_id: 'b5000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [] }],
    },
  };
}

export async function publishConfiguration(port: number, upstreamPort: number, targetPath: string, expectedRevision: number, mutationId: string, timeoutMs = 20_000): Promise<{ readonly converged_ms: number }> {
  const started = performance.now();
  const deadline = started + timeoutMs;
  const payload = { expected_revision: expectedRevision, aggregate: configurationAggregate(upstreamPort, targetPath), mutation_id: mutationId };
  const payloadText = JSON.stringify(payload);
  const putUrl = `http://127.0.0.1:${port}/api/config`;
  const operationUrl = `http://127.0.0.1:${port}/api/config/operations/${encodeURIComponent(mutationId)}`;
  const request = async (url: string, init: RequestInit, sliceMs?: number): Promise<{ readonly response: Response; readonly text: string }> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ConfigurationDeadlineExceeded();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, sliceMs ?? remaining));
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      return { response, text: await response.text() };
    } catch (error) {
      if (controller.signal.aborted && performance.now() >= deadline) throw new ConfigurationDeadlineExceeded();
      throw error;
    } finally { clearTimeout(timer); }
  };
  const put = async (): Promise<Response> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ConfigurationDeadlineExceeded();
    const { response } = await request(putUrl, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: payloadText,
    }, Math.min(CONFIG_PUT_TRANSPORT_SLICE_MS, Math.max(1, Math.floor(remaining / 2))));
    return response;
  };
  let latest: LatestOperation | undefined;
  try {
    let putRequired = true;
    while (true) {
      if (putRequired) {
        let putResponse: Response;
        try { putResponse = await put(); }
        catch (error) {
          if (error instanceof ConfigurationDeadlineExceeded) throw error;
          putRequired = false;
          continue;
        }
        if (putResponse.status !== 202 && putResponse.status !== 200) throw new Error(`configuration PUT returned HTTP ${putResponse.status}`);
        putRequired = false;
      }
      let operation: Response;
      let text: string;
      try {
        const result = await request(operationUrl, { method: 'GET' });
        operation = result.response;
        text = result.text;
      } catch (error) {
        if (error instanceof ConfigurationDeadlineExceeded) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ConfigurationDeadlineExceeded();
        await Bun.sleep(Math.min(50, remaining));
        continue;
      }
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { body = undefined; }
      latest = { status: operation.status, body };
      if (operation.status === 404) {
        putRequired = true;
        continue;
      }
      if (operation.status !== 200 && operation.status !== 202) throw new Error(`configuration operation returned HTTP ${operation.status}`);
      const details = operationDetails(body);
      if (details.state === 'degraded' || details.state === 'failed') {
        throw new Error(`configuration operation ${details.state}: error_code=${details.errorCode ?? 'unknown'}`);
      }
      if (operation.status === 200 && details.state === 'converged') break;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new ConfigurationDeadlineExceeded();
      await Bun.sleep(Math.min(50, remaining));
    }
  } catch (error) {
    if (error instanceof ConfigurationDeadlineExceeded) {
      throw new Error(`configuration operation did not converge: latest ${operationEvidence(latest)}`, { cause: error });
    }
    throw error;
  }
  return { converged_ms: Math.round((performance.now() - started) * 1_000) / 1_000 };
}

function operationEvidence(latest: LatestOperation | undefined): string {
  if (latest === undefined) return 'state=unknown status=unknown error_code=unknown';
  const details = operationDetails(latest.body);
  return `state=${details.state ?? 'unknown'} status=${latest.status} error_code=${details.errorCode ?? 'unknown'}`;
}

function entryFor(target: TargetInfo): MasterEntry { return { name: 'source', executable: process.execPath, args: [target.source] }; }

type TrialDependencies = Partial<Readonly<{
  startUpstream: typeof startUpstream;
  freePort: typeof freePort;
  prewarmUpstream: typeof prewarmUpstream;
  createMasterFixture: typeof createMasterFixture;
  spawnMaster: typeof spawnMaster;
  waitForHealth: typeof waitForHealth;
  publishConfiguration: typeof publishConfiguration;
  synchronizeOwnership: (master: RunningMaster) => Promise<void>;
  runScenario: typeof runScenario;
  cleanupSpawnedProcesses: typeof cleanupSpawnedProcesses;
  removeFixture: typeof removeFixture;
}>>;

const DEFAULT_TRIAL_DEPENDENCIES: Required<TrialDependencies> = {
  startUpstream, freePort, prewarmUpstream, createMasterFixture, spawnMaster,
  waitForHealth, publishConfiguration,
  synchronizeOwnership: async (master) => { await master.synchronizeOwnership?.(); },
  runScenario, cleanupSpawnedProcesses, removeFixture,
};

export async function runTrial(
  target: TargetInfo,
  label: 'before' | 'after',
  scenario: ScenarioName,
  profile: TestProfile,
  legacy: boolean,
  retryAttempt = 0,
  injectedDependencies: TrialDependencies = {},
): Promise<TrialRecord> {
  const dependencies = { ...DEFAULT_TRIAL_DEPENDENCIES, ...injectedDependencies };
  const cleanupScope = createMasterCleanupScope();
  let upstream: UpstreamProbe | undefined;
  let fixture: Awaited<ReturnType<typeof createMasterFixture>> | undefined;
  let master: RunningMaster | undefined;
  let revision = 1;
  let stage: TrialStage = 'health';
  let trial: TrialRecord | undefined;
  let failure: unknown;
  let retryableAddressCollision = false;
  try {
    const startedUpstream = await dependencies.startUpstream();
    upstream = startedUpstream;
    const basePort = await dependencies.freePort(cleanupScope, [startedUpstream.port]);
    const managementPort = basePort;
    const publicPort = basePort + 1;
    await dependencies.prewarmUpstream(startedUpstream);
    fixture = await dependencies.createMasterFixture(`bungee-real-proxy-${label}-`);
    const healthPort = legacy ? publicPort : managementPort;
    master = dependencies.spawnMaster(cleanupScope, entryFor(target), fixture, legacy ? publicPort : managementPort, profile.workers, fixture.root, fixture.accessDbPath, childEnvironment(), { layout: legacy ? 'legacy-single-port' : 'split', stopProcessMonitor: false });
    await dependencies.waitForHealth(healthPort, master);
    const initialTarget = '/a';
    stage = 'initial-publication';
    await dependencies.publishConfiguration(healthPort, startedUpstream.port, initialTarget, revision, `b5000000-0000-4000-8000-${label === 'before' ? '000000000101' : '000000000102'}`);
    await dependencies.synchronizeOwnership(master);
    revision += 1;
    stage = 'scenario';
    const report = await dependencies.runScenario(scenario, {
      publicPort, profile, upstream: startedUpstream,
      publish: async (targetPath) => {
        const result = await dependencies.publishConfiguration(healthPort, startedUpstream.port, targetPath, revision, `b5000000-0000-4000-8000-${Date.now().toString(16).slice(-12)}`);
        revision += 1;
        return result;
      },
    });
    trial = { label, target, upstream_instance_id: startedUpstream.instance_id, upstream_port: startedUpstream.port, valid: report.valid, report };
  } catch (error) {
    retryableAddressCollision = stage === 'health' && isStartupAddressCollision(error, master);
    failure = trialFailure(error, label, scenario, stage, master);
  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanupOptions = retryableAddressCollision && retryAttempt < MAX_STARTUP_RETRIES ? { quarantinePorts: true } : undefined;
    try {
      if (cleanupOptions === undefined) await dependencies.cleanupSpawnedProcesses(cleanupScope);
      else await dependencies.cleanupSpawnedProcesses(cleanupScope, cleanupOptions);
    } catch (firstCleanupError) {
      cleanupErrors.push(cleanupPhaseError('process_cleanup:first', firstCleanupError, `scope=${label}/${scenario}`));
      try {
        if (cleanupOptions === undefined) await dependencies.cleanupSpawnedProcesses(cleanupScope);
        else await dependencies.cleanupSpawnedProcesses(cleanupScope, cleanupOptions);
      } catch (retryCleanupError) {
        cleanupErrors.push(cleanupPhaseError('process_cleanup:retry', retryCleanupError, `scope=${label}/${scenario}`));
      }
    }
    if (fixture !== undefined && master === undefined) {
      try { await dependencies.removeFixture(fixture); }
      catch (error) { cleanupErrors.push(cleanupPhaseError('fixture_remove', error)); }
    }
    if (upstream) try { await upstream.server.stop(true); }
    catch (error) { cleanupErrors.push(cleanupPhaseError('upstream_stop', error, `port=${upstream.port}`)); }
    if (cleanupErrors.length > 0) {
      retryableAddressCollision = false;
      const cleanupFailure = new AggregateError(cleanupErrors, `${label} ${scenario} cleanup failed`);
      failure = failure === undefined ? trialFailure(cleanupFailure, label, scenario, stage, master)
        : (() => {
          const combined = new AggregateError([failure, cleanupFailure], `${label} ${scenario} failed and cleanup failed`, { cause: failure });
          return new AggregateError([failure, cleanupFailure], diagnosticMessage(combined, label, scenario, stage, master, failure), { cause: failure });
        })();
    }
  }
  if (failure !== undefined && retryableAddressCollision && retryAttempt < MAX_STARTUP_RETRIES) {
    return runTrial(target, label, scenario, profile, legacy, retryAttempt + 1, injectedDependencies);
  }
  if (failure !== undefined) throw failure;
  return trial!;
}

function invalidComparison(scenario: ScenarioName): ScenarioComparison {
  return compareScenario({ scenario, before: undefined, after: undefined } as unknown);
}

function geometricMean(left: number, right: number): number | null {
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) return null;
  const result = Math.exp((Math.log(left) + Math.log(right)) / 2);
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function compareLogicalBlocks(records: readonly PairRecord[], repeats = FORMAL_PROFILE.repeats): SuiteComparison {
  if (records.length !== expectedPairCount(repeats)) {
    return compareSuite(SCENARIO_NAMES.map(invalidComparison));
  }
  const inputs = SCENARIO_NAMES.map((scenario) => {
    const before: number[] = [];
    const after: number[] = [];
    for (let block = 0; block < repeats; block += 1) {
      const legs = records.filter((record) => record.scenario === scenario && record.logical_block === block);
      if (legs.length !== 2 || new Set(legs.map((record) => record.leg)).size !== 2) return invalidComparison(scenario);
      const ab = legs.find((record) => record.leg === 'AB');
      const ba = legs.find((record) => record.leg === 'BA');
      if (ab === undefined || ba === undefined
        || ab.repeat !== block || ba.repeat !== block
        || ab.order.join(',') !== 'before,after' || ba.order.join(',') !== 'after,before'
        || !ab.before.valid || !ab.after.valid || !ba.before.valid || !ba.after.valid) return invalidComparison(scenario);
      const beforeMean = geometricMean(ab.before.report.metric, ba.before.report.metric);
      const afterMean = geometricMean(ab.after.report.metric, ba.after.report.metric);
      if (beforeMean === null || afterMean === null) return invalidComparison(scenario);
      before.push(beforeMean);
      after.push(afterMean);
    }
    return { scenario, before, after };
  });
  return compareSuite(inputs);
}

function reportForComparison(records: readonly PairRecord[]): SuiteComparison {
  return compareLogicalBlocks(records, FORMAL_PROFILE.repeats);
}

export function targetConfigEvidence(target: Pick<TargetInfo, 'root'>, upstreamPort: number, measuredPath: '/a' | '/b'): TargetConfigEvidence {
  return {
    target_root: target.root, upstream_port: upstreamPort,
    initial: { path: '/a', hash: hash(configurationAggregate(upstreamPort, '/a')) },
    measured: { path: measuredPath, hash: hash(configurationAggregate(upstreamPort, measuredPath)) },
  };
}

export function formatCommandLine(argv: readonly string[]): string { return argv.join(' '); }

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) [left, right] = [right, left % right];
  return left;
}

export function scenarioOrderForRepeat(scenarios: readonly ScenarioName[], repeat: number): readonly ScenarioName[] {
  if (scenarios.length < 2) return [...scenarios];
  let step = 3;
  while (greatestCommonDivisor(step, scenarios.length) !== 1) step += 1;
  const offset = (repeat * step) % scenarios.length;
  return [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
}

export function expectedPairCount(repeats: number, scenarioCount = SCENARIO_NAMES.length): number {
  return repeats * scenarioCount * 2;
}

export async function runTestProfile(
  profile: TestProfile,
  roots?: { readonly beforeRoot: string; readonly afterRoot: string },
  onPair?: (pair: PairRecord) => void | Promise<void>,
): Promise<readonly PairRecord[]> {
  const before = await validateTarget(roots?.beforeRoot ?? resolve(import.meta.dir, '../../..'), false);
  const after = await validateTarget(roots?.afterRoot ?? resolve(import.meta.dir, '../../..'), false);
  const records: PairRecord[] = [];
  const scenarios = profile.scenarios ?? SCENARIO_NAMES;
  for (let repeat = 0; repeat < profile.repeats; repeat += 1) {
    const scenarioOrder = scenarioOrderForRepeat(scenarios, repeat);
    for (let scenarioIndex = 0; scenarioIndex < scenarioOrder.length; scenarioIndex += 1) {
      const scenario = scenarioOrder[scenarioIndex]!;
      const legOrder: readonly Leg[] = (repeat + scenarioIndex) % 2 === 0 ? ['AB', 'BA'] : ['BA', 'AB'];
      for (const leg of legOrder) {
        const order: readonly ('before' | 'after')[] = leg === 'AB' ? ['before', 'after'] : ['after', 'before'];
        const trials: Partial<Record<'before' | 'after', TrialRecord>> = {};
        for (const label of order) {
          const legacy = label === 'before' && before.root !== after.root;
          trials[label] = await runTrial(label === 'before' ? before : after, label, scenario, profile, legacy);
        }
        const measuredPath = scenario === 'publication' ? '/b' : '/a';
        const config = (target: TargetInfo, upstreamPort: number): TargetConfigEvidence => targetConfigEvidence(target, upstreamPort, measuredPath);
        const pair: PairRecord = {
          schema: 'bungee.performance.real-proxy.raw', version: 3, logical_block: repeat, repeat, scenario,
          scenario_order: scenarioOrder, leg, order,
          run: {
            argv: safeArguments(process.argv), cwd: process.cwd(), runner_sha: command(['git', 'rev-parse', 'HEAD'], process.cwd()),
            profile_hash: hash(profile), config: { before: config(before, trials.before!.upstream_port), after: config(after, trials.after!.upstream_port) },
          },
          before: trials.before!, after: trials.after!,
        };
        records.push(pair);
        if (onPair) await onPair(pair);
      }
    }
  }
  return records;
}

async function writeFormalOutput(args: CliArguments, preflight: Awaited<ReturnType<typeof validatePreflight>>): Promise<void> {
  await mkdir(preflight.output, { recursive: true });
  const records: PairRecord[] = [];
  try {
    await runTestProfile(FORMAL_PROFILE, { beforeRoot: preflight.before.root, afterRoot: preflight.after.root }, async (record) => {
      records.push(record);
      await appendFile(join(preflight.output, 'raw.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
    });
    if (records.length !== expectedPairCount(FORMAL_PROFILE.repeats)) {
      throw new Error(`benchmark raw pair count mismatch: ${records.length}/${expectedPairCount(FORMAL_PROFILE.repeats)}`);
    }
    const comparison: {
      schema: 'bungee.performance.real-proxy.comparison'; version: 3; argv: readonly string[]; cwd: string; runner: Record<string, unknown>;
      targets: { before: TargetInfo; after: TargetInfo }; environment: Record<string, unknown>; profile: TestProfile; suite: SuiteComparison;
      completed_pairs: number;
      capability_issues: readonly { label: string; scenario: ScenarioName; errors: readonly string[] }[];
    } = {
      schema: 'bungee.performance.real-proxy.comparison', version: 3, argv: safeArguments(process.argv), cwd: process.cwd(),
      runner: { command: formatCommandLine(safeArguments(process.argv)), ...runnerMetadata() },
      targets: { before: preflight.before, after: preflight.after }, environment: environmentMetadata(preflight),
      profile: FORMAL_PROFILE, completed_pairs: records.length, suite: reportForComparison(records),
      capability_issues: records.flatMap((record) => [
        ...(record.before.valid ? [] : [{ label: 'before', scenario: record.scenario, errors: record.before.report.correctness.error_samples }]),
        ...(record.after.valid ? [] : [{ label: 'after', scenario: record.scenario, errors: record.after.report.correctness.error_samples }]),
      ]),
    };
    await Bun.write(join(preflight.output, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
    if (comparison.suite.verdict !== 'pass') throw new Error(`performance suite ${comparison.suite.verdict}: ${comparison.suite.reason ?? 'unknown'}`);
    if (records.some((record) => !record.before.valid || !record.after.valid)) throw new Error('performance correctness gate failed');
  } catch (error) {
    const failure = {
      schema: 'bungee.performance.real-proxy.failure', version: 1, argv: safeArguments(process.argv), cwd: process.cwd(),
      runner: runnerMetadata(), targets: { before: preflight.before, after: preflight.after },
      environment: environmentMetadata(preflight), profile: FORMAL_PROFILE, completed_pairs: records.length,
      error: formatBenchmarkError(error),
    };
    try { await Bun.write(join(preflight.output, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`); }
    catch (writeError) { throw new AggregateError([error, writeError], 'failed to write benchmark failure evidence', { cause: error }); }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  if (args.help) { console.log(USAGE); return; }
  const preflight = await validatePreflight(args.beforeRoot, args.afterRoot, args.output);
  const onSignal = () => requestScenarioStop();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try { await writeFormalOutput(args, preflight); }
  finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
