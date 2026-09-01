#!/usr/bin/env bun

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPluginManifestCatalog } from '../packages/core/src/plugin-manifest-catalog/catalog';
import type { PluginManifestRecord, StrictPluginManifest } from '../packages/core/src/plugin-manifest-catalog/types';

const ROOT_DIR = path.resolve(import.meta.dir, '..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'plugins');
const OUTPUT_DIR = path.join(ROOT_DIR, 'packages/core/dist/plugins');

export interface ExternalPluginBuildOptions {
  readonly sourceDirectory?: string;
  readonly outputDirectory?: string;
  readonly replacementOperations?: ReplacementOperations;
}

export interface ReplacementOperations {
  readonly exists: (path: string) => boolean;
  readonly rename: (source: string, destination: string) => void;
  readonly remove: (path: string) => void;
}

const REPLACEMENT_OPERATIONS: ReplacementOperations = {
  exists: fs.existsSync,
  rename: fs.renameSync,
  remove: (target) => fs.rmSync(target, { recursive: true, force: true }),
};

export function rewriteManifestForBuiltArtifact(manifest: StrictPluginManifest): StrictPluginManifest {
  return { ...manifest, main: 'index.js' };
}

function copyPluginUi(record: PluginManifestRecord, outputPath: string): void {
  const uiSource = path.join(record.pluginPath, 'ui');
  if (fs.existsSync(uiSource)) fs.cpSync(uiSource, path.join(outputPath, 'ui'), { recursive: true });
  for (const component of record.manifest.ui?.components ?? []) {
    const destination = path.join(outputPath, component.entry);
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(record.pluginPath, component.entry), destination);
  }
}

async function buildPlugin(record: PluginManifestRecord, stagingDirectory: string): Promise<void> {
  const outputPath = path.join(stagingDirectory, record.name);
  fs.mkdirSync(outputPath, { recursive: true });
  console.log(`  Building ${record.name}...`);
  try {
    const result = await Bun.build({
      entrypoints: [record.mainPath], outdir: outputPath, target: 'bun', format: 'esm',
      naming: 'index.js', minify: false, sourcemap: 'external',
    });
    if (!result.success) throw new Error(result.logs.join('\n'));
  } catch (error) {
    throw new Error(`Failed to build ${record.name}`, { cause: error });
  }
  copyPluginUi(record, outputPath);
  const manifestPath = path.join(outputPath, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(rewriteManifestForBuiltArtifact(record.manifest), null, 2)}\n`);
  fs.chmodSync(manifestPath, 0o644);
}

function recoveryError(message: string, backupDirectory: string, cause: unknown): Error {
  return new Error(`${message}; recovery backup preserved at ${backupDirectory}`, { cause });
}

interface ReplacementPaths {
  readonly staging: string;
  readonly output: string;
  readonly backup: string;
}

function replaceOutput(
  paths: ReplacementPaths,
  operations: ReplacementOperations,
): void {
  const hadOutput = operations.exists(paths.output);
  if (hadOutput) operations.rename(paths.output, paths.backup);
  try {
    operations.rename(paths.staging, paths.output);
  } catch (installError) {
    if (!hadOutput) throw installError;
    if (operations.exists(paths.output)) {
      throw recoveryError('Staging install failed while output path was occupied', paths.backup, installError);
    }
    try {
      operations.rename(paths.backup, paths.output);
    } catch (restoreError) {
      throw recoveryError('Staging install and previous output restoration failed', paths.backup, restoreError);
    }
    throw installError;
  }
  if (hadOutput) {
    try {
      operations.remove(paths.backup);
    } catch (cleanupError) {
      throw recoveryError('New output installed but backup cleanup failed', paths.backup, cleanupError);
    }
  }
}

export async function buildExternalPlugins(options: ExternalPluginBuildOptions = {}): Promise<void> {
  const sourceDirectory = path.resolve(options.sourceDirectory ?? PLUGINS_DIR);
  const outputDirectory = path.resolve(options.outputDirectory ?? OUTPUT_DIR);
  const replacementOperations = options.replacementOperations ?? REPLACEMENT_OPERATIONS;
  console.log('Building external plugins...');
  console.log(`  Source: ${sourceDirectory}`);
  console.log(`  Output: ${outputDirectory}`);

  const sourceCatalog = await buildPluginManifestCatalog({ scanDirectories: [sourceDirectory] });
  const outputParent = path.dirname(outputDirectory);
  fs.mkdirSync(outputParent, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(outputParent, `${path.basename(outputDirectory)}.staging-`));
  const backupDirectory = path.join(outputParent, `${path.basename(outputDirectory)}.backup-${randomUUID()}`);
  try {
    for (const record of sourceCatalog.records()) await buildPlugin(record, stagingDirectory);
    await buildPluginManifestCatalog({ scanDirectories: [stagingDirectory] });
    replaceOutput({ staging: stagingDirectory, output: outputDirectory, backup: backupDirectory }, replacementOperations);
  } finally {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
  console.log('External plugins build complete.');
}

if (import.meta.main) {
  buildExternalPlugins().catch((error: unknown) => {
    console.error('Build failed:', error);
    process.exit(1);
  });
}
