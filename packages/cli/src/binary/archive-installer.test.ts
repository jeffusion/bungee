import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBinaryArchive } from './archive-installer';

const roots: string[] = [];

function archive(root: string, binaryName: string, binaryBody = '#!/bin/sh\nexit 0\n'): string {
  const content = join(root, 'content');
  const plugin = join(content, 'plugins', 'example');
  const archivePath = join(root, `${binaryName}.tar.gz`);
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(content, binaryName), binaryBody);
  chmodSync(join(content, binaryName), 0o755);
  writeFileSync(join(plugin, 'index.js'), 'export default {};');
  writeFileSync(join(plugin, 'manifest.json'), '{"name":"example"}');
  const packed = Bun.spawnSync(['tar', '-czf', archivePath, '-C', content, binaryName, 'plugins']);
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  return archivePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('installBinaryArchive', () => {
  test('extracts a real archive into a versioned executable layout', () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'bungee-binary-install-'));
    roots.push(root);
    const binaryName = 'bungee-linux';

    // When
    const executable = installBinaryArchive({
      archivePath: archive(root, binaryName),
      installRoot: join(root, 'bin'),
      version: '4.2.0',
      binaryName,
    });

    // Then
    expect(executable).toBe(join(root, 'bin', '4.2.0', binaryName));
    expect(existsSync(join(root, 'bin', '4.2.0', 'plugins', 'example', 'index.js'))).toBe(true);
    expect(Bun.spawnSync([executable]).exitCode).toBe(0);
  });

  test('keeps the previous install when replacement archive is invalid', () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'bungee-binary-rollback-'));
    roots.push(root);
    const binaryName = 'bungee-linux';
    const installRoot = join(root, 'bin');
    const installed = installBinaryArchive({
      archivePath: archive(root, binaryName, 'previous'), installRoot, version: '4.2.0', binaryName,
    });
    const invalidArchive = join(root, 'invalid.tar.gz');
    writeFileSync(invalidArchive, 'not an archive');

    // When
    const replace = () => installBinaryArchive({
      archivePath: invalidArchive, installRoot, version: '4.2.0', binaryName,
    });

    // Then
    expect(replace).toThrow();
    expect(readFileSync(installed, 'utf8')).toBe('previous');
  });
});
