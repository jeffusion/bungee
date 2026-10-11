import { describe, expect, test } from 'bun:test';

describe('plugins toggle surface', () => {
  test('plugin mutations retain the existing switch and dependency checks', async () => {
    const source = await Bun.file(new URL('../../../src/routes/Plugins.svelte', import.meta.url)).text();

    expect(source).not.toContain('getConfigSnapshot');

    expect(source).not.toContain("$capabilities");
    expect(source).toContain('<BSwitch');
    expect(source).toContain('checked={plugin.enabled}');
    expect(source).not.toContain('<button role="switch"');
    expect(source).toContain('activationBlockedReason(plugin, pluginDisplayName, $_)');
    expect(source).toContain('action.kind === \'config\'');

    // onMount only refreshes plugins.
    expect(source).toMatch(/onMount\(async \(\) => \{\s*await refreshPlugins\(\);\s*\}\)/);
  });
});
