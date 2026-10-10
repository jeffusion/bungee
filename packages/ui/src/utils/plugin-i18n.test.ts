import { describe, expect, test } from 'bun:test';
import { getPluginText } from './plugin-i18n';

const translate = (key: string, options?: { default?: string }) => {
  const messages: Record<string, string> = {
    'plugins.llm-protocol-adapter.metadata.name': 'LLM Protocol Adapter',
    'plugins.llm-protocol-adapter.plugin.description': 'Convert LLM protocols',
    'plugins.llm-protocol-adapter.sourceProtocol.label': 'Source protocol',
  };

  return messages[key] ?? options?.default ?? key;
};

describe('getPluginText', () => {
  test('resolves relative plugin translation keys', () => {
    expect(getPluginText('metadata.name', 'llm-protocol-adapter', translate)).toBe('LLM Protocol Adapter');
    expect(getPluginText('sourceProtocol.label', 'llm-protocol-adapter', translate)).toBe('Source protocol');
  });

  test('resolves fully namespaced plugin translation keys without double-prefixing', () => {
    expect(getPluginText('plugins.llm-protocol-adapter.plugin.description', 'llm-protocol-adapter', translate)).toBe('Convert LLM protocols');
  });

  test('returns plain text unchanged', () => {
    expect(getPluginText('LLM Protocol Adapter', 'llm-protocol-adapter', translate)).toBe('LLM Protocol Adapter');
  });
});
