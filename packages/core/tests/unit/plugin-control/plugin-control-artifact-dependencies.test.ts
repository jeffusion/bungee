import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadImmutableControlArtifact } from '../../../src/plugin-control/artifact-loader';
import { PluginManifestCatalog } from '../../../src/plugin-manifest-catalog/catalog';
import { externalRuntimeDependencyIdentity, hashRuntimeIdentity } from '../../../src/plugin-manifest-catalog/runtime-identity';
import { BUILTINS, cleanupCatalogRoots, manifest, tempRoot, writePlugin } from '../../helpers/plugin-manifest-catalog';
import { installPluginLogSink, type PluginLogSink } from '../../../src/plugin-logger';

async function controlRecord(source: string) {
  const root = tempRoot();
  const directory = writePlugin(root, 'control-fixture', manifest('control-fixture', {
    capabilities: ['hooks', 'dynamicRuntimeLoad', 'controlPlane'], control: { entry: 'server/control.ts', rpc: [] },
  }), 'export default class Plugin {}');
  writeFileSync(join(directory, 'server/control.ts'), source);
  writeFileSync(join(directory, 'server/dependency.ts'), 'export const value=42;');
  const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
  return { record: catalog.get('control-fixture')!, directory };
}

afterEach(cleanupCatalogRoots);

test('external dependency identity locks both original and Bun resolved names', () => {
  const identity = (original: string, path: string) => hashRuntimeIdentity('/plugin', [], [externalRuntimeDependencyIdentity({ original, path })]);
  const original = './internal/streams/stream';
  expect(externalRuntimeDependencyIdentity({ original, path: 'stream' })).toBe(JSON.stringify([original, 'stream']));
  expect(identity(original, 'stream')).not.toBe(identity('./changed', 'stream'));
  expect(identity(original, 'stream')).not.toBe(identity(original, 'node:stream'));
});

test('a captured builtin control import loads with the same catalog identity', async () => {
  const root = tempRoot();
  const directory = writePlugin(root, 'builtin-control', manifest('builtin-control', {
    capabilities: ['hooks', 'dynamicRuntimeLoad', 'controlPlane'], control: { entry: 'server/control.ts', rpc: [] },
  }), 'export default class Plugin {}');
  writeFileSync(join(directory, 'server/control.ts'), 'import { basename } from "node:path"; export function createControl(){return { basename };}');
  const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
  expect(typeof (await loadImmutableControlArtifact(catalog.get('builtin-control')!)).createControl).toBe('function');
});

test('an unlocked runtime load remains rejected by the control artifact', async () => {
  const root = tempRoot();
  const directory = writePlugin(root, 'unlocked-control', manifest('unlocked-control', {
    capabilities: ['hooks', 'dynamicRuntimeLoad', 'controlPlane'], control: { entry: 'server/control.ts', rpc: [] },
  }), 'export default class Plugin {}');
  writeFileSync(join(directory, 'server/control.ts'), 'export function createControl(){const path=globalThis.location?.href;return import(path);}');
  const catalog = await PluginManifestCatalog.build({ scanDirectories: [root] });
  // Bun wraps the onLoad policy error in its own aggregate build error.
  await expect(loadImmutableControlArtifact(catalog.get('unlocked-control')!)).rejects.toThrow();
});

for (const [name, declaration, call] of [
  ['Bun generated alias', 'var load = import.meta.require;', 'load("os")'],
  ['transitive alias', 'const first = import.meta.require; const load = first;', 'load(`node:os`)'],
  ['assigned alias', 'let load; load = import.meta.require;', 'load("os")'],
  ['property', '', 'import.meta.require("os")'],
  ['element property', '', 'import.meta["require"]("os")'],
  ['parenthesized alias', 'const load = (import.meta.require);', '(load)("os")'],
  ['typed alias', 'const load = import.meta.require as Function;', 'load("os")'],
  ['destructured alias', 'const {require:load} = import.meta;', 'load("os")'],
] as const) {
  test(`static builtin ${name} loads from the captured artifact`, async () => {
    const { record } = await controlRecord(`${declaration} export function createControl(){return {platform:${call}.platform()};}`);
    const control = await loadImmutableControlArtifact(record);
    expect((control.createControl as Function)().platform).toBe(process.platform);
  });
}

