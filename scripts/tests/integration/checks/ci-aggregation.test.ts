import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as any;
const script = workflow.jobs.test.steps.find((step: any) => step.name === 'Require planned jobs and exact executed-file union').run;
const repository = fileURLToPath(new URL('../../../..', import.meta.url));
const sha = 'a'.repeat(40), tree = 'b'.repeat(40);
const plan = { version: 1, base: sha, testCommit: sha, tree, head: 'c'.repeat(40), mode: 'full', build: true, reasons: ['explicit-full'],
  files: { unit: ['tests/unit/a.test.ts'], integration: ['tests/integration/a.test.ts', 'tests/integration/b.test.ts'],
    browser: ['tests/browser/a.test.ts', 'tests/browser/b.test.ts'] } };
function record(phase: string, files: string[], executed: string[], shard?: string) {
  return { phase, files, executed, commit: sha, tree, ...(shard ? { shard } : {}), elapsed: 1, status: 0 };
}
function records(): object[] {
  return [
    record('unit', plan.files.unit, plan.files.unit),
    ...plan.files.integration.map((file, index) => record('integration', plan.files.integration, [file], `${index + 1}/2`)),
    ...plan.files.browser.map((file, index) => record('browser', plan.files.browser, [file], `${index + 1}/2`)),
  ];
}
const complete = { plan: { result: 'success', outputs: { mode: 'full', integration: '2', browser: '2' } }, build: { result: 'success' }, integration: { result: 'success' }, browser: { result: 'success' } };
async function accepted(needs: object, entries = records()): Promise<{ status: number; platform: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bungee-ci-aggregation-'));
  try {
    await mkdir(join(dir, 'plan')); await mkdir(join(dir, 'execution'));
    const mode = (needs as any).plan?.outputs?.mode;
    await writeFile(join(dir, 'plan', 'plan.json'), JSON.stringify(mode === 'none'
      ? { ...plan, mode: 'none', build: false, files: { unit: [], integration: [], browser: [] } } : plan));
    await Promise.all(entries.map((entry, index) => writeFile(join(dir, 'execution', `record-${index}.json`), JSON.stringify(entry))));
    const child = Bun.spawn(['bash', '-c', script], { cwd: repository, env: { ...process.env, RUNNER_TEMP: dir, PLATFORM: 'ubuntu-latest', NEEDS: JSON.stringify(needs) }, stdout: 'ignore', stderr: 'pipe' });
    const [status] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    let platform = '';
    try { platform = await readFile(join(dir, 'ubuntu-latest.json'), 'utf8'); } catch {}
    return { status, platform };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test('CI summary rejects failed, cancelled and unexpectedly skipped tasks', async () => {
  expect((await accepted(complete)).status).toBe(0);
  for (const job of ['plan', 'build', 'integration', 'browser']) for (const result of ['failure', 'cancelled', 'skipped']) {
    const needs = structuredClone(complete); (needs as any)[job].result = result;
    expect((await accepted(needs)).status).not.toBe(0);
  }
  expect((await accepted({ plan: { result: 'success', outputs: { mode: 'none', integration: '0', browser: '0' } }, build: { result: 'skipped' }, integration: { result: 'skipped' }, browser: { result: 'skipped' } }, [])).status).toBe(0);
  expect((await accepted({ plan: { result: 'success', outputs: { mode: 'affected', integration: '0', browser: '1' } }, build: { result: 'success' }, integration: { result: 'skipped' }, browser: { result: 'cancelled' } })).status).not.toBe(0);
});
test('successful job status cannot hide a missing or duplicated execution record', async () => {
  const acceptedRun = await accepted(complete);
  expect(acceptedRun.status).toBe(0); expect(JSON.parse(acceptedRun.platform)).toMatchObject({ platform: 'ubuntu-latest', commit: sha, tree, success: true });
  const missing = records(); missing.pop();
  const duplicate = records(); duplicate[4] = duplicate[3]!;
  const extra = records(); extra.push(record('unit', plan.files.unit, plan.files.unit));
  for (const entries of [missing, duplicate, extra]) {
    const rejected = await accepted(complete, entries);
    expect(rejected.status).not.toBe(0); expect(rejected.platform).toBe('');
  }
});
