import ts from 'typescript';
import { posix } from 'node:path';

export const phases = ['unit', 'integration', 'browser'] as const;
export type Phase = typeof phases[number];
export type Snapshot = Record<string, string>;
export interface TestPlan {
  version: 1;
  base: string;
  testCommit: string;
  tree: string;
  head?: string;
  mode: 'none' | 'affected' | 'full';
  reasons: string[];
  build: boolean;
  files: Record<Phase, string[]>;
}
export function moduleOf(file: string): string {
  return file.match(/^(packages|plugins)\/[^/]+/)?.[0] ?? (file.startsWith('scripts/') ? 'scripts' : 'root');
}
export function phaseOf(file: string): Phase | undefined {
  if (/(^|\/)(node_modules|dist|manual|benchmarks)\//.test(file)) return;
  if (/(?:^|\/)tests\/(helpers|fixtures)\//.test(file)) return;
  if (!/(?:\.(?:test|spec)|_(?:test|spec))\.[cm]?[jt]sx?$/.test(file)) return;
  return file.match(/(?:^|\/)tests\/(unit|integration|browser)\//)?.[1] as Phase | undefined;
}
export function discoverTests(paths: readonly string[]): Record<Phase, string[]> {
  const files: Record<Phase, string[]> = { unit: [], integration: [], browser: [] };
  for (const file of new Set(paths)) { const phase = phaseOf(file); if (phase) files[phase].push(file); }
  for (const phase of phases) files[phase].sort();
  return files;
}
function isHelper(file: string): boolean { return /(?:^|\/)tests\/(helpers|fixtures)(?:\/|$)/.test(file); }
export function isDocumentation(file: string): boolean {
  if (isHelper(file) || file.includes('/tests/')) return false;
  return file.startsWith('docs/') || file.startsWith('.agents/skills/') || file.startsWith('.codex/skills/') ||
    /(?:^|\/)AGENTS\.md$/.test(file) || /(?:^|\/)(?:README(?:[._-][^/]*)?\.md|CHANGELOG\.md|LICENSE(?:\.[^/]*)?)$/.test(file) ||
    /^packages\/[^/]+\/docs\//.test(file) || /^plugins\/[^/]+\/INTEGRATION\.md$/.test(file);
}
export interface Relations {
  reversePlugins: Map<string, Set<string>>;
  llmsConsumers: Set<string>;
  helperConsumers: Map<string, Set<string>>;
}
function add(map: Map<string, Set<string>>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key)!.add(value);
}
function references(file: string, text: string): string[] {
  // Svelte scripts use the same TS syntax; template/markup strings are not imports.
  const sources = file.endsWith('.svelte') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]!) : [text];
  const refs = new Set<string>();
  for (const source of sources) {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      // Include literal resource paths (new URL/resolve/read) as well as imports.
      if (ts.isStringLiteralLike(node) && (node.text.startsWith('.') || node.text.startsWith('@jeffusion/bungee-llms'))) refs.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...refs];
}
export function buildRelations(...snapshots: Snapshot[]): Relations {
  const result: Relations = { reversePlugins: new Map(), llmsConsumers: new Set(), helperConsumers: new Map() };
  for (const snapshot of snapshots) {
    const pluginNames = new Map<string, string>();
    const manifests: [string, Record<string, unknown>][] = [];
    for (const [file, text] of Object.entries(snapshot)) {
      if (!/^plugins\/[^/]+\/manifest\.json$/.test(file)) continue;
      const manifest = JSON.parse(text);
      if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') throw new Error(`Invalid plugin manifest: ${file}`);
      if (pluginNames.has(manifest.name)) throw new Error(`Duplicate plugin name: ${manifest.name}`);
      pluginNames.set(manifest.name, moduleOf(file)); manifests.push([moduleOf(file), manifest]);
    }
    for (const [owner, manifest] of manifests) {
      const dependencies = manifest.dependencies;
      if (dependencies !== undefined && (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies))) throw new Error(`Invalid dependencies: ${owner}`);
      for (const name of Object.keys(dependencies ?? {})) {
        if (typeof (dependencies as Record<string, unknown>)[name] !== 'string') throw new Error(`Invalid dependency range ${name} in ${owner}`);
        const target = pluginNames.get(name);
        if (!target) throw new Error(`Unknown plugin dependency ${name} in ${owner}`);
        add(result.reversePlugins, target, owner);
      }
    }
    const paths = new Set(Object.keys(snapshot)), directories = new Set<string>();
    for (const path of paths) {
      let directory = posix.dirname(path);
      while (directory !== '.') { directories.add(directory); directory = posix.dirname(directory); }
    }
    for (const [file, text] of Object.entries(snapshot)) {
      if (!/\.[cm]?[jt]sx?$|\.svelte$/.test(file)) continue;
      const owner = moduleOf(file);
      for (const reference of references(file, text)) {
        if (reference.startsWith('@jeffusion/bungee-llms') && owner.startsWith('plugins/') && !file.includes('/tests/')) result.llmsConsumers.add(owner);
        if (!reference.startsWith('.')) continue;
        const raw = posix.normalize(posix.join(posix.dirname(file), reference));
        const candidates = [raw, ...['.ts','.tsx','.js','.jsx','.json','.svelte','/index.ts','/index.js'].map(s => raw + s), ...(raw.endsWith('.js') ? [raw.slice(0,-3)+'.ts'] : [])];
        const target = candidates.find(candidate => paths.has(candidate)) ?? (directories.has(raw) ? raw : undefined);
        if (!target) continue;
        const targetModule = moduleOf(target);
        if (targetModule === 'packages/llms' && owner.startsWith('plugins/') && !file.includes('/tests/')) result.llmsConsumers.add(owner);
        if (owner.startsWith('plugins/') && targetModule.startsWith('plugins/') && owner !== targetModule) add(result.reversePlugins, targetModule, owner);
        if (isHelper(target) && owner !== targetModule) add(result.helperConsumers, target, owner);
      }
    }
  }
  return result;
}
export function reverseClosure(roots: Iterable<string>, relations: Relations): Set<string> {
  const modules = new Set(roots);
  for (const module of modules) for (const consumer of relations.reversePlugins.get(module) ?? []) modules.add(consumer);
  return modules;
}
export function selectTests(input: {
  paths: readonly string[]; changed: readonly string[]; relations: Relations;
  base: string; testCommit: string; tree: string; head?: string; full?: boolean;
}): TestPlan {
  const all = discoverTests(input.paths);
  const selected: Record<Phase, Set<string>> = { unit: new Set(), integration: new Set(), browser: new Set() };
  const reasons = new Set<string>();
  let full = Boolean(input.full), active = full;
  if (full) reasons.add('explicit-full');
  const include = (module: string, layers: readonly Phase[]): boolean => {
    const entries = phases.flatMap(phase => all[phase].filter(file => moduleOf(file) === module));
    if (!entries.length) { full = true; reasons.add(`no-module-tests:${module}`); }
    for (const phase of layers) for (const file of all[phase]) if (moduleOf(file) === module) selected[phase].add(file);
    return entries.length > 0;
  };
  const ui = (): void => {
    include('packages/ui', ['integration']);
    for (const file of all.browser) if (moduleOf(file) === 'root' || moduleOf(file) === 'packages/ui' || moduleOf(file).startsWith('plugins/')) selected.browser.add(file);
  };
  const server = (modules: Iterable<string>): void => {
    for (const module of reverseClosure(modules, input.relations)) include(module, ['integration']);
    include('packages/core', ['integration']); include('root', ['integration', 'browser']);
  };
  for (const file of [...new Set(input.changed)].sort()) {
    if (isDocumentation(file)) { reasons.add(`documentation:${file}`); continue; }
    active = true;
    const module = moduleOf(file), phase = phaseOf(file);
    if (phase) {
      reasons.add(`test:${file}`);
      if (all[phase].includes(file)) selected[phase].add(file);
      else reasons.add(`deleted-test:${file}`);
      continue;
    }
    if (isHelper(file)) {
      reasons.add(`test-support:${file}`);
      if (module === 'root') full = true;
      else {
        include(module, phases);
        for (const [support, consumers] of input.relations.helperConsumers) {
          if (moduleOf(support) === module) for (const consumer of consumers) include(consumer, phases);
        }
      }
      continue;
    }
    if (/(?:^|\/)(?:package\.json|bun\.lockb?|[^/]*lock\.yaml|tsconfig[^/]*\.json|(?:vite|svelte|tailwind|postcss)\.config\.[^/]+|tailwind\.theme\.[^/]+)$/.test(file)) { full = true; reasons.add(`configuration:${file}`); continue; }
    if (module === 'packages/ui') { reasons.add(`ui:${file}`); ui(); continue; }
    if (module === 'packages/cli') { reasons.add(`cli:${file}`); include(module, ['integration']); server([]); continue; }
    if (module === 'packages/llms') { reasons.add(`llms:${file}`); include(module, ['integration']); server(input.relations.llmsConsumers); continue; }
    if (module.startsWith('plugins/')) {
      if (file === `${module}/manifest.json`) { reasons.add(`manifest:${file}`); server([module]); ui(); continue; }
      if (file.startsWith(`${module}/ui/`)) { reasons.add(`plugin-ui:${file}`); include(module, []); ui(); continue; }
      if (file.startsWith(`${module}/server/`) || file === `${module}/contract.ts`) { reasons.add(`plugin-server:${file}`); server([module]); continue; }
    }
    full = true; reasons.add(`fallback:${file}`);
  }
  if (active) for (const file of all.unit) selected.unit.add(file);
  return {
    version: 1, base: input.base, testCommit: input.testCommit, tree: input.tree,
    ...(input.head ? { head: input.head } : {}), mode: full ? 'full' : active ? 'affected' : 'none',
    reasons: [...reasons].sort(), build: active,
    files: Object.fromEntries(phases.map(phase => [phase, full ? all[phase] : [...selected[phase]].sort()])) as Record<Phase, string[]>,
  };
}
export function validatePlan(value: unknown, paths: readonly string[]): TestPlan {
  const plan = value as TestPlan;
  if (!plan || plan.version !== 1 || !['none','affected','full'].includes(plan.mode) || typeof plan.build !== 'boolean' ||
    !/^[a-f0-9]{40,64}$/.test(plan.base) || !/^[a-f0-9]{40,64}$/.test(plan.testCommit) || !/^[a-f0-9]{40,64}$/.test(plan.tree) ||
    !Array.isArray(plan.reasons) || !plan.reasons.every(reason => typeof reason === 'string') || !plan.files) throw new Error('Invalid test plan');
  const existing = new Set(paths), seen = new Set<string>();
  for (const phase of phases) {
    if (!Array.isArray(plan.files[phase])) throw new Error(`Missing plan phase: ${phase}`);
    for (const file of plan.files[phase]) {
      if (typeof file !== 'string' || file.startsWith('/') || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..') || /[\r\n\0]/.test(file) ||
        phaseOf(file) !== phase || !existing.has(file) || seen.has(file)) throw new Error(`Invalid plan test path: ${String(file)}`);
      seen.add(file);
    }
  }
  if (plan.mode === 'none' && (plan.build || seen.size)) throw new Error('Invalid empty test plan');
  if (plan.mode !== 'none' && !plan.build) throw new Error('Selected test plan requires build');
  const all = discoverTests(paths);
  for (const phase of phases) {
    if (plan.mode === 'full' || (phase === 'unit' && plan.mode !== 'none')) {
      if (JSON.stringify([...plan.files[phase]].sort()) !== JSON.stringify(all[phase])) throw new Error(`Incomplete ${phase} test plan`);
    }
  }
  return plan;
}
