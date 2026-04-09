import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { loadPluginArtifactManifest } from '../../src/plugin-artifact-contract';

const BUILTIN_PLUGINS_DIR = path.resolve(import.meta.dir, '../../../../plugins');

const BUILTIN_PLUGIN_NAMES = [
  'ai-transformer',
  'model-mapping',
  'token-stats',
  'openai-messages-to-chat',
  'anthropic-tool-name-transformer',
  'anthropic-request-sanitizer',
];

describe('builtin plugin manifests', () => {
  test.each(BUILTIN_PLUGIN_NAMES)('loads %s as a vnext manifest', async (pluginName) => {
    const manifest = await loadPluginArtifactManifest(path.join(BUILTIN_PLUGINS_DIR, pluginName));

    expect(manifest.manifestContract).toBe('vnext');
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.artifactKind).toBe('runtime-plugin');
    expect(manifest.main).toBe('server/index.ts');
    expect(manifest.engines.bungee).toBe('^3.2.0');
    expect(manifest.metadata?.name).toBeDefined();
    expect(manifest.translations?.en).toBeDefined();
    expect(manifest.translations?.['zh-CN']).toBeDefined();
  });
});
