import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { buildPluginManifestCatalog } from '../packages/core/src/plugin-manifest-catalog';
import { buildExternalPlugins } from './build-external-plugins';

interface ReplacementOperations {
  readonly exists: (path: string) => boolean;
  readonly rename: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
}

const roots: string[] = [];

function fixture(): Readonly<{ root: string; source: string; output: string; oldMarker: string }> {
  const root = mkdtempSync(join(tmpdir(), 'bungee-plugin-recovery-'));
  roots.push(root);
  const source = join(root, 'source');
  const plugin = join(source, 'new-plugin');
  mkdirSync(join(plugin, 'server'), { recursive: true });
  writeFileSync(join(plugin, 'server/index.ts'), 'export default {};');
  writeFileSync(join(plugin, 'manifest.json'), JSON.stringify({
    name: 'new-plugin', version: '1.0.0', schemaVersion: 2,
    artifactKind: 'runtime-plugin', main: 'server/index.ts',
    capabilities: ['hooks', 'dynamicRuntimeLoad'], uiExtensionMode: 'none',
    engines: { bungee: '^4.2.0' }, configSchema: [],
  }));
  const output = join(root, 'dist/plugins');
  mkdirSync(output, { recursive: true });
  const oldMarker = join(output, 'old-marker');
  writeFileSync(oldMarker, 'old-output');
  return { root, source, output, oldMarker };
}

function temporaryDirectories(output: string, kind: 'backup' | 'staging'): string[] {
  const prefix = `${basename(output)}.${kind}-`;
  return readdirSync(dirname(output))
    .filter((name) => name.startsWith(prefix))
    .map((name) => join(dirname(output), name));
}

async function captureFailure(options: Readonly<{
  sourceDirectory: string;
  outputDirectory: string;
  replacementOperations: ReplacementOperations;
}>): Promise<Error | undefined> {
  try { await buildExternalPlugins(options); } catch (error) {
    if (error instanceof Error) return error;
  }
  return undefined;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('external plugin output recovery', () => {
  test('preserves verified new output and residual backup when backup cleanup fails', async () => {
    const context = fixture();
    const operations: ReplacementOperations = {
      exists: existsSync,
      rename: renameSync,
      remove: (target) => {
        if (target.includes('.backup-')) throw new Error('injected backup cleanup failure');
        rmSync(target, { recursive: true, force: true });
      },
    };

    const error = await captureFailure({
      sourceDirectory: context.source, outputDirectory: context.output, replacementOperations: operations,
    });
    const backups = temporaryDirectories(context.output, 'backup');
    expect(error?.message).toContain('recovery backup');
    expect(backups).toHaveLength(1);
    expect((await buildPluginManifestCatalog({ scanDirectories: [context.output] })).names()).toEqual(['new-plugin']);
    expect(temporaryDirectories(context.output, 'staging')).toEqual([]);
    if (backups[0]) {
      expect(error?.message).toContain(backups[0]);
      expect(readFileSync(join(backups[0], 'old-marker'), 'utf8')).toBe('old-output');
    }
  });

  test('preserves concurrent output and backup when staging install cannot restore', async () => {
    const context = fixture();
    const renameSources: string[] = [];
    const operations: ReplacementOperations = {
      exists: existsSync,
      rename: (source, destination) => {
        renameSources.push(source);
        if (source.includes('.staging-') && destination === context.output) {
          mkdirSync(context.output);
          writeFileSync(join(context.output, 'concurrent-marker'), 'concurrent-output');
          throw new Error('injected staging install failure');
        }
        renameSync(source, destination);
      },
      remove: (target) => rmSync(target, { recursive: true, force: true }),
    };

    const error = await captureFailure({
      sourceDirectory: context.source, outputDirectory: context.output, replacementOperations: operations,
    });
    const backups = temporaryDirectories(context.output, 'backup');
    expect(error?.message).toContain('recovery backup');
    expect(readFileSync(join(context.output, 'concurrent-marker'), 'utf8')).toBe('concurrent-output');
    expect(backups).toHaveLength(1);
    expect(renameSources.filter((source) => source.includes('.backup-'))).toEqual([]);
    expect(temporaryDirectories(context.output, 'staging')).toEqual([]);
    if (backups[0]) {
      expect(error?.message).toContain(backups[0]);
      expect(readFileSync(join(backups[0], 'old-marker'), 'utf8')).toBe('old-output');
    }
  });

  test('preserves backup when restoration is attempted on a free path and fails', async () => {
    const context = fixture();
    const operations: ReplacementOperations = {
      exists: existsSync,
      rename: (source, destination) => {
        if (source.includes('.staging-')) throw new Error('injected staging install failure');
        if (source.includes('.backup-')) throw new Error('injected restore failure');
        renameSync(source, destination);
      },
      remove: (target) => rmSync(target, { recursive: true, force: true }),
    };

    const error = await captureFailure({
      sourceDirectory: context.source, outputDirectory: context.output, replacementOperations: operations,
    });
    const backups = temporaryDirectories(context.output, 'backup');
    expect(error?.message).toContain('restoration failed');
    expect(existsSync(context.output)).toBe(false);
    expect(backups).toHaveLength(1);
    expect(temporaryDirectories(context.output, 'staging')).toEqual([]);
    if (backups[0]) {
      expect(error?.message).toContain(backups[0]);
      expect(readFileSync(join(backups[0], 'old-marker'), 'utf8')).toBe('old-output');
    }
  });
});
