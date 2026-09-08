import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildPluginManifestCatalog,
  PluginManifestCatalog,
} from '../../src/plugin-manifest-catalog';
import type { PluginScanRoot } from '../../src/plugin-manifest-catalog';
import {
  BUILTINS,
  cleanupCatalogRoots,
  expectCatalogError,
  manifest,
  tempRoot,
  writePlugin,
} from './plugin-manifest-catalog-fixtures';

afterEach(() => {
  cleanupCatalogRoots();
});

describe('PluginManifestCatalog filesystem snapshot', () => {
  test('cannot be constructed outside the validated async build path', () => {
    expect(() => Reflect.construct(PluginManifestCatalog, [[]])).toThrow('private');
  });

  test('accepts every built-in and is deterministic across duplicate or reordered roots', async () => {
    const first: PluginManifestCatalog = await buildPluginManifestCatalog({ scanDirectories: [BUILTINS] });
    const second = await buildPluginManifestCatalog({ scanDirectories: [BUILTINS, BUILTINS] });
    const viaResolver = await buildPluginManifestCatalog({
      pathResolver: { getScanDirectories: () => [BUILTINS] },
    });

    expect(first.names()).toEqual([
      'ai-transformer',
      'anthropic-request-sanitizer',
      'anthropic-tool-name-transformer',
      'chatgpt-oauth',
      'deepseek-reasoning-fix',
      'model-mapping',
      'openai-messages-to-chat',
      'signature-repair',
      'token-stats',
    ]);
    expect(second.names()).toEqual(first.names());
    expect(second.hash).toBe(first.hash);
    expect(viaResolver.hash).toBe(first.hash);
    expect(first.schemaEntries()).toEqual(second.schemaEntries());

    const leftRoot = tempRoot();
    const rightRoot = tempRoot();
    writePlugin(leftRoot, 'left-plugin');
    writePlugin(rightRoot, 'right-plugin');
    const forward = await buildPluginManifestCatalog({ scanDirectories: [leftRoot, rightRoot] });
    const reversed = await buildPluginManifestCatalog({ scanDirectories: [rightRoot, leftRoot] });
    expect(reversed.names()).toEqual(forward.names());
    expect(reversed.hash).toBe(forward.hash);

    const aliasParent = tempRoot();
    const alias = join(aliasParent, 'same-root');
    symlinkSync(leftRoot, alias);
    const deduplicated = await buildPluginManifestCatalog({ scanDirectories: [leftRoot, alias] });
    expect(deduplicated.names()).toEqual(['left-plugin']);
  });

  test('hash ignores object key order and changes for schema semantics', async () => {
    const firstRoot = tempRoot();
    const secondRoot = tempRoot();
    const thirdRoot = tempRoot();
    const base = manifest('hash-plugin', {
      configSchema: [{ name: 'mode', type: 'select', label: 'Mode', default: 'a', options: [
        { label: 'A', value: 'a' }, { label: 'B', value: 'b' },
      ] }],
    });
    writePlugin(firstRoot, 'hash-plugin', base);
    writePlugin(secondRoot, 'hash-plugin', {
      configSchema: base.configSchema,
      engines: base.engines,
      uiExtensionMode: base.uiExtensionMode,
      capabilities: base.capabilities,
      main: base.main,
      artifactKind: base.artifactKind,
      schemaVersion: base.schemaVersion,
      version: base.version,
      name: base.name,
    });
    writePlugin(thirdRoot, 'hash-plugin', manifest('hash-plugin', {
      configSchema: [{ name: 'mode', type: 'select', label: 'Mode', default: 'b', options: [
        { label: 'A', value: 'a' }, { label: 'B', value: 'b' },
      ] }],
    }));

    const first = await buildPluginManifestCatalog({ scanDirectories: [firstRoot] });
    const second = await buildPluginManifestCatalog({ scanDirectories: [secondRoot] });
    const third = await buildPluginManifestCatalog({ scanDirectories: [thirdRoot] });
    expect(second.hash).toBe(first.hash);
    expect(third.hash).not.toBe(first.hash);

    const translatedRoot = tempRoot();
    writePlugin(translatedRoot, 'hash-plugin', { ...base, translations: { en: { title: 'Changed' } } });
    const translated = await buildPluginManifestCatalog({ scanDirectories: [translatedRoot] });
    expect(translated.hash).not.toBe(first.hash);
  });

  test('hashes the complete Bun dependency graph, not only the entry file', async () => {
    const firstRoot = tempRoot();
    const secondRoot = tempRoot();
    const code = 'import { value } from "./helper"; export default value;\n';
    const first = writePlugin(firstRoot, 'dependency-plugin', undefined, code);
    const second = writePlugin(secondRoot, 'dependency-plugin', undefined, code);
    writeFileSync(join(first, 'server/helper.ts'), 'export const value = 1;\n');
    writeFileSync(join(second, 'server/helper.ts'), 'export const value = 2;\n');
    const firstCatalog = await buildPluginManifestCatalog({ scanDirectories: [firstRoot] });
    const secondCatalog = await buildPluginManifestCatalog({ scanDirectories: [secondRoot] });
    expect(secondCatalog.hash).not.toBe(firstCatalog.hash);
  });

  test('keeps runtime identity independent of cwd for dependencies outside the plugin root', async () => {
    const root = tempRoot();
    const cwdA = tempRoot();
    const cwdB = tempRoot();
    writePlugin(root, 'cwd-plugin', undefined,
      'import { value } from "../../shared/helper"; export default value;\n');
    mkdirSync(join(root, 'shared'), { recursive: true });
    writeFileSync(join(root, 'shared/helper.ts'), 'export const value = 1;\n');
    const originalCwd = process.cwd();
    try {
      process.chdir(cwdA);
      const first = await buildPluginManifestCatalog({ scanDirectories: [root] });
      process.chdir(cwdB);
      const second = await buildPluginManifestCatalog({ scanDirectories: [root] });
      expect(second.hash).toBe(first.hash);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('keeps runtime identity when the plugin tree and its dependency move together', async () => {
    const firstRoot = tempRoot();
    const destinationParent = tempRoot();
    const secondRoot = join(destinationParent, 'moved-tree');
    const source = 'import { value } from "../../shared/helper"; export default value;\n';
    writePlugin(firstRoot, 'moved-plugin', undefined, source);
    mkdirSync(join(firstRoot, 'shared'), { recursive: true });
    writeFileSync(join(firstRoot, 'shared/helper.ts'), 'export const value = 1;\n');
    const first = await buildPluginManifestCatalog({ scanDirectories: [firstRoot] });
    renameSync(firstRoot, secondRoot);
    const second = await buildPluginManifestCatalog({ scanDirectories: [secondRoot] });
    expect(second.hash).toBe(first.hash);
  });

  test('rejects unresolved non-host external dependencies for runtime identity', async () => {
    const root = tempRoot();
    writePlugin(root, 'external-plugin', undefined,
      'import value from "https://example.com/not-bundled"; export default value;\n');
    await expectCatalogError([root], 'Failed to build external-plugin');
  });

  test('fails closed for duplicate names, mismatched directories, symlinks, and missing artifacts', async () => {
    const first = tempRoot();
    const second = tempRoot();
    writePlugin(first, 'same');
    writePlugin(second, 'same');
    await expectCatalogError([first, second], 'duplicate plugin name');

    const mismatch = tempRoot();
    writePlugin(mismatch, 'directory-name', manifest('manifest-name'));
    await expectCatalogError([mismatch], 'must match directory name');

    const linkedRoot = tempRoot();
    const outside = tempRoot();
    writePlugin(outside, 'linked-plugin');
    symlinkSync(join(outside, 'linked-plugin'), join(linkedRoot, 'linked-plugin'));
    await expectCatalogError([linkedRoot], 'symbolic link');

    const missing = tempRoot();
    const directory = writePlugin(missing, 'missing');
    rmSync(join(directory, 'server/index.ts'));
    await expectCatalogError([missing], 'regular file');

    const linkedMain = tempRoot();
    const linkedDirectory = writePlugin(linkedMain, 'linked-main');
    rmSync(join(linkedDirectory, 'server/index.ts'));
    symlinkSync(join(BUILTINS, 'ai-transformer/server/index.ts'), join(linkedDirectory, 'server/index.ts'));
    await expectCatalogError([linkedMain], 'regular file');
  });

  test('validates every executable and UI entry as a contained regular file', async () => {
    const root = tempRoot();
    const directory = writePlugin(root, 'native-entry', manifest('native-entry', {
      capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
      uiExtensionMode: 'native-static',
      ui: { components: [{ name: 'NativeWidget', entry: 'ui/NativeWidget.svelte' }] },
      contributes: { nativeWidgets: [{ id: 'native-widget', title: 'Widget', size: 'small', component: 'NativeWidget' }] },
    }));
    mkdirSync(join(directory, 'ui'));
    writeFileSync(join(directory, 'ui/NativeWidget.svelte'), '<div />');
    expect((await buildPluginManifestCatalog({ scanDirectories: [root] })).has('native-entry')).toBe(true);

    rmSync(join(directory, 'ui/NativeWidget.svelte'));
    symlinkSync(join(BUILTINS, 'token-stats/ui/TokenStatsChart.svelte'), join(directory, 'ui/NativeWidget.svelte'));
    await expectCatalogError([root], 'regular file');

    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest('native-entry', { main: 'server/index.txt' })));
    writeFileSync(join(directory, 'server/index.txt'), 'text');
    await expectCatalogError([root], 'extension');
  });

  test('fails closed for empty and missing roots while resolver roots declare optionality', async () => {
    const missing = join(tempRoot(), 'missing');
    await expectCatalogError([], 'required scan root');
    await expectCatalogError([missing], 'required scan root');

    const optional: PluginScanRoot = { path: missing, required: false };
    const required: PluginScanRoot = { path: BUILTINS, required: true };
    const catalog = await buildPluginManifestCatalog({
      pathResolver: { getScanRoots: () => [optional, required] },
    });
    expect(catalog.names()).toHaveLength(9);
  });

  test('resolves catalogPlugin references only after the complete catalog is built', async () => {
    const root = tempRoot();
    writePlugin(root, 'consumer', manifest('consumer', { configSchema: [{
      name: 'mapping', type: 'model_mapping', label: 'Mapping', catalogPlugin: 'missing-catalog',
    }] }));
    await expectCatalogError([root], 'unknown catalog plugin');

    writePlugin(root, 'missing-catalog');
    expect((await buildPluginManifestCatalog({ scanDirectories: [root] })).has('consumer')).toBe(true);
  });

  test('never imports plugin code or creates database/global side effects', async () => {
    const root = tempRoot();
    const sideEffect = join(root, 'imported.txt');
    writePlugin(root, 'side-effect-free', manifest('side-effect-free'),
      `await Bun.write(${JSON.stringify(sideEffect)}, 'imported');\n`);
    const beforeKeys = Reflect.ownKeys(globalThis);

    const catalog = await buildPluginManifestCatalog({ scanDirectories: [root] });

    expect(catalog.has('side-effect-free')).toBe(true);
    expect(existsSync(sideEffect)).toBe(false);
    expect(existsSync(join(root, 'access.db'))).toBe(false);
    expect(existsSync(join(root, 'config.db'))).toBe(false);
    expect(Reflect.ownKeys(globalThis)).toEqual(beforeKeys);
  });

  test('returned structures cannot mutate lookup, schemas, or hash', async () => {
    const root = tempRoot();
    writePlugin(root, 'frozen', manifest('frozen', {
      configSchema: [{ name: 'enabled', type: 'boolean', label: 'Enabled', default: true }],
    }));
    const catalog = await buildPluginManifestCatalog({ scanDirectories: [root] });
    const hash = catalog.hash;
    const entry = catalog.get('frozen');
    const schemas = catalog.schemaEntries();
    const compileOptions = catalog.toCompileOptions();

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry?.manifest.configSchema)).toBe(true);
    expect(() => Object.assign(entry?.manifest ?? {}, { name: 'changed' })).toThrow();
    const clear = Reflect.get(schemas, 'clear');
    if (typeof clear === 'function') Reflect.apply(clear, schemas, []);
    const availableClear = Reflect.get(compileOptions.availablePlugins ?? {}, 'clear');
    if (typeof availableClear === 'function') Reflect.apply(availableClear, compileOptions.availablePlugins, []);
    const schemaClear = Reflect.get(compileOptions.pluginSchemas, 'clear');
    if (typeof schemaClear === 'function') Reflect.apply(schemaClear, compileOptions.pluginSchemas, []);
    expect(catalog.has('frozen')).toBe(true);
    expect(catalog.get('frozen')?.manifest.name).toBe('frozen');
    expect(catalog.hash).toBe(hash);
  });

  test('fails on malformed JSON and unreadable or unknown manifest fields', async () => {
    const root = tempRoot();
    const directory = writePlugin(root, 'malformed');
    writeFileSync(join(directory, 'manifest.json'), '{broken');
    await expectCatalogError([root], 'invalid JSON');

    rmSync(join(directory, 'manifest.json'));
    mkdirSync(join(directory, 'manifest.json'));
    await expectCatalogError([root], 'regular file');
    rmSync(join(directory, 'manifest.json'), { recursive: true });

    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest('malformed', { mystery: true })));
    await expectCatalogError([root], 'unknown field');

    writeFileSync(join(directory, 'manifest.json'), readFileSync(join(BUILTINS, 'deepseek-reasoning-fix/manifest.json')));
    await expectCatalogError([root], 'must match directory name');

    const invalidEncoding = tempRoot();
    const invalidDirectory = writePlugin(invalidEncoding, 'invalid-encoding');
    const encoded = Buffer.from(JSON.stringify(manifest('invalid-encoding', { description: 'xx' })));
    encoded[encoded.indexOf('xx')] = 0xff;
    writeFileSync(join(invalidDirectory, 'manifest.json'), encoded);
    await expectCatalogError([invalidEncoding], 'UTF-8');
  });
});
