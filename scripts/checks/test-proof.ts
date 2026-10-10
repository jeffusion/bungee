import type { Phase, TestPlan } from './test-selection';

export const platforms = ['ubuntu-latest', 'macos-latest'] as const;
export type Platform = typeof platforms[number];
export interface PhaseRecord {
  phase: Phase;
  files: string[];
  executed: string[];
  commit: string;
  tree: string;
  shard?: string;
  elapsed: number;
  status: number;
}
export interface PlatformProof {
  platform: Platform;
  commit: string;
  tree: string;
  scope: TestPlan['mode'];
  success: true;
}
export interface TestProof {
  version: 1;
  base: string;
  testCommit: string;
  tree: string;
  head: string;
  pr: number;
  scope: TestPlan['mode'];
  runId: string;
  runAttempt: number;
  createdAt: string;
  platforms: PlatformProof[];
}
const same = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

/** Verify the native runner's executed-file evidence, without calculating its partition. */
export function verifyRecords(plan: TestPlan, records: PhaseRecord[], platform: Platform): PlatformProof {
  if (!platforms.includes(platform)) throw new Error('Unknown test platform');
  const phases: Phase[] = ['unit', 'integration', 'browser'];
  for (const record of records) {
    if (!phases.includes(record.phase) || record.status !== 0 || record.commit !== plan.testCommit || record.tree !== plan.tree ||
        !Number.isFinite(record.elapsed) || record.elapsed < 0 || !Array.isArray(record.files) || !Array.isArray(record.executed)) throw new Error('Failed or mismatched execution record');
    if (!same(record.files, plan.files[record.phase])) throw new Error('Execution used a different candidate list');
  }
  for (const phase of phases) {
    const selected = plan.files[phase], found = records.filter(record => record.phase === phase);
    const count = selected.length ? (phase === 'browser' ? Math.min(2, selected.length) : 1) : 0;
    if (found.length !== count) throw new Error(`Missing or extra ${phase} task`);
    const executed = found.flatMap(record => record.executed);
    if (new Set(executed).size !== executed.length || !same(executed, selected)) throw new Error(`Incomplete or duplicate ${phase} execution`);
    if (phase === 'browser') {
      if (new Set(found.map(record => record.shard)).size !== count || found.some(record => !Array.from({ length: count }, (_, i) => `${i + 1}/${count}`).includes(record.shard!))) throw new Error('Invalid browser shard evidence');
    } else if (found.some(record => record.shard)) throw new Error('Unexpected non-browser shard');
  }
  return { platform, commit: plan.testCommit, tree: plan.tree, scope: plan.mode, success: true };
}

export function createProof(plan: TestPlan, results: PlatformProof[], metadata: {
  head: string; pr: number; runId: string; runAttempt: number; now?: Date;
}): TestProof {
  if (results.length !== platforms.length || new Set(results.map(result => result.platform)).size !== platforms.length ||
      results.some(result => !platforms.includes(result.platform) || result.commit !== plan.testCommit || result.tree !== plan.tree || result.scope !== plan.mode || result.success !== true)) throw new Error('Missing successful platform proof');
  return { version: 1, base: plan.base, testCommit: plan.testCommit, tree: plan.tree, scope: plan.mode,
    head: metadata.head, pr: metadata.pr, runId: metadata.runId, runAttempt: metadata.runAttempt,
    createdAt: (metadata.now ?? new Date()).toISOString(), platforms: [...results].sort((a, b) => a.platform.localeCompare(b.platform)) };
}

/** Latest PR success is required even when a fresh full release run is necessary. */
export function releaseNeedsFull(value: unknown, expected: {
  tree: string; head: string; pr: number; runId: string; runAttempt: number; now?: Date;
}): boolean {
  const proof = value as TestProof;
  if (!proof || proof.version !== 1 || !['none','affected','full'].includes(proof.scope) ||
      !/^[a-f0-9]{40}$/.test(proof.base) || !/^[a-f0-9]{40}$/.test(proof.testCommit) ||
      !/^[a-f0-9]{40}$/.test(proof.tree) || !/^[a-f0-9]{40}$/.test(proof.head) ||
      proof.tree !== expected.tree || proof.head !== expected.head || proof.pr !== expected.pr ||
      proof.runId !== expected.runId || proof.runAttempt !== expected.runAttempt || !Array.isArray(proof.platforms)) throw new Error('Invalid or mismatched PR test proof');
  const age = (expected.now ?? new Date()).getTime() - Date.parse(proof.createdAt);
  if (!Number.isFinite(age) || age < 0 || age >= 14 * 24 * 60 * 60 * 1000) throw new Error('Expired PR test proof');
  createProof({ testCommit: proof.testCommit, tree: proof.tree, mode: proof.scope } as TestPlan, proof.platforms, {
    head: proof.head, pr: proof.pr, runId: proof.runId, runAttempt: proof.runAttempt,
  });
  return proof.scope !== 'full';
}
