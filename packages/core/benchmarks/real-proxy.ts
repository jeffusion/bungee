import { createHash } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';
import { appendFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  cleanupMaster, createMasterCleanupScope, createMasterFixture, removeFixture, spawnMaster, waitForHealth, waitUntil,
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
type CleanupPhase = 'master_cleanup:first' | 'master_cleanup:retry' | 'fixture_remove' | 'reservation_release' | 'upstream_stop';

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

const MAX_PORT_RESERVATION_ATTEMPTS = 32;
const MAX_STARTUP_RETRIES = 3;
type ReservationServer = { readonly port?: number; readonly stop: (closeActive?: boolean) => unknown };
type PortReservation = {
  readonly basePort: number;
  readonly publicPort: number;
  readonly managementPort: number;
  readonly ingressPort: number;
  readonly release: () => Promise<void>;
};
type ReservePortOptions = Readonly<{
  readonly maxAttempts?: number;
  readonly serve?: (port: number) => ReservationServer;
}>;

export async function reservePortPair(excludedPort: number, options: ReservePortOptions = {}): Promise<PortReservation> {
  const maxAttempts = options.maxAttempts ?? MAX_PORT_RESERVATION_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('port reservation attempts must be positive');
  const serve = options.serve ?? ((port: number) => Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('reserved') }));
  let lastCollision: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let first: ReservationServer | undefined;
    let second: ReservationServer | undefined;
    let third: ReservationServer | undefined;
    const owned: ReservationServer[] = [];
    const stopped = new Set<ReservationServer>();
    const releaseOwned = async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const server of owned) {
        if (stopped.has(server)) continue;
        try {
          await server.stop(true);
          stopped.add(server);
        } catch (error) { errors.push(error); }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'port reservation cleanup failed');
    };
    try {
      first = serve(0);
      owned.push(first);
      const basePort = first.port;
      if (basePort === undefined || !Number.isSafeInteger(basePort) || basePort < 1 || basePort > 65532) {
        throw new Error('port reservation returned an invalid base port');
      }
      if ([basePort, basePort + 1, basePort + 2].includes(excludedPort)) {
        await releaseOwned();
        continue;
      }
      second = serve(basePort + 1);
      owned.push(second);
      third = serve(basePort + 2);
      owned.push(third);
      let released = false;
      return {
        basePort, managementPort: basePort, publicPort: basePort + 1, ingressPort: basePort + 2,
        release: async () => {
          if (released) return;
          await releaseOwned();
          released = true;
        },
      };
    } catch (error) {
      try { await releaseOwned(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'port reservation failed', { cause: error }); }
      if (!isAddressInUse(error)) throw error;
      lastCollision = error;
    }
  }
  throw new Error(`port reservation exhausted after ${maxAttempts} attempts`, { cause: lastCollision });
}

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

function phaseSummary(error: unknown): string {
  const seen = new WeakSet<object>();
  const summaries: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth >= 4 || summaries.length >= MAX_FAILURE_ERRORS || typeof value !== 'object' || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    const candidate = value as Error & { cleanup_phase?: unknown; cleanup_category?: unknown; cleanup_detail?: unknown };
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
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, aggregate: configurationAggregate(upstreamPort, targetPath), mutation_id: mutationId }),
    signal: AbortSignal.timeout(5_000),
  });
  await response.text();
  if (response.status !== 202 && response.status !== 200) throw new Error(`configuration PUT returned HTTP ${response.status}`);
  let latest: LatestOperation | undefined;
  try {
    await waitUntil(async () => {
      const operation = await fetch(`http://127.0.0.1:${port}/api/config/operations/${encodeURIComponent(mutationId)}`, { signal: AbortSignal.timeout(2_000) });
      const text = await operation.text();
      let body: unknown;
      try { body = JSON.parse(text); }
      catch { body = undefined; }
      latest = { status: operation.status, body };
      const details = operationDetails(body);
      if (details.state === 'degraded' || details.state === 'failed') {
        throw new Error(`configuration operation ${details.state}: error_code=${details.errorCode ?? 'unknown'}`);
      }
      return operation.status === 200 && details.state === 'converged';
    }, 'configuration operation did not converge', timeoutMs);
  } catch (error) {
    if (error instanceof Error && error.message === 'configuration operation did not converge') {
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
  reservePortPair: typeof reservePortPair;
  prewarmUpstream: typeof prewarmUpstream;
  createMasterFixture: typeof createMasterFixture;
  spawnMaster: typeof spawnMaster;
  waitForHealth: typeof waitForHealth;
  publishConfiguration: typeof publishConfiguration;
  runScenario: typeof runScenario;
  cleanupMaster: typeof cleanupMaster;
  removeFixture: typeof removeFixture;
}>>;

const DEFAULT_TRIAL_DEPENDENCIES: Required<TrialDependencies> = {
  startUpstream, reservePortPair, prewarmUpstream, createMasterFixture, spawnMaster,
  waitForHealth, publishConfiguration, runScenario, cleanupMaster, removeFixture,
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
  let reservation: PortReservation | undefined;
  let reservationReleased = false;
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
    reservation = await dependencies.reservePortPair(startedUpstream.port);
    const { publicPort, managementPort } = reservation;
    await dependencies.prewarmUpstream(startedUpstream);
    fixture = await dependencies.createMasterFixture(`bungee-real-proxy-${label}-`);
    const healthPort = legacy ? publicPort : managementPort;
    await reservation.release();
    reservationReleased = true;
    master = dependencies.spawnMaster(cleanupScope, entryFor(target), fixture, legacy ? publicPort : managementPort, profile.workers, fixture.root, fixture.accessDbPath, childEnvironment(), { layout: legacy ? 'legacy-single-port' : 'split', stopProcessMonitor: false });
    await dependencies.waitForHealth(healthPort, master);
    const initialTarget = '/a';
    stage = 'initial-publication';
    await dependencies.publishConfiguration(healthPort, startedUpstream.port, initialTarget, revision, `b5000000-0000-4000-8000-${label === 'before' ? '000000000101' : '000000000102'}`);
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
    let processCleanupSucceeded = true;
    if (master) {
      const cleanupOptions = retryableAddressCollision && retryAttempt < MAX_STARTUP_RETRIES
        ? { ports: [] }
        : undefined;
      try { await dependencies.cleanupMaster(master, [], cleanupOptions); }
      catch (firstCleanupError) {
        processCleanupSucceeded = false;
        cleanupErrors.push(cleanupPhaseError('master_cleanup:first', firstCleanupError,
          `pid=${master.child.pid ?? 'unknown'} ports=${master.ports.join(',')}`));
        try {
          await dependencies.cleanupMaster(master, [], cleanupOptions);
          processCleanupSucceeded = true;
        } catch (secondCleanupError) {
          cleanupErrors.push(cleanupPhaseError('master_cleanup:retry', secondCleanupError,
            `pid=${master.child.pid ?? 'unknown'} ports=${master.ports.join(',')}`));
        }
      }
    }
    if (fixture && processCleanupSucceeded) try { await dependencies.removeFixture(fixture); }
    catch (error) { cleanupErrors.push(cleanupPhaseError('fixture_remove', error)); }
    if (reservation && !reservationReleased) try { await reservation.release(); }
    catch (error) {
      cleanupErrors.push(cleanupPhaseError('reservation_release', error,
        `ports=${reservation.basePort},${reservation.publicPort},${reservation.ingressPort}`));
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
