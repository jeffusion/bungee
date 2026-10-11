import { describe, expect, test } from 'bun:test';
import { buildRelations, discoverTests, selectTests, validatePlan, type Snapshot, type TestPlan } from '../../../checks/test-selection';

const modules = ['root','scripts','packages/core','packages/ui','packages/cli','packages/llms','plugins/a','plugins/b','plugins/c'];
const paths = modules.flatMap(module => ['unit','integration','browser'].map(phase => `${module === 'root' ? '' : module + '/'}tests/${phase}/sample.test.ts`));
const sha = 'a'.repeat(40), tree = 'b'.repeat(64);
const snapshot: Snapshot = {
  'plugins/a/manifest.json': '{"name":"a"}',
  'plugins/b/manifest.json': '{"name":"b","dependencies":{"a":"*"}}',
  'plugins/c/manifest.json': '{"name":"c","dependencies":{"b":"*"}}',
  'plugins/a/server/index.ts': "import {codec} from '@jeffusion/bungee-llms/plugin-api';",
};
function plan(changed: string[], overrides: Partial<Parameters<typeof selectTests>[0]> = {}): TestPlan {
  return selectTests({ paths, changed, relations: buildRelations(snapshot), base: sha, testCommit: sha, tree, ...overrides });
}
const entry = (module: string, phase: string) => `${module === 'root' ? '' : module + '/'}tests/${phase}/sample.test.ts`;

describe('test scope selection', () => {
  test('discovers category entries, including tests of helpers, without discovering support files', () => {
    expect(discoverTests([...paths, 'tests/helpers/fake.test.ts', 'tests/fixtures/fake.test.ts', 'tests/fixtures/example/tests/unit/fake.test.ts', 'tests/manual/fake.test.ts', 'node_modules/x/tests/unit/fake.test.ts', 'dist/tests/unit/fake.test.ts', 'tests/integration/helpers/fixture.test.ts'])).toEqual({
      unit: paths.filter(p => p.includes('/unit/')).sort(),
      integration: [...paths.filter(p => p.includes('/integration/')), 'tests/integration/helpers/fixture.test.ts'].sort(),
      browser: paths.filter(p => p.includes('/browser/')).sort(),
    });
  });
  test.each(['docs/a.md','docs/image.png','AGENTS.md','packages/core/AGENTS.md','README_zh.md','plugins/a/LICENSE','packages/ui/docs/style.md','.agents/skills/scripts/SKILL.md'])('explicit documentation whitelist: %s', file => {
    expect(plan([file])).toMatchObject({ mode: 'none', build: false, files: { unit: [], integration: [], browser: [] } });
  });
  test.each(['tests/fixtures/README.md','plugins/a/tests/fixtures/README.md','unrecognized.md'])('markdown alone does not exempt inputs: %s', file => {
    expect(plan([file]).mode).not.toBe('none');
    expect(plan([file]).files.unit).toEqual(discoverTests(paths).unit);
  });
  test.each(['packages/core/src/a.ts','packages/types/src/a.ts','scripts/build/a.ts','scripts/runtime/a.ts','scripts/release/a.ts','scripts/checks/select-tests.ts','package.json','bun.lock','.github/workflows/ci.yml','unknown/file.ts','plugins/a/package.json','packages/ui/vite.config.ts'])('full fallback: %s', file => {
    expect(plan([file]).mode).toBe('full'); expect(plan([file]).files).toEqual(discoverTests(paths));
  });
  test.each(['packages/ui/src/App.svelte','plugins/a/ui/settings.html'])('UI includes shared integration and every UI/plugin/root browser: %s', file => {
    const value = plan([file]);
    expect(value.mode).toBe('affected'); expect(value.files.unit).toEqual(discoverTests(paths).unit);
    expect(value.files.integration).toEqual([entry('packages/ui','integration')]);
    expect(value.files.browser).toEqual(['root','packages/ui','plugins/a','plugins/b','plugins/c'].map(m => entry(m,'browser')).sort());
  });
  test('server includes transitive reverse dependencies, core/root integration and root browser', () => {
    const value = plan(['plugins/a/server/index.ts']);
    expect(value.files.integration).toEqual(['plugins/a','plugins/b','plugins/c','packages/core','root'].map(m => entry(m,'integration')).sort());
    expect(value.files.browser).toEqual([entry('root','browser')]);
  });
  test('manifest combines server and UI and multiple edits form a sorted union', () => {
    const value = plan(['plugins/a/manifest.json','packages/cli/src/index.ts','docs/a.md','plugins/a/manifest.json']);
    expect(value.files.integration).toEqual(['plugins/a','plugins/b','plugins/c','packages/core','packages/cli','packages/ui','root'].map(m => entry(m,'integration')).sort());
    expect(new Set(value.reasons).size).toBe(value.reasons.length);
  });
  test('CLI scope', () => {
    expect(plan(['packages/cli/src/index.ts']).files.integration).toEqual(['packages/cli','packages/core','root'].map(m => entry(m,'integration')).sort());
  });
  test('LLMS includes direct SDK consumers and reverse dependencies', () => {
    expect(plan(['packages/llms/src/index.ts']).files.integration).toEqual(['packages/llms','plugins/a','plugins/b','plugins/c','packages/core','root'].map(m => entry(m,'integration')).sort());
  });
  test('direct tests select that entry with all units; deleted tests cannot become execution paths', () => {
    expect(plan([entry('plugins/b','browser')]).files.browser).toEqual([entry('plugins/b','browser')]);
    expect(plan(['plugins/b/tests/integration/removed.test.ts']).files.integration).toEqual([]);
    expect(plan([entry('plugins/a','unit')]).files.unit).toEqual(discoverTests(paths).unit);
  });
  test('module support includes all module layers and confirmed cross-module consumers', () => {
    const relations = buildRelations({ ...snapshot, 'packages/core/tests/helpers/util.ts': 'export const x = 1;', 'plugins/a/tests/integration/a.ts': "import {x} from '../../../../packages/core/tests/helpers/util';" });
    const value = plan(['packages/core/tests/helpers/util.ts'], { relations });
    expect(value.files.integration).toEqual(['packages/core','plugins/a'].map(m => entry(m,'integration')).sort());
    expect(value.files.browser).toEqual(['packages/core','plugins/a'].map(m => entry(m,'browser')).sort());
    expect(plan(['tests/helpers/shared.ts']).mode).toBe('full');
  });
  test('directory/resource references register consumers for the owning support module', () => {
    const relations = buildRelations({ ...snapshot, 'packages/ui/tests/fixtures/page.html': '', 'packages/ui/tests/helpers/changed.ts': '',
      'plugins/a/tests/browser/a.ts': "const path = new URL('../../../../packages/ui/tests/fixtures', import.meta.url);" });
    expect(plan(['packages/ui/tests/helpers/changed.ts'], { relations }).files.browser).toEqual(['packages/ui','plugins/a'].map(m => entry(m,'browser')).sort());
  });
  test('modules without tests broaden to full and explain why', () => {
    for (const file of ['plugins/missing/server/a.ts','plugins/missing/ui/index.svelte']) {
      const value = plan([file]); expect(value.mode).toBe('full');
      expect(value.reasons).toContain('no-module-tests:plugins/missing');
    }
  });
  test('explicit full and empty diffs', () => {
    expect(plan([], { full: true }).files).toEqual(discoverTests(paths)); expect(plan([]).mode).toBe('none');
  });
});

