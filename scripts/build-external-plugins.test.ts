import { describe, expect, test } from 'bun:test';
import { rewriteManifestForBuiltArtifact } from './build-external-plugins';

describe('rewriteManifestForBuiltArtifact', () => {
  test('rewrites built plugin manifest main entry to bundled artifact', () => {
    const rewritten = rewriteManifestForBuiltArtifact({
      name: 'ai-transformer',
      version: '2.0.0',
      schemaVersion: 2,
      artifactKind: 'runtime-plugin',
      main: 'server/index.ts',
      capabilities: ['hooks', 'api', 'dynamicRuntimeLoad'],
      uiExtensionMode: 'none',
      engines: { bungee: '^3.2.0' },
      metadata: {
        name: 'metadata.name',
        description: 'plugin.description',
      },
      translations: {
        en: { 'metadata.name': 'AI Transformer' },
        'zh-CN': { 'metadata.name': 'AI 格式转换器' },
      },
    });

    expect(rewritten.main).toBe('index.js');
    expect(rewritten.schemaVersion).toBe(2);
    expect(rewritten.capabilities).toEqual(['hooks', 'api', 'dynamicRuntimeLoad']);
    expect(rewritten.metadata?.name).toBe('metadata.name');
    expect(rewritten.translations?.['zh-CN']?.['metadata.name']).toBe('AI 格式转换器');
  });
});
