import { AnthropicToGeminiConverter } from './anthropic-to-gemini.converter';
import { AnthropicToOpenAIConverter } from './anthropic-to-openai.converter';
import { GeminiToAnthropicConverter } from './gemini-to-anthropic.converter';
import { GeminiToOpenAIConverter } from './gemini-to-openai.converter';
import { OpenAIToAnthropicConverter } from './openai-to-anthropic.converter';
import { OpenAIToGeminiConverter } from './openai-to-gemini.converter';
import { ProtocolTransformerRegistry } from './registry';

export function registerDefaultProtocolConverters(): void {
  ProtocolTransformerRegistry.register('anthropic', 'openai', AnthropicToOpenAIConverter);
  ProtocolTransformerRegistry.register('openai', 'anthropic', OpenAIToAnthropicConverter);
  ProtocolTransformerRegistry.register('anthropic', 'gemini', AnthropicToGeminiConverter);
  ProtocolTransformerRegistry.register('gemini', 'anthropic', GeminiToAnthropicConverter);
  ProtocolTransformerRegistry.register('openai', 'gemini', OpenAIToGeminiConverter);
  ProtocolTransformerRegistry.register('gemini', 'openai', GeminiToOpenAIConverter);
}