describe('dependency evidence', () => {
  test('unions old/current manifest, confirmed literal imports, aliases and helper resources', () => {
    const before = { ...snapshot, 'plugins/c/server/ref.ts': "export {thing} from '../../a/server/api';", 'plugins/a/server/api.ts': 'export const thing=1;' };
    const after = { 'plugins/b/manifest.json': '{"name":"b"}', 'plugins/c/manifest.json': '{"name":"c"}', 'plugins/c/server/ref.ts': "// import '../../b/server/api'\nconst text=\"../../missing/server/api\";" };
    const relations = buildRelations(before, after);
    expect([...relations.reversePlugins.get('plugins/a')!].sort()).toEqual(['plugins/b','plugins/c']);
    expect([...relations.llmsConsumers]).toEqual(['plugins/a']);
  });
  test('invalid manifest/dependencies fail instead of empty plan', () => {
    expect(() => buildRelations({ 'plugins/a/manifest.json': '{' })).toThrow();
    expect(() => buildRelations({ 'plugins/a/manifest.json': '{"name":"a","dependencies":{"missing":"*"}}' })).toThrow('Unknown plugin dependency');
    expect(() => buildRelations({ 'plugins/a/manifest.json': '{"name":"a","dependencies":[]}' })).toThrow('Invalid dependencies');
    expect(() => buildRelations({ 'plugins/a/manifest.json': '{"name":"a"}', 'plugins/b/manifest.json': '{"name":"a"}' })).toThrow('Duplicate plugin name');
    expect(() => buildRelations({ 'plugins/a/manifest.json': '{"name":"a","dependencies":{"a":4}}' })).toThrow('Invalid dependency range');
  });
});

describe('plan validation', () => {
  test('accepts generated plan', () => { const value = plan(['plugins/a/server/index.ts']); expect(validatePlan(value, paths)).toBe(value); });
  test.each(['../tests/unit/fake.test.ts','/tests/unit/fake.test.ts','tests/unit/missing.test.ts','tests/unit/../unit/sample.test.ts','tests\\unit\\sample.test.ts'])('rejects invalid paths: %s', file => {
    const value = plan(['plugins/a/server/index.ts']); value.files.unit = [file]; expect(() => validatePlan(value, paths)).toThrow();
  });
  test('rejects duplicates, wrong phase, schema, and inconsistent none mode', () => {
    for (const mutate of [
      (p: TestPlan) => p.files.unit.push(p.files.unit[0]!),
      (p: TestPlan) => p.files.browser.push(p.files.unit[0]!),
      (p: TestPlan) => { p.version = 2 as 1; },
      (p: TestPlan) => { p.mode = 'none'; },
    ]) { const value = plan(['plugins/a/server/index.ts']); mutate(value); expect(() => validatePlan(value, paths)).toThrow(); }
  });
  test('full and active unit plans cannot omit discovered tests', () => {
    const full = plan([], { full: true }); full.files.browser.pop(); expect(() => validatePlan(full, paths)).toThrow('Incomplete');
    const active = plan(['plugins/a/server/index.ts']); active.files.unit.pop(); expect(() => validatePlan(active, paths)).toThrow('Incomplete');
  });
});
