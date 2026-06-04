import { describe, expect, test } from 'bun:test';
import { getPluginText } from './plugin-i18n';

const translate = (key: string, options?: { default?: string }) => {
  const messages: Record<string, string> = {
    'plugins.ai-transformer.metadata.name': 'AI Transformer',
    'plugins.ai-transformer.plugin.description': 'Unified AI format transformer',
    'plugins.ai-transformer.transformation.label': 'Transformation Direction',
  };

  return messages[key] ?? options?.default ?? key;
};

describe('getPluginText', () => {
  test('resolves relative plugin translation keys', () => {
    expect(getPluginText('metadata.name', 'ai-transformer', translate)).toBe('AI Transformer');
    expect(getPluginText('transformation.label', 'ai-transformer', translate)).toBe('Transformation Direction');
  });

  test('resolves fully namespaced plugin translation keys without double-prefixing', () => {
    expect(getPluginText('plugins.ai-transformer.plugin.description', 'ai-transformer', translate)).toBe('Unified AI format transformer');
  });

  test('returns plain text unchanged', () => {
    expect(getPluginText('AI Transformer', 'ai-transformer', translate)).toBe('AI Transformer');
  });
});
