import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';

export type BinaryArchiveInstall = {
  readonly archivePath: string;
  readonly installRoot: string;
  readonly version: string;
  readonly binaryName: string;
};

function runTar(args: readonly string[]): string {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Invalid binary archive: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function validateListing(listing: string, binaryName: string): void {
  const entries = listing.split('\n').filter(Boolean).map((entry) => entry.replace(/^\.\//, ''));
  if (!entries.includes(binaryName)) throw new Error(`Binary archive is missing ${binaryName}`);
  if (!entries.some((entry) => entry.startsWith('plugins/'))) {
    throw new Error('Binary archive is missing plugins/');
  }
  for (const entry of entries) {
    const segments = entry.split('/');
    if (entry.startsWith('/') || entry.includes('\\') || segments.includes('..')) {
      throw new Error(`Unsafe binary archive entry: ${entry}`);
    }
    const root = segments[0];
    if (root !== binaryName && root !== 'plugins') {
      throw new Error(`Unexpected binary archive entry: ${entry}`);
    }
  }
}

function validateExtractedTree(directory: string, binaryName: string): void {
  const executable = join(directory, binaryName);
  const plugins = join(directory, 'plugins');
  if (!lstatSync(executable).isFile() || !lstatSync(plugins).isDirectory()) {
    throw new Error('Binary archive has an invalid root layout');
  }
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Binary archive contains a symlink: ${entry.name}`);
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(directory);
  for (const plugin of readdirSync(plugins, { withFileTypes: true })) {
    if (!plugin.isDirectory()) throw new Error(`Invalid plugin artifact: ${plugin.name}`);
    const pluginDirectory = join(plugins, plugin.name);
    if (!existsSync(join(pluginDirectory, 'manifest.json')) || !existsSync(join(pluginDirectory, 'index.js'))) {
      throw new Error(`Incomplete plugin artifact: ${plugin.name}`);
    }
  }
}

export function installBinaryArchive(options: BinaryArchiveInstall): string {
  if (basename(options.binaryName) !== options.binaryName || !/^[0-9A-Za-z._-]+$/.test(options.version)) {
    throw new Error('Invalid binary install identity');
  }
  mkdirSync(options.installRoot, { recursive: true });
  const target = join(options.installRoot, options.version);
  const staging = mkdtempSync(join(options.installRoot, `${options.version}.staging-`));
  const backup = `${target}.backup-${randomUUID()}`;
  let backedUp = false;
  try {
    validateListing(runTar(['-tzf', options.archivePath]), options.binaryName);
    runTar(['-xzf', options.archivePath, '-C', staging]);
    validateExtractedTree(staging, options.binaryName);
    chmodSync(join(staging, options.binaryName), 0o755);
    if (existsSync(target)) {
      renameSync(target, backup);
      backedUp = true;
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      if (backedUp) renameSync(backup, target);
      throw error;
    }
    if (backedUp) rmSync(backup, { recursive: true, force: true });
    return join(target, options.binaryName);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
