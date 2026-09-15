import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBinaryArchive, parseTarListing } from './archive-installer';

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
  test.skipIf(process.platform !== 'win32')('normalizes CRLF and Windows separators in Windows tar listings', () => {
    expect(parseTarListing('.\\bungee-windows.exe\r\n.\\plugins\\\r\nplugins\\example\\index.js\r\n'))
      .toEqual(['bungee-windows.exe', 'plugins/', 'plugins/example/index.js']);
  });

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

  test('rejects an unexpected ordinary top-level root from a real archive', () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-binary-hostile-'));
    roots.push(root);
    const binaryName = 'bungee-linux';
    const content = join(root, 'content');
    const archivePath = join(root, 'hostile.tar.gz');
    mkdirSync(join(content, 'plugins'), { recursive: true });
    writeFileSync(join(content, binaryName), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(content, 'unexpected-root'), 'not a plugin');
    const packed = Bun.spawnSync([
      'tar', '-czf', archivePath, '-C', content, binaryName, 'plugins', 'unexpected-root',
    ]);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());

    expect(() => installBinaryArchive({
      archivePath, installRoot: join(root, 'bin'), version: '4.2.0', binaryName,
    })).toThrow(/Unexpected binary archive entry|Invalid plugin artifact/);
  });

  test.skipIf(process.platform === 'win32')('rejects a hostile literal backslash filename on POSIX', () => {
    const root = mkdtempSync(join(tmpdir(), 'bungee-binary-backslash-'));
    roots.push(root);
    const binaryName = 'bungee-linux';
    const content = join(root, 'content');
    const archivePath = join(root, 'hostile.tar.gz');
    mkdirSync(join(content, 'plugins'), { recursive: true });
    writeFileSync(join(content, binaryName), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(content, 'plugins\\evil'), 'not a plugin');
    const packed = Bun.spawnSync([
      'tar', '-czf', archivePath, '-C', content, binaryName, 'plugins', 'plugins\\evil',
    ]);
    if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());

    expect(() => installBinaryArchive({
      archivePath, installRoot: join(root, 'bin'), version: '4.2.0', binaryName,
    })).toThrow(/Unexpected binary archive entry|Invalid plugin artifact/);
  });
});
