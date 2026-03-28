import type { AIConverter } from './base';
import { AnthropicToOpenAIConverter as LLMSAnthropicToOpenAIConverter } from '@jeffusion/bungee-llms/plugin-api';

export class AnthropicToOpenAIConverter extends LLMSAnthropicToOpenAIConverter implements AIConverter {}
