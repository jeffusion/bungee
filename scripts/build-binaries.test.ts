import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinaryArchive } from './build-binaries';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createBinaryArchive', () => {
  test('packages only the executable and built plugin artifacts', async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'bungee-binary-archive-'));
    roots.push(root);
    const binaryName = 'bungee-linux';
    const binaryPath = join(root, binaryName);
    const pluginsDirectory = join(root, 'built-plugins');
    const pluginDirectory = join(pluginsDirectory, 'example');
    const archivePath = join(root, `${binaryName}.tar.gz`);
    mkdirSync(pluginDirectory, { recursive: true });
    writeFileSync(binaryPath, '#!/bin/sh\nexit 0\n');
    chmodSync(binaryPath, 0o755);
    writeFileSync(join(pluginDirectory, 'index.js'), 'export default {};');
    writeFileSync(join(pluginDirectory, 'manifest.json'), '{"name":"example"}');

    // When
    await createBinaryArchive({ binaryPath, pluginsDirectory, archivePath, binaryName });

    // Then
    const listing = Bun.spawnSync(['tar', '-tzf', archivePath]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.toString().trim().split('\n').sort()).toEqual([
      binaryName,
      'plugins/',
      'plugins/example/',
      'plugins/example/index.js',
      'plugins/example/manifest.json',
    ]);
  });
});
