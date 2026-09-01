import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  buildPluginManifestCatalog,
  parsePluginManifestText,
} from '../packages/core/src/plugin-manifest-catalog';
import { rewriteManifestForBuiltArtifact } from './build-external-plugins';
import * as builder from './build-external-plugins';

const ROOT = resolve(import.meta.dir, '..');
const SOURCE = join(ROOT, 'plugins');
const OUTPUT = join(ROOT, 'packages/core/dist/plugins');
const BUILTINS = [
  'ai-transformer', 'anthropic-request-sanitizer', 'anthropic-tool-name-transformer',
  'deepseek-reasoning-fix', 'model-mapping', 'openai-messages-to-chat',
  'signature-repair', 'token-stats',
] as const;
const roots: string[] = [];

interface BuildOptions {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
}

function isBuildFunction(value: unknown): value is (options: BuildOptions) => Promise<void> {
  return typeof value === 'function';
}

function buildExternalPlugins(options: BuildOptions): Promise<void> {
  const candidate: unknown = Reflect.get(builder, 'buildExternalPlugins');
  if (!isBuildFunction(candidate)) throw new Error('buildExternalPlugins export unavailable');
  return candidate(options);
}

function workspace(): Readonly<{ root: string; source: string; output: string }> {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-build-'));
  roots.push(root);
  const source = join(root, 'source');
  const output = join(root, 'dist/plugins');
  mkdirSync(source, { recursive: true });
  return { root, source, output };
}

function strictManifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, version: '1.0.0', schemaVersion: 2, artifactKind: 'runtime-plugin',
    main: 'server/index.ts', capabilities: ['hooks', 'dynamicRuntimeLoad'],
    uiExtensionMode: 'none', engines: { bungee: '^4.2.0' }, configSchema: [], ...overrides,
  };
}

function writePlugin(
  source: string,
  name: string,
  options: Readonly<{ code?: string; manifest?: Record<string, unknown>; ui?: boolean }> = {},
): string {
  const directory = join(source, name);
  mkdirSync(join(directory, 'server'), { recursive: true });
  writeFileSync(join(directory, 'server/index.ts'), options.code ?? 'export default {};');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(options.manifest ?? strictManifest(name)));
  if (options.ui) {
    mkdirSync(join(directory, 'ui'));
    writeFileSync(join(directory, 'ui/widget.svelte'), '<div />');
  }
  return directory;
}

function oldOutput(output: string): string {
  mkdirSync(output, { recursive: true });
  const marker = join(output, 'previous-output');
  writeFileSync(marker, 'preserve');
  return marker;
}

async function expectFailure(options: BuildOptions): Promise<Error> {
  let error: unknown;
  try { await buildExternalPlugins(options); } catch (caught) { error = caught; }
  if (!(error instanceof Error)) throw new Error('expected external plugin build to fail');
  return error;
}

