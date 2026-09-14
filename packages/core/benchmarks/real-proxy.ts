import { createHash } from 'node:crypto';
import { cpus, freemem, totalmem } from 'node:os';
import { appendFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import {
  cleanupMaster, createMasterFixture, freePort, removeFixture, spawnMaster, waitForHealth, waitUntil,
  type MasterEntry, type RunningMaster,
} from '../tests/fixtures/master-real-process-harness';
import {
  requestScenarioStop, runScenario, SCENARIO_NAMES, startUpstream, type ScenarioName, type ScenarioProfile, type ScenarioReport, type UpstreamProbe,
} from './real-proxy-scenarios';
import { compareSuite, type ScenarioComparison, type SuiteComparison } from './real-proxy-compare';

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

type TargetInfo = {
  readonly root: string;
  readonly source: string;
  readonly lock: string;
  readonly workspace: string;
  readonly commit: string;
  readonly tree: string;
  readonly clean: true;
};

type CliArguments = { readonly beforeRoot: string; readonly afterRoot: string; readonly output: string; readonly help: boolean };
type PairRecord = {
  readonly schema: 'bungee.performance.real-proxy.raw';
  readonly version: 2;
  readonly repeat: number;
  readonly scenario: ScenarioName;
  readonly order: readonly ('before' | 'after')[];
  readonly run: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly runner_sha: string;
    readonly profile_hash: string;
    readonly config_hash: string;
  };
  readonly before: TrialRecord;
  readonly after: TrialRecord;
};
type TrialRecord = {
  readonly label: 'before' | 'after';
  readonly target: TargetInfo;
  readonly valid: boolean;
  readonly report: ScenarioReport;
};

const USAGE = 'bun run benchmark --before-root ABS --after-root ABS --output ABS';
const ENV_NAMES = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'BUN_INSTALL', 'LANG', 'LC_ALL', 'TZ'] as const;

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

async function requiredRealpath(path: string, label: string): Promise<string> {
  try { return await realpath(path); }
  catch { throw new Error(`${label} does not exist: ${path}`); }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export async function validateTarget(rootInput: string, strict = true): Promise<TargetInfo> {
  if (!isAbsolute(rootInput)) throw new Error('target roots must be absolute');
  const root = await requiredRealpath(rootInput, 'target root');
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

async function publishConfiguration(port: number, upstreamPort: number, targetPath: string, expectedRevision: number, mutationId: string): Promise<{ readonly converged_ms: number }> {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: expectedRevision, aggregate: configurationAggregate(upstreamPort, targetPath), mutation_id: mutationId }),
    signal: AbortSignal.timeout(5_000),
  });
  await response.text();
  if (response.status !== 202 && response.status !== 200) throw new Error(`configuration PUT returned HTTP ${response.status}`);
  await waitUntil(async () => {
    const operation = await fetch(`http://127.0.0.1:${port}/api/config/operations/${encodeURIComponent(mutationId)}`, { signal: AbortSignal.timeout(2_000) });
    if (operation.status !== 200) return false;
    const body = await operation.json() as { operation?: { state?: string; error_code?: string }; state?: string; error_code?: string };
    const state = body.operation?.state ?? body.state;
    if (state === 'failed') throw new Error(`configuration operation failed: ${body.operation?.error_code ?? body.error_code ?? 'unknown'}`);
    return state === 'converged';
  }, 'configuration operation did not converge', 20_000);
  return { converged_ms: Math.round((performance.now() - started) * 1_000) / 1_000 };
}

function entryFor(target: TargetInfo): MasterEntry { return { name: 'source', executable: process.execPath, args: [target.source] }; }

