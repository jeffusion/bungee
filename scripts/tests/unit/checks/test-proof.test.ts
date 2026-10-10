import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createProof, platforms, releaseNeedsFull, verifyRecords, type PhaseRecord } from '../../../checks/test-proof';
import type { TestPlan } from '../../../checks/test-selection';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const plan: TestPlan = { version: 1, base: sha, testCommit: sha, tree, mode: 'full', build: true, reasons: ['explicit-full'],
  files: { unit: ['tests/unit/a.test.ts'], integration: ['tests/integration/a.test.ts'], browser: ['tests/browser/a.test.ts','tests/browser/b.test.ts'] } };
const metadata = { head: sha, pr: 12, runId: '123', runAttempt: 1, now: new Date('2026-10-11T00:00:00Z') };
function records(): PhaseRecord[] {
  return [
    { phase: 'unit', files: plan.files.unit, executed: plan.files.unit, commit: sha, tree, elapsed: 1, status: 0 },
    { phase: 'integration', files: plan.files.integration, executed: plan.files.integration, commit: sha, tree, elapsed: 2, status: 0 },
    ...plan.files.browser.map((file, index) => ({ phase: 'browser' as const, files: plan.files.browser, executed: [file], commit: sha, tree, elapsed: 3, status: 0, shard: `${index+1}/2` })),
  ];
}
const proof = (input = plan) => createProof(input, platforms.map(platform => verifyRecords(input, records(), platform)), metadata);

test('native shards cover each selected file once and use identical candidate lists', () => {
  expect(verifyRecords(plan, records(), 'ubuntu-latest').success).toBe(true);
  for (const mutate of [
    (rs: PhaseRecord[]) => rs.pop(),
    (rs: PhaseRecord[]) => { rs[0]!.status = 1; },
    (rs: PhaseRecord[]) => { rs[0]!.tree = 'c'.repeat(40); },
    (rs: PhaseRecord[]) => { rs[0]!.commit = 'c'.repeat(40); },
    (rs: PhaseRecord[]) => { rs[0]!.executed = []; },
    (rs: PhaseRecord[]) => { rs[3]!.executed = rs[2]!.executed; },
    (rs: PhaseRecord[]) => { rs[3]!.shard = '1/2'; },
    (rs: PhaseRecord[]) => { rs[3]!.files = [plan.files.browser[1]!]; },
    (rs: PhaseRecord[]) => { rs[0]!.elapsed = NaN; },
  ]) { const rs = records(); mutate(rs); expect(() => verifyRecords(plan, rs, 'macos-latest')).toThrow(); }
});

test('document-only proof requires no execution; one browser file requires one native shard', () => {
  expect(verifyRecords({ ...plan, mode: 'none', build: false, files: { unit: [], integration: [], browser: [] } }, [], 'macos-latest').scope).toBe('none');
  const single = { ...plan, files: { ...plan.files, browser: [plan.files.browser[0]!] } };
  const rs = records().slice(0,3); rs[2] = { ...rs[2]!, files: single.files.browser, shard: '1/1' };
  expect(verifyRecords(single, rs, 'ubuntu-latest').success).toBe(true);
});

test.each(['affected','none'] as const)('%s proof never satisfies full release validation', scope => {
  const value = proof(); value.scope = scope; value.platforms.forEach(result => result.scope = scope);
  expect(releaseNeedsFull(value, { ...metadata, tree })).toBe(true);
});
test('exact tree full proof can be reused; missing platform, old schema, expired and mismatched proofs reject', () => {
  expect(releaseNeedsFull(proof(), { ...metadata, tree })).toBe(false);
  for (const mutate of [
    (p: any) => { delete p.version; },
    (p: any) => { delete p.scope; },
    (p: any) => { p.scope = 'partial'; },
    (p: any) => { p.platforms.pop(); },
    (p: any) => { p.platforms[0].success = false; },
    (p: any) => { p.platforms[0].scope = 'affected'; },
    (p: any) => { p.tree = 'c'.repeat(40); },
    (p: any) => { p.head = 'c'.repeat(40); },
    (p: any) => { p.pr++; },
    (p: any) => { p.runId = '124'; },
    (p: any) => { p.runAttempt++; },
    (p: any) => { p.createdAt = 'invalid'; },
    (p: any) => { p.createdAt = '2026-09-20T00:00:00Z'; },
    (p: any) => { p.createdAt = '2026-10-12T00:00:00Z'; },
  ]) { const value = proof(); mutate(value); expect(() => releaseNeedsFull(value, { ...metadata, tree })).toThrow(); }
});

test('publishing is isolated behind strict PR and shared full-validation jobs', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8')) as any;
  expect(workflow.jobs['full-tests'].uses).toBe('./.github/workflows/ci.yml');
  expect(workflow.jobs['full-tests'].with.full).toBe(true);
  expect(workflow.jobs.release.needs).toEqual(['verify-pr','full-tests']);
  expect(workflow.jobs.release.if).toContain("needs.full-tests.result == 'success'");
  expect(workflow.jobs.release.if).toContain("needs.verify-pr.result == 'success'");
  expect(workflow.jobs['verify-pr'].environment).toBeUndefined();
  expect(workflow.jobs['verify-pr'].steps.some((step: any) => step.uses?.includes('create-github-app-token') || step.run?.includes('semantic-release'))).toBe(false);
  expect(workflow.jobs.release.environment).toBe('release');
});
