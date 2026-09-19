import { describe, expect, test } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { PluginPathResolver } from '../../src/plugin-path-resolver';

describe('PluginPathResolver compiled layout', () => {
  test('resolves required system plugins beside the executable', () => {
    const configBasePath = '/home/test/.bungee/data';
    const executablePath = '/home/test/.bungee/bin/4.2.0/bungee-linux';

    // Given
    const resolver = new PluginPathResolver('/$bunfs/root', configBasePath, executablePath);

    // When
    const roots = resolver.getScanRoots();

    // Then: mirror the production path functions so expectations stay portable
    expect(roots).toEqual([
      { path: resolve(configBasePath, './plugins'), required: false },
      { path: join(dirname(executablePath), 'plugins'), required: true },
    ]);
  });
});
