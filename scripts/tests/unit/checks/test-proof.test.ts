import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createProof, platforms, releaseNeedsFull, verifyRecords, type PhaseRecord } from '../../../checks/test-proof';
import type { TestPlan } from '../../../checks/test-selection';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), source = 'c'.repeat(40), releaseCommit = 'd'.repeat(40);
const plan: TestPlan = { version: 1, base: sha, testCommit: sha, tree, head: source, mode: 'full', build: true, reasons: ['explicit-full'],
  files: { unit: ['tests/unit/a.test.ts','tests/unit/b.test.ts'], integration: ['tests/integration/a.test.ts','tests/integration/b.test.ts'], browser: ['tests/browser/a.test.ts','tests/browser/b.test.ts'] } };
const metadata = { pr: 12, runId: '123', runAttempt: 1, now: new Date('2026-10-11T00:00:00Z') };
const expected = { ...metadata, head: source, tree };
function records(): PhaseRecord[] {
  return [
    { phase: 'unit', files: plan.files.unit, executed: plan.files.unit, commit: sha, tree, elapsed: 1, status: 0 },
    ...plan.files.integration.map((file, index) => ({ phase: 'integration' as const, files: plan.files.integration, executed: [file], commit: sha, tree, elapsed: 2, status: 0, shard: `${index+1}/2` })),
    ...plan.files.browser.map((file, index) => ({ phase: 'browser' as const, files: plan.files.browser, executed: [file], commit: sha, tree, elapsed: 3, status: 0, shard: `${index+1}/2` })),
  ];
}
const proof = (input = plan) => createProof(input, platforms.map(platform => verifyRecords(input, records(), platform)), metadata);

test('proof source comes from the plan and same-tree release commits need not match PR commits', () => {
  const value = proof();
  expect(value.head).toBe(source);
  expect(value.testCommit).toBe(sha);
  expect(releaseNeedsFull(value, expected)).toBe(false);
  const releasePlan = { ...plan, base: releaseCommit, testCommit: releaseCommit };
  const results = platforms.map(platform => ({ platform, commit: releaseCommit, tree, scope: 'full' as const, success: true as const }));
  const releaseProof = createProof(releasePlan, results, { ...metadata, runId: '456', runAttempt: 2 });
  expect(releaseProof).toMatchObject({ head: source, testCommit: releaseCommit, tree, runId: '456', runAttempt: 2 });
  expect(releaseNeedsFull(releaseProof, { ...expected, runId: '456', runAttempt: 2 })).toBe(false);
  expect(() => releaseNeedsFull(releaseProof, expected)).toThrow('mismatched');
});

test.each([undefined, null, 123, '', 'main', 'abcdef0', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64)])('proof rejects missing or malformed source SHA: %s', head => {
  expect(() => proof({ ...plan, head: head as string | undefined })).toThrow('Invalid source head SHA');
});

test('native shards cover each selected file once and use identical candidate lists', () => {
  expect(verifyRecords(plan, records(), 'ubuntu-latest').success).toBe(true);
  for (const mutate of [
    (rs: PhaseRecord[]) => rs.pop(),
    (rs: PhaseRecord[]) => rs.splice(0, 1),
    (rs: PhaseRecord[]) => rs.splice(1, 1),
    (rs: PhaseRecord[]) => rs.push({ ...rs[1]! }),
    (rs: PhaseRecord[]) => { rs[0]!.status = 1; },
    (rs: PhaseRecord[]) => { rs[0]!.tree = 'c'.repeat(40); },
    (rs: PhaseRecord[]) => { rs[0]!.commit = 'c'.repeat(40); },
    (rs: PhaseRecord[]) => { rs[0]!.executed = []; },
    (rs: PhaseRecord[]) => { rs[0]!.shard = '1/1'; },
    (rs: PhaseRecord[]) => { rs[1]!.shard = undefined; },
    (rs: PhaseRecord[]) => { rs[1]!.shard = '1/1'; },
    (rs: PhaseRecord[]) => { rs[2]!.shard = '1/2'; },
    (rs: PhaseRecord[]) => { rs[4]!.executed = rs[3]!.executed; },
    (rs: PhaseRecord[]) => { rs[4]!.shard = '1/2'; },
    (rs: PhaseRecord[]) => { rs[4]!.shard = '1/3'; },
    (rs: PhaseRecord[]) => { rs[4]!.files = [plan.files.browser[1]!]; },
    (rs: PhaseRecord[]) => { rs[0]!.elapsed = NaN; },
  ]) { const rs = records(); mutate(rs); expect(() => verifyRecords(plan, rs, 'macos-latest')).toThrow(); }
});