async function runTrial(
  target: TargetInfo,
  label: 'before' | 'after',
  scenario: ScenarioName,
  profile: TestProfile,
  upstream: UpstreamProbe,
  publicPort: number,
  managementPort: number,
  legacy: boolean,
): Promise<TrialRecord> {
  const fixture = await createMasterFixture(`bungee-real-proxy-${label}-`);
  let master: RunningMaster | undefined;
  let revision = 1;
  try {
    const healthPort = legacy ? publicPort : managementPort;
    master = spawnMaster(entryFor(target), fixture, legacy ? publicPort : managementPort, profile.workers, fixture.root, fixture.accessDbPath, childEnvironment(), { layout: legacy ? 'legacy-single-port' : 'split', stopProcessMonitor: false });
    await waitForHealth(healthPort, master);
    const initialTarget = scenario === 'publication' ? '/b' : '/a';
    await publishConfiguration(healthPort, upstream.port, initialTarget, revision, `b5000000-0000-4000-8000-${label === 'before' ? '000000000101' : '000000000102'}`);
    revision += 1;
    const report = await runScenario(scenario, {
      publicPort, profile, upstream,
      initialPublicationTarget: initialTarget,
      publish: async (targetPath) => {
        const result = await publishConfiguration(healthPort, upstream.port, targetPath, revision, `b5000000-0000-4000-8000-${Date.now().toString(16).slice(-12)}`);
        revision += 1;
        return result;
      },
    });
    return { label, target, valid: report.valid, report };
  } finally {
    const cleanupErrors: unknown[] = [];
    if (master) {
      try { await cleanupMaster(master); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await removeFixture(fixture); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${label} ${scenario} cleanup failed`);
  }
}

function reportForComparison(records: readonly PairRecord[]): SuiteComparison {
  const inputs = SCENARIO_NAMES.map((scenario) => {
    const pairs = records.filter((record) => record.scenario === scenario);
    return { scenario, before: pairs.map((pair) => pair.before.report.metric), after: pairs.map((pair) => pair.after.report.metric) };
  });
  return compareSuite(inputs);
}

function commandLine(): string { return [process.execPath, ...process.argv].join(' '); }

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
    for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
      const scenario = scenarios[scenarioIndex]!;
      const order: readonly ('before' | 'after')[] = (repeat + scenarioIndex) % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      const basePort = await freePort();
      const splitManagement = basePort;
      const splitPublic = basePort + 1;
      const legacyPublic = splitPublic;
      const upstream = await startUpstream();
      try {
        const trials: Partial<Record<'before' | 'after', TrialRecord>> = {};
        for (const label of order) {
          const legacy = label === 'before' && before.root !== after.root;
          trials[label] = await runTrial(label === 'before' ? before : after, label, scenario, profile, upstream, legacy ? legacyPublic : splitPublic, legacy ? legacyPublic : splitManagement, legacy);
        }
        const pair: PairRecord = {
          schema: 'bungee.performance.real-proxy.raw', version: 2, repeat, scenario, order,
          run: {
            argv: process.argv, cwd: process.cwd(), runner_sha: command(['git', 'rev-parse', 'HEAD'], process.cwd()),
            profile_hash: hash(profile), config_hash: hash(configurationAggregate(upstream.port, scenario === 'publication' ? '/b' : '/a')),
          },
          before: trials.before!, after: trials.after!,
        };
        records.push(pair);
        if (onPair) await onPair(pair);
      } finally {
        await upstream.server.stop(true);
      }
    }
  }
  return records;
}

async function writeFormalOutput(args: CliArguments, preflight: Awaited<ReturnType<typeof validatePreflight>>): Promise<void> {
  await mkdir(preflight.output, { recursive: true });
  const records: PairRecord[] = [];
  await runTestProfile(FORMAL_PROFILE, { beforeRoot: preflight.before.root, afterRoot: preflight.after.root }, async (record) => {
    records.push(record);
    await appendFile(join(preflight.output, 'raw.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');
  });
  const comparison: {
    schema: 'bungee.performance.real-proxy.comparison'; version: 2; argv: readonly string[]; cwd: string; runner: Record<string, unknown>;
    targets: { before: TargetInfo; after: TargetInfo }; environment: Record<string, unknown>; profile: TestProfile; suite: SuiteComparison;
    capability_issues: readonly { label: string; scenario: ScenarioName; errors: readonly string[] }[];
  } = {
    schema: 'bungee.performance.real-proxy.comparison', version: 2, argv: process.argv, cwd: process.cwd(),
    runner: { command: commandLine(), bun: Bun.version, sha: command(['git', 'rev-parse', 'HEAD'], process.cwd()) },
    targets: { before: preflight.before, after: preflight.after },
    environment: {
      bun: Bun.version, os: process.platform, arch: process.arch, cpu: { model: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
      memory: { total: totalmem(), free_at_start: freemem() }, env_whitelist: Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name] ?? null])),
      exact_commands: [commandLine(), `${process.execPath} ${preflight.before.source}`, `${process.execPath} ${preflight.after.source}`],
    },
    profile: FORMAL_PROFILE, suite: reportForComparison(records),
    capability_issues: records.flatMap((record) => [
      ...(record.before.valid ? [] : [{ label: 'before', scenario: record.scenario, errors: record.before.report.correctness.error_samples }]),
      ...(record.after.valid ? [] : [{ label: 'after', scenario: record.scenario, errors: record.after.report.correctness.error_samples }]),
    ]),
  };
  await Bun.write(join(preflight.output, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  if (comparison.suite.verdict !== 'pass') throw new Error(`performance suite ${comparison.suite.verdict}: ${comparison.suite.reason ?? 'unknown'}`);
  if (records.some((record) => !record.before.valid || !record.after.valid)) throw new Error('performance correctness gate failed');
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
