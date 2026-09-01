#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { getAssetName } from '../packages/cli/src/binary/names';
import { buildExternalPlugins } from './build-external-plugins';

const ROOT = resolve(import.meta.dir, '..');
const BIN_DIR = join(ROOT, 'bin');
const MAIN_SOURCE = join(ROOT, 'packages/core/src/main.ts');
const BUILT_PLUGINS = join(ROOT, 'packages/core/dist/plugins');

const TARGETS = [
  { binaryName: 'bungee-linux', target: 'bun-linux-x64' },
  { binaryName: 'bungee-linux-arm64', target: 'bun-linux-arm64' },
  { binaryName: 'bungee-macos', target: 'bun-darwin-x64' },
  { binaryName: 'bungee-macos-arm64', target: 'bun-darwin-arm64' },
  { binaryName: 'bungee-windows.exe', target: 'bun-windows-x64' },
] as const;

export type BinaryArchiveOptions = {
  readonly binaryPath: string;
  readonly pluginsDirectory: string;
  readonly archivePath: string;
  readonly binaryName: string;
};

async function run(command: readonly string[], cwd?: string): Promise<void> {
  const process = Bun.spawn([...command], { cwd, stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
}

export async function createBinaryArchive(options: BinaryArchiveOptions): Promise<void> {
  if (basename(options.binaryPath) !== options.binaryName) {
    throw new Error('Binary path name does not match archive contract');
  }
  const staging = mkdtempSync(join(import.meta.dir, '.binary-archive-'));
  try {
    cpSync(options.binaryPath, join(staging, options.binaryName));
    cpSync(options.pluginsDirectory, join(staging, 'plugins'), { recursive: true });
    rmSync(options.archivePath, { force: true });
    await run(['tar', '-czf', options.archivePath, '-C', staging, options.binaryName, 'plugins']);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function buildBinaries(): Promise<void> {
  mkdirSync(BIN_DIR, { recursive: true });
  for (const target of TARGETS) rmSync(join(BIN_DIR, target.binaryName), { force: true });
  await buildExternalPlugins();
  if (!existsSync(BUILT_PLUGINS)) throw new Error('Built plugin directory is missing');
  for (const target of TARGETS) {
    const staging = mkdtempSync(join(BIN_DIR, '.binary-build-'));
    try {
      const binaryPath = join(staging, target.binaryName);
      console.log(`Building ${target.binaryName} (${target.target})...`);
      await run([
        process.execPath, 'build', '--compile', `--target=${target.target}`,
        MAIN_SOURCE, '--outfile', binaryPath,
      ], ROOT);
      await createBinaryArchive({
        binaryPath,
        pluginsDirectory: BUILT_PLUGINS,
        archivePath: join(BIN_DIR, getAssetName(target.binaryName)),
        binaryName: target.binaryName,
      });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  console.log(`Binary archives written to ${BIN_DIR}`);
}

if (import.meta.main) await buildBinaries();
