import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = Bun.YAML.parse(readFileSync(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8')) as any;
const script = workflow.jobs.test.steps.find((step: any) => step.name === 'Require all planned jobs to succeed').run;
async function accepted(needs: object): Promise<boolean> {
  const child = Bun.spawn(['bash','-c',script], { env: { ...process.env, NEEDS: JSON.stringify(needs) }, stdout: 'ignore', stderr: 'pipe' });
  const [status] = await Promise.all([child.exited,new Response(child.stderr).text()]); return status === 0;
}
test('CI summary rejects failed, cancelled and unexpectedly skipped tasks', async () => {
  const complete = { plan: { result:'success', outputs: { mode:'full',integration:'3',browser:'2' } }, build:{result:'success'},integration:{result:'success'},browser:{result:'success'} };
  expect(await accepted(complete)).toBe(true);
  for (const job of ['plan','build','integration','browser']) for (const result of ['failure','cancelled','skipped']) {
    const needs=structuredClone(complete); (needs as any)[job].result=result;
    expect(await accepted(needs)).toBe(false);
  }
  expect(await accepted({ plan:{result:'success',outputs:{mode:'none',integration:'0',browser:'0'}},build:{result:'skipped'},integration:{result:'skipped'},browser:{result:'skipped'} })).toBe(true);
  expect(await accepted({ plan:{result:'success',outputs:{mode:'affected',integration:'0',browser:'1'}},build:{result:'success'},integration:{result:'skipped'},browser:{result:'cancelled'} })).toBe(false);
});
