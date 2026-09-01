import { describe, expect, test } from 'bun:test';
import { getAssetName, getBinaryName } from './names';

describe('binary release names', () => {
  test('maps every supported target to its archive asset', () => {
    // Given
    const targets = [
      ['linux', 'x64', 'bungee-linux.tar.gz'],
      ['linux', 'arm64', 'bungee-linux-arm64.tar.gz'],
      ['darwin', 'x64', 'bungee-macos.tar.gz'],
      ['darwin', 'arm64', 'bungee-macos-arm64.tar.gz'],
      ['win32', 'x64', 'bungee-windows.exe.tar.gz'],
    ] as const;

    // When / Then
    for (const [platform, architecture, asset] of targets) {
      expect(getAssetName(getBinaryName(platform, architecture))).toBe(asset);
    }
  });
});
