import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rename, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createPlan, git, main, testCommand, workingSnapshot } from '../../../checks/select-tests';
import { verifyRecords, type PhaseRecord } from '../../../checks/test-proof';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function put(root: string, file: string, text = 'export const value=1;'): Promise<void> { await mkdir(dirname(join(root,file)), { recursive:true }); await writeFile(join(root,file),text); }
async function save(root: string, message: string): Promise<string> {
  await git(root,['add','.']); await git(root,['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m',message]);
  return (await git(root,['rev-parse','HEAD'])).toString().trim();
}
async function repo(): Promise<{ root: string; base: string }> {
  const root = await mkdtemp(join(tmpdir(),'bungee-select-tests-')); roots.push(root); await git(root,['init','-q']);
  for (const module of ['','packages/core/','packages/ui/','packages/cli/','packages/llms/','plugins/a/','plugins/b/']) for (const phase of ['unit','integration','browser']) await put(root,`${module}tests/${phase}/one.test.ts`,"import {test,expect} from 'bun:test'; test('ok',()=>expect(1).toBe(1));");
  await put(root,'plugins/a/manifest.json','{"name":"a"}'); await put(root,'plugins/b/manifest.json','{"name":"b","dependencies":{"a":"*"}}');
  await put(root,'plugins/a/server/old name.ts'); await put(root,'plugins/b/server/index.ts'); await put(root,'.gitignore','ignored/\n');
  return { root, base: await save(root,'base') };
}
describe('Git test planning and execution contract', () => {
  test('local union contains staged, unstaged, untracked, cumulative commits and ignores ignored inputs', async () => {
    const {root,base}=await repo(); await put(root,'packages/cli/src/index.ts'); await save(root,'cli change');
    await put(root,'plugins/b/server/index.ts','export const value=2;'); await git(root,['add','plugins/b/server/index.ts']);
    await put(root,'plugins/a/ui/settings.html','<h1>settings</h1>'); await put(root,'ignored/foo.ts');
    const value=await createPlan(root,{base});
    expect(value.reasons).toContain('cli:packages/cli/src/index.ts'); expect(value.reasons).toContain('plugin-server:plugins/b/server/index.ts'); expect(value.reasons).toContain('plugin-ui:plugins/a/ui/settings.html');
    expect(value.mode).toBe('affected'); expect(value.tree).toHaveLength(64);
    const committed=await createPlan(root,{base,committed:true}); expect(committed.reasons).toEqual(['cli:packages/cli/src/index.ts']); expect(committed.tree).toHaveLength(40);
  });
  test('renames with spaces select both original server and new UI; deletes retain base dependencies', async () => {
    const {root,base}=await repo(); await mkdir(join(root,'plugins/b/ui'),{recursive:true}); await rename(join(root,'plugins/a/server/old name.ts'),join(root,'plugins/b/ui/new name.ts')); await git(root,['add','.']);
    await rm(join(root,'plugins/b/manifest.json')); await rm(join(root,'plugins/a/server'),{recursive:true,force:true});
    const value=await createPlan(root,{base});
    expect(value.reasons).toContain('plugin-server:plugins/a/server/old name.ts'); expect(value.reasons).toContain('plugin-ui:plugins/b/ui/new name.ts');
    expect(value.files.integration).toContain('plugins/b/tests/integration/one.test.ts'); expect(value.files.browser).toContain('packages/ui/tests/browser/one.test.ts');
  });
  test('new test and documentation fixture are included, deleted test paths are absent', async () => {
    const {root,base}=await repo(); await put(root,'plugins/a/tests/integration/new test.test.ts'); await put(root,'plugins/b/tests/fixtures/README.md','# data');
    await rm(join(root,'plugins/a/tests/integration/one.test.ts'));
    const value=await createPlan(root,{base}); expect(value.files.integration).toContain('plugins/a/tests/integration/new test.test.ts'); expect(value.files.integration).not.toContain('plugins/a/tests/integration/one.test.ts');
    expect(value.reasons).toContain('test-support:plugins/b/tests/fixtures/README.md');
  });
  test('missing base, Git failures and corrupt configuration reject', async () => {
    const {root,base}=await repo(); await expect(createPlan(root,{base:'missing-ref'})).rejects.toThrow('git rev-parse failed');
    const other=await mkdtemp(join(tmpdir(),'bungee-not-git-')); roots.push(other); await expect(createPlan(other,{base})).rejects.toThrow();
    await put(root,'plugins/a/manifest.json','bad'); await expect(createPlan(root,{base})).rejects.toThrow();
  });
  test('phase consumes plan, executes explicit spaced path and records; tree/commit changes reject', async () => {
    const {root,base}=await repo(); const file='plugins/a/tests/integration/new test.test.ts'; await put(root,file,"import {test,expect} from 'bun:test'; test('space',()=>expect(true).toBe(true));");
    const value=await createPlan(root,{base}); const planFile=join(tmpdir(),`bungee-plan-${crypto.randomUUID()}.json`); const record=join(tmpdir(),`bungee-record-${crypto.randomUUID()}.json`); roots.push(planFile,record,record+'.timings.json');
    await writeFile(planFile,JSON.stringify(value)); expect(testCommand(value,'integration','1/1').slice(-1)).toEqual(['./'+file]);
    expect(await main(['--plan',planFile,'--phase','integration','--shard','1/1','--record',record],root)).toBe(0);
    expect(JSON.parse(await readFile(record,'utf8'))).toMatchObject({phase:'integration',files:[file],commit:value.testCommit,tree:value.tree,status:0,shard:'1/1'});
    await put(root,'docs/readme.md','# changed'); await expect(main(['--plan',planFile,'--phase','unit'],root)).rejects.toThrow('working tree has changed');
    await save(root,'new commit'); await expect(main(['--plan',planFile,'--phase','unit'],root)).rejects.toThrow('commit does not match');
  });
  test('working snapshot is stable and CLI errors remain nonzero at executable boundary', async () => {
    const {root,base}=await repo(); expect((await workingSnapshot(root)).tree).toBe((await workingSnapshot(root)).tree);
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'../../../checks/select-tests.ts'),'--base','missing'],{cwd:root,stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,status]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]); expect(status).toBe(1); expect(stdout).toBe(''); expect(stderr).toContain('failed');
    await expect(main(['--base',base,'--output',join(root,'plan.json')],root)).rejects.toThrow('outside');
    const aliases=await mkdtemp(join(tmpdir(),'bungee-plan-alias-')); roots.push(aliases);
    await symlink(root,join(aliases,'repository'),'dir');
    await expect(main(['--base',base,'--output',join(aliases,'repository','plan.json')],root)).rejects.toThrow('outside');
    const external=join(aliases,'external.json'); await writeFile(external,'keep');
    await symlink(external,join(root,'linked-output.json'),'file');
    await expect(main(['--base',base,'--output',join(root,'linked-output.json')],root)).rejects.toThrow('outside');
    expect(await readFile(external,'utf8')).toBe('keep');
    await symlink(join(root,'not-created.json'),join(aliases,'dangling.json'),'file');
    await expect(main(['--base',base,'--output',join(aliases,'dangling.json')],root)).rejects.toThrow('outside');
    await symlink(aliases,join(root,'external-directory'),'dir');
    await expect(main(['--base',base,'--output',join(aliases,'repository','external-directory','new.json')],root)).rejects.toThrow('outside');
    await expect(main(['--base',base,'--shard','1/2'],root)).rejects.toThrow('require --plan');
  });
  test('committed plan consumes actual HEAD and rejects subsequent dirty changes', async () => {
    const {root,base}=await repo(); await put(root,'docs/guide.md','# guide'); const head=await save(root,'docs');
    const value=await createPlan(root,{base,committed:true,head:base}); expect(value.testCommit).toBe(head); expect(value.head).toBe(base); expect(value.mode).toBe('none');
    const file=join(tmpdir(),`bungee-committed-plan-${crypto.randomUUID()}.json`); roots.push(file); await writeFile(file,JSON.stringify(value));
    expect(await main(['--plan',file,'--phase','unit'],root)).toBe(0);
    await put(root,'plugins/a/server/new.ts'); await expect(main(['--plan',file,'--phase','unit'],root)).rejects.toThrow('committed tree has changed');
  });
  test('committed execution accepts the two generated build sources but rejects other source edits', async () => {
    const {root,base}=await repo();
    for (const file of ['packages/core/src/ui/assets.ts','packages/ui/src/components/native-widgets/generated.ts']) await put(root,file,'// before build');
    await save(root,'generated baseline');
    const value=await createPlan(root,{base,committed:true,full:true});
    const dir=await mkdtemp(join(tmpdir(),'bungee-generated-plan-')); roots.push(dir);
    const file=join(dir,'plan.json'); await writeFile(file,JSON.stringify(value));
    for (const generated of ['packages/core/src/ui/assets.ts','packages/ui/src/components/native-widgets/generated.ts']) await put(root,generated,'// regenerated by build');
    expect(await main(['--plan',file,'--phase','unit'],root)).toBe(0);
    await put(root,'packages/core/src/main.ts','// unexpected source change');
    await expect(main(['--plan',file,'--phase','unit'],root)).rejects.toThrow('committed tree has changed');
  });
  test('--run builds once before unit, integration and browser; build failure stops execution', async () => {
    const {root,base}=await repo();
    await put(root,'package.json',JSON.stringify({scripts:{build:"bun -e 'import {appendFileSync,mkdirSync} from \"node:fs\";mkdirSync(\"ignored\",{recursive:true});appendFileSync(\"ignored/order\",\"build\\n\")'"}}));
    const snapshot=await workingSnapshot(root);
    for (const file of snapshot.paths.filter(path => path.endsWith('.test.ts'))) {
      const phase=file.match(/tests\/(unit|integration|browser)\//)![1];
      await put(root,file,`import {test} from 'bun:test'; import {appendFileSync} from 'node:fs'; test('order',()=>appendFileSync('ignored/order','${phase}\\n'));`);
    }
    const script=join(import.meta.dir,'../../../checks/select-tests.ts');
    async function run(): Promise<{code:number;stdout:string}> {
      const child=Bun.spawn([process.execPath,script,'--base',base,'--full','--run'],{cwd:root,stdout:'pipe',stderr:'pipe'});
      const [code,stdout]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]); return {code,stdout};
    }
    const first=await run(); expect(first.code).toBe(0); expect(JSON.parse(first.stdout).mode).toBe('full');
    expect((await readFile(join(root,'ignored/order'),'utf8')).trim().split('\n')).toEqual(['build',...Array(7).fill('unit'),...Array(7).fill('integration'),...Array(7).fill('browser')]);
    await put(root,'package.json','{"scripts":{"build":"bun -e \'process.exit(7)\'"}}');
    expect((await run()).code).toBe(7);
    expect((await readFile(join(root,'ignored/order'),'utf8')).trim().split('\n')).toHaveLength(22);
  });
  test('native shards report disjoint executed files whose union is the complete selected suite', async () => {
    const {root,base}=await repo();
    const value=await createPlan(root,{base,full:true});
    const dir=await mkdtemp(join(tmpdir(),'bungee-native-shards-')); roots.push(dir);
    const planFile=join(dir,'plan.json'); await writeFile(planFile,JSON.stringify(value));
    const records: PhaseRecord[]=[];
    for (const [phase,shard] of [['unit',undefined],['integration',undefined],['browser','1/2'],['browser','2/2']] as const) {
      const record=join(dir,`${phase}-${shard?.replace('/','-') ?? 'all'}.json`);
      expect(await main(['--plan',planFile,'--phase',phase,...(shard?['--shard',shard]:[]),'--record',record],root)).toBe(0);
      records.push(JSON.parse(await readFile(record,'utf8')));
    }
    expect(verifyRecords(value,records,'ubuntu-latest').success).toBe(true);
    expect(records.filter(record=>record.phase==='browser').every(record=>record.executed.length<value.files.browser.length)).toBe(true);
  });
});
