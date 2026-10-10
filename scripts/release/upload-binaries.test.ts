import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectBinaryArchives } from './upload-binaries';

describe('selectBinaryArchives', () => {
  test('selects release archives and excludes bare binaries', () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), 'bungee-upload-assets-'));
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'bungee-linux'), 'bare');
    writeFileSync(join(root, 'bungee-linux.tar.gz'), 'archive');
    writeFileSync(join(root, 'bungee-macos.tar.gz'), 'archive');

    // When
    const selected = selectBinaryArchives(root);

    // Then
    expect(selected).toEqual(['bungee-linux.tar.gz', 'bungee-macos.tar.gz']);
  });
});
