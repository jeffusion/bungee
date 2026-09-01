import { describe, expect, test } from 'bun:test';
import { PluginPathResolver } from '../../src/plugin-path-resolver';

describe('PluginPathResolver compiled layout', () => {
  test('resolves required system plugins beside the executable', () => {
    // Given
    const resolver = new PluginPathResolver(
      '/$bunfs/root',
      '/home/test/.bungee/data',
      '/home/test/.bungee/bin/4.2.0/bungee-linux',
    );

    // When
    const roots = resolver.getScanRoots();

    // Then
    expect(roots).toEqual([
      { path: '/home/test/.bungee/data/plugins', required: false },
      { path: '/home/test/.bungee/bin/4.2.0/plugins', required: true },
    ]);
  });
});
