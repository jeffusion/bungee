import { describe, expect, test } from 'bun:test';

describe('plugins toggle surface', () => {
  test('plugin mutations are not gated on configuration or auth state', async () => {
    const source = await Bun.file(new URL('./Plugins.svelte', import.meta.url)).text();

    expect(source).not.toContain('getConfigSnapshot');

    // Toggle disabled only while that plugin's mutation is processing.
    expect(source).toContain('disabled={processingTick >= 0 && processingState.names.has(plugin.name)}');

    // onMount only refreshes plugins.
    expect(source).toMatch(/onMount\(async \(\) => \{\s*await refreshPlugins\(\);\s*\}\)/);
  });
});