for (const [name, expression] of [
  ['direct dynamic require', 'require(globalThis.moduleName)'],
  ['dynamic import', 'import(globalThis.moduleName)'],
  ['dynamic alias', 'const load=import.meta.require; load(globalThis.moduleName)'],
  ['assigned dynamic alias', 'let load; load=import.meta.require; load("./locale/"+globalThis.locale)'],
  ['transitive assigned alias', 'let first; first=import.meta.require; const load=first; load(globalThis.moduleName)'],
  ['relative alias', 'const load=import.meta.require; load("./dependency.ts")'],
  ['package alias', 'const load=import.meta.require; load("unlocked-package")'],
  ['dynamic property', 'import.meta.require(globalThis.moduleName)'],
  ['dynamic element property', 'import.meta["require"](globalThis.moduleName)'],
  ['relative property', 'import.meta.require("./dependency.ts")'],
  ['typed dynamic alias', 'const load=import.meta.require as Function; load(globalThis.moduleName)'],
  ['destructured dynamic alias', 'const {require:load}=import.meta; load(globalThis.moduleName)'],
  ['bound dynamic alias', 'const load=import.meta.require.bind(import.meta); load(globalThis.moduleName)'],
  ['indirect dynamic call', 'import.meta.require.call(import.meta,globalThis.moduleName)'],
  ['bracket static call', 'import.meta.require["call"](import.meta,"./dependency.ts")'],
  ['bracket static apply', 'import.meta.require["apply"](import.meta,["./dependency.ts"])'],
  ['bracket bound alias', 'const load=import.meta.require["bind"](import.meta); load("./dependency.ts")'],
  ['bracket wrapped alias', 'const load=import.meta.require as Function; (load!)["call"](import.meta,globalThis.moduleName)'],
  ['computed indirect call', 'import.meta.require["ca"+"ll"](import.meta,"./dependency.ts")'],
] as const) {
  test(`rejects ${name} before evaluating control module code`, async () => {
    const { record, directory } = await controlRecord(`export function createControl(){ ${expression}; return {}; }`);
    writeFileSync(join(directory, 'server/dependency.ts'), 'export default {};');
    await expect(loadImmutableControlArtifact(record)).rejects.toThrow();
  });
}

test('a captured direct relative require stays locked against dependency changes', async () => {
  const { directory } = await controlRecord('const value=require("./dependency.ts"); export function createControl(){return value;}');
  writeFileSync(join(directory, 'server/dependency.ts'), 'export const value=42;');
  const catalog = await PluginManifestCatalog.build({ scanDirectories: [join(directory, '..')] });
  const record = catalog.get('control-fixture')!;
  expect(typeof (await loadImmutableControlArtifact(record)).createControl).toBe('function');
  writeFileSync(join(directory, 'server/dependency.ts'), 'export const value=43;');
  await expect(loadImmutableControlArtifact(record)).rejects.toThrow('does not match the catalog runtime identity');
});

test('plugin artifacts keep the shared host log sink', async () => {
  const { record } = await controlRecord(`import {logger} from ${JSON.stringify(join(import.meta.dir, '../../../src/logger.ts'))}; export function createControl(){logger.info('artifact-log-marker'); return {};}`);
  const observed: unknown[] = [];
  const log = (...args: unknown[]) => { observed.push(args); };
  const sink: PluginLogSink = { info: log, warn: log, error: log, debug: log, fatal: log, child: () => sink };
  const key = Symbol.for('@jeffusion/bungee/plugin-log-sink');
  const previous = (globalThis as Record<symbol, unknown>)[key];
  try {
    installPluginLogSink(sink);
    const control = await loadImmutableControlArtifact(record);
    (control.createControl as Function)();
    expect(observed).toEqual([[{}, 'artifact-log-marker']]);
  } finally {
    if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[key];
    else (globalThis as Record<symbol, unknown>)[key] = previous;
  }
});

test('repository control artifacts load through the built public package SDK', async () => {
  const catalog = await PluginManifestCatalog.build({ scanDirectories: [BUILTINS] });
  const controls = catalog.records().filter(record => record.controlPath !== undefined);
  expect(controls.length).toBeGreaterThan(0);
  for (const record of controls) expect(typeof (await loadImmutableControlArtifact(record)).createControl).toBe('function');
});
