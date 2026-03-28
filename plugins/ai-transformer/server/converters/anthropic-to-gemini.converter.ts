import type { AIConverter } from './base';
import { AnthropicToGeminiConverter as LLMSAnthropicToGeminiConverter } from '@jeffusion/bungee-llms/plugin-api';

export class AnthropicToGeminiConverter extends LLMSAnthropicToGeminiConverter implements AIConverter {}
