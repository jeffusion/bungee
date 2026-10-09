import { describe, expect, test } from 'bun:test';
import * as path from 'path';
import { loadPluginArtifactManifest } from '../../src/plugin-artifact-contract';

const BUILTIN_PLUGINS_DIR = path.resolve(import.meta.dir, '../../../../plugins');

const BUILTIN_PLUGIN_ENGINES = {
  'ai-transformer': '^4.2.0 || ^5.0.0',
  'anthropic-request-sanitizer': '^4.2.0 || ^5.0.0',
  'anthropic-tool-name-transformer': '^4.2.0 || ^5.0.0',
  'chatgpt-oauth': '^4.3.0 || ^5.0.0',
  'codex-router': '^4.2.0 || ^5.0.0',
  'deepseek-reasoning-fix': '^4.2.0 || ^5.0.0',
  'model-mapping': '^4.2.0 || ^5.0.0',
  'openai-messages-to-chat': '^4.2.0 || ^5.0.0',
  'signature-repair': '^4.2.0 || ^5.0.0',
  'token-stats': '^5.0.0',
} as const;
const BUILTIN_PLUGIN_NAMES = Object.keys(BUILTIN_PLUGIN_ENGINES) as (keyof typeof BUILTIN_PLUGIN_ENGINES)[];

describe('builtin plugin manifests', () => {
  test('covers all ten built-in plugin engine declarations', () => {
    expect(BUILTIN_PLUGIN_NAMES).toHaveLength(10);
  });

  test.each(BUILTIN_PLUGIN_NAMES)('loads %s as a vnext manifest', async (pluginName) => {
    const manifest = await loadPluginArtifactManifest(path.join(BUILTIN_PLUGINS_DIR, pluginName));

    expect(manifest.manifestContract).toBe('vnext');
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.artifactKind).toBe('runtime-plugin');
    expect(manifest.main).toBe('server/index.ts');
    expect(manifest.engines.bungee).toBe(BUILTIN_PLUGIN_ENGINES[pluginName]);
    expect(manifest.metadata?.name).toBeDefined();
    expect(manifest.translations?.en).toBeDefined();
    expect(manifest.translations?.['zh-CN']).toBeDefined();
  });
});