function expectNoTemporaryOutput(output: string): void {
  const prefix = `${basename(output)}.`;
  expect(readdirSync(dirname(output)).filter((name) => name.startsWith(prefix))).toEqual([]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('rewriteManifestForBuiltArtifact', () => {
  test('rewrites built plugin manifest main entry to bundled artifact', () => {
    const rewritten = rewriteManifestForBuiltArtifact({
      name: 'ai-transformer',
      version: '2.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'server/index.ts',
      capabilities: ['hooks', 'api', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'none',
  engines: { bungee: '^4.2.0' },
      metadata: {
        name: 'metadata.name',
        description: 'plugin.description',
      },
      translations: {
        en: { 'metadata.name': 'AI Transformer' },
        'zh-CN': { 'metadata.name': 'AI 格式转换器' },
      },
      configSchema: [],
    });

    expect(rewritten.main).toBe('index.js');
    expect(rewritten.schemaVersion).toBe(2);
    expect(rewritten.capabilities).toEqual(['hooks', 'api', 'dynamicRuntimeLoad']);
    expect(rewritten.metadata?.name).toBe('metadata.name');
    expect(rewritten.translations?.['zh-CN']?.['metadata.name']).toBe('AI 格式转换器');
  });

  test('emits complete strict manifests that the production catalog can scan', async () => {
    const build = Bun.spawn({
      cmd: ['bun', 'scripts/build-external-plugins.ts'], cwd: ROOT,
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await build.exited).toBe(0);

    const catalog = await buildPluginManifestCatalog({ scanDirectories: [OUTPUT] });
    expect(catalog.names()).toEqual(BUILTINS);
    for (const name of BUILTINS) {
      const source = parsePluginManifestText(await Bun.file(join(SOURCE, name, 'manifest.json')).text());
      const built = catalog.get(name);
      expect(built?.manifest).toEqual({ ...source, main: 'index.js' });
      expect(built?.mainPath).toBe(await realpath(join(OUTPUT, name, 'index.js')));
      expect((await stat(join(OUTPUT, name, 'index.js'))).isFile()).toBe(true);
    }
  }, 120_000);

  test('rejects missing and empty source roots without changing old output', async () => {
    for (const sourceKind of ['missing', 'empty']) {
      const fixture = workspace();
      const source = sourceKind === 'missing' ? join(fixture.root, 'missing') : fixture.source;
      const marker = oldOutput(fixture.output);
      await expectFailure({ sourceDirectory: source, outputDirectory: fixture.output });
      expect(readFileSync(marker, 'utf8')).toBe('preserve');
      expectNoTemporaryOutput(fixture.output);
    }
  });

  test('preflights malformed first and later manifests before output mutation', async () => {
    for (const badName of ['a-bad', 'z-bad']) {
      const fixture = workspace();
      writePlugin(fixture.source, 'middle', { code: 'export const = ;' });
      writePlugin(fixture.source, badName, { manifest: { name: badName } });
      const marker = oldOutput(fixture.output);
      const error = await expectFailure({ sourceDirectory: fixture.source, outputDirectory: fixture.output });
      expect(error.message).toContain('schemaVersion');
      expect(readFileSync(marker, 'utf8')).toBe('preserve');
      expectNoTemporaryOutput(fixture.output);
    }
  });

  test('preflights source main and UI symlinks before output mutation', async () => {
    for (const entry of ['main', 'ui']) {
      const fixture = workspace();
      const external = join(fixture.root, `${entry}.ts`);
      writeFileSync(external, 'export default {};');
      const overrides = entry === 'ui' ? {
        capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
        uiExtensionMode: 'native-static', ui: { components: [{ name: 'Widget', entry: 'ui/widget.svelte' }] },
      } : {};
      const directory = writePlugin(fixture.source, 'symlink-plugin', {
        manifest: strictManifest('symlink-plugin', overrides), ui: entry === 'ui',
      });
      const target = entry === 'main' ? join(directory, 'server/index.ts') : join(directory, 'ui/widget.svelte');
      rmSync(target);
      symlinkSync(external, target);
      const marker = oldOutput(fixture.output);
      const error = await expectFailure({ sourceDirectory: fixture.source, outputDirectory: fixture.output });
      expect(error.message).toContain('symlink');
      expect(readFileSync(marker, 'utf8')).toBe('preserve');
      expectNoTemporaryOutput(fixture.output);
    }
  });

  test('preserves old output and cleans staging when a plugin build fails', async () => {
    const fixture = workspace();
    writePlugin(fixture.source, 'first-plugin');
    writePlugin(fixture.source, 'second-plugin', { code: 'export const = ;' });
    const marker = oldOutput(fixture.output);
    const error = await expectFailure({ sourceDirectory: fixture.source, outputDirectory: fixture.output });
    expect(error.message).toContain('Failed to build second-plugin');
    expect(readFileSync(marker, 'utf8')).toBe('preserve');
    expectNoTemporaryOutput(fixture.output);
  });

  test('replaces old output only after a complete staging catalog validates', async () => {
    const fixture = workspace();
    writePlugin(fixture.source, 'first-plugin');
    writePlugin(fixture.source, 'second-plugin');
    const marker = oldOutput(fixture.output);
    mkdirSync(join(fixture.output, 'stale-plugin'));
    await buildExternalPlugins({ sourceDirectory: fixture.source, outputDirectory: fixture.output });
    expect(existsSync(marker)).toBe(false);
    expect((await buildPluginManifestCatalog({ scanDirectories: [fixture.output] })).names())
      .toEqual(['first-plugin', 'second-plugin']);
    expectNoTemporaryOutput(fixture.output);
  });
});
