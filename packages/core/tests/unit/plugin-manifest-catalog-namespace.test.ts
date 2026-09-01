import { afterEach, describe, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupCatalogRoots,
  expectCatalogError,
  manifest,
  tempRoot,
  writePlugin,
} from './plugin-manifest-catalog-fixtures';

afterEach(cleanupCatalogRoots);

describe('PluginManifestCatalog global namespace', () => {
  test('rejects Linux backslash entry filenames', async () => {
    const root = tempRoot();
    const directory = writePlugin(root, 'backslash-entry', manifest('backslash-entry', {
      main: 'server\\index.ts',
    }));
    writeFileSync(join(directory, 'server\\index.ts'), 'export default {};');
    await expectCatalogError([root], 'path segments');
  });

  test('rejects component names duplicated across plugins', async () => {
    const root = tempRoot();
    for (const name of ['component-one', 'component-two']) {
      const directory = writePlugin(root, name, manifest(name, {
        capabilities: ['hooks', 'dynamicRuntimeLoad', 'nativeWidgetsStatic'],
        uiExtensionMode: 'native-static',
        ui: { components: [{ name: 'SharedWidget', entry: 'ui/widget.svelte' }] },
      }));
      mkdirSync(join(directory, 'ui'));
      writeFileSync(join(directory, 'ui/widget.svelte'), '<div />');
    }
    await expectCatalogError([root], 'duplicate UI component');
  });
});