test('document-only proof requires no execution; single integration and browser files each require one native 1/1 shard', () => {
  expect(verifyRecords({ ...plan, mode: 'none', build: false, files: { unit: [], integration: [], browser: [] } }, [], 'macos-latest').scope).toBe('none');
  const single = { ...plan, files: { unit: plan.files.unit, integration: [plan.files.integration[0]!], browser: [plan.files.browser[0]!] } };
  const rs = [records()[0]!, { ...records()[1]!, files: single.files.integration, executed: single.files.integration, shard: '1/1' },
    { ...records()[3]!, files: single.files.browser, executed: single.files.browser, shard: '1/1' }];
  expect(verifyRecords(single, rs, 'ubuntu-latest').success).toBe(true);
  rs[1] = { ...rs[1]!, shard: '1/2' };
  expect(() => verifyRecords(single, rs, 'ubuntu-latest')).toThrow();
});

test.each(['affected','none'] as const)('%s proof never satisfies full release validation', scope => {
  const value = proof(); value.scope = scope; value.platforms.forEach(result => result.scope = scope);
  expect(releaseNeedsFull(value, expected)).toBe(true);
});
test('exact tree full proof can be reused; missing platform, old schema, expired and mismatched proofs reject', () => {
  expect(releaseNeedsFull(proof(), expected)).toBe(false);
  for (const mutate of [
    (p: any) => { delete p.version; },
    (p: any) => { delete p.scope; },
    (p: any) => { p.scope = 'partial'; },
    (p: any) => { p.platforms.pop(); },
    (p: any) => { p.platforms[0].success = false; },
    (p: any) => { p.platforms[0].scope = 'affected'; },
    (p: any) => { p.tree = 'c'.repeat(40); },
    (p: any) => { p.head = 'd'.repeat(40); },
    (p: any) => { p.pr++; },
    (p: any) => { p.runId = '124'; },
    (p: any) => { p.runAttempt++; },
    (p: any) => { p.createdAt = 'invalid'; },
    (p: any) => { p.createdAt = '2026-09-20T00:00:00Z'; },
    (p: any) => { p.createdAt = '2026-10-12T00:00:00Z'; },
  ]) { const value = proof(); mutate(value); expect(() => releaseNeedsFull(value, expected)).toThrow(); }
});

test('publishing is isolated behind strict PR and shared full-validation jobs', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/release.yml', import.meta.url), 'utf8')) as any;
  expect(workflow.jobs['full-tests'].uses).toBe('./.github/workflows/ci.yml');
  expect(workflow.jobs['full-tests'].with.full).toBe(true);
  expect(workflow.jobs['full-tests'].with.ref).toBe('${{ github.sha }}');
  expect(workflow.jobs['full-tests'].with.base).toBe('${{ github.sha }}');
  expect(workflow.jobs['full-tests'].with.head).toBe('${{ needs.verify-pr.outputs.head }}');
  expect(workflow.jobs['full-tests'].with.pr).toBe('${{ fromJSON(needs.verify-pr.outputs.number) }}');
  expect(workflow.jobs.release.needs).toEqual(['verify-pr','full-tests']);
  expect(workflow.jobs.release.if).toContain("needs.full-tests.result == 'success'");
  expect(workflow.jobs.release.if).toContain("needs.verify-pr.result == 'success'");
  expect(workflow.jobs['verify-pr'].environment).toBeUndefined();
  expect(workflow.jobs['verify-pr'].steps.some((step: any) => step.uses?.includes('create-github-app-token') || step.run?.includes('semantic-release'))).toBe(false);
  expect(workflow.jobs.release.environment).toBe('release');
});

test('CI records PR source independently of the tested checkout and proof uses the plan source', () => {
  const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as any;
  const selection = workflow.jobs.plan.steps.find((step: any) => step.id === 'plan');
  const checkout = workflow.jobs.plan.steps.find((step: any) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with.ref).toBe('${{ inputs.ref || github.sha }}');
  expect(selection.env.BASE).toBe('${{ inputs.base || github.event.pull_request.base.sha }}');
  expect(selection.env.PR_HEAD_SHA).toBe('${{ inputs.head || github.event.pull_request.head.sha }}');
  const generation = workflow.jobs.proof.steps.find((step: any) => step.name === 'Record strict PR validation provenance');
  expect(generation.env.PR_NUMBER).toBe('${{ inputs.pr || github.event.pull_request.number }}');
  expect(generation.env.PR_HEAD_SHA).toBeUndefined();
});
