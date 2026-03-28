import { describe, expect, test } from 'bun:test';
import {
  AnthropicToOpenAIConverter,
  OpenAIMessagesCompatibilityNormalizer,
  OpenAIProtocolConversion,
  ProtocolTransformerRegistry,
  registerDefaultProtocolConverters,
  type AIConverter
} from '@jeffusion/bungee-llms/plugin-api';

describe('llms plugin-api facade', () => {
  test('exposes converter registry through stable facade', () => {
    ProtocolTransformerRegistry.clear();
    registerDefaultProtocolConverters();

    const converter = ProtocolTransformerRegistry.get('anthropic', 'openai');
    const typedConverter: AIConverter = converter;

    expect(typedConverter).toBeDefined();
    expect(typedConverter.from).toBe('anthropic');
    expect(typedConverter.to).toBe('openai');
  });

  test('exposes openai protocol utilities through stable facade', () => {
    const protocolConversion = new OpenAIProtocolConversion();
    const normalizer = new OpenAIMessagesCompatibilityNormalizer();
    const responseConverter = new AnthropicToOpenAIConverter();

    expect(protocolConversion).toBeInstanceOf(OpenAIProtocolConversion);
    expect(normalizer).toBeInstanceOf(OpenAIMessagesCompatibilityNormalizer);
    expect(responseConverter).toBeInstanceOf(AnthropicToOpenAIConverter);
  });
});
