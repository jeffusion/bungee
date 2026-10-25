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
  test('shared menu contracts and core storage/API changes retain full regression selection', () => {
    const added = [
      'packages/types/tests/unit/menus.test.ts',
      'packages/core/tests/integration/ui-menus.test.ts',
      'packages/ui/tests/browser/menus.test.ts',
    ];
    for (const file of ['packages/types/src/menus.ts', 'packages/core/src/master-runtime/menu-api.ts', 'packages/core/scripts/generate-icon-resources.ts']) {
      const selected = plan([file], { paths: [...paths, ...added] });
      expect(selected.mode).toBe('full');
      expect(selected.files.unit).toContain(added[0]);
      expect(selected.files.integration).toContain(added[1]);
      expect(selected.files.browser).toContain(added[2]);
    }
  });
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
  test('adapter and catalog changes retain Router process coverage through the actual declared dependency chain', async () => {
    const snapshot: Snapshot = {};
    for (const plugin of ['models-dev','llm-protocol-adapter','codex-router']) {
      const path = `plugins/${plugin}/manifest.json`;
      snapshot[path] = await Bun.file(new URL(`../../../../${path}`, import.meta.url)).text();
    }
    const paths = [
      'plugins/models-dev/tests/integration/manager.test.ts',
      'plugins/llm-protocol-adapter/tests/unit/service.test.ts',
      'plugins/codex-router/tests/unit/history-protocol.test.ts',
      'packages/core/tests/integration/plugins/llm-protocol-adapter.test.ts',
      'tests/integration/codex-router-real-process.test.ts',
      'tests/browser/dashboard.test.ts',
    ];
    const relations = buildRelations(snapshot);
    expect([...relations.reversePlugins.get('plugins/llm-protocol-adapter')!]).toContain('plugins/codex-router');
    for (const changed of ['plugins/models-dev/server/reasoning.ts','plugins/llm-protocol-adapter/server/service.ts']) {
      const result = plan([changed], {paths, relations});
      expect(result.mode).toBe('affected');
      expect(result.files.integration).toContain('packages/core/tests/integration/plugins/llm-protocol-adapter.test.ts');
      expect(result.files.integration).toContain('tests/integration/codex-router-real-process.test.ts');
      expect(result.files.unit).toContain('plugins/llm-protocol-adapter/tests/unit/service.test.ts');
    }
  });
  test('TPS service, UI, manifest and shared metering dependencies retain their corresponding coverage', () => {
    const tps = 'plugins/llm-tps';
    const tpsPaths = [...paths, ...['unit','integration','browser'].map(phase => entry(tps,phase)), ...['unit','integration'].map(phase => entry('plugins/token-metering',phase))];
    const relations = buildRelations({...snapshot,
      'plugins/token-metering/manifest.json':'{"name":"token-metering"}',
      'plugins/llm-tps/manifest.json':'{"name":"llm-tps","dependencies":{"token-metering":"*"}}',
    });
    for(const changed of ['plugins/llm-tps/server/index.ts','plugins/llm-tps/manifest.json','plugins/token-metering/server/index.ts','packages/core/src/plugin-services.ts']) {
      const result=plan([changed],{paths:tpsPaths,relations});
      expect(result.files.integration).toContain(entry(tps,'integration'));
      expect(result.files.browser).toContain(entry(tps,'browser'));
      expect(result.files.unit).toEqual(discoverTests(tpsPaths).unit);
    }
    const ui=plan(['plugins/llm-tps/ui/TpsWidget.svelte'],{paths:tpsPaths,relations});
    expect(ui.files.browser).toContain(entry(tps,'browser'));
    expect(ui.files.unit).toEqual(discoverTests(tpsPaths).unit);
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
  test('logs route keeps only its maintained browser entries and falls back when one is missing', () => {
    const route = 'packages/ui/src/routes/Logs.svelte';
    const logs = ['packages/ui/tests/browser/header-actions.test.ts', 'packages/ui/tests/browser/routes/logs-outcomes.test.ts'];
    const value = plan([route], { paths: [...paths, ...logs] });
    expect(value.mode).toBe('affected');
    expect(value.files.integration).toEqual([entry('packages/ui', 'integration')]);
    expect(value.files.browser).toEqual([...logs, entry('root', 'browser'), entry('plugins/a', 'browser'), entry('plugins/b', 'browser'), entry('plugins/c', 'browser')].sort());
    expect(value.files.browser).not.toContain(entry('packages/ui', 'browser'));
    const fallback = plan([route], { paths: [...paths, ...logs.slice(0, 1)] });
    expect(fallback.files.browser).toContain(entry('packages/ui', 'browser'));
    expect(plan(['packages/ui/src/App.svelte']).files.browser).toContain(entry('packages/ui', 'browser'));
    expect(plan(['packages/ui/src/App.svelte', route], { paths: [...paths, ...logs] }).files.browser)
      .toEqual(plan(['packages/ui/src/App.svelte'], { paths: [...paths, ...logs] }).files.browser);
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
  test('source SHA is optional metadata independent of the tested commit', () => {
    const local = plan([]);
    expect(local.head).toBeUndefined();
    expect(validatePlan(local, paths)).toBe(local);
    const sourced = plan([], { head: 'c'.repeat(40) });
    expect(validatePlan(sourced, paths).head).toBe('c'.repeat(40));
    expect(sourced.testCommit).toBe(sha);
  });
  test.each([null, 123, '', 'main', 'abcdef0', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64)])('rejects malformed source SHA: %s', head => {
    const value = plan([]); value.head = head as string;
    expect(() => validatePlan(value, paths)).toThrow('Invalid source head SHA');
  });
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
